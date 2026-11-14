import "./inapp.js";
import { STRINGS, SPEECH_LANG, FLAG } from "./i18n.js";
import { Call } from "./rtc.js";
import { Recognizer, speechSupported, speak, isSpeaking } from "./speech.js";
import { ServerSTT } from "./stt.js";

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
  mic: true,
  roomCode: null, // code of the room link the current room came from (if any)
  waiting: false, // waiting in my room link for my friend
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

// A private id for this browser tab. After a dropped connection the server uses it to give us our
// room back. sessionStorage (not localStorage) so two tabs in the same browser stay two different users.
const cid = (() => {
  try {
    let v = sessionStorage.getItem("koja:cid");
    if (!v) sessionStorage.setItem("koja:cid", (v = crypto.randomUUID()));
    return v;
  } catch {
    return crypto.randomUUID();
  }
})();

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

// Opened from an invite link (/?room=CODE): greet the friend and preselect their language.
let pendingJoin = new URLSearchParams(location.search).get("room");
if (pendingJoin) {
  fetch(`/api/link/${encodeURIComponent(pendingJoin)}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((info) => {
      const banner = $("#invite-banner");
      if (info?.host) {
        const { name, lang } = info.host;
        banner.textContent = `💌 ${name}님이 기다리고 있어요 · ${name}さんが待っています`;
        const radio = document.querySelector(`input[name=lang][value="${lang === "ko" ? "ja" : "ko"}"]`);
        if (radio) radio.checked = true;
      } else if (info?.ok) {
        banner.textContent = "💌 초대 링크로 들어왔어요. 친구가 들어오면 바로 연결돼요 · 招待リンクから入りました。友達が来るとすぐにつながります";
      } else {
        banner.textContent = `⚠️ ${STRINGS.ko.linkExpired} / ${STRINGS.ja.linkExpired}`;
      }
      banner.hidden = false;
    });
}

// Fetched again for every call so short-lived TURN credentials are always fresh.
// Server features (is server-side speech recognition available?), fetched once at startup.
fetch("/api/config")
  .then((r) => r.json())
  .then((c) => (state.stt = c.stt ?? null))
  .catch(() => {});

const getIceServers = () =>
  fetch("/api/config")
    .then((r) => r.json())
    .then((c) => c.iceServers);

$("#setup-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("#nickname").value.trim();
  const lang = document.querySelector("input[name=lang]:checked").value;
  if (!name) return;
  setProfile(name, lang);
});

function setProfile(name, lang) {
  socket.emit("profile:set", { name, lang, cid }, (res) => {
    if (!res?.ok) return toast("⚠️");
    const reconnect = Boolean(state.me);
    state.me = res.me;
    state.translator = res.translator;
    T = STRINGS[lang];
    save("profile", { name, lang });
    if (!call) setupCall();
    applyI18n();
    renderMe();
    renderLink();
    $("#mock-banner").hidden = state.translator !== "mock";
    if (reconnect) setOffline(false);

    if (res.room) {
      // The server kept our seat while we were gone: carry on where we left off.
      if (state.roomOpen) resumeRoom(res.room);
      else enterRoom(res.room);
    } else if (state.roomOpen && state.partner) {
      lostRoom();
    } else if (!state.roomOpen) {
      show("lobby");
    }

    if (pendingJoin) joinByLink();
    else if (state.waiting && !res.waitingCode && !state.roomOpen) createLink(); // e.g. the server restarted
  });
}

function joinByLink() {
  const code = pendingJoin.toLowerCase();
  pendingJoin = null;
  history.replaceState(null, "", location.pathname);
  socket.emit("link:join", { code }, (res) => {
    if (!res?.ok) return toast(res?.error === "busy" ? T.partnerBusy : T.linkExpired, 5000);
    // The friend's link becomes "our room" on this device too, so either of us can open it next time.
    save("roomCode", res.code);
    setWaiting(res.waiting);
  });
}

socket.on("connect", () => {
  // Re-register after a reconnect. The server recognises our cid and gives us our room back.
  if (state.me) setProfile(state.me.name, state.me.lang);
});
socket.on("disconnect", () => {
  if (state.me) setOffline(true);
});

let offlineTimer = null;
function setOffline(on) {
  clearTimeout(offlineTimer);
  document.body.classList.toggle("offline", on);
  // Short blips are common on phones: only say something if it lasts.
  if (on) offlineTimer = setTimeout(() => toast(`📶 ${T.disconnected}`, 60000), 1500);
  else if ($("#toast").textContent.includes(T.disconnected)) toast(`✅ ${T.reconnected}`);
}

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

// ---- Room link ------------------------------------------------------------------
// One permanent link per pair of friends. Whoever opens it first waits; the second person is connected.
// openExternalBrowser=1 makes LINE open the link in Safari/Chrome instead of its in-app browser.
const linkUrl = (code) => `${location.origin}${location.pathname}?room=${code}&openExternalBrowser=1`;

function createLink() {
  socket.emit("link:create", { code: load("roomCode", null) }, (res) => {
    if (!res?.ok) return toast(res?.error === "busy" ? T.partnerBusy : "⚠️");
    save("roomCode", res.code);
    setWaiting(res.waiting);
  });
}

function setWaiting(on) {
  state.waiting = Boolean(on);
  renderLink();
}

function renderLink() {
  const code = load("roomCode", null);
  $("#link-btn").hidden = Boolean(code);
  $("#link-box").hidden = !code;
  if (!code) return;
  $("#link-url").value = linkUrl(code);
  $(".invite-card").classList.toggle("waiting", state.waiting);
  $("#link-status").textContent = state.waiting ? T.linkWaiting : T.linkIdle;
  $("#wait-btn").textContent = state.waiting ? T.stopWaiting : T.enterRoom;
  $("#wait-btn").classList.toggle("primary", !state.waiting);
}

$("#link-btn").addEventListener("click", () => createLink());
$("#wait-btn").addEventListener("click", () => {
  if (!state.waiting) return createLink();
  socket.emit("link:cancel");
  setWaiting(false);
});
$("#copy-btn").addEventListener("click", async () => {
  const url = $("#link-url").value;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    $("#link-url").select();
    document.execCommand("copy");
  }
  toast(T.copied);
});
if (navigator.share) {
  $("#share-btn").hidden = false;
  $("#share-btn").addEventListener("click", () =>
    navigator.share({ title: "KoJa Talk", text: T.shareText, url: $("#link-url").value }).catch(() => {}),
  );
}

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
socket.on("room:joined", (room) => enterRoom(room));

let repairTimer = null;

function enterRoom({ code, partner }) {
  closeModal();
  setMatching(false);
  setWaiting(false);
  // Same friend again on the same room link right after losing the room (e.g. the server restarted):
  // keep the conversation and the call going instead of starting over.
  const repairing = Boolean(repairTimer) && state.roomOpen && state.lastPartner?.name === partner.name;
  clearTimeout(repairTimer);
  repairTimer = null;
  state.partner = partner;
  state.lastPartner = partner;
  state.roomOpen = true;
  state.roomCode = code ?? null;
  renderPartner(partner, true);
  setRoomEnabled(true);
  if (repairing) {
    systemMessage(`✅ ${T.reconnected}`);
    call?.recover();
    restartServerStt();
    return;
  }
  call?.abort();
  messageEls.clear();
  $("#messages").replaceChildren();
  systemMessage(T.roomStart(partner.name));
  show("room");
  $("#msg-input").focus();
}

/** We reconnected and the server still had our room. */
function resumeRoom({ code, partner }) {
  state.partner = partner;
  state.roomCode = code ?? null;
  renderPartner(partner, true);
  setRoomEnabled(true);
  call?.recover();
  restartServerStt();
}

/** We reconnected but the server no longer knows our room (it restarted, or we were gone too long). */
function lostRoom() {
  if (!state.roomCode) return partnerGone(T.partnerLeft);
  // Both of us will come back to the same room link: wait there for a while before giving up.
  renderPartner(state.partner, false);
  clearTimeout(repairTimer);
  repairTimer = setTimeout(() => {
    repairTimer = null;
    partnerGone(T.partnerLeft);
  }, 30_000);
  socket.emit("link:join", { code: state.roomCode }, (res) => {
    if (!res?.ok) partnerGone(T.partnerLeft);
  });
}

/** After a reconnect the server has forgotten our speech stream: open a new one. */
function restartServerStt() {
  if (!serverStt?.running) return;
  serverStt.stop();
  startRecognition();
}

function renderPartner(partner, online) {
  const info = $("#partner-info");
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = partner.name;
  info.replaceChildren(avatar(partner), name, langBadge(partner.lang));
  info.querySelector(".avatar").style.cssText = "width:30px;height:30px;font-size:13px";
  info.classList.toggle("offline", !online);
}

socket.on("room:partner-left", () => partnerGone(T.partnerLeft));

socket.on("partner:status", ({ online }) => {
  if (!state.partner) return;
  renderPartner(state.partner, online);
  systemMessage(online ? `✅ ${T.partnerBack}` : `📶 ${T.partnerOffline}`);
  if (online) call?.recover();
});

function partnerGone(text) {
  clearTimeout(repairTimer);
  repairTimer = null;
  call?.abort();
  systemMessage(text);
  setRoomEnabled(false);
  state.partner = null;
  if (state.roomCode) socket.emit("link:cancel");
}

function setRoomEnabled(on) {
  $("#msg-input").disabled = !on;
  $("#composer button").disabled = !on;
  $("#call-btn").disabled = !on;
  $("#typing").hidden = true;
}

$("#leave-btn").addEventListener("click", () => {
  call?.hangup();
  socket.emit("room:leave");
  clearTimeout(repairTimer);
  repairTimer = null;
  state.roomOpen = false;
  state.partner = null;
  state.roomCode = null;
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

function applyTranslation({ id, text, ok, lang, error }) {
  const r = messageEls.get(id);
  if (!r) return null;
  r.translation = ok ? text : null;
  r.main.classList.remove("pending");
  const original = r.entry.text;
  if (!ok) {
    const why = { daily_limit: T.dailyLimit, no_credit: T.noCredit }[error] ?? T.translateFailed;
    r.subText.replaceChildren(`⚠️ ${why}`);
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
// Room: voice call + live translated captions
//   - My real voice goes to my partner over WebRTC (no synthetic voice).
//   - The browser turns my speech into text, the server translates it,
//     and my partner sees it on screen in their language.
// ---------------------------------------------------------------------------
const remoteAudio = $("#remote-audio");
let callTimer = null;
let partnerCapTimer = null;
let myCapTimer = null;
let lastMyCaptionId = null;

function setupCall() {
  call = new Call(socket, getIceServers);

  call.addEventListener("incoming", () => {
    if (!state.partner) return call.decline();
    openModal("incoming-call", `📞 ${T.incomingCall(state.partner.name)}`, [
      { label: T.decline, onClick: () => call.decline() },
      {
        label: T.accept,
        cls: "primary",
        onClick: () => {
          getServerStt()?.prime();
          call.accept().catch(() => toast(T.mediaError));
        },
      },
    ]);
  });

  call.addEventListener("local-stream", () => openStage());
  call.addEventListener("remote-stream", ({ detail }) => {
    remoteAudio.srcObject = detail.stream;
    remoteAudio.play().catch(() => {});
  });
  call.addEventListener("state", ({ detail }) => {
    $("#call-status").textContent = T.calling;
    if (detail.state === "active") startRecognition();
  });
  call.addEventListener("connection", ({ detail }) => {
    if (detail.state === "connected") {
      if (!callTimer) startTimer();
      $("#stage").classList.remove("reconnecting");
    } else if (detail.state === "reconnecting" || detail.state === "disconnected") {
      $("#stage").classList.add("reconnecting");
    }
  });
  call.addEventListener("ended", ({ detail }) => {
    closeModal("incoming-call");
    closeStage();
    if (detail.reason === "declined") toast(T.callDeclined);
    else if (detail.reason === "media_error") toast(T.mediaError);
    if (detail.was === "active") systemMessage(`📞 ${T.callEnded}`);
  });
}

function setPartnerCaption(main, orig = "") {
  const el = $("#cap-partner");
  el.classList.toggle("hint", !main);
  el.textContent = main || T.captionHint;
  $("#cap-partner-orig").textContent = orig;
}

function openStage() {
  $("#stage").hidden = false;
  $("#call-btn").hidden = true;
  const av = $("#remote-avatar");
  if (state.partner) {
    av.className = `avatar-big ${state.partner.lang}`;
    av.textContent = [...state.partner.name][0]?.toUpperCase() ?? "?";
    $("#call-name").textContent = state.partner.name;
  }
  setPartnerCaption("");
  ["#cap-partner-interim", "#cap-me", "#cap-me-translated"].forEach((sel) => ($(sel).textContent = ""));
  state.mic = true;
  $("#mic-btn").classList.add("on");
  keepAwake(true);
}

// Keep the screen on during a call: on phones a locked screen can pause the mic and the page.
let wakeLock = null;
async function keepAwake(on) {
  if (!on) {
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    return;
  }
  try {
    wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
  } catch {
    wakeLock = null; // not supported, or the page is hidden
  }
}
document.addEventListener("visibilitychange", () => {
  // The browser drops the lock when the page is hidden; take it again when we come back.
  if (document.visibilityState === "visible" && !$("#stage").hidden) keepAwake(true);
});

function closeStage() {
  serverSttFailed = false;
  $("#stage").hidden = true;
  $("#stage").classList.remove("reconnecting");
  $("#call-btn").hidden = false;
  keepAwake(false);
  stopRecognition();
  window.speechSynthesis?.cancel();
  clearInterval(callTimer);
  callTimer = null;
  $("#call-status").textContent = "";
  remoteAudio.srcObject = null;
}

function startTimer() {
  const started = Date.now();
  clearInterval(callTimer);
  const tick = () => {
    const s = Math.floor((Date.now() - started) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    const live = $("#stage").classList.contains("reconnecting")
      ? ` · 📶 ${T.reconnecting}`
      : !state.mic
        ? ` · 🔇 ${T.mutedHint}`
        : recognizer?.running || serverStt?.running
          ? ` · 🎙️ ${T.listening}`
          : "";
    $("#call-status").textContent = `${mm}:${ss}${live}`;
  };
  tick();
  callTimer = setInterval(tick, 1000);
}

function showMyCaption(text, translated = "") {
  clearTimeout(myCapTimer);
  $("#cap-me").textContent = text;
  $("#cap-me-translated").textContent = translated;
  if (translated) {
    myCapTimer = setTimeout(() => {
      $("#cap-me").textContent = "";
      $("#cap-me-translated").textContent = "";
    }, 10000);
  }
}

// Call captions: prefer server-side recognition (works on phones, uses the echo-cancelled call audio);
// fall back to the browser's own speech recognition when the server has none or it fails.
let serverStt = null;
let serverSttFailed = false;

function getServerStt() {
  if (!state.stt) return null;
  serverStt ??= new ServerSTT(socket, {
    shouldPause: () => isSpeaking() || !state.mic,
    onInterim: (text) => showMyCaption(text),
    onError: (code) => {
      serverSttFailed = true;
      if (code === "no_credit") toast(`⚠️ ${T.sttNoCredit}`, 6000);
      else if (code === "daily_limit") toast(`⚠️ ${T.sttDailyLimit}`, 6000);
      if (!$("#stage").hidden && state.mic) startBrowserRecognition();
    },
  });
  return serverStt;
}

async function startRecognition() {
  if (!state.mic) return;
  const stt = !serverSttFailed && call?.localStream ? getServerStt() : null;
  if (stt) {
    if (stt.running) return;
    if (await stt.start(call.localStream)) {
      if (!state.mic || $("#stage").hidden) stt.stop(); // muted or hung up while it was starting
      else showHeadphoneTip();
      return;
    }
    serverSttFailed = true;
  }
  startBrowserRecognition();
}

function showHeadphoneTip() {
  if (!load("tipShown", false)) {
    toast(`🎧 ${T.headphoneTip}`, 6000);
    save("tipShown", true);
  }
}

function startBrowserRecognition() {
  if (!speechSupported) return toast(T.speechUnsupported, 6000);
  if (!state.mic) return;
  if (!recognizer) {
    let lastInterim = 0;
    recognizer = new Recognizer(SPEECH_LANG[state.me.lang], {
      // Ignore the mic while a 🔊 pronunciation sample is playing, or while muted.
      shouldIgnore: () => isSpeaking() || !state.mic,
      onInterim: (text) => {
        showMyCaption(text);
        const now = Date.now();
        if (now - lastInterim > 350) {
          lastInterim = now;
          socket.emit("speech:interim", { text });
        }
      },
      onFinal: (text) => {
        showMyCaption(text);
        socket.emit("speech:final", { text });
      },
      onState: (st) => {
        if (st === "denied") toast(T.speechDenied);
      },
    });
  }
  recognizer.lang = SPEECH_LANG[state.me.lang];
  recognizer.start();
  showHeadphoneTip();
}
function stopRecognition() {
  recognizer?.stop();
  serverStt?.stop();
}

// Partner is speaking: show their words live (original language) until the translation arrives.
socket.on("speech:interim", ({ text }) => {
  $("#cap-partner-interim").textContent = text ? `${text}…` : "";
  $("#stage").classList.toggle("speaking", Boolean(text));
});

socket.on("caption", (cap) => {
  renderEntry(cap, "caption");
  if (cap.from === state.me.id) {
    lastMyCaptionId = cap.id;
    showMyCaption(cap.text);
  }
  else {
    $("#cap-partner-interim").textContent = "";
    $("#stage").classList.remove("speaking");
  }
});

socket.on("caption:translation", (t) => {
  const r = applyTranslation(t);
  if (!r || !t.ok) return;
  if (r.mine) {
    // Let me see how my sentence was shown to my partner (good for learning).
    if (t.id === lastMyCaptionId) showMyCaption(r.entry.text, t.text);
    return;
  }
  setPartnerCaption(t.text, r.entry.text);
  clearTimeout(partnerCapTimer);
  partnerCapTimer = setTimeout(() => setPartnerCaption(""), 12000);
});

$("#call-btn").addEventListener("click", () => {
  getServerStt()?.prime(); // iOS only allows audio processing to start from a tap
  call?.start().catch(() => toast(T.mediaError));
});
$("#hangup-btn").addEventListener("click", () => call?.hangup());

$("#mic-btn").addEventListener("click", () => {
  state.mic = !state.mic;
  call?.setMicEnabled(state.mic);
  $("#mic-btn").classList.toggle("on", state.mic);
  if (state.mic) startRecognition();
  else {
    stopRecognition();
    showMyCaption("");
  }
});

// Hook for automated tests and debugging (simulates a finished spoken sentence).
window.__koja = {
  sendSpeech: (text) => socket.emit("speech:final", { text }),
  dropConnection: () => socket.io.engine.close(), // simulates a network blip; socket.io reconnects by itself
  state,
};
