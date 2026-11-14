// Home Screen app support: service worker, push notifications, install hints, app badge.
const ua = navigator.userAgent;
export const isIOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
export const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

let registration = null;
export const swReady = "serviceWorker" in navigator
  ? navigator.serviceWorker
      .register("/sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => (registration = reg))
      .catch((e) => {
        console.warn("service worker registration failed", e);
        return null;
      })
  : Promise.resolve(null);

/** "granted" | "denied" | "default" | "unsupported" */
export function notificationState() {
  if (!pushSupported) return "unsupported";
  return Notification.permission;
}

function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/**
 * Get (or create) this device's push subscription. Asking for permission must happen from a tap.
 * @returns {Promise<PushSubscriptionJSON|null>}
 */
export async function subscribePush(vapidPublicKey, { ask = false } = {}) {
  if (!pushSupported || !vapidPublicKey) return null;
  if (Notification.permission === "default" && ask) {
    const result = await Notification.requestPermission();
    if (result !== "granted") return null;
  }
  if (Notification.permission !== "granted") return null;
  const reg = registration ?? (await swReady);
  if (!reg) return null;
  let sub = await reg.pushManager.getSubscription();
  const key = urlBase64ToUint8Array(vapidPublicKey);
  // A subscription made with another server key (e.g. data was reset) would be rejected: replace it.
  const same = sub?.options?.applicationServerKey && new Uint8Array(sub.options.applicationServerKey).every((b, i) => b === key[i]);
  if (sub && !same) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  return sub.toJSON();
}

export function setBadge(count) {
  try {
    if (count > 0) navigator.setAppBadge?.(count);
    else navigator.clearAppBadge?.();
  } catch {}
}

/** Point the manifest's start_url at a sign-in token, so the Home Screen app opens as the same user. */
export function setManifestToken(token) {
  const link = document.querySelector('link[rel="manifest"]');
  if (link) link.href = `/manifest.webmanifest?t=${encodeURIComponent(token)}`;
}

// Android / desktop Chrome: offer our own "Install" button.
export let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  window.dispatchEvent(new Event("koja:installable"));
});
