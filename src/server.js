import express from "express";
import http from "node:http";
import path from "node:path";
import { randomUUID, randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { translate, translatorInfo, LANGS } from "./translator.js";
import { iceServers, turnInfo } from "./ice.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
// How long a user (and their room) survives a dropped connection — e.g. a phone switching networks or a locked screen.
const GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 60_000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 64 * 1024 });

app.use(express.static(path.join(here, "..", "public")));

app.get("/api/config", async (_req, res) => {
  res.json({ translator: translatorInfo.mode, iceServers: await iceServers() });
});
app.get("/healthz", (_req, res) => res.send("ok"));

// ---------------------------------------------------------------------------
// In-memory state (single server instance). Swap for Redis/DB when scaling out.
//
// Users are identified by a public id (shared with other users) and a private client id (cid) that
// only their own browser tab knows. When a socket drops and reconnects, the cid lets the user take
// their place back — same room, same partner — instead of starting over.
// ---------------------------------------------------------------------------
/**
 * @typedef {{id: string, cid: string, name: string, lang: "ko"|"ja", roomId: string|null, matching: boolean,
 *            socketId: string|null, graceTimer: NodeJS.Timeout|null}} User
 */
/** @type {Map<string, User>} public id -> user */
const users = new Map();
/** @type {Map<string, string>} cid -> public id */
const byCid = new Map();
/** @type {Map<string, string>} socket id -> public id */
const bySocket = new Map();
/** @type {Map<string, {id: string, code: string|null, members: string[], history: {speaker: string, text: string}[]}>} */
const rooms = new Map();
/** pending invites: inviterId -> targetId */
const invites = new Map();
/**
 * Room links: code -> id of the user waiting there. A code is permanent (the client keeps it), so the same
 * link works every time: whoever opens it first waits, the second person is connected to them.
 */
const links = new Map();
const LINK_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const isCode = (c) => typeof c === "string" && /^[a-z0-9]{6}$/.test(c);
function newLinkCode() {
  let code;
  do code = Array.from({ length: 6 }, () => LINK_ALPHABET[randomInt(LINK_ALPHABET.length)]).join("");
  while (links.has(code));
  return code;
}
function dropLinksOf(userId) {
  for (const [code, uid] of links) if (uid === userId) links.delete(code);
}
const HISTORY_LINES = 6;

const userRoom = (id) => `u:${id}`;
const toUser = (id) => io.to(userRoom(id));
const toRoom = (room) => io.to(room.members.map(userRoom));
const publicUser = (u) => ({ id: u.id, name: u.name, lang: u.lang, busy: Boolean(u.roomId) });
const other = (lang) => (lang === "ko" ? "ja" : "ko");

function broadcastUsers() {
  const list = [...users.values()].filter((u) => u.socketId).map(publicUser);
  io.to("lobby").emit("users:update", list);
}

function partnerOf(userId) {
  const u = users.get(userId);
  const room = u?.roomId && rooms.get(u.roomId);
  if (!room) return null;
  const pid = room.members.find((m) => m !== userId);
  return pid ? users.get(pid) ?? null : null;
}

function createRoom(aId, bId, code = null) {
  const a = users.get(aId);
  const b = users.get(bId);
  if (!a || !b || a.id === b.id || a.roomId || b.roomId) return null;
  const room = { id: randomUUID(), code, members: [aId, bId], history: [] };
  rooms.set(room.id, room);
  for (const [me, partner] of [[a, b], [b, a]]) {
    me.roomId = room.id;
    me.matching = false;
    invites.delete(me.id);
    dropLinksOf(me.id);
    toUser(me.id).emit("room:joined", { roomId: room.id, code, partner: publicUser(partner) });
  }
  broadcastUsers();
  return room;
}

function leaveRoom(userId, reason = "left") {
  const u = users.get(userId);
  if (!u?.roomId) return;
  const room = rooms.get(u.roomId);
  u.roomId = null;
  if (room) {
    for (const mid of room.members) {
      if (mid === userId) continue;
      const m = users.get(mid);
      if (m) m.roomId = null;
      toUser(mid).emit("room:partner-left", { reason });
    }
    rooms.delete(room.id);
  }
  broadcastUsers();
}

function removeUser(userId) {
  const u = users.get(userId);
  if (!u) return;
  clearTimeout(u.graceTimer);
  leaveRoom(userId, "disconnected");
  const targetId = invites.get(userId);
  if (targetId) toUser(targetId).emit("invite:cancelled", { from: userId });
  invites.delete(userId);
  dropLinksOf(userId);
  users.delete(userId);
  byCid.delete(u.cid);
  broadcastUsers();
}

function tryMatch(userId) {
  const me = users.get(userId);
  if (!me || me.roomId) return false;
  const candidate = [...users.values()].find(
    (u) => u.id !== me.id && u.matching && u.socketId && !u.roomId && u.lang === other(me.lang),
  );
  if (!candidate) return false;
  createRoom(candidate.id, me.id);
  return true;
}

/** Enter a room link: wait there, or connect to whoever is already waiting. */
function enterLink(me, code) {
  if (me.roomId) return { ok: false, error: "busy" };
  const waiter = users.get(links.get(code));
  if (!waiter || waiter.id === me.id) {
    dropLinksOf(me.id);
    links.set(code, me.id);
    return { ok: true, code, waiting: true };
  }
  if (waiter.roomId) return { ok: false, error: "busy" };
  links.delete(code);
  createRoom(waiter.id, me.id, code);
  return { ok: true, code, waiting: false };
}

// Lets the invite page greet the friend ("민수 is waiting") and preselect their language.
app.get("/api/link/:code", (req, res) => {
  const code = String(req.params.code).toLowerCase();
  if (!isCode(code)) return res.status(404).json({ ok: false });
  const host = users.get(links.get(code));
  res.json({ ok: true, host: host ? { name: host.name, lang: host.lang } : null });
});

function remember(room, speaker, text) {
  room.history.push({ speaker, text });
  if (room.history.length > HISTORY_LINES) room.history.shift();
}

// Simple per-user rate limit for translation requests: 20 per 10 seconds.
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
const allow = (userId) => {
  if (!limiters.has(userId)) limiters.set(userId, makeLimiter());
  return limiters.get(userId)();
};

const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

io.on("connection", (socket) => {
  const me = () => users.get(bySocket.get(socket.id));

  socket.on("profile:set", ({ name, lang, cid } = {}, ack) => {
    const nick = clean(name, 24);
    if (!nick || !LANGS[lang]) return ack?.({ ok: false, error: "invalid_profile" });
    const clientId = typeof cid === "string" && /^[\w-]{16,64}$/.test(cid) ? cid : randomUUID();

    let user = users.get(byCid.get(clientId));
    const resumed = Boolean(user);
    if (user) {
      clearTimeout(user.graceTimer);
      user.graceTimer = null;
      // The same tab reconnected on a new socket: the old one (if still around) no longer speaks for this user.
      if (user.socketId && user.socketId !== socket.id) {
        bySocket.delete(user.socketId);
        io.sockets.sockets.get(user.socketId)?.leave(userRoom(user.id));
      }
      user.name = nick;
      user.lang = lang;
    } else {
      user = { id: randomUUID(), cid: clientId, name: nick, lang, roomId: null, matching: false, socketId: null, graceTimer: null };
      users.set(user.id, user);
      byCid.set(clientId, user.id);
    }
    const wasOffline = !user.socketId;
    user.socketId = socket.id;
    bySocket.set(socket.id, user.id);
    socket.join(["lobby", userRoom(user.id)]);

    const partner = partnerOf(user.id);
    if (partner && wasOffline) toUser(partner.id).emit("partner:status", { online: true });
    const room = user.roomId ? rooms.get(user.roomId) : null;
    ack?.({
      ok: true,
      resumed,
      me: publicUser(user),
      translator: translatorInfo.mode,
      room: room && partner ? { roomId: room.id, code: room.code, partner: publicUser(partner) } : null,
      waitingCode: [...links].find(([, uid]) => uid === user.id)?.[0] ?? null,
    });
    broadcastUsers();
  });

  // ---- Invites & random matching -----------------------------------------
  socket.on("invite:send", ({ to } = {}, ack) => {
    const u = me();
    const target = users.get(to);
    if (!u || !target || target.id === u.id || !target.socketId) return ack?.({ ok: false, error: "not_found" });
    if (u.roomId || target.roomId) return ack?.({ ok: false, error: "busy" });
    invites.set(u.id, target.id);
    toUser(target.id).emit("invite:received", { from: publicUser(u) });
    ack?.({ ok: true });
  });

  socket.on("invite:cancel", () => {
    const u = me();
    if (!u) return;
    const targetId = invites.get(u.id);
    invites.delete(u.id);
    if (targetId) toUser(targetId).emit("invite:cancelled", { from: u.id });
  });

  socket.on("invite:respond", ({ from, accept } = {}) => {
    const u = me();
    if (!u || invites.get(from) !== u.id) return;
    invites.delete(from);
    if (accept) {
      if (!createRoom(from, u.id)) toUser(from).emit("invite:declined", { reason: "busy" });
    } else {
      toUser(from).emit("invite:declined", { reason: "declined" });
    }
  });

  socket.on("match:find", (_p, ack) => {
    const u = me();
    if (!u || u.roomId) return ack?.({ ok: false });
    u.matching = true;
    ack?.({ ok: true, matched: tryMatch(u.id) });
  });

  socket.on("match:cancel", () => {
    const u = me();
    if (u) u.matching = false;
  });

  // ---- Room links ------------------------------------------------------------
  // `code` is the client's saved code (so the link stays the same forever); a new one is made if absent.
  socket.on("link:create", ({ code } = {}, ack) => {
    const u = me();
    if (!u) return ack?.({ ok: false });
    const wanted = String(code ?? "").toLowerCase();
    ack?.(enterLink(u, isCode(wanted) ? wanted : newLinkCode()));
  });

  socket.on("link:join", ({ code } = {}, ack) => {
    const u = me();
    const key = String(code ?? "").toLowerCase();
    if (!u) return ack?.({ ok: false, error: "no_profile" });
    if (!isCode(key)) return ack?.({ ok: false, error: "expired" });
    ack?.(enterLink(u, key));
  });

  socket.on("link:cancel", () => {
    const u = me();
    if (u) dropLinksOf(u.id);
  });

  socket.on("room:leave", () => {
    const u = me();
    if (u) leaveRoom(u.id, "left");
  });

  // ---- Chat ----------------------------------------------------------------
  socket.on("chat:send", async ({ text } = {}, ack) => {
    const u = me();
    const partner = u && partnerOf(u.id);
    const body = clean(text, 1000);
    if (!u || !partner || !body) return ack?.({ ok: false });
    if (!allow(u.id)) return ack?.({ ok: false, error: "rate_limited" });

    const room = rooms.get(u.roomId);
    const msg = { id: randomUUID(), from: u.id, name: u.name, lang: u.lang, text: body, ts: Date.now() };
    toRoom(room).emit("chat:message", msg);
    ack?.({ ok: true, id: msg.id });

    const context = [...room.history];
    remember(room, u.name, body);
    const result = await translate(body, u.lang, partner.lang, context);
    toRoom(room).emit("chat:translation", { id: msg.id, lang: partner.lang, ...result });
  });

  socket.on("chat:typing", (typing) => {
    const u = me();
    const partner = u && partnerOf(u.id);
    if (partner) toUser(partner.id).emit("chat:typing", Boolean(typing));
  });

  // ---- Call: live speech captions -------------------------------------------
  socket.on("speech:interim", ({ text } = {}) => {
    const u = me();
    const partner = u && partnerOf(u.id);
    if (partner) toUser(partner.id).emit("speech:interim", { text: clean(text, 300) });
  });

  socket.on("speech:final", async ({ text } = {}) => {
    const u = me();
    const partner = u && partnerOf(u.id);
    const body = clean(text, 500);
    if (!u || !partner || !body) return;
    if (!allow(u.id)) return;

    const room = rooms.get(u.roomId);
    const caption = { id: randomUUID(), from: u.id, name: u.name, lang: u.lang, text: body, ts: Date.now() };
    toRoom(room).emit("caption", caption);

    const context = [...room.history];
    remember(room, u.name, body);
    const result = await translate(body, u.lang, partner.lang, context);
    toRoom(room).emit("caption:translation", { id: caption.id, lang: partner.lang, ...result });
  });

  // ---- Call: signaling (WebRTC media flows peer-to-peer) ---------------------
  const relay = (event) =>
    socket.on(event, (payload = {}) => {
      const u = me();
      const partner = u && partnerOf(u.id);
      if (partner) toUser(partner.id).emit(event, payload);
    });
  ["call:request", "call:accept", "call:decline", "call:cancel", "call:end", "rtc:signal"].forEach(relay);

  socket.on("disconnect", () => {
    const id = bySocket.get(socket.id);
    bySocket.delete(socket.id);
    const u = users.get(id);
    if (!u || u.socketId !== socket.id) return; // already taken over by a newer socket
    u.socketId = null;
    u.matching = false;
    const targetId = invites.get(u.id);
    if (targetId) toUser(targetId).emit("invite:cancelled", { from: u.id });
    invites.delete(u.id);
    const partner = partnerOf(u.id);
    if (partner) toUser(partner.id).emit("partner:status", { online: false });
    broadcastUsers();
    // Keep the seat warm for a while; if they don't come back, clean up for real.
    u.graceTimer = setTimeout(() => {
      limiters.delete(u.id);
      removeUser(u.id);
    }, GRACE_MS);
  });
});

server.listen(PORT, () => {
  const t = translatorInfo.mode === "mock" ? "mock (no API calls)" : `Claude (${translatorInfo.model})`;
  console.log(`Language exchange server on http://localhost:${PORT}  ·  translator: ${t}  ·  ICE: ${turnInfo()}`);
  if (translatorInfo.mode !== "mock" && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn("⚠️  ANTHROPIC_API_KEY is not set — translations will fail. Set it, or run with TRANSLATOR=mock.");
  }
});
