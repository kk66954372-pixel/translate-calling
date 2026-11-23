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
  const users = new Map(); // id -> {id, name, lang, created, email, googleSub}
  const keys = new Map(); // key hash -> user id (one per signed-in device)
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
    async createUser({ name, lang, email = null, googleSub = null }) {
      const key = newKey();
      const user = { id: randomUUID(), name, lang, created: Date.now(), email, googleSub };
      users.set(user.id, user);
      keys.set(hashKey(key), user.id);
      return { user: publicRecord(user), key };
    },
    async userByKey(key) {
      return publicRecord(users.get(keys.get(hashKey(key))));
    },
    async addKey(userId) {
      const key = newKey();
      keys.set(hashKey(key), userId);
      return key;
    },
    async revokeKey(key) {
      keys.delete(hashKey(key));
    },
    async userByEmail(email) {
      return publicRecord([...users.values()].find((u) => u.email === email));
    },
    async userByGoogle(sub) {
      return publicRecord([...users.values()].find((u) => u.googleSub === sub));
    },
    async accountOf(id) {
      const u = users.get(id);
      return u ? { email: u.email ?? null, google: Boolean(u.googleSub) } : null;
    },
    async setEmail(id, email) {
      const u = users.get(id);
      if (u) u.email = email;
    },
    async setGoogle(id, sub) {
      const u = users.get(id);
      if (u) u.googleSub = sub;
    },
    /** Move everything of `fromId` (rooms, messages, devices, push) to `toId`, then delete `fromId`. */
    async mergeUsers(fromId, toId) {
      for (const r of rooms.values()) {
        const mine = r.members.get(fromId);
        if (!mine) continue;
        r.members.delete(fromId);
        if (!r.members.has(toId)) r.members.set(toId, mine);
      }
      for (const list of messages.values()) for (const m of list) if (m.from === fromId) m.from = toId;
      for (const s of subs.values()) if (s.userId === fromId) s.userId = toId;
      for (const [h, uid] of keys) if (uid === fromId) keys.set(h, toId);
      users.delete(fromId);
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
    /** Groups of rooms shared by the same two people, oldest first (duplicates to merge). */
    async duplicateRoomGroups() {
      const byPair = new Map();
      for (const r of [...rooms.values()].sort((x, y) => x.created - y.created)) {
        if (r.members.size !== 2) continue;
        const pair = [...r.members.keys()].sort().join(",");
        byPair.set(pair, [...(byPair.get(pair) ?? []), r.id]);
      }
      return [...byPair.values()].filter((ids) => ids.length > 1);
    },
    /** Move all messages of room `fromId` into `toId` and delete `fromId`. */
    async mergeRoom(fromId, toId) {
      const moved = (messages.get(fromId) ?? []).map((m) => ({ ...m, roomId: toId }));
      const list = [...(messages.get(toId) ?? []), ...moved].sort((x, y) => x.ts - y.ts);
      messages.set(toId, list.slice(-MESSAGE_KEEP));
      messages.delete(fromId);
      rooms.delete(fromId);
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
        -- Accounts: a user can sign in with email and/or Google, from several devices (one key each).
        ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT UNIQUE;
        CREATE TABLE IF NOT EXISTS user_keys (
          key_hash TEXT PRIMARY KEY, user_id UUID REFERENCES users(id) ON DELETE CASCADE, created BIGINT NOT NULL);
        INSERT INTO user_keys (key_hash, user_id, created) SELECT key_hash, id, created FROM users ON CONFLICT DO NOTHING;
      `);
    },
    async getSetting(k) {
      return (await q("SELECT v FROM settings WHERE k = $1", [k])).rows[0]?.v ?? null;
    },
    async setSetting(k, v) {
      await q("INSERT INTO settings (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = $2", [k, v]);
    },
    async createUser({ name, lang, email = null, googleSub = null }) {
      const key = newKey();
      const id = randomUUID();
      const now = Date.now();
      await q("INSERT INTO users (id, key_hash, name, lang, created, email, google_sub) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
        id,
        hashKey(key),
        name,
        lang,
        now,
        email,
        googleSub,
      ]);
      await q("INSERT INTO user_keys (key_hash, user_id, created) VALUES ($1, $2, $3)", [hashKey(key), id, now]);
      return { user: { id, name, lang }, key };
    },
    async userByKey(key) {
      const r = await q("SELECT u.id, u.name, u.lang FROM user_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = $1", [hashKey(key)]);
      return r.rows[0] ?? null;
    },
    async addKey(userId) {
      const key = newKey();
      await q("INSERT INTO user_keys (key_hash, user_id, created) VALUES ($1, $2, $3)", [hashKey(key), userId, Date.now()]);
      return key;
    },
    async revokeKey(key) {
      await q("DELETE FROM user_keys WHERE key_hash = $1", [hashKey(key)]);
    },
    async userByEmail(email) {
      return (await q("SELECT id, name, lang FROM users WHERE email = $1", [email])).rows[0] ?? null;
    },
    async userByGoogle(sub) {
      return (await q("SELECT id, name, lang FROM users WHERE google_sub = $1", [sub])).rows[0] ?? null;
    },
    async accountOf(id) {
      const r = (await q("SELECT email, google_sub FROM users WHERE id = $1", [id])).rows[0];
      return r ? { email: r.email ?? null, google: Boolean(r.google_sub) } : null;
    },
    async setEmail(id, email) {
      await q("UPDATE users SET email = $2 WHERE id = $1", [id, email]);
    },
    async setGoogle(id, sub) {
      await q("UPDATE users SET google_sub = $2 WHERE id = $1", [id, sub]);
    },
    async mergeUsers(fromId, toId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "DELETE FROM room_members WHERE user_id = $1 AND room_id IN (SELECT room_id FROM room_members WHERE user_id = $2)",
          [fromId, toId],
        );
        await client.query("UPDATE room_members SET user_id = $2 WHERE user_id = $1", [fromId, toId]);
        await client.query("UPDATE messages SET from_id = $2 WHERE from_id = $1", [fromId, toId]);
        await client.query("UPDATE push_subs SET user_id = $2 WHERE user_id = $1", [fromId, toId]);
        await client.query("UPDATE user_keys SET user_id = $2 WHERE user_id = $1", [fromId, toId]);
        await client.query("DELETE FROM users WHERE id = $1", [fromId]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
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
    async duplicateRoomGroups() {
      const r = await q(`
        SELECT array_agg(id ORDER BY created) AS ids FROM (
          SELECT r.id, r.created, string_agg(m.user_id::text, ',' ORDER BY m.user_id) AS pair
            FROM rooms r JOIN room_members m ON m.room_id = r.id
           GROUP BY r.id, r.created HAVING count(*) = 2
        ) t GROUP BY pair HAVING count(*) > 1`);
      return r.rows.map((x) => x.ids);
    },
    async mergeRoom(fromId, toId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("UPDATE messages SET room_id = $2 WHERE room_id = $1", [fromId, toId]);
        await client.query("DELETE FROM rooms WHERE id = $1", [fromId]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
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
