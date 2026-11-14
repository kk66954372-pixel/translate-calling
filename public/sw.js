// Service worker: shows push notifications (new message, incoming/missed call) and opens the app on tap.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data?.json() ?? {};
  } catch {
    d = { body: e.data?.text() };
  }
  // iOS requires every push to show a notification, so always show one.
  e.waitUntil(
    self.registration.showNotification(d.title || "KoJa Talk", {
      body: d.body || "",
      tag: d.tag,
      renotify: Boolean(d.tag),
      requireInteraction: d.kind === "call",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: d.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", self.location.origin).href;
  e.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const app = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (app) {
        app.postMessage({ type: "open", url });
        return app.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
