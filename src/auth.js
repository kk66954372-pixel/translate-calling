// Sign-in with an email code or with Google.
// Accounts exist so people keep their rooms when they change phones, and so a subscription can be attached.
import { createHash, randomBytes, randomInt } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { sendCode, mailInfo } from "./mail.js";

const CODE_TTL_MS = 10 * 60_000;
const RESEND_AFTER_MS = Number(process.env.AUTH_RESEND_MS) || 60_000; // shortened only in tests
const MAX_SENDS_PER_HOUR = 5;
const MAX_TRIES = 5;

export const googleClientId = process.env.GOOGLE_CLIENT_ID || null;
const GOOGLE_JWKS = createRemoteJWKSet(new URL(process.env.GOOGLE_JWKS_URL || "https://www.googleapis.com/oauth2/v3/certs"));
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export const authInfo = { email: mailInfo.enabled, google: Boolean(googleClientId) };

export function normalizeEmail(v) {
  const e = String(v ?? "").trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254 ? e : null;
}

const hash = (s) => createHash("sha256").update(s).digest("hex");

/** Send a 6-digit code. Codes and rate limits live in the store's settings (they survive restarts). */
export async function startEmail(store, rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, error: "invalid_email" };
  if (!mailInfo.enabled) return { ok: false, error: "unavailable" };
  const key = `otp:${email}`;
  const now = Date.now();
  const prev = JSON.parse((await store.getSetting(key)) || "null");
  if (prev && now - prev.sentAt < RESEND_AFTER_MS) return { ok: false, error: "too_soon" };
  const windowStart = prev && now - prev.windowStart < 3600_000 ? prev.windowStart : now;
  const sends = prev && windowStart === prev.windowStart ? prev.sends + 1 : 1;
  if (sends > MAX_SENDS_PER_HOUR) return { ok: false, error: "too_many" };

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const record = { hash: hash(`${email}:${code}`), expires: now + CODE_TTL_MS, tries: 0, sentAt: now, windowStart, sends };
  await store.setSetting(key, JSON.stringify(record));
  if (!(await sendCode(email, code))) return { ok: false, error: "send_failed" };
  return { ok: true, email };
}

export async function verifyEmail(store, rawEmail, rawCode) {
  const email = normalizeEmail(rawEmail);
  const code = String(rawCode ?? "").trim();
  if (!email || !/^\d{6}$/.test(code)) return { ok: false, error: "invalid_code" };
  const key = `otp:${email}`;
  const rec = JSON.parse((await store.getSetting(key)) || "null");
  if (!rec?.hash) return { ok: false, error: "invalid_code" };
  if (rec.expires < Date.now()) return { ok: false, error: "expired" };
  if (rec.tries >= MAX_TRIES) return { ok: false, error: "too_many_tries" };
  if (rec.hash !== hash(`${email}:${code}`)) {
    rec.tries++;
    await store.setSetting(key, JSON.stringify(rec));
    return { ok: false, error: rec.tries >= MAX_TRIES ? "too_many_tries" : "invalid_code" };
  }
  // Single use; keep the send counters for the rate limit.
  await store.setSetting(key, JSON.stringify({ ...rec, hash: null }));
  return { ok: true, email };
}

/** Check a "Sign in with Google" ID token (signature, audience, issuer, expiry). */
export async function verifyGoogle(credential) {
  if (!googleClientId || typeof credential !== "string") return { ok: false, error: "unavailable" };
  try {
    const { payload } = await jwtVerify(credential, GOOGLE_JWKS, { issuer: GOOGLE_ISSUERS, audience: googleClientId });
    if (!payload.sub) return { ok: false, error: "invalid_token" };
    const email = payload.email_verified ? normalizeEmail(payload.email) : null;
    return { ok: true, sub: String(payload.sub), email, name: typeof payload.name === "string" ? payload.name : null };
  } catch (e) {
    console.error("[auth] Google token rejected:", e.code || e.message);
    return { ok: false, error: "invalid_token" };
  }
}

/** A short-lived one-time ticket, for the redirect flow (the Google page posts back to the server). */
export async function createTicket(store, data) {
  const ticket = randomBytes(18).toString("base64url");
  await store.setSetting(`ticket:${ticket}`, JSON.stringify({ ...data, expires: Date.now() + 5 * 60_000 }));
  return ticket;
}

export async function consumeTicket(store, ticket) {
  if (!/^[\w-]{16,64}$/.test(String(ticket ?? ""))) return null;
  const key = `ticket:${ticket}`;
  const data = JSON.parse((await store.getSetting(key)) || "null");
  await store.setSetting(key, "{}");
  return data?.sub && data.expires > Date.now() ? data : null;
}
