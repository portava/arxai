// Remembers the page an anonymous visitor asked for, so signing in lands them
// there instead of always on the role home. Stored per tab in sessionStorage.
// Only same-app absolute paths are kept; role containment is still enforced
// by RouteAccessGuard after sign-in.

const KEY = "arx.auth.returnTo";
const AUTH_PATHS = new Set(["/login", "/register", "/reset-password"]);

export function isSafeReturnPath(path: string | null | undefined): path is string {
  if (!path || typeof path !== "string") return false;
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return false;
  const bare = path.split(/[?#]/)[0].replace(/\/$/, "") || "/";
  if (bare === "/" || AUTH_PATHS.has(bare)) return false;
  return true;
}

const SUPPRESS_KEY = "arx.auth.returnTo.suppress";

/** Called on sign-out: the page the user was on is not a destination for whoever signs in next. */
export function suppressNextReturnTo(): void {
  try {
    window.sessionStorage.removeItem(KEY);
    window.sessionStorage.setItem(SUPPRESS_KEY, "1");
  } catch { /* storage unavailable */ }
}

export function rememberReturnTo(path: string): void {
  try {
    if (window.sessionStorage.getItem(SUPPRESS_KEY)) {
      window.sessionStorage.removeItem(SUPPRESS_KEY);
      return;
    }
  } catch { return; }
  if (!isSafeReturnPath(path)) return;
  try { window.sessionStorage.setItem(KEY, path); } catch { /* storage unavailable */ }
}

export function readReturnTo(): string | null {
  try {
    const v = window.sessionStorage.getItem(KEY);
    return isSafeReturnPath(v) ? v : null;
  } catch { return null; }
}

export function clearReturnTo(): void {
  try { window.sessionStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}
