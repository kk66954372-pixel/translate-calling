import express from "express";
import http from "node:http";
import path from "node:path";
import { randomUUID, randomInt, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { translate, translatorInfo, LANGS } from "./translator.js";
import { iceServers, turnInfo } from "./ice.js";
import { openStream, sttInfo, sttEnabled } from "./stt.js";
import { openStore } from "./store.js";
import { initPush, pushTo, vapidPublicKey } from "./push.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const RING_MS = 45_000; // how long a call rings (incl. waiting for a friend to open the app from a notification)
const OFFLINE_DEBOUNCE_MS = 5_000; // short network blips don't flip someone to "offline"

const store = await openStore();
await initPush(store);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 64 * 1024 });

// The service worker must never be served stale, or app updates would not reach installed apps.
app.get("/sw.js", (_req, res, next) => {
  res.set("Cache-Control", "no-cache");
  next();
});
app.use(express.static(path.join(here, "..", "public")));

app.get("/api/config", async (_req, res) => {
  res.json({
    translator: translatorInfo.mode,
    stt: sttEnabled ? sttInfo.mode : null,
    vapidPublicKey: vapidPublicKey(),
    iceServers: await iceServers(),
  });
});
app.get("/healthz", (_req, res) => res.send("ok"));

// Web app manifest. `t` carries a one-time token so the Home Screen app (which on iPhone has its own,
// empty storage) can sign in as the same user it was installed from.
app.get("/manifest.webmanifest", (req, res) => {
  const t = /^[\w-]{16,64}$/.test(String(req.query.t ?? "")) ? `?t=${req.query.t}` : "";
  res.type("application/manifest+json").send(
    JSON.stringify({
      name: "KoJa Talk · 코자톡 · コジャトーク",
      short_name: "KoJa Talk",
      description: "한국어 ↔ 日本語 번역 채팅 & 통화",
      start_url: `/${t}`,
      scope: "/",
      display: "standalone",
      background_color: "#f6f4f1",
      theme_color: "#2f5bea",
      icons: [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
        { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    }),
  );
});

// ---------------------------------------------------------------------------
// State. Users, rooms and messages live in the store (database). What follows is only who is connected.
// ---------------------------------------------------------------------------
/** @type {Map<string, {userId: string, roomId: string|null, visible: boolean}>} socket id -> session */
const sessions = new Map();
/** @type {Map<string, Set<string>>} user id -> socket ids */
const online = new Map();
/** @type {Map<string, {id: string, name: string, lang: "ko"|"ja"}>} */
const profiles = new Map();
const lastSeen = new Map();
const offlineTimers = new Map();
const invites = new Map(); // inviterId -> targetId
const matching = new Set(); // user ids looking for a random partner
/** @type {Map<string, {roomId: string, from: string, to: string, timer: NodeJS.Timeout, delivered: Set<string>}>} */
const pendingCalls = new Map(); // roomId -> ringing call
const roomCache = new Map(); // roomId -> {id, members}

const LINK_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const isCode = (c) => typeof c === "string" && /^[a-z0-9]{6}$/.test(c);
const newCode = () => Array.from({ length: 6 }, () => LINK_ALPHABET[randomInt(LINK_ALPHABET.length)]).join("");
const userRoom = (id) => `u:${id}`;
const toUser = (id) => io.to(userRoom(id));
const toMembers = (room) => io.to(room.members.map(userRoom));
const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

const isOnline = (uid) => (online.get(uid)?.size ?? 0) > 0;
const userSessions = (uid) => [...(online.get(uid) ?? [])].map((sid) => sessions.get(sid)).filter(Boolean);
const isVisible = (uid) => userSessions(uid).some((s) => s.visible);
const isViewing = (uid, roomId) => userSessions(uid).some((s) => s.visible && s.roomId === roomId);
const presenceOf = (uid) => ({ online: isOnline(uid), lastSeen: lastSeen.get(uid) ?? null });

const PUSH_TEXT = {
  ko: { incoming: "전화가 왔어요 · 눌러서 받기", missed: "부재중 전화", joined: (n) => `${n}님이 대화방에 들어왔어요` },
  ja: { incoming: "着信中 · タップして応答", missed: "不在着信", joined: (n) => `${n}さんがルームに入りました` },
};

async function getProfile(uid) {
  if (!profiles.has(uid)) {
    const u = await store.getUser(uid);
    if (u) profiles.set(uid, u);
  }
  return profiles.get(uid) ?? null;
}

async function getRoom(id) {
  if (!roomCache.has(id)) {
    const r = await store.getRoom(id);
    if (!r) return null;
    roomCache.set(id, r);
  }
  return roomCache.get(id);
}
async function memberRoom(uid, roomId) {
  if (!uid || typeof roomId !== "string") return null;
  const r = await getRoom(roomId);
  return r?.members.includes(uid) ? r : null;
}
const partnerIdOf = (room, uid) => room.members.find((m) => m !== uid) ?? null;

async function createRoom(memberIds, code = null) {
  for (let i = 0; i < 10; i++) {
    const r = await store.createRoom(code ?? newCode(), memberIds);
    if (r) {
      roomCache.set(r.id, r);
      return r;
    }
    if (code) return null; // that code is taken
  }
  throw new Error("could not create a room");
}

async function findOrCreatePairRoom(a, b) {
  const existing = (await store.roomsOf(a)).find((r) => r.members.length === 2 && r.members.includes(b));
  return existing ?? createRoom([a, b]);
}

async function roomSummary(room, uid) {
  const pid = partnerIdOf(room, uid);
  const partner = pid ? await getProfile(pid) : null;
  const [last] = await store.recentMessages(room.id, 1);
  return {
    id: room.id,
    partner: partner ? { ...partner, ...presenceOf(pid) } : null,
    last: last ? { text: last.from === uid ? last.text : last.translation || last.text, ts: last.ts, mine: last.from === uid, kind: last.kind } : null,
    unread: await store.unread(room.id, uid),
  };
}
async function sendSummaries(room) {
  await Promise.all(room.members.map(async (m) => toUser(m).emit("room:summary", await roomSummary(room, m))));
}

const publicUser = (p) => ({ id: p.id, name: p.name, lang: p.lang, busy: false });
function broadcastUsers() {
  const list = [...online.keys()].map((uid) => profiles.get(uid)).filter(Boolean).map(publicUser);
  io.to("lobby").emit("users:update", list);
}

async function notifyPresence(uid) {
  const rooms = await store.roomsOf(uid).catch(() => []);
  for (const r of rooms) {
    const pid = partnerIdOf(r, uid);
    if (pid) toUser(pid).emit("presence", { userId: uid, ...presenceOf(uid) });
  }
}

// ---- Calls that ring while the friend is away --------------------------------------------------------
function deliverPendingCalls(uid, socket) {
  const s = sessions.get(socket.id);
  if (!s?.visible) return;
  for (const call of pendingCalls.values()) {
    if (call.to !== uid || call.delivered.has(socket.id)) continue;
    call.delivered.add(socket.id);
    socket.emit("call:request", { roomId: call.roomId, from: call.from });
  }
}

function clearPendingCall(roomId) {
  const call = pendingCalls.get(roomId);
  if (call) clearTimeout(call.timer);
  pendingCalls.delete(roomId);
  return call;
}

async function pushMissedCall(call) {
  const caller = await getProfile(call.from);
  const callee = await getProfile(call.to);
  if (!caller || !callee || isVisible(call.to)) return;
  await pushTo(call.to, {
    kind: "missed",
    title: `📞 ${caller.name}`,
    body: PUSH_TEXT[callee.lang].missed,
    tag: `call-${call.roomId}`,
    url: `/?open=${call.roomId}`,
  });
}

// ---- Translation pipeline (chat messages and call captions) ---------------------------------------
function makeLimiter(limit = 20, windowMs = 10_000) {
  let stamps = [];
  return () => {
    const now = Date.now();
    stamps = stamps.filter((t) => now - t < windowMs);
    if (stamps.length >= limit) return false;
    stamps.push(now);
    return true;
  };
}
const limiters = new Map();
const allow = (uid) => {
  if (!limiters.has(uid)) limiters.set(uid, makeLimiter());
  return limiters.get(uid)();
};

async function postMessage(uid, roomId, text, kind) {
  const room = await memberRoom(uid, roomId);
  const me = await getProfile(uid);
  const pid = room && partnerIdOf(room, uid);
  const partner = pid && (await getProfile(pid));
  const body = clean(text, kind === "chat" ? 1000 : 500);
  if (!room || !me || !partner || !body) return { ok: false, error: partner ? "invalid" : "alone" };
  if (!allow(uid)) return { ok: false, error: "rate_limited" };

  const context = (await store.recentMessages(room.id, 6)).map((m) => ({ speaker: m.name, text: m.text }));
  const msg = { id: randomUUID(), roomId: room.id, from: uid, name: me.name, lang: me.lang, kind, text: body, ts: Date.now() };
  await store.addMessage(msg);
  toMembers(room).emit(kind === "chat" ? "chat:message" : "caption", msg);
  if (isViewing(pid, room.id)) await store.setLastRead(room.id, pid, msg.ts);

  (async () => {
    const result = await translate(body, me.lang, partner.lang, context);
    await store.updateMessage(room.id, msg.id, { translation: result.text, tlang: partner.lang, ok: result.ok, error: result.error });
    toMembers(room).emit(kind === "chat" ? "chat:translation" : "caption:translation", { roomId: room.id, id: msg.id, lang: partner.lang, ...result });
    if (kind !== "chat") return;
    await sendSummaries(room);
    if (!isViewing(pid, room.id)) {
      await pushTo(pid, {
        kind: "message",
        title: me.name,
        body: result.ok && result.text ? `${result.text}\n${body}` : body,
        tag: `msg-${room.id}`,
        url: `/?open=${room.id}`,
      });
    }
  })().catch((e) => console.error("[message] translate/notify failed:", e.message));

  return { ok: true, id: msg.id };
}

// ---------------------------------------------------------------------------
// Invite page: greet the friend by the host's name and preselect their language.
// ---------------------------------------------------------------------------
app.get("/api/link/:code", async (req, res) => {
  const code = String(req.params.code).toLowerCase();
  if (!isCode(code)) return res.status(404).json({ ok: false });
  const room = await getRoom(code).catch(() => null);
  const host = room ? await getProfile(room.members[0]) : null;
  res.json({ ok: true, host: host ? { name: host.name, lang: host.lang } : null, full: (room?.members.length ?? 0) >= 2 });
});

io.on("connection", (socket) => {
  const uid = () => sessions.get(socket.id)?.userId ?? null;
  const safe = (fn) => async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      console.error("[socket] handler failed:", e.message);
      const ack = args.find((a) => typeof a === "function");
      ack?.({ ok: false, error: "server" });
    }
  };

  function attach(user) {
    const prev = sessions.get(socket.id);
    sessions.set(socket.id, { userId: user.id, roomId: prev?.roomId ?? null, visible: prev?.visible ?? true });
    profiles.set(user.id, user);
    clearTimeout(offlineTimers.get(user.id));
    offlineTimers.delete(user.id);
    const wasOnline = isOnline(user.id);
    if (!online.has(user.id)) online.set(user.id, new Set());
    online.get(user.id).add(socket.id);
    socket.join(["lobby", userRoom(user.id)]);
    if (!wasOnline) notifyPresence(user.id);
  }

  // ---- Identity ----------------------------------------------------------------
  // The browser keeps a secret key (localStorage); the server only stores its hash.
  socket.on(
    "hello",
    safe(async ({ key, name, lang } = {}, ack) => {
      const nick = clean(name, 24);
      let user = typeof key === "string" && key.length >= 16 ? await store.userByKey(key) : null;
      let issuedKey = null;
      if (!user) {
        if (!nick || !LANGS[lang]) return ack?.({ ok: false, needProfile: true });
        ({ user, key: issuedKey } = await store.createUser({ name: nick, lang }));
      } else if (nick && LANGS[lang] && (nick !== user.name || lang !== user.lang)) {
        await store.updateUser(user.id, { name: nick, lang });
        user = { ...user, name: nick, lang };
      }
      attach(user);
      const rooms = await store.roomsOf(user.id);
      ack?.({
        ok: true,
        me: user,
        key: issuedKey,
        rooms: await Promise.all(rooms.map((r) => roomSummary(r, user.id))),
        translator: translatorInfo.mode,
      });
      broadcastUsers();
      deliverPendingCalls(user.id, socket);
    }),
  );

  socket.on("presence", ({ visible } = {}) => {
    const s = sessions.get(socket.id);
    if (!s) return;
    s.visible = Boolean(visible);
    if (s.visible) deliverPendingCalls(s.userId, socket);
  });

  // Move the identity to the Home Screen app (separate storage on iPhone): a 6-digit code to type in,
  // or a long token placed in the manifest's start_url.
  socket.on(
    "transfer:create",
    safe(async ({ key } = {}, ack) => {
      const me = uid();
      const user = typeof key === "string" ? await store.userByKey(key) : null;
      if (!me || user?.id !== me) return ack?.({ ok: false });
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const token = randomBytes(18).toString("base64url");
      const value = JSON.stringify({ key, expires: Date.now() + 24 * 3600_000 });
      await store.setSetting(`transfer:${code}`, value);
      await store.setSetting(`transfer:${token}`, value);
      ack?.({ ok: true, code, token });
    }),
  );
  let redeemTries = 0;
  socket.on(
    "transfer:redeem",
    safe(async ({ code } = {}, ack) => {
      if (++redeemTries > 8) return ack?.({ ok: false, error: "too_many" });
      const id = String(code ?? "").trim();
      if (!/^(\d{6}|[\w-]{16,64})$/.test(id)) return ack?.({ ok: false, error: "invalid" });
      const raw = await store.getSetting(`transfer:${id}`);
      const data = raw ? JSON.parse(raw) : null;
      if (!data?.key || data.expires < Date.now()) return ack?.({ ok: false, error: "invalid" });
      if (/^\d{6}$/.test(id)) await store.setSetting(`transfer:${id}`, "{}"); // short codes are single-use
      ack?.({ ok: true, key: data.key });
    }),
  );

  socket.on(
    "push:subscribe",
    safe(async ({ subscription } = {}, ack) => {
      const me = uid();
      if (!me || typeof subscription?.endpoint !== "string" || !/^https:\/\//.test(subscription.endpoint)) return ack?.({ ok: false });
      await store.saveSubscription(me, { endpoint: subscription.endpoint, keys: subscription.keys ?? {} });
      ack?.({ ok: true });
    }),
  );

  // ---- Rooms -----------------------------------------------------------------------
  socket.on(
    "room:open",
    safe(async ({ roomId } = {}, ack) => {
      const me = uid();
      const room = await memberRoom(me, roomId);
      if (!room) return ack?.({ ok: false, error: "not_found" });
      sessions.get(socket.id).roomId = room.id;
      await store.setLastRead(room.id, me, Date.now());
      const messages = await store.recentMessages(room.id, 100);
      ack?.({ ok: true, room: await roomSummary(room, me), messages });
      toUser(me).emit("room:summary", await roomSummary(room, me)); // clears the unread badge on other devices too
      deliverPendingCalls(me, socket);
    }),
  );

  socket.on("room:close", () => {
    const s = sessions.get(socket.id);
    if (s) s.roomId = null;
  });

  socket.on(
    "room:read",
    safe(async ({ roomId } = {}) => {
      const me = uid();
      if (await memberRoom(me, roomId)) await store.setLastRead(roomId, me, Date.now());
    }),
  );

  // A new room link (one per friend). Reuses my room that is still waiting for someone, if any.
  socket.on(
    "link:create",
    safe(async ({ code } = {}, ack) => {
      const me = uid();
      if (!me) return ack?.({ ok: false });
      const wanted = String(code ?? "").toLowerCase();
      if (isCode(wanted)) {
        const room = (await getRoom(wanted)) ?? (await createRoom([me], wanted));
        if (room?.members.includes(me)) return ack?.({ ok: true, roomId: room.id });
      }
      const waiting = (await store.roomsOf(me)).find((r) => r.members.length === 1);
      const room = waiting ?? (await createRoom([me]));
      toUser(me).emit("room:summary", await roomSummary(room, me));
      ack?.({ ok: true, roomId: room.id });
    }),
  );

  socket.on(
    "link:join",
    safe(async ({ code } = {}, ack) => {
      const me = uid();
      const key = String(code ?? "").toLowerCase();
      if (!me) return ack?.({ ok: false, error: "no_profile" });
      if (!isCode(key)) return ack?.({ ok: false, error: "expired" });
      let room = await getRoom(key);
      if (!room) {
        // Unknown code (e.g. the data was reset): whoever opens it first owns it, like a fresh link.
        room = await createRoom([me], key);
        toUser(me).emit("room:summary", await roomSummary(room, me));
        return ack?.({ ok: true, roomId: room.id, waiting: true });
      }
      if (room.members.includes(me)) return ack?.({ ok: true, roomId: room.id, waiting: room.members.length < 2 });
      if (room.members.length >= 2) return ack?.({ ok: false, error: "full" });
      await store.addMember(room.id, me);
      room.members.push(me);
      await sendSummaries(room);
      const host = room.members[0];
      const meProfile = await getProfile(me);
      const hostProfile = await getProfile(host);
      toUser(host).emit("room:joined-by", { roomId: room.id, user: publicUser(meProfile) });
      if (hostProfile && !isVisible(host)) {
        pushTo(host, { kind: "joined", title: "KoJa Talk", body: PUSH_TEXT[hostProfile.lang].joined(meProfile.name), tag: `room-${room.id}`, url: `/?open=${room.id}` });
      }
      ack?.({ ok: true, roomId: room.id, waiting: false });
    }),
  );

  // ---- Lobby: invites & random matching (they create a lasting room too) -------------------------
  async function startPair(a, b) {
    const room = await findOrCreatePairRoom(a, b);
    invites.delete(a);
    invites.delete(b);
    matching.delete(a);
    matching.delete(b);
    await sendSummaries(room);
    toUser(a).emit("room:start", { roomId: room.id });
    toUser(b).emit("room:start", { roomId: room.id });
  }

  socket.on("invite:send", ({ to } = {}, ack) => {
    const me = uid();
    const target = profiles.get(to);
    if (!me || !target || to === me || !isOnline(to)) return ack?.({ ok: false, error: "not_found" });
    invites.set(me, to);
    toUser(to).emit("invite:received", { from: publicUser(profiles.get(me)) });
    ack?.({ ok: true });
  });
  socket.on("invite:cancel", () => {
    const me = uid();
    const to = invites.get(me);
    invites.delete(me);
    if (to) toUser(to).emit("invite:cancelled", { from: me });
  });
  socket.on(
    "invite:respond",
    safe(async ({ from, accept } = {}) => {
      const me = uid();
      if (!me || invites.get(from) !== me) return;
      invites.delete(from);
      if (accept) await startPair(from, me);
      else toUser(from).emit("invite:declined", { reason: "declined" });
    }),
  );

  socket.on(
    "match:find",
    safe(async (_p, ack) => {
      const me = uid();
      const mine = profiles.get(me);
      if (!mine) return ack?.({ ok: false });
      const other = [...matching].find((u) => u !== me && isOnline(u) && profiles.get(u)?.lang !== mine.lang);
      if (!other) {
        matching.add(me);
        return ack?.({ ok: true, matched: false });
      }
      ack?.({ ok: true, matched: true });
      await startPair(other, me);
    }),
  );
  socket.on("match:cancel", () => matching.delete(uid()));

  // ---- Chat ----------------------------------------------------------------------------
  socket.on("chat:send", safe(async ({ roomId, text } = {}, ack) => ack?.(await postMessage(uid(), roomId, text, "chat"))));

  socket.on(
    "chat:typing",
    safe(async ({ roomId, typing } = {}) => {
      const me = uid();
      const room = await memberRoom(me, roomId);
      const pid = room && partnerIdOf(room, me);
      if (pid) toUser(pid).emit("chat:typing", { roomId, typing: Boolean(typing) });
    }),
  );

  // ---- Call captions -----------------------------------------------------------------------
  // Text comes from the browser's own speech recognition (speech:*) or from server-side STT (stt:*).
  async function speechInterim(me, roomId, text) {
    const room = await memberRoom(me, roomId);
    const pid = room && partnerIdOf(room, me);
    if (pid) toUser(pid).emit("speech:interim", { roomId, text: clean(text, 300) });
  }
  socket.on("speech:interim", safe(({ roomId, text } = {}) => speechInterim(uid(), roomId, text)));
  socket.on("speech:final", safe(({ roomId, text } = {}) => postMessage(uid(), roomId, text, "caption")));

  let stt = null;
  const stopStt = () => {
    stt?.close();
    stt = null;
  };
  socket.on(
    "stt:start",
    safe(async ({ roomId } = {}, ack) => {
      const me = uid();
      const room = await memberRoom(me, roomId);
      if (!room || !partnerIdOf(room, me)) return ack?.({ ok: false, error: "no_room" });
      stopStt();
      stt = openStream({
        lang: profiles.get(me).lang,
        onInterim: (text) => {
          socket.emit("stt:interim", { text });
          speechInterim(me, room.id, text).catch(() => {});
        },
        onFinal: (text) => postMessage(me, room.id, text, "caption").catch((e) => console.error("[stt] caption failed:", e.message)),
        onError: (error) => {
          stt = null;
          socket.emit("stt:error", { error });
        },
      });
      ack?.(stt ? { ok: true } : { ok: false, error: "unavailable" });
    }),
  );
  socket.on("stt:audio", (chunk) => {
    if (stt && Buffer.isBuffer(chunk) && chunk.length <= 16_000) stt.write(chunk);
  });
  socket.on("stt:stop", stopStt);

  // ---- Call signaling (WebRTC media flows peer-to-peer) ---------------------------------------
  for (const event of ["call:request", "call:accept", "call:decline", "call:cancel", "call:end", "rtc:signal"]) {
    socket.on(
      event,
      safe(async (payload = {}) => {
        const me = uid();
        const room = await memberRoom(me, payload.roomId);
        const pid = room && partnerIdOf(room, me);
        if (!pid) return;
        const out = { ...payload, roomId: room.id, from: me };

        if (event === "call:request") {
          clearPendingCall(room.id);
          const call = {
            roomId: room.id,
            from: me,
            to: pid,
            delivered: new Set(),
            timer: setTimeout(() => {
              pendingCalls.delete(room.id);
              toUser(me).emit("call:no-answer", { roomId: room.id });
              toUser(pid).emit("call:cancel", { roomId: room.id, from: me });
              pushMissedCall(call).catch(() => {});
            }, RING_MS),
          };
          pendingCalls.set(room.id, call);
          for (const sid of online.get(pid) ?? []) {
            if (sessions.get(sid)?.visible) {
              call.delivered.add(sid);
              io.to(sid).emit("call:request", out);
            }
          }
          if (!isVisible(pid)) {
            const caller = profiles.get(me);
            const callee = await getProfile(pid);
            const sent = await pushTo(pid, {
              kind: "call",
              title: `📞 ${caller.name}`,
              body: PUSH_TEXT[callee?.lang ?? "ko"].incoming,
              tag: `call-${room.id}`,
              url: `/?open=${room.id}&call=1`,
              ttl: Math.ceil(RING_MS / 1000),
            });
            socket.emit("call:ringing", { roomId: room.id, notified: sent > 0 });
          }
          return;
        }

        if (event === "call:cancel") {
          const call = clearPendingCall(room.id);
          if (call) pushMissedCall(call).catch(() => {});
        } else if (event !== "rtc:signal") {
          clearPendingCall(room.id);
        }
        toUser(pid).emit(event, out);
        // Answered or declined on one device: stop it ringing on my other devices.
        if (event === "call:accept" || event === "call:decline") socket.to(userRoom(me)).emit("call:cancel", { roomId: room.id, from: pid });
      }),
    );
  }

  socket.on("disconnect", () => {
    stopStt();
    const me = uid();
    sessions.delete(socket.id);
    if (!me) return;
    const set = online.get(me);
    set?.delete(socket.id);
    if (set?.size) return;
    online.delete(me);
    matching.delete(me);
    const to = invites.get(me);
    if (to) toUser(to).emit("invite:cancelled", { from: me });
    invites.delete(me);
    broadcastUsers();
    offlineTimers.set(
      me,
      setTimeout(() => {
        offlineTimers.delete(me);
        if (isOnline(me)) return;
        lastSeen.set(me, Date.now());
        notifyPresence(me);
      }, OFFLINE_DEBOUNCE_MS),
    );
  });
});

server.listen(PORT, () => {
  const t = translatorInfo.mode === "mock" ? "mock (no API calls)" : `Claude (${translatorInfo.model})`;
  const s = sttEnabled ? `${sttInfo.mode}${sttInfo.mode === "deepgram" ? ` (${sttInfo.model})` : ""}` : "browser only (set DEEPGRAM_API_KEY for phones)";
  console.log(`Language exchange server on http://localhost:${PORT}`);
  console.log(`  translator: ${t}  ·  speech-to-text: ${s}  ·  ICE: ${turnInfo()}`);
  console.log(`  storage: ${store.kind === "postgres" ? "Postgres (DATABASE_URL)" : "memory — data is lost on restart (set DATABASE_URL)"}`);
  if (translatorInfo.mode !== "mock" && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn("⚠️  ANTHROPIC_API_KEY is not set — translations will fail. Set it, or run with TRANSLATOR=mock.");
  }
  // One-off translation model comparison (results go to the log). Turn the variable off afterwards.
  if (process.env.TRANSLATION_COMPARE === "1") {
    import("./compare.js").then((m) => m.runCompare()).catch((e) => console.error("[compare] failed:", e.message));
  }
});
