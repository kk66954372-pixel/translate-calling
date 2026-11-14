// Web Push notifications (new message / incoming call) for the home-screen app.
// On iPhone this works for apps added to the Home Screen (iOS 16.4+).
//
// VAPID keys identify this server to the push services. They are created on first start and saved in
// the store, so subscriptions keep working across restarts (with a database). VAPID_PUBLIC_KEY /
// VAPID_PRIVATE_KEY can override them.
import webpush from "web-push";

let publicKey = null;
let store = null;

export async function initPush(s) {
  store = s;
  let keys = null;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    const saved = await store.getSetting("vapid");
    keys = saved ? JSON.parse(saved) : webpush.generateVAPIDKeys();
    if (!saved) await store.setSetting("vapid", JSON.stringify(keys));
  }
  // The subject is a contact for push services; a URL of this app works.
  webpush.setVapidDetails(process.env.PUBLIC_URL || "https://koja-talk.onrender.com", keys.publicKey, keys.privateKey);
  publicKey = keys.publicKey;
}

export const vapidPublicKey = () => publicKey;

/**
 * Send a notification to every device of a user.
 * @param {string} userId
 * @param {{title: string, body: string, tag?: string, url?: string, kind?: string, ttl?: number}} payload
 */
export async function pushTo(userId, payload) {
  if (!store || !publicKey) return 0;
  const subs = await store.subscriptionsOf(userId).catch(() => []);
  let sent = 0;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: payload.ttl ?? 3600, urgency: "high" });
        sent++;
      } catch (e) {
        // 404/410: the subscription is gone (app removed, permission revoked).
        if (e.statusCode === 404 || e.statusCode === 410) await store.deleteSubscription(sub.endpoint).catch(() => {});
        else console.error("[push] failed:", e.statusCode ?? "", e.body || e.message);
      }
    }),
  );
  return sent;
}
