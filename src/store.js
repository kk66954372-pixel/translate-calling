// Persistent data: users, rooms (pairs of friends), messages, push subscriptions, settings.
//
// DATABASE_URL set -> Postgres (e.g. a free Neon database). Survives restarts and deploys.
// Otherwise        -> in memory. Fine for development and tests; everything is lost on restart.
import { createHash, randomBytes, randomUUID } from "node:crypto";

const MESSAGE_KEEP = 1000; // per room, oldest are deleted beyond this
const hashKey = (key) => createHash("sha256").update(String(key)).digest("hex");
const newKey = () => randomBytes(24).toString("base64url");

// ---------------------------------------------------------------------------
// In-memory backend
// ---------------------------------------------------------------------------
function memoryStore() {
  const settings = new Map();
  const users = new Map(); // id -> {id, keyHash, name, lang, created}
  const rooms = new Map(); // id -> {id, created, members: Map<userId, {lastRead}>}
  const messages = new Map(); // roomId -> msg[]
  const subs = new Map(); // endpoint -> {userId, sub}

  const roomView = (r) => r && { id: r.id, created: r.created, members: [...r.members.keys()] };

  return {
    kind: "memory",
    async init() {},
    async getSetting(k) {
      return settings.get(k) ?? null;
    },
    async setSetting(k, v) {
      settings.set(k, v);
    },
    async createUser({ name, lang }) {
      const key = newKey();
      const user = { id: randomUUID(), keyHash: hashKey(key), name, lang, created: Date.now() };
      users.set(user.id, user);
      return { user: publicRecord(user), key };
    },
    async userByKey(key) {
      const h = hashKey(key);
      return publicRecord([...users.values()].find((u) => u.keyHash === h));
    },
    async getUser(id) {
      return publicRecord(users.get(id));
    },
    async updateUser(id, { name, lang }) {
      const u = users.get(id);
      if (u) Object.assign(u, { name, lang });
    },
    async createRoom(id, memberIds) {
      if (rooms.has(id)) return null;
      const r = { id, created: Date.now(), members: new Map(memberIds.map((m) => [m, { lastRead: Date.now() }])) };
      rooms.set(id, r);
      return roomView(r);
    },
    async getRoom(id) {
      return roomView(rooms.get(id));
    },
    async addMember(id, userId) {
      rooms.get(id)?.members.set(userId, { lastRead: Date.now() });
    },
    async roomsOf(userId) {
      return [...rooms.values()].filter((r) => r.members.has(userId)).map(roomView);
    },
    async addMessage(m) {
      const list = messages.get(m.roomId) ?? [];
      list.push({ ...m });
      if (list.length > MESSAGE_KEEP) list.shift();
      messages.set(m.roomId, list);
    },
    async updateMessage(roomId, id, patch) {
      const m = messages.get(roomId)?.find((x) => x.id === id);
      if (m) Object.assign(m, patch);
    },
    async recentMessages(roomId, limit) {
      return (messages.get(roomId) ?? []).slice(-limit).map((m) => ({ ...m }));
    },
    async setLastRead(roomId, userId, ts) {
      const mem = rooms.get(roomId)?.members.get(userId);
      if (mem) mem.lastRead = ts;
    },
    async unread(roomId, userId) {
      const lastRead = rooms.get(roomId)?.members.get(userId)?.lastRead ?? 0;
      return (messages.get(roomId) ?? []).filter((m) => m.ts > lastRead && m.from !== userId && m.kind === "chat").length;
    },
    async saveSubscription(userId, sub) {
      subs.set(sub.endpoint, { userId, sub });
    },
    async subscriptionsOf(userId) {
      return [...subs.values()].filter((s) => s.userId === userId).map((s) => s.sub);
    },
    async deleteSubscription(endpoint) {
      subs.delete(endpoint);
    },
  };
}

function publicRecord(u) {
  return u ? { id: u.id, name: u.name, lang: u.lang } : null;
}

// ---------------------------------------------------------------------------
// Postgres backend
// ---------------------------------------------------------------------------
async function postgresStore(url) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
  });
  pool.on("error", (e) => console.error("[db] idle client error:", e.message));
  const q = (sql, params) => pool.query(sql, params);
  const toMsg = (r) => ({
    id: r.id,
    roomId: r.room_id,
    from: r.from_id,
    name: r.name,
    lang: r.lang,
    kind: r.kind,
    text: r.text,
    ts: Number(r.ts),
    translation: r.translation,
    tlang: r.tlang,
    ok: r.ok,
    error: r.error,
  });

  return {
    kind: "postgres",
    async init() {
      await q(`
        CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY, key_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL, lang TEXT NOT NULL,
          created BIGINT NOT NULL);
        CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, created BIGINT NOT NULL);
        CREATE TABLE IF NOT EXISTS room_members (
          room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE, user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          last_read BIGINT NOT NULL DEFAULT 0, PRIMARY KEY (room_id, user_id));
        CREATE TABLE IF NOT EXISTS messages (
          id UUID PRIMARY KEY, room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE, from_id UUID, name TEXT,
          lang TEXT, kind TEXT NOT NULL, text TEXT NOT NULL, ts BIGINT NOT NULL,
          translation TEXT, tlang TEXT, ok BOOLEAN, error TEXT);
        CREATE INDEX IF NOT EXISTS messages_room_ts ON messages (room_id, ts);
        CREATE TABLE IF NOT EXISTS push_subs (
          endpoint TEXT PRIMARY KEY, user_id UUID REFERENCES users(id) ON DELETE CASCADE, sub JSONB NOT NULL);
      `);
    },
    async getSetting(k) {
      return (await q("SELECT v FROM settings WHERE k = $1", [k])).rows[0]?.v ?? null;
    },
    async setSetting(k, v) {
      await q("INSERT INTO settings (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = $2", [k, v]);
    },
    async createUser({ name, lang }) {
      const key = newKey();
      const id = randomUUID();
      await q("INSERT INTO users (id, key_hash, name, lang, created) VALUES ($1, $2, $3, $4, $5)", [id, hashKey(key), name, lang, Date.now()]);
      return { user: { id, name, lang }, key };
    },
    async userByKey(key) {
      return (await q("SELECT id, name, lang FROM users WHERE key_hash = $1", [hashKey(key)])).rows[0] ?? null;
    },
    async getUser(id) {
      return (await q("SELECT id, name, lang FROM users WHERE id = $1", [id])).rows[0] ?? null;
    },
    async updateUser(id, { name, lang }) {
      await q("UPDATE users SET name = $2, lang = $3 WHERE id = $1", [id, name, lang]);
    },
    async createRoom(id, memberIds) {
      const now = Date.now();
      const r = await q("INSERT INTO rooms (id, created) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id", [id, now]);
      if (!r.rowCount) return null;
      for (const m of memberIds) await q("INSERT INTO room_members (room_id, user_id, last_read) VALUES ($1, $2, $3)", [id, m, now]);
      return { id, created: now, members: [...memberIds] };
    },
    async getRoom(id) {
      const r = (await q("SELECT id, created FROM rooms WHERE id = $1", [id])).rows[0];
      if (!r) return null;
      const members = (await q("SELECT user_id FROM room_members WHERE room_id = $1", [id])).rows.map((x) => x.user_id);
      return { id: r.id, created: Number(r.created), members };
    },
    async addMember(id, userId) {
      await q("INSERT INTO room_members (room_id, user_id, last_read) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [id, userId, Date.now()]);
    },
    async roomsOf(userId) {
      const rows = (
        await q(
          `SELECT r.id, r.created, array_agg(m2.user_id) AS members
             FROM room_members m JOIN rooms r ON r.id = m.room_id JOIN room_members m2 ON m2.room_id = r.id
            WHERE m.user_id = $1 GROUP BY r.id, r.created`,
          [userId],
        )
      ).rows;
      return rows.map((r) => ({ id: r.id, created: Number(r.created), members: r.members }));
    },
    async addMessage(m) {
      await q(
        `INSERT INTO messages (id, room_id, from_id, name, lang, kind, text, ts, translation, tlang, ok, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [m.id, m.roomId, m.from, m.name, m.lang, m.kind, m.text, m.ts, m.translation ?? null, m.tlang ?? null, m.ok ?? null, m.error ?? null],
      );
      // Keep the table small (free database tiers): drop the oldest beyond the limit now and then.
      if (Math.random() < 0.05) {
        await q(
          `DELETE FROM messages WHERE room_id = $1 AND id IN (
             SELECT id FROM messages WHERE room_id = $1 ORDER BY ts DESC OFFSET $2)`,
          [m.roomId, MESSAGE_KEEP],
        );
      }
    },
    async updateMessage(roomId, id, patch) {
      await q("UPDATE messages SET translation = $3, tlang = $4, ok = $5, error = $6 WHERE room_id = $1 AND id = $2", [
        roomId,
        id,
        patch.translation ?? null,
        patch.tlang ?? null,
        patch.ok ?? null,
        patch.error ?? null,
      ]);
    },
    async recentMessages(roomId, limit) {
      const rows = (await q("SELECT * FROM messages WHERE room_id = $1 ORDER BY ts DESC LIMIT $2", [roomId, limit])).rows;
      return rows.reverse().map(toMsg);
    },
    async setLastRead(roomId, userId, ts) {
      await q("UPDATE room_members SET last_read = $3 WHERE room_id = $1 AND user_id = $2", [roomId, userId, ts]);
    },
    async unread(roomId, userId) {
      const r = await q(
        `SELECT count(*)::int AS n FROM messages msg JOIN room_members m ON m.room_id = msg.room_id AND m.user_id = $2
          WHERE msg.room_id = $1 AND msg.ts > m.last_read AND msg.from_id <> $2 AND msg.kind = 'chat'`,
        [roomId, userId],
      );
      return r.rows[0]?.n ?? 0;
    },
    async saveSubscription(userId, sub) {
      await q("INSERT INTO push_subs (endpoint, user_id, sub) VALUES ($1, $2, $3) ON CONFLICT (endpoint) DO UPDATE SET user_id = $2, sub = $3", [
        sub.endpoint,
        userId,
        sub,
      ]);
    },
    async subscriptionsOf(userId) {
      return (await q("SELECT sub FROM push_subs WHERE user_id = $1", [userId])).rows.map((r) => r.sub);
    },
    async deleteSubscription(endpoint) {
      await q("DELETE FROM push_subs WHERE endpoint = $1", [endpoint]);
    },
  };
}

export async function openStore() {
  const url = process.env.DATABASE_URL;
  const store = url ? await postgresStore(url) : memoryStore();
  await store.init();
  return store;
}
