import "./inapp.js";
import { STRINGS, SPEECH_LANG, FLAG } from "./i18n.js";
import { Call } from "./rtc.js";
import { Recognizer, speechSupported, speak, isSpeaking } from "./speech.js";
import { ServerSTT } from "./stt.js";
import * as pwa from "./pwa.js";

/* global io */
const socket = io();
const $ = (sel) => document.querySelector(sel);

const state = {
  me: null,
  rooms: new Map(), // roomId -> summary {id, partner, last, unread}
  roomId: null, // the room shown on screen
  users: [],
  translator: "claude",
  stt: null,
  vapid: null,
  matching: false,
  modal: null, // { kind, data }
  mic: true,
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
    if (value === null) localStorage.removeItem(`koja:${key}`);
    else localStorage.setItem(`koja:${key}`, JSON.stringify(value));
  } catch {}
}

// Things to do once we are signed in, taken from the URL:
//   ?room=CODE         invite link        ?open=ROOM(&call=1)  opened from a notification
//   ?t=TOKEN           first launch of the Home Screen app (sign in as the user it was installed from)
const params = new URLSearchParams(location.search);
let pendingJoin = params.get("room");
let pendingOpen = params.get("open");
let pendingToken = params.get("t");
if ([...params.keys()].length) history.replaceState(null, "", location.pathname);

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
  $("#modal-actions").replaceChildren(
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

const locale = () => (state.me?.lang === "ja" ? "ja-JP" : "ko-KR");
function timeStr(ts) {
  return new Date(ts).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
}
function shortWhen(ts) {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString() ? timeStr(ts) : d.toLocaleDateString(locale(), { month: "numeric", day: "numeric" });
}
function ago(ts) {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return T.justNow;
  if (min < 60) return T.minutesAgo(min);
  if (min < 60 * 24) return T.hoursAgo(Math.floor(min / 60));
  return T.daysAgo(Math.floor(min / 1440));
}
function statusText(p) {
  if (p.online) return `● ${T.statusOnline}`;
  return p.lastSeen ? T.lastSeen(ago(p.lastSeen)) : T.statusOffline;
}

const linkUrl = (code) => `${location.origin}/?room=${code}&openExternalBrowser=1`;

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

// ---------------------------------------------------------------------------
// Sign-in. The server knows us by a secret key kept in localStorage.
// ---------------------------------------------------------------------------
const saved = load("profile", null);
if (saved) {
  $("#nickname").value = saved.name ?? "";
  const radio = document.querySelector(`input[name=lang][value="${saved.lang}"]`);
  if (radio) radio.checked = true;
}

if (pendingJoin) {
  fetch(`/api/link/${encodeURIComponent(pendingJoin)}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((info) => {
      const banner = $("#invite-banner");
      if (info?.host) {
        const { name, lang } = info.host;
        banner.textContent = `💌 ${name}님이 초대했어요 · ${name}さんから招待が届きました`;
        if (!load("profile", null)) {
          const radio = document.querySelector(`input[name=lang][value="${lang === "ko" ? "ja" : "ko"}"]`);
          if (radio) radio.checked = true;
        }
      } else if (info?.ok) {
        banner.textContent = "💌 초대 링크로 들어왔어요 · 招待リンクから入りました";
      } else {
        banner.textContent = `⚠️ ${STRINGS.ko.linkExpired} / ${STRINGS.ja.linkExpired}`;
      }
      banner.hidden = false;
    });
}

fetch("/api/config")
  .then((r) => r.json())
  .then((c) => {
    state.stt = c.stt ?? null;
    state.vapid = c.vapidPublicKey ?? null;
    renderAppCard();
  })
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
  save("profile", { name, lang });
  hello();
});

$("#code-form").addEventListener("submit", (e) => {
  e.preventDefault();
  redeem($("#code-input").value.trim(), true);
});

/** Exchange a 6-digit code (typed) or token (from the Home Screen app's start URL) for this user's key. */
function redeem(code, typed = false) {
  socket.emit("transfer:redeem", { code }, (res) => {
    if (res?.ok) {
      save("key", res.key);
      hello();
    } else {
      if (typed) toast(`⚠️ ${STRINGS.ko.codeInvalid} · ${STRINGS.ja.codeInvalid}`, 5000);
      else hello();
    }
  });
}

function hello() {
  const key = load("key", null);
  const profile = load("profile", null);
  if (!key && pendingToken) {
    const token = pendingToken;
    pendingToken = null;
    return redeem(token);
  }
  if (!key && !profile) return show("setup");
  socket.emit("hello", { key, name: profile?.name, lang: profile?.lang }, (res) => {
    if (res?.needProfile) {
      save("key", null);
      return show("setup");
    }
    if (!res?.ok) return toast("⚠️");
    const reconnect = Boolean(state.me);
    if (res.key) save("key", res.key);
    state.me = res.me;
    state.translator = res.translator;
    save("profile", { name: res.me.name, lang: res.me.lang });
    T = STRINGS[res.me.lang];
    state.rooms = new Map(res.rooms.map((r) => [r.id, r]));
    if (!call) setupCall();
    applyI18n();
    renderMe();
    renderRooms();
    renderAppCard();
    $("#mock-banner").hidden = state.translator !== "mock";
    sendPresence();
    pwa.subscribePush(state.vapid).then(sendSubscription).catch(() => {});
    if (reconnect) setOffline(false);

    if (state.roomId) {
      // Reconnected while a room is open: re-sync it (and keep any ongoing call).
      openRoom(state.roomId, { resync: true });
      call?.recover();
      restartServerStt();
    } else if (pendingJoin) {
      joinByLink();
    } else if (pendingOpen) {
      const id = pendingOpen;
      pendingOpen = null;
      openRoom(id);
    } else {
      show("home");
    }
  });
}

function joinByLink() {
  const code = pendingJoin.toLowerCase();
  pendingJoin = null;
  socket.emit("link:join", { code }, (res) => {
    if (!res?.ok) {
      show("home");
      return toast(res?.error === "full" ? T.linkFull : T.linkExpired, 5000);
    }
    if (res.waiting) show("home");
    else openRoom(res.roomId);
  });
}

socket.on("connect", hello);
socket.on("disconnect", () => {
  if (state.me) setOffline(true);
});

let offlineTimer = null;
function setOffline(on) {
  clearTimeout(offlineTimer);
  document.body.classList.toggle("offline", on);
  // Short blips are common on phones: only say something if it lasts.
  if (on) offlineTimer = setTimeout(() => toast(`📶 ${T.disconnected}`, 60000), 2500);
  else if ($("#toast").textContent.includes(T.disconnected)) toast(`✅ ${T.reconnected}`);
}

function sendPresence() {
  socket.emit("presence", { visible: document.visibilityState === "visible" });
}
document.addEventListener("visibilitychange", () => {
  sendPresence();
  if (document.visibilityState === "visible" && state.roomId) socket.emit("room:read", { roomId: state.roomId });
});

function sendSubscription(sub) {
  if (sub) socket.emit("push:subscribe", { subscription: sub });
}

// Opened from a notification while the app was already running.
navigator.serviceWorker?.addEventListener("message", (e) => {
  if (e.data?.type !== "open") return;
  const id = new URL(e.data.url, location.origin).searchParams.get("open");
  if (id && state.me) openRoom(id);
});

// ---------------------------------------------------------------------------
// Home: my rooms, invite link, app install / notifications, people online
// ---------------------------------------------------------------------------
function renderMe() {
  const chip = $("#me-chip");
  chip.replaceChildren(avatar(state.me), document.createTextNode(state.me.name), langBadge(state.me.lang));
  chip.querySelector(".avatar").style.cssText = "width:28px;height:28px;font-size:13px";
}

function sortedRooms() {
  return [...state.rooms.values()].sort((a, b) => (b.last?.ts ?? 0) - (a.last?.ts ?? 0));
}

function renderRooms() {
  if (!state.me) return;
  const rooms = sortedRooms();
  const paired = rooms.filter((r) => r.partner);
  const waiting = rooms.find((r) => !r.partner);

  $("#rooms-empty").hidden = paired.length > 0;
  $("#room-list").replaceChildren(
    ...paired.map((r) => {
      const li = document.createElement("li");
      li.className = "room-row";
      li.onclick = () => openRoom(r.id);
      const av = avatar(r.partner);
      if (r.partner.online) av.classList.add("online");
      const mid = document.createElement("div");
      mid.className = "room-mid";
      const name = document.createElement("b");
      name.textContent = r.partner.name;
      const last = document.createElement("small");
      last.textContent = r.last ? `${r.last.kind === "caption" ? "🎙️ " : ""}${r.last.text}` : statusText(r.partner);
      mid.append(name, last);
      const side = document.createElement("div");
      side.className = "room-side";
      const when = document.createElement("small");
      when.textContent = r.last ? shortWhen(r.last.ts) : "";
      side.append(when);
      if (r.unread) {
        const badge = document.createElement("span");
        badge.className = "unread";
        badge.textContent = r.unread > 99 ? "99+" : String(r.unread);
        side.append(badge);
      }
      li.append(av, mid, side);
      return li;
    }),
  );

  // The invite link of a room that is still waiting for my friend.
  $("#link-btn").hidden = Boolean(waiting);
  $("#link-box").hidden = !waiting;
  if (waiting) $("#link-url").value = linkUrl(waiting.id);

  pwa.setBadge(paired.reduce((n, r) => n + (r.unread || 0), 0));
}

socket.on("room:summary", (summary) => {
  state.rooms.set(summary.id, summary);
  renderRooms();
  if (summary.id === state.roomId) renderPartner();
});

socket.on("presence", ({ userId, online, lastSeen }) => {
  for (const r of state.rooms.values()) {
    if (r.partner?.id === userId) Object.assign(r.partner, { online, lastSeen });
  }
  renderRooms();
  renderPartner();
});

socket.on("room:joined-by", ({ roomId, user }) => {
  toast(`🎉 ${T.friendJoined(user.name)}`, 5000);
  if (!state.roomId && $("#screen-home").classList.contains("active")) openRoom(roomId);
});

socket.on("room:start", ({ roomId }) => {
  closeModal();
  setMatching(false);
  openRoom(roomId);
});

$("#link-btn").addEventListener("click", () => {
  socket.emit("link:create", { code: load("roomCode", null) }, (res) => {
    if (!res?.ok) return toast("⚠️");
    save("roomCode", null); // legacy single saved code: no longer needed
  });
});
$("#copy-btn").addEventListener("click", async () => {
  await copyText($("#link-url").value);
  toast(T.copied);
});
if (navigator.share) {
  $("#share-btn").hidden = false;
  $("#share-btn").addEventListener("click", () =>
    navigator.share({ title: "KoJa Talk", text: T.shareText, url: $("#link-url").value }).catch(() => {}),
  );
}

// ---- App card: install on the Home Screen, turn on notifications ----------------------------------
let transferCode = null;

function renderAppCard() {
  const card = $("#app-card");
  if (!state.me) return;
  const notif = pwa.notificationState();
  const body = $("#app-card-body");
  const actions = $("#app-card-actions");
  actions.replaceChildren();

  if (pwa.isIOS && !pwa.isStandalone) {
    // iPhone: notifications only work in the Home Screen app, which has its own storage → give it a code.
    card.hidden = false;
    $("#app-card-title").textContent = `📲 ${T.installTitle}`;
    body.innerHTML = "";
    const steps = document.createElement("ol");
    steps.className = "steps";
    for (const s of [T.iosStep1, T.iosStep2, T.iosStep3]) {
      const li = document.createElement("li");
      li.innerHTML = s;
      steps.append(li);
    }
    const code = document.createElement("div");
    code.className = "transfer-code";
    code.textContent = transferCode ?? "······";
    body.append(steps, code);
    if (!transferCode) requestTransferCode();
    return;
  }

  if (notif === "default" && state.vapid) {
    card.hidden = false;
    $("#app-card-title").textContent = `🔔 ${T.notifTitle}`;
    body.textContent = T.notifDesc;
    const b = document.createElement("button");
    b.className = "btn primary";
    b.textContent = T.notifOn;
    b.onclick = async () => {
      const sub = await pwa.subscribePush(state.vapid, { ask: true }).catch(() => null);
      if (sub) {
        sendSubscription(sub);
        toast(`🔔 ${T.notifEnabled}`);
      } else if (pwa.notificationState() === "denied") toast(T.notifDenied, 6000);
      renderAppCard();
    };
    actions.append(b);
    return;
  }

  if (notif === "denied") {
    card.hidden = false;
    $("#app-card-title").textContent = `🔕 ${T.notifTitle}`;
    body.textContent = T.notifDenied;
    return;
  }

  if (pwa.installPrompt && !pwa.isStandalone) {
    card.hidden = false;
    $("#app-card-title").textContent = `📲 ${T.installTitle}`;
    body.textContent = T.installDesc;
    const b = document.createElement("button");
    b.className = "btn primary";
    b.textContent = T.install;
    b.onclick = () => pwa.installPrompt.prompt();
    actions.append(b);
    return;
  }

  card.hidden = true;
}
window.addEventListener("koja:installable", renderAppCard);

function requestTransferCode() {
  const key = load("key", null);
  if (!key) return;
  socket.emit("transfer:create", { key }, (res) => {
    if (!res?.ok) return;
    transferCode = res.code;
    pwa.setManifestToken(res.token);
    renderAppCard();
  });
}

// ---- People online, invites, random matching ----------------------------------------------------
socket.on("users:update", (list) => {
  state.users = list;
  renderUsers();
});

function renderUsers() {
  if (!state.me) return;
  const friends = new Map([...state.rooms.values()].filter((r) => r.partner).map((r) => [r.partner.id, r.id]));
  const others = state.users.filter((u) => u.id !== state.me.id).sort((a, b) => (a.lang === state.me.lang) - (b.lang === state.me.lang));
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
      const roomId = friends.get(u.id);
      const same = u.lang === state.me.lang;
      btn.textContent = roomId ? T.openChat : same ? T.sameLang : T.invite;
      btn.disabled = !roomId && same;
      btn.onclick = () => (roomId ? openRoom(roomId) : sendInvite(u));
      li.append(avatar(u), who, btn);
      return li;
    }),
  );
}

function sendInvite(user) {
  socket.emit("invite:send", { to: user.id }, (res) => {
    if (!res?.ok) return toast(T.partnerBusy);
    openModal("outgoing-invite", T.inviting(user.name), [{ label: T.cancel, onClick: () => socket.emit("invite:cancel") }]);
  });
}

socket.on("invite:received", ({ from }) => {
  if (state.modal) return socket.emit("invite:respond", { from: from.id, accept: false });
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
socket.on("invite:declined", () => {
  closeModal("outgoing-invite");
  toast(T.declined);
});

$("#match-btn").addEventListener("click", () => {
  if (state.matching) return setMatching(false, true);
  setMatching(true);
  socket.emit("match:find", null, (res) => {
    if (!res?.ok || res.matched) setMatching(false);
  });
});

function setMatching(on, notify = false) {
  state.matching = on;
  if (!on && notify) socket.emit("match:cancel");
  $(".match-card").classList.toggle("finding", on);
  $("#match-btn").textContent = on ? `${T.finding} ✕` : T.findPartner;
}

// ---------------------------------------------------------------------------
// Room: chat history + live chat
// ---------------------------------------------------------------------------
function openRoom(roomId, { resync = false } = {}) {
  socket.emit("room:open", { roomId }, (res) => {
    if (!res?.ok) {
      if (state.roomId === roomId) leaveRoomScreen();
      return show("home");
    }
    const switching = state.roomId !== roomId;
    if (switching && call && call.state !== "idle" && call.roomId !== roomId) call.hangup();
    state.roomId = roomId;
    state.rooms.set(roomId, res.room);
    renderRooms();
    renderPartner();
    messageEls.clear();
    $("#messages").replaceChildren();
    for (const m of res.messages) {
      renderEntry(m, m.kind);
      if (m.ok !== null && m.ok !== undefined) applyTranslation({ id: m.id, text: m.translation, ok: m.ok, lang: m.tlang, error: m.error });
    }
    if (!res.messages.length && res.room.partner) systemMessage(T.roomStart(res.room.partner.name));
    if (!res.room.partner) systemMessage(T.alone);
    setRoomEnabled(Boolean(res.room.partner));
    const list = $("#messages");
    list.scrollTop = list.scrollHeight;
    show("room");
    if (!resync && switching && !matchMedia("(pointer: coarse)").matches) $("#msg-input").focus();
  });
}

function leaveRoomScreen() {
  if (call && call.state !== "idle") call.hangup();
  socket.emit("room:close");
  state.roomId = null;
  show("home");
  renderRooms();
  renderUsers();
}

const currentRoom = () => (state.roomId ? state.rooms.get(state.roomId) : null);

function renderPartner() {
  const room = currentRoom();
  if (!room) return;
  const info = $("#partner-info");
  if (!room.partner) {
    info.replaceChildren(document.createTextNode(T.waitingFriend));
    return;
  }
  const p = room.partner;
  const av = avatar(p);
  av.style.cssText = "width:30px;height:30px;font-size:13px";
  if (p.online) av.classList.add("online");
  const text = document.createElement("div");
  text.className = "partner-text";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = p.name;
  const status = document.createElement("small");
  status.className = `status ${p.online ? "on" : ""}`;
  status.textContent = statusText(p);
  text.append(name, status);
  info.replaceChildren(av, text, langBadge(p.lang));
}
setInterval(() => {
  // keep "3분 전 접속" fresh
  if (state.roomId) renderPartner();
}, 60_000);

function setRoomEnabled(on) {
  $("#msg-input").disabled = !on;
  $("#composer button").disabled = !on;
  $("#call-btn").disabled = !on;
  $("#typing").hidden = true;
}

$("#leave-btn").addEventListener("click", leaveRoomScreen);

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
    r.subText.replaceChildren(text);
    r.sub.append(ttsButton(() => text, lang));
  } else {
    r.main.textContent = text;
    r.subText.replaceChildren(original);
    r.sub.append(ttsButton(() => original, r.entry.lang));
  }
  return r;
}

socket.on("chat:message", (msg) => {
  if (msg.roomId !== state.roomId) return;
  renderEntry(msg, "chat");
  if (msg.from !== state.me.id) $("#typing").hidden = true;
});
socket.on("chat:translation", (t) => t.roomId === state.roomId && applyTranslation(t));

let typingSent = false;
let typingTimer;
const sendTyping = (typing) => state.roomId && socket.emit("chat:typing", { roomId: state.roomId, typing });
$("#msg-input").addEventListener("input", (e) => {
  const el = e.target;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  if (!typingSent) {
    sendTyping(true);
    typingSent = true;
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    sendTyping(false);
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
  if (!text || !state.roomId) return;
  socket.emit("chat:send", { roomId: state.roomId, text }, (res) => {
    if (res?.error === "rate_limited") toast("⏳");
    else if (res?.error === "alone") toast(T.alone);
  });
  input.value = "";
  input.style.height = "auto";
  clearTimeout(typingTimer);
  sendTyping(false);
  typingSent = false;
});
socket.on("chat:typing", ({ roomId, typing }) => {
  if (roomId === state.roomId) $("#typing").hidden = !typing;
});

// ---------------------------------------------------------------------------
// Room: voice call + live translated captions
//   - My real voice goes to my partner over WebRTC (no synthetic voice).
//   - My speech becomes text (server STT, or the browser's), the server translates it,
//     and my partner sees it on screen in their language.
// ---------------------------------------------------------------------------
const remoteAudio = $("#remote-audio");
let callTimer = null;
let partnerCapTimer = null;
let myCapTimer = null;
let lastMyCaptionId = null;

function setupCall() {
  call = new Call(socket, getIceServers);

  call.addEventListener("incoming", ({ detail }) => {
    const ring = () => {
      const room = state.rooms.get(detail.roomId);
      const name = room?.partner?.name ?? "";
      openModal("incoming-call", `📞 ${T.incomingCall(name)}`, [
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
    };
    if (state.roomId !== detail.roomId) openRoom(detail.roomId); // the call is for a room that is not on screen
    ring();
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
  call.addEventListener("ringing", ({ detail }) => {
    if (call.state === "outgoing") $("#call-status").textContent = detail.notified ? T.notifiedPartner : T.calling;
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
    if (detail.reason === "declined" || detail.reason === "no_answer") toast(T.callDeclined);
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
  const p = currentRoom()?.partner;
  if (p) {
    av.className = `avatar-big ${p.lang}`;
    av.textContent = [...p.name][0]?.toUpperCase() ?? "?";
    $("#call-name").textContent = p.name;
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
    wakeLock = null;
  }
}
document.addEventListener("visibilitychange", () => {
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

// Captions: prefer server-side recognition (works on phones, uses the echo-cancelled call audio);
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
  if (!state.mic || !call?.roomId) return;
  const stt = !serverSttFailed && call.localStream ? getServerStt() : null;
  if (stt) {
    if (stt.running) return;
    if (await stt.start(call.localStream, call.roomId)) {
      if (!state.mic || $("#stage").hidden) stt.stop();
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
          socket.emit("speech:interim", { roomId: call?.roomId, text });
        }
      },
      onFinal: (text) => {
        showMyCaption(text);
        socket.emit("speech:final", { roomId: call?.roomId, text });
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

/** After a reconnect the server has forgotten our speech stream: open a new one. */
function restartServerStt() {
  if (!serverStt?.running) return;
  serverStt.stop();
  startRecognition();
}

// Partner is speaking: show their words live (original language) until the translation arrives.
socket.on("speech:interim", ({ roomId, text }) => {
  if (roomId !== state.roomId) return;
  $("#cap-partner-interim").textContent = text ? `${text}…` : "";
  $("#stage").classList.toggle("speaking", Boolean(text));
});

socket.on("caption", (cap) => {
  if (cap.roomId !== state.roomId) return;
  renderEntry(cap, "caption");
  if (cap.from === state.me.id) {
    lastMyCaptionId = cap.id;
    showMyCaption(cap.text);
  } else {
    $("#cap-partner-interim").textContent = "";
    $("#stage").classList.remove("speaking");
  }
});

socket.on("caption:translation", (t) => {
  if (t.roomId !== state.roomId) return;
  const r = applyTranslation(t);
  if (!r || !t.ok) return;
  if (r.mine) {
    if (t.id === lastMyCaptionId) showMyCaption(r.entry.text, t.text);
    return;
  }
  setPartnerCaption(t.text, r.entry.text);
  clearTimeout(partnerCapTimer);
  partnerCapTimer = setTimeout(() => setPartnerCaption(""), 12000);
});

$("#call-btn").addEventListener("click", () => {
  if (!state.roomId) return;
  getServerStt()?.prime(); // iOS only allows audio processing to start from a tap
  call?.start(state.roomId).catch(() => toast(T.mediaError));
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

// Hooks for automated tests and debugging.
window.__koja = {
  sendSpeech: (text) => socket.emit("speech:final", { roomId: state.roomId, text }),
  dropConnection: () => socket.io.engine.close(), // simulates a network blip; socket.io reconnects by itself
  setVisible: (visible) => socket.emit("presence", { visible }),
  state,
};
