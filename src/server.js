import express from "express";
import http from "node:http";
import path from "node:path";
import { randomUUID, randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { translate, translatorInfo, LANGS } from "./translator.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 64 * 1024 });

app.use(express.static(path.join(here, "..", "public")));

function iceServers() {
  if (process.env.ICE_SERVERS) {
    try {
      return JSON.parse(process.env.ICE_SERVERS);
    } catch {
      console.warn("ICE_SERVERS is not valid JSON; using the default STUN server");
    }
  }
  return [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
}

app.get("/api/config", (_req, res) => {
  res.json({ translator: translatorInfo.mode, iceServers: iceServers() });
});
app.get("/healthz", (_req, res) => res.send("ok"));

// Lets the invite page greet the friend ("민수 invited you") and preselect their language.
app.get("/api/link/:code", (req, res) => {
  const host = users.get(links.get(String(req.params.code).toLowerCase()));
  if (!host) return res.status(404).json({ ok: false });
  res.json({ ok: true, host: { name: host.name, lang: host.lang } });
});

// ---------------------------------------------------------------------------
// In-memory state (single server instance). Swap for Redis/DB when scaling out.
// ---------------------------------------------------------------------------
/** @type {Map<string, {id: string, name: string, lang: "ko"|"ja", roomId: string|null, matching: boolean}>} */
const users = new Map();
/** @type {Map<string, {id: string, members: string[], history: {speaker: string, text: string}[]}>} */
const rooms = new Map();
/** pending invites: inviterId -> targetId */
const invites = new Map();
/** invite links: code -> hostId (a friend who opens /?room=CODE joins the host directly) */
const links = new Map();
const LINK_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
function newLinkCode() {
  let code;
  do code = Array.from({ length: 6 }, () => LINK_ALPHABET[randomInt(LINK_ALPHABET.length)]).join("");
  while (links.has(code));
  return code;
}
function dropLinksOf(hostId) {
  for (const [code, host] of links) if (host === hostId) links.delete(code);
}
const HISTORY_LINES = 6;

const publicUser = (u) => ({ id: u.id, name: u.name, lang: u.lang, busy: Boolean(u.roomId) });
const other = (lang) => (lang === "ko" ? "ja" : "ko");

function broadcastUsers() {
  const list = [...users.values()].map(publicUser);
  io.to("lobby").emit("users:update", list);
}

function partnerOf(socketId) {
  const u = users.get(socketId);
  if (!u?.roomId) return null;
  const room = rooms.get(u.roomId);
  if (!room) return null;
  const pid = room.members.find((m) => m !== socketId);
  return pid ? users.get(pid) ?? null : null;
}

function createRoom(aId, bId) {
  const a = users.get(aId);
  const b = users.get(bId);
  if (!a || !b || a.roomId || b.roomId) return null;
  const room = { id: randomUUID(), members: [aId, bId], history: [] };
  rooms.set(room.id, room);
  for (const [me, partner] of [[a, b], [b, a]]) {
    me.roomId = room.id;
    me.matching = false;
    invites.delete(me.id);
    const s = io.sockets.sockets.get(me.id);
    s?.join(room.id);
    s?.emit("room:joined", { roomId: room.id, partner: publicUser(partner) });
  }
  broadcastUsers();
  return room;
}

function leaveRoom(socketId, reason = "left") {
  const u = users.get(socketId);
  if (!u?.roomId) return;
  const room = rooms.get(u.roomId);
  u.roomId = null;
  io.sockets.sockets.get(socketId)?.leave(room?.id ?? "");
  if (room) {
    for (const mid of room.members) {
      if (mid === socketId) continue;
      const m = users.get(mid);
      if (m) m.roomId = null;
      const s = io.sockets.sockets.get(mid);
      s?.leave(room.id);
      s?.emit("room:partner-left", { reason });
    }
    rooms.delete(room.id);
  }
  broadcastUsers();
}

function tryMatch(socketId) {
  const me = users.get(socketId);
  if (!me || me.roomId) return false;
  const candidate = [...users.values()].find(
    (u) => u.id !== me.id && u.matching && !u.roomId && u.lang === other(me.lang),
  );
  if (!candidate) return false;
  createRoom(candidate.id, me.id);
  return true;
}

function remember(room, speaker, text) {
  room.history.push({ speaker, text });
  if (room.history.length > HISTORY_LINES) room.history.shift();
}

// Simple per-socket rate limit for translation requests: 20 per 10 seconds.
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

const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

io.on("connection", (socket) => {
  const allow = makeLimiter();

  socket.on("profile:set", ({ name, lang } = {}, ack) => {
    const nick = clean(name, 24);
    if (!nick || !LANGS[lang]) return ack?.({ ok: false, error: "invalid_profile" });
    const existing = users.get(socket.id);
    const user = { id: socket.id, name: nick, lang, roomId: existing?.roomId ?? null, matching: false };
    users.set(socket.id, user);
    socket.join("lobby");
    ack?.({ ok: true, me: publicUser(user), translator: translatorInfo.mode });
    broadcastUsers();
  });

  // ---- Invites & random matching -----------------------------------------
  socket.on("invite:send", ({ to } = {}, ack) => {
    const me = users.get(socket.id);
    const target = users.get(to);
    if (!me || !target || target.id === me.id) return ack?.({ ok: false, error: "not_found" });
    if (me.roomId || target.roomId) return ack?.({ ok: false, error: "busy" });
    invites.set(me.id, target.id);
    io.to(target.id).emit("invite:received", { from: publicUser(me) });
    ack?.({ ok: true });
  });

  socket.on("invite:cancel", () => {
    const targetId = invites.get(socket.id);
    invites.delete(socket.id);
    if (targetId) io.to(targetId).emit("invite:cancelled", { from: socket.id });
  });

  socket.on("invite:respond", ({ from, accept } = {}) => {
    if (invites.get(from) !== socket.id) return;
    invites.delete(from);
    if (accept) {
      if (!createRoom(from, socket.id)) io.to(from).emit("invite:declined", { reason: "busy" });
    } else {
      io.to(from).emit("invite:declined", { reason: "declined" });
    }
  });

  socket.on("match:find", (_p, ack) => {
    const me = users.get(socket.id);
    if (!me || me.roomId) return ack?.({ ok: false });
    me.matching = true;
    const matched = tryMatch(socket.id);
    ack?.({ ok: true, matched });
  });

  socket.on("match:cancel", () => {
    const me = users.get(socket.id);
    if (me) me.matching = false;
  });

  // ---- Invite links ---------------------------------------------------------
  socket.on("link:create", ({ code: wanted } = {}, ack) => {
    const me = users.get(socket.id);
    if (!me) return ack?.({ ok: false });
    let code = [...links].find(([, host]) => host === me.id)?.[0];
    if (!code) {
      // After a reconnect the host asks for their previous code back, so the link they already sent keeps working.
      const reuse = typeof wanted === "string" && /^[a-z0-9]{6}$/.test(wanted) && !links.has(wanted);
      code = reuse ? wanted : newLinkCode();
      links.set(code, me.id);
    }
    ack?.({ ok: true, code });
  });

  socket.on("link:cancel", () => dropLinksOf(socket.id));

  socket.on("link:join", ({ code } = {}, ack) => {
    const me = users.get(socket.id);
    const key = String(code ?? "").toLowerCase();
    const hostId = links.get(key);
    const host = users.get(hostId);
    if (!me) return ack?.({ ok: false, error: "no_profile" });
    if (!host) return ack?.({ ok: false, error: "expired" });
    if (host.id === me.id) return ack?.({ ok: false, error: "self" });
    if (host.roomId || me.roomId) return ack?.({ ok: false, error: "busy" });
    links.delete(key);
    createRoom(host.id, me.id);
    ack?.({ ok: true });
  });

  socket.on("room:leave", () => leaveRoom(socket.id, "left"));

  // ---- Chat ----------------------------------------------------------------
  socket.on("chat:send", async ({ text } = {}, ack) => {
    const me = users.get(socket.id);
    const partner = partnerOf(socket.id);
    const body = clean(text, 1000);
    if (!me || !partner || !body) return ack?.({ ok: false });
    if (!allow()) return ack?.({ ok: false, error: "rate_limited" });

    const room = rooms.get(me.roomId);
    const msg = { id: randomUUID(), from: me.id, name: me.name, lang: me.lang, text: body, ts: Date.now() };
    io.to(room.id).emit("chat:message", msg);
    ack?.({ ok: true, id: msg.id });

    const context = [...room.history];
    remember(room, me.name, body);
    const result = await translate(body, me.lang, partner.lang, context);
    io.to(room.id).emit("chat:translation", { id: msg.id, lang: partner.lang, ...result });
  });

  socket.on("chat:typing", (typing) => {
    const partner = partnerOf(socket.id);
    if (partner) io.to(partner.id).emit("chat:typing", Boolean(typing));
  });

  // ---- Call: live speech captions -------------------------------------------
  socket.on("speech:interim", ({ text } = {}) => {
    const partner = partnerOf(socket.id);
    if (partner) io.to(partner.id).emit("speech:interim", { text: clean(text, 300) });
  });

  socket.on("speech:final", async ({ text } = {}) => {
    const me = users.get(socket.id);
    const partner = partnerOf(socket.id);
    const body = clean(text, 500);
    if (!me || !partner || !body) return;
    if (!allow()) return;

    const room = rooms.get(me.roomId);
    const caption = { id: randomUUID(), from: me.id, name: me.name, lang: me.lang, text: body, ts: Date.now() };
    io.to(room.id).emit("caption", caption);

    const context = [...room.history];
    remember(room, me.name, body);
    const result = await translate(body, me.lang, partner.lang, context);
    io.to(room.id).emit("caption:translation", { id: caption.id, lang: partner.lang, ...result });
  });

  // ---- Call: signaling (WebRTC media flows peer-to-peer) ---------------------
  const relay = (event) =>
    socket.on(event, (payload = {}) => {
      const partner = partnerOf(socket.id);
      if (partner) io.to(partner.id).emit(event, payload);
    });
  ["call:request", "call:accept", "call:decline", "call:cancel", "call:end", "rtc:signal"].forEach(relay);

  socket.on("disconnect", () => {
    leaveRoom(socket.id, "disconnected");
    const targetId = invites.get(socket.id);
    if (targetId) io.to(targetId).emit("invite:cancelled", { from: socket.id });
    invites.delete(socket.id);
    dropLinksOf(socket.id);
    users.delete(socket.id);
    broadcastUsers();
  });
});

server.listen(PORT, () => {
  const t = translatorInfo.mode === "mock" ? "mock (no API calls)" : `Claude (${translatorInfo.model})`;
  console.log(`Language exchange server on http://localhost:${PORT}  ·  translator: ${t}`);
  if (translatorInfo.mode !== "mock" && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn("⚠️  ANTHROPIC_API_KEY is not set — translations will fail. Set it, or run with TRANSLATOR=mock.");
  }
});
