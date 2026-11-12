import { STRINGS, SPEECH_LANG, FLAG } from "./i18n.js";
import { Call } from "./rtc.js";
import { Recognizer, speechSupported, speak, isSpeaking } from "./speech.js";

/* global io */
const socket = io();
const $ = (sel) => document.querySelector(sel);

const state = {
  me: null,
  partner: null,
  roomOpen: false,
  users: [],
  translator: "claude",
  matching: false,
  modal: null, // { kind, data }
  readAloud: load("readAloud", true),
  mic: true,
  cam: true,
};
let T = STRINGS.ko;
let call = null;
let recognizer = null;
const messageEls = new Map();

function load(key, fallback) {
  try {
    const v = localStorage.getItem(`koja:${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(`koja:${key}`, JSON.stringify(value));
  } catch {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function show(screen) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === `screen-${screen}`));
}

function applyI18n() {
  document.documentElement.lang = state.me?.lang ?? "ko";
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const v = T[el.dataset.i18n];
    if (typeof v === "string") el.textContent = v;
  });
  $("#msg-input").placeholder = T.typeMessage;
}

let toastTimer;
function toast(text, ms = 3200) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function openModal(kind, text, buttons, data = null) {
  state.modal = { kind, data };
  $("#modal-text").textContent = text;
  const actions = $("#modal-actions");
  actions.replaceChildren(
    ...buttons.map(({ label, cls = "", onClick }) => {
      const b = document.createElement("button");
      b.className = `btn ${cls}`;
      b.textContent = label;
      b.onclick = () => {
        closeModal();
        onClick?.();
      };
      return b;
    }),
  );
  $("#modal").hidden = false;
}
function closeModal(kind) {
  if (kind && state.modal?.kind !== kind) return;
  state.modal = null;
  $("#modal").hidden = true;
}

function avatar(user, cls = "avatar") {
  const el = document.createElement("div");
  el.className = `${cls} ${user.lang}`;
  el.textContent = [...user.name][0]?.toUpperCase() ?? "?";
  return el;
}

function langBadge(lang) {
  const el = document.createElement("span");
  el.className = `lang-badge ${lang}`;
  el.textContent = `${FLAG[lang]} ${STRINGS[lang].langName}`;
  return el;
}

function timeStr(ts) {
  return new Date(ts).toLocaleTimeString(state.me?.lang === "ja" ? "ja-JP" : "ko-KR", { hour: "2-digit", minute: "2-digit" });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
const saved = load("profile", null);
if (saved) {
  $("#nickname").value = saved.name ?? "";
  const radio = document.querySelector(`input[name=lang][value="${saved.lang}"]`);
  if (radio) radio.checked = true;
}

const configPromise = fetch("/api/config")
  .then((r) => r.json())
  .catch(() => ({ translator: "claude", iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }));

$("#setup-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("#nickname").value.trim();
  const lang = document.querySelector("input[name=lang]:checked").value;
  if (!name) return;
  setProfile(name, lang);
});

function setProfile(name, lang) {
  socket.emit("profile:set", { name, lang }, async (res) => {
    if (!res?.ok) return toast("⚠️");
    const config = await configPromise;
    state.me = res.me;
    state.translator = res.translator;
    T = STRINGS[lang];
    save("profile", { name, lang });
    if (!call) setupCall(config.iceServers);
    applyI18n();
    renderMe();
    $("#mock-banner").hidden = state.translator !== "mock";
    if (!state.roomOpen) show("lobby");
  });
}

socket.on("connect", () => {
  // Re-register after a reconnect (the server forgets us when the socket drops).
  if (state.me) setProfile(state.me.name, state.me.lang);
});
socket.on("disconnect", () => {
  if (state.roomOpen && state.partner) partnerGone(T.partnerLeft);
});

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------
function renderMe() {
  const chip = $("#me-chip");
  chip.replaceChildren(avatar(state.me), document.createTextNode(state.me.name), langBadge(state.me.lang));
  chip.querySelector(".avatar").style.cssText = "width:28px;height:28px;font-size:13px";
}

socket.on("users:update", (list) => {
  state.users = list;
  renderUsers();
});

function renderUsers() {
  if (!state.me) return;
  const others = state.users
    .filter((u) => u.id !== state.me.id)
    .sort((a, b) => (a.lang === state.me.lang) - (b.lang === state.me.lang) || a.busy - b.busy);
  $("#online-count").textContent = others.length ? `${others.length}` : "";
  $("#nobody").hidden = others.length > 0;
  $("#user-list").replaceChildren(
    ...others.map((u) => {
      const li = document.createElement("li");
      const who = document.createElement("div");
      who.className = "who";
      const b = document.createElement("b");
      b.textContent = u.name;
      const small = document.createElement("small");
      small.textContent = `${FLAG[u.lang]} ${u.lang === state.me.lang ? T.langName : T.otherLangName}`;
      who.append(b, small);
      const btn = document.createElement("button");
      btn.className = "btn primary";
      const same = u.lang === state.me.lang;
      btn.textContent = u.busy ? T.busy : same ? T.sameLang : T.invite;
      btn.disabled = u.busy || same || state.roomOpen;
      btn.onclick = () => sendInvite(u);
      li.append(avatar(u), who, btn);
      return li;
    }),
  );
}

function sendInvite(user) {
  socket.emit("invite:send", { to: user.id }, (res) => {
    if (!res?.ok) return toast(T.partnerBusy);
    openModal("outgoing-invite", T.inviting(user.name), [
      { label: T.cancel, onClick: () => socket.emit("invite:cancel") },
    ]);
  });
}

socket.on("invite:received", ({ from }) => {
  if (state.modal || state.roomOpen) {
    return socket.emit("invite:respond", { from: from.id, accept: false });
  }
  openModal(
    "incoming-invite",
    T.inviteFrom(from.name),
    [
      { label: T.decline, onClick: () => socket.emit("invite:respond", { from: from.id, accept: false }) },
      { label: T.accept, cls: "primary", onClick: () => socket.emit("invite:respond", { from: from.id, accept: true }) },
    ],
    from,
  );
});
socket.on("invite:cancelled", ({ from }) => {
  if (state.modal?.kind === "incoming-invite" && state.modal.data?.id === from) closeModal();
});
socket.on("invite:declined", ({ reason }) => {
  closeModal("outgoing-invite");
  toast(reason === "busy" ? T.partnerBusy : T.declined);
});

$("#match-btn").addEventListener("click", () => {
  if (state.matching) return setMatching(false, true);
  setMatching(true);
  socket.emit("match:find", null, (res) => {
    if (!res?.ok) setMatching(false);
  });
});

function setMatching(on, notify = false) {
  state.matching = on;
  if (!on && notify) socket.emit("match:cancel");
  $(".match-card").classList.toggle("finding", on);
  $("#match-btn").textContent = on ? `${T.finding} ✕` : T.findPartner;
}

// ---------------------------------------------------------------------------
// Room: chat
// ---------------------------------------------------------------------------
socket.on("room:joined", ({ partner }) => {
  closeModal();
  setMatching(false);
  state.partner = partner;
  state.roomOpen = true;
  messageEls.clear();
  $("#messages").replaceChildren();
  const info = $("#partner-info");
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = partner.name;
  info.replaceChildren(avatar(partner), name, langBadge(partner.lang));
  info.querySelector(".avatar").style.cssText = "width:30px;height:30px;font-size:13px";
  setRoomEnabled(true);
  systemMessage(T.roomStart(partner.name));
  show("room");
  $("#msg-input").focus();
});

socket.on("room:partner-left", () => partnerGone(T.partnerLeft));

function partnerGone(text) {
  call?.abort();
  systemMessage(text);
  setRoomEnabled(false);
  state.partner = null;
}

function setRoomEnabled(on) {
  $("#msg-input").disabled = !on;
  $("#composer button").disabled = !on;
  $("#voice-btn").disabled = !on;
  $("#video-btn").disabled = !on;
  $("#typing").hidden = true;
}

$("#leave-btn").addEventListener("click", () => {
  call?.hangup();
  socket.emit("room:leave");
  state.roomOpen = false;
  state.partner = null;
  show("lobby");
  renderUsers();
});

function systemMessage(text) {
  const li = document.createElement("li");
  li.className = "msg system";
  li.textContent = text;
  appendMessage(li);
}

function appendMessage(el) {
  const list = $("#messages");
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  list.append(el);
  if (nearBottom || el.classList.contains("mine")) list.scrollTop = list.scrollHeight;
}

function ttsButton(getText, lang) {
  const b = document.createElement("button");
  b.className = "tts";
  b.type = "button";
  b.title = T.listen;
  b.textContent = "🔊";
  b.onclick = () => speak(getText(), SPEECH_LANG[lang], { rate: 0.95 });
  return b;
}

/**
 * Render a chat message or a call caption.
 * Their messages show the translation big and the original small (with 🔊 to hear the real pronunciation).
 * My messages show what I wrote big and the translation my partner sees small (with 🔊 to learn how to say it).
 */
function renderEntry(entry, kind) {
  const mine = entry.from === state.me.id;
  const li = document.createElement("li");
  li.className = `msg ${mine ? "mine" : "theirs"}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const main = document.createElement("div");
  main.className = "main";
  const sub = document.createElement("div");
  sub.className = "sub";
  const label = document.createElement("span");
  label.className = "label";
  const subText = document.createElement("span");
  subText.className = "sub-text";
  const pending = document.createElement("span");
  pending.innerHTML = '<span class="spinner"></span>';
  pending.append(T.translating);
  subText.append(pending);
  sub.append(label, subText);

  main.textContent = entry.text;
  if (!mine) main.classList.add("pending");
  label.textContent = mine ? T.theySee : T.original;

  bubble.append(main, sub);
  const meta = document.createElement("div");
  meta.className = "meta";
  if (kind === "caption") {
    const k = document.createElement("span");
    k.className = "kind";
    k.textContent = `🎙️ ${T.callTranscript}`;
    meta.append(k);
  }
  meta.append(timeStr(entry.ts));
  li.append(bubble, meta);
  appendMessage(li);

  const record = { entry, mine, main, sub, subText, label, translation: null };
  messageEls.set(entry.id, record);
  return record;
}

function applyTranslation({ id, text, ok, lang }) {
  const r = messageEls.get(id);
  if (!r) return null;
  r.translation = ok ? text : null;
  r.main.classList.remove("pending");
  const original = r.entry.text;
  if (!ok) {
    r.subText.replaceChildren(`⚠️ ${T.translateFailed}`);
    return r;
  }
  if (r.mine) {
    // Big: what I wrote. Small: what my partner sees.
    r.subText.replaceChildren(text);
    r.sub.append(ttsButton(() => text, lang));
  } else {
    // Big: translation into my language. Small: the original, for learning.
    r.main.textContent = text;
    r.subText.replaceChildren(original);
    r.sub.append(ttsButton(() => original, r.entry.lang));
  }
  return r;
}

socket.on("chat:message", (msg) => {
  renderEntry(msg, "chat");
  if (msg.from !== state.me.id) $("#typing").hidden = true;
});
socket.on("chat:translation", (t) => applyTranslation(t));

let typingSent = false;
let typingTimer;
$("#msg-input").addEventListener("input", (e) => {
  const el = e.target;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  if (!typingSent) {
    socket.emit("chat:typing", true);
    typingSent = true;
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    socket.emit("chat:typing", false);
    typingSent = false;
  }, 1800);
});
$("#msg-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#composer").requestSubmit();
  }
});
$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#msg-input");
  const text = input.value.trim();
  if (!text || !state.partner) return;
  socket.emit("chat:send", { text }, (res) => {
    if (res?.error === "rate_limited") toast("⏳");
  });
  input.value = "";
  input.style.height = "auto";
  clearTimeout(typingTimer);
  socket.emit("chat:typing", false);
  typingSent = false;
});
socket.on("chat:typing", (on) => ($("#typing").hidden = !on));

// ---------------------------------------------------------------------------
// Room: call + live translated captions
// ---------------------------------------------------------------------------
const remoteVideo = $("#remote-video");
const localVideo = $("#local-video");
remoteVideo.volume = Number($("#vol").value);

let callTimer = null;
let partnerCapTimer = null;

function setupCall(iceServers) {
  call = new Call(socket, iceServers);

  call.addEventListener("incoming", ({ detail }) => {
    if (!state.partner) return call.decline();
    openModal("incoming-call", `${detail.video ? "🎥" : "📞"} ${T.incomingCall(state.partner.name, detail.video)}`, [
      { label: T.decline, onClick: () => call.decline() },
      { label: T.accept, cls: "primary", onClick: () => call.accept().catch(() => toast(T.mediaError)) },
    ]);
  });

  call.addEventListener("local-stream", ({ detail }) => {
    localVideo.srcObject = detail.stream;
    localVideo.hidden = !detail.stream.getVideoTracks().length;
    openStage();
  });
  call.addEventListener("remote-stream", ({ detail }) => {
    remoteVideo.srcObject = detail.stream;
    remoteVideo.play().catch(() => {});
  });
  call.addEventListener("remote-track", ({ detail }) => {
    if (detail.track.kind === "video") $("#stage").classList.add("has-remote-video");
  });
  call.addEventListener("state", ({ detail }) => {
    if (detail.state === "outgoing") $("#call-status").textContent = T.calling;
    if (detail.state === "active") {
      $("#call-status").textContent = T.calling;
      startRecognition();
    }
  });
  call.addEventListener("connection", ({ detail }) => {
    if (detail.state === "connected") startTimer();
  });
  call.addEventListener("ended", ({ detail }) => {
    closeModal("incoming-call");
    closeStage();
    if (detail.reason === "declined") toast(T.callDeclined);
    else if (detail.reason === "media_error") toast(T.mediaError);
    if (detail.was === "active") systemMessage(`📞 ${T.callEnded}`);
  });
}

function openStage() {
  const stage = $("#stage");
  stage.hidden = false;
  stage.classList.remove("has-remote-video");
  const av = $("#remote-avatar");
  if (state.partner) {
    av.className = `avatar-big ${state.partner.lang}`;
    av.textContent = [...state.partner.name][0]?.toUpperCase() ?? "?";
  }
  ["#cap-partner", "#cap-partner-orig", "#cap-partner-interim", "#cap-me"].forEach((s) => ($(s).textContent = ""));
  state.mic = true;
  state.cam = true;
  $("#mic-btn").classList.add("on");
  $("#cam-btn").classList.add("on");
  $("#cam-btn").hidden = !call.hasLocalVideo;
  $("#tts-btn").classList.toggle("on", state.readAloud);
}

function closeStage() {
  $("#stage").hidden = true;
  stopRecognition();
  window.speechSynthesis?.cancel();
  clearInterval(callTimer);
  callTimer = null;
  $("#call-status").textContent = "";
  remoteVideo.srcObject = null;
  localVideo.srcObject = null;
}

function startTimer() {
  const started = Date.now();
  clearInterval(callTimer);
  const tick = () => {
    const s = Math.floor((Date.now() - started) / 1000);
    const live = recognizer?.running ? ` · 🎙️ ${T.listening}` : "";
    $("#call-status").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}${live}`;
  };
  tick();
  callTimer = setInterval(tick, 1000);
}

function startRecognition() {
  if (!speechSupported) return toast(T.speechUnsupported, 6000);
  if (!state.mic) return;
  if (!recognizer) {
    let lastInterim = 0;
    recognizer = new Recognizer(SPEECH_LANG[state.me.lang], {
      shouldIgnore: () => isSpeaking() || !state.mic,
      onInterim: (text) => {
        $("#cap-me").textContent = `${T.you}: ${text}`;
        const now = Date.now();
        if (now - lastInterim > 350) {
          lastInterim = now;
          socket.emit("speech:interim", { text });
        }
      },
      onFinal: (text) => {
        $("#cap-me").textContent = "";
        socket.emit("speech:final", { text });
      },
      onState: (s) => {
        if (s === "denied") toast(T.speechDenied);
      },
    });
  }
  recognizer.lang = SPEECH_LANG[state.me.lang];
  recognizer.start();
  if (!load("tipShown", false) && state.readAloud) {
    toast(`🎧 ${T.headphoneTip}`, 6000);
    save("tipShown", true);
  }
}
function stopRecognition() {
  recognizer?.stop();
}

socket.on("speech:interim", ({ text }) => {
  $("#cap-partner-interim").textContent = text ? `${text}…` : "";
});

socket.on("caption", (cap) => {
  renderEntry(cap, "caption");
  if (cap.from !== state.me.id) $("#cap-partner-interim").textContent = "";
});

socket.on("caption:translation", (t) => {
  const r = applyTranslation(t);
  if (!r || r.mine || !t.ok) return;
  // Show the partner's sentence, translated, as a subtitle over the call.
  $("#cap-partner").textContent = t.text;
  $("#cap-partner-orig").textContent = r.entry.text;
  clearTimeout(partnerCapTimer);
  partnerCapTimer = setTimeout(() => {
    $("#cap-partner").textContent = "";
    $("#cap-partner-orig").textContent = "";
  }, 9000);
  if (state.readAloud && call?.state === "active") speak(t.text, SPEECH_LANG[state.me.lang], { rate: 1.05 });
});

$("#voice-btn").addEventListener("click", () => call?.start(false).catch(() => toast(T.mediaError)));
$("#video-btn").addEventListener("click", () => call?.start(true).catch(() => toast(T.mediaError)));
$("#hangup-btn").addEventListener("click", () => call?.hangup());

$("#mic-btn").addEventListener("click", () => {
  state.mic = !state.mic;
  call?.setMicEnabled(state.mic);
  $("#mic-btn").classList.toggle("on", state.mic);
  if (state.mic) startRecognition();
  else {
    stopRecognition();
    $("#cap-me").textContent = "";
  }
});
$("#cam-btn").addEventListener("click", () => {
  state.cam = !state.cam;
  call?.setCameraEnabled(state.cam);
  $("#cam-btn").classList.toggle("on", state.cam);
});
$("#tts-btn").addEventListener("click", () => {
  state.readAloud = !state.readAloud;
  save("readAloud", state.readAloud);
  $("#tts-btn").classList.toggle("on", state.readAloud);
  if (!state.readAloud) window.speechSynthesis?.cancel();
});
$("#vol").addEventListener("input", (e) => (remoteVideo.volume = Number(e.target.value)));

// Hook for automated tests and debugging (simulates a finished spoken sentence).
window.__koja = { sendSpeech: (text) => socket.emit("speech:final", { text }), state };
