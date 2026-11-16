// Frontend view-mode header shim.
//
// When an admin-capable user previews ARX AI as a regular user, every
// outbound fetch carries the header `X-Arx-View-Mode: user`. The server
// middleware (`effectiveViewMode.ts`) consumes this header and downgrades
// `req.authUser.role` to "USER" for that request, so every existing
// `requireAdmin` check naturally returns 403.
//
// The current view mode is mirrored to `sessionStorage` by `useViewMode`
// (see `VIEW_MODE_SESSION_KEY`). This shim reads from the mirror on every
// call — no React subscription, no module-level cache that can go stale.
//
// SAFETY:
// - Header is only sent when the runtime mirror says "user". Default is
//   to send nothing (so the server treats the caller at their real role).
// - localStorage/sessionStorage are NOT trusted by the server as the only
//   gate — the server also checks the real session role before acting on
//   the header. This is defense-in-depth, not the primary gate.
// - Non-admin users have no toggle and therefore no mirror, so this is a
//   no-op for them.

export const VIEW_MODE_SESSION_KEY = "arx.viewmode.current";
export const VIEW_MODE_HEADER = "X-Arx-View-Mode";

let installed = false;

function currentMode(): "admin" | "user" | null {
  // Preview/"View as user" mode is DISABLED platform-wide. Always return null
  // so the shim never stamps X-Arx-View-Mode — every request is evaluated at
  // the caller's REAL role. Also proactively clear any stale persisted value.
  if (typeof window === "undefined") return null;
  try {
    window.sessionStorage.removeItem(VIEW_MODE_SESSION_KEY);
  } catch { /* noop */ }
  return null;
}

function shouldDecorate(input: RequestInfo | URL): boolean {
  // Only add the header to same-origin / relative requests. Don't leak it
  // to third-party fetches (TwelveData, analytics, etc.).
  try {
    if (typeof input === "string") {
      if (input.startsWith("/")) return true;
      const u = new URL(input, window.location.origin);
      return u.origin === window.location.origin;
    }
    if (input instanceof URL) return input.origin === window.location.origin;
    if (input instanceof Request) {
      const u = new URL(input.url, window.location.origin);
      return u.origin === window.location.origin;
    }
  } catch {
    /* fall through */
  }
  return false;
}

export function installViewModeFetchShim(): void {
  if (installed || typeof window === "undefined" || typeof window.fetch !== "function") return;
  installed = true;
  const originalFetch = window.fetch.bind(window);

  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const mode = currentMode();
    // Only decorate when the user has actively opted into "user" mode.
    // "admin" or null means: no header, server sees real role.
    if (mode !== "user" || !shouldDecorate(input)) {
      return originalFetch(input, init);
    }

    // Merge header safely across Headers / array / object init shapes.
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(VIEW_MODE_HEADER, "user");
    const nextInit: RequestInit = { ...(init ?? {}), headers };
    return originalFetch(input, nextInit);
  };
}
