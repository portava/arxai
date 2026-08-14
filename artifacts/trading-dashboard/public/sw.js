// Phase 22D — ARX AI service worker for web push.
// Receives push events, shows notifications, handles click-to-focus.
// Contains no secrets. Payload is set server-side and constrained to
// title/body/type/notificationId/url/createdAt.
/* global self, clients */

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = { title: "ARX AI", body: "New notification" };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch (_e) {
    try {
      const text = event.data ? event.data.text() : "";
      if (text) payload.body = text.slice(0, 240);
    } catch (_ignored) {
      // keep fallback copy
    }
  }
  const title = String(payload.title || "ARX AI").slice(0, 120);
  const body = String(payload.body || "").slice(0, 240);
  const tag = payload.type ? `arx-${payload.type}` : "arx-notification";
  const data = {
    url: typeof payload.url === "string" && payload.url.startsWith("/") ? payload.url : "/notifications",
    notificationId: payload.notificationId || null,
    type: payload.type || "system",
    createdAt: payload.createdAt || new Date().toISOString(),
  };
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag,
    renotify: false,
    icon: "/brand/icon-192.png",
    badge: "/brand/icon-192.png",
    data,
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/notifications";
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of allClients) {
      try {
        const url = new URL(client.url);
        if (url.origin === self.location.origin) {
          await client.focus();
          if ("navigate" in client) {
            try { await client.navigate(targetUrl); } catch (_e) { /* ignore */ }
          }
          return;
        }
      } catch (_e) {
        // ignore
      }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});
