import { useSyncExternalStore } from "react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { VIEW_MODE_SESSION_KEY } from "@/lib/viewMode/fetchShim";

// Per-user "View as" mode. Lets specific admins preview the app as a
// regular user without losing their ADMIN role on the server.
//
// SECURITY: this hook is a UI affordance. Real enforcement is in two
// places:
//   1) Frontend: `installViewModeFetchShim()` attaches an
//      `X-Arx-View-Mode: user` header to every same-origin fetch when
//      the mirror in sessionStorage says "user".
//   2) Server: `effectiveViewMode` middleware downgrades
//      `req.authUser.role` to "USER" when that header is present AND the
//      session belongs to a real admin. Every existing `requireAdmin`
//      check then naturally returns 403.
//   3) Mode changes are also POSTed to `/api/me/view-mode` for an audit
//      row in `admin_action_audit_log`.
//
// Only users whose email is in TOGGLE_ALLOWLIST see the switch. Their
// preference is stored per-user in localStorage so other users on the
// same browser are never affected. All consumers of this hook subscribe
// to one shared store, so toggling in the Topbar immediately re-renders
// the sidebar, mobile nav, and admin route guard.
// Preview/"View as user" mode is DISABLED. Empty allowlist → canToggle is
// always false → effectiveIsAdmin always equals realIsAdmin → no preview
// header is ever sent. OWNER/ADMIN always render as their real session.
const TOGGLE_ALLOWLIST = new Set<string>([]);
const STORAGE_PREFIX = "arx.viewmode.v1:";
type ViewMode = "admin" | "user";

function storageKey(userId: number): string {
  return `${STORAGE_PREFIX}${userId}`;
}
function readStored(userId: number): ViewMode {
  if (typeof window === "undefined") return "admin";
  try {
    const v = window.localStorage.getItem(storageKey(userId));
    return v === "user" ? "user" : "admin";
  } catch {
    return "admin";
  }
}
function mirrorToSession(mode: ViewMode): void {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.setItem(VIEW_MODE_SESSION_KEY, mode); } catch { /* noop */ }
}
function postModeChange(mode: ViewMode): void {
  if (typeof window === "undefined") return;
  // Fire-and-forget audit log POST. We deliberately do NOT block the UI
  // on this — the localStorage/sessionStorage mirror is already updated
  // and the fetch shim will use the new value on the very next call.
  try {
    void fetch("/api/me/view-mode", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    }).catch(() => { /* server may 401/403 in odd states — non-fatal */ });
  } catch { /* noop */ }
}

// Shared external store — one instance per browser tab. Every component
// that calls useViewMode() subscribes to the same store, so a toggle in
// the Topbar is observed by the sidebar, mobile nav, and route guard in
// the same render pass.
const listeners = new Set<() => void>();
let currentMode: ViewMode = "admin";
let currentUserId: number | null = null;
function emit() {
  for (const l of listeners) l();
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
function getSnapshot(): ViewMode {
  return currentMode;
}
function getServerSnapshot(): ViewMode {
  return "admin";
}
function ensureLoadedFor(userId: number | null): void {
  if (userId === currentUserId) return;
  currentUserId = userId;
  // Preview mode is disabled — proactively clear any stale persisted flag so
  // a previously-saved "user" value can never keep a session in preview.
  if (userId != null && typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(storageKey(userId));
      window.sessionStorage.removeItem(VIEW_MODE_SESSION_KEY);
    } catch { /* noop */ }
  }
  const next: ViewMode = "admin"; void userId;
  // Always mirror to sessionStorage so the fetch shim reads the right
  // value on the very first fetch after login.
  mirrorToSession(next);
  if (next !== currentMode) {
    currentMode = next;
    emit();
  }
}
function writeMode(userId: number, next: ViewMode): void {
  try {
    window.localStorage.setItem(storageKey(userId), next);
  } catch {
    /* noop */
  }
  mirrorToSession(next);
  if (next !== currentMode) {
    currentMode = next;
    emit();
    postModeChange(next);
  }
}

export function useViewMode() {
  const { user } = useCurrentUser();
  const realRole = String(user?.role ?? "").toUpperCase();
  const realIsAdmin = realRole === "ADMIN" || realRole === "OWNER";
  const canToggle = realIsAdmin && !!user?.email
    && TOGGLE_ALLOWLIST.has(user.email.toLowerCase());

  // Sync the shared store to the current user before subscribing. When
  // the user changes (login/logout), reset to that user's stored value.
  ensureLoadedFor(user?.id ?? null);

  const viewMode = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  function setViewMode(next: ViewMode) {
    if (!user || !canToggle) return;
    writeMode(user.id, next);
  }

  const effectiveIsAdmin = realIsAdmin && (!canToggle || viewMode === "admin");
  return { realIsAdmin, effectiveIsAdmin, canToggle, viewMode, setViewMode };
}
