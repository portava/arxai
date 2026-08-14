// Phase 22D — Browser-side push setup.
// SAFETY:
// - We only request Notification permission inside enablePush(), which is
//   always invoked from a direct user gesture (button click), never on load.
// - We never claim push is active unless subscribe() returns stored:true and
//   the browser PushManager.subscribe() succeeds.
// - VAPID public key is fetched per-request from /api/me/push/status and is
//   never hardcoded. The private key never reaches this module.

export interface PushStatus {
  configured: boolean;
  publicKey: string | null;
  activeSubscriptions: number;
  revokedSubscriptions: number;
  pushEnabled: boolean;
  setupHint: string | null;
}

export interface PushCapability {
  serviceWorker: boolean;
  notification: boolean;
  pushManager: boolean;
  permission: NotificationPermission | "unsupported";
}

export function getPushCapability(): PushCapability {
  const sw = typeof navigator !== "undefined" && "serviceWorker" in navigator;
  const notif = typeof window !== "undefined" && "Notification" in window;
  const pm = typeof window !== "undefined" && "PushManager" in window;
  const permission: NotificationPermission | "unsupported" = notif ? Notification.permission : "unsupported";
  return { serviceWorker: sw, notification: notif, pushManager: pm, permission };
}

export function isPushSupported(): boolean {
  const c = getPushCapability();
  return c.serviceWorker && c.notification && c.pushManager;
}

export async function fetchPushStatus(): Promise<PushStatus> {
  const r = await fetch("/api/me/push/status", { credentials: "include" });
  if (!r.ok) {
    return { configured: false, publicKey: null, activeSubscriptions: 0, revokedSubscriptions: 0, pushEnabled: false, setupHint: "Push status unavailable" };
  }
  const j = await r.json();
  return {
    configured: !!j.configured,
    publicKey: j.publicKey ?? null,
    activeSubscriptions: Number(j.activeSubscriptions ?? 0),
    revokedSubscriptions: Number(j.revokedSubscriptions ?? 0),
    pushEnabled: !!j.pushEnabled,
    setupHint: j.setupHint ?? null,
  };
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const buf = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}

async function registerSWOnce(): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator)) throw new Error("Service workers are not supported in this browser.");
  const existing = await navigator.serviceWorker.getRegistration("/sw.js");
  if (existing) return existing;
  return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

export interface EnableResult {
  ok: boolean;
  reason?: "unsupported" | "denied" | "vapid_missing" | "subscribe_failed" | "store_failed";
  message: string;
}

export async function enablePush(): Promise<EnableResult> {
  if (!isPushSupported()) {
    return { ok: false, reason: "unsupported", message: "This browser does not support push notifications." };
  }
  const status = await fetchPushStatus();
  if (!status.configured || !status.publicKey) {
    return { ok: false, reason: "vapid_missing", message: "Push notifications are not configured on this server yet." };
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    return { ok: false, reason: "denied", message: "Notification permission was not granted." };
  }
  const reg = await registerSWOnce();
  await navigator.serviceWorker.ready;
  let subscription: PushSubscription | null = null;
  try {
    subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(status.publicKey),
      });
    }
  } catch (err) {
    return { ok: false, reason: "subscribe_failed", message: "Browser refused to create a push subscription." + (err ? ` (${String(err).slice(0, 120)})` : "") };
  }
  const r = await fetch("/api/me/push/subscribe", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subscription: subscription.toJSON(),
      deviceLabel: navigator.userAgent.slice(0, 80),
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.stored !== true) {
    return { ok: false, reason: "store_failed", message: body.reason || body.error || "Server did not store the subscription." };
  }
  return { ok: true, message: "Push notifications enabled on this device." };
}

export async function disablePush(): Promise<{ ok: boolean; message: string }> {
  if (!("serviceWorker" in navigator)) {
    return { ok: false, message: "Service workers are not supported in this browser." };
  }
  let endpoint: string | null = null;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/sw.js");
    if (reg) {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        endpoint = sub.endpoint;
        await sub.unsubscribe().catch(() => undefined);
      }
    }
  } catch (_e) {
    // continue — we still try server-side revoke
  }
  const r = await fetch("/api/me/push/unsubscribe", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(endpoint ? { endpoint } : {}),
  });
  if (!r.ok) return { ok: false, message: "Failed to revoke server-side subscription." };
  return { ok: true, message: "Push notifications disabled on this device." };
}

export async function sendTestPush(): Promise<{ ok: boolean; message: string }> {
  const r = await fetch("/api/me/push/test", { method: "POST", credentials: "include" });
  const body = await r.json().catch(() => ({} as { message?: string; sent?: number }));
  if (r.ok && body.ok) return { ok: true, message: `Test push sent to ${body.sent} device(s).` };
  return { ok: false, message: body.message || "Test push failed." };
}
