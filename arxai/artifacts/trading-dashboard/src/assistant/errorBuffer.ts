// Frontend safe error buffer (last 25 events, scrubbed).
// All sensitive values are redacted before storage.

import type { SafeFrontendError } from "./runtimeContextTypes";

const MAX_EVENTS = 25;
const buffer: SafeFrontendError[] = [];
const listeners = new Set<() => void>();

const SECRET_KEY_RE = /(token|secret|password|passwd|apikey|api[-_]?key|authorization|bearer|cookie|sessionid|session_secret|mt5[-_a-z0-9]*token|broker[-_a-z0-9]*pass)/i;
const TOKEN_VALUE_RE = /\b(?:[A-Za-z0-9+/_-]{20,}|sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_.-]{6,})\b/g;
const BEARER_RE = /\b(bearer)\s+\S+/gi;
const JWT_LIKE_RE = /\b[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_.-]{4,}\b/g;
const HEX_BLOB_RE = /\b[a-f0-9]{16,}\b/gi;
const MIXED_BLOB_RE = /\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{12,}\b/g;

/**
 * Strip query strings, hashes, embedded credentials, JWT-ish tokens, and
 * known-sensitive key=value substrings from a free-form string.
 */
export function scrubString(input: string): string {
  if (!input) return "";
  let s = String(input);
  if (s.length > 600) s = s.slice(0, 600) + "…";
  // Strip embedded user:pass@
  s = s.replace(/([a-z]+:\/\/)[^@\s/]+@/gi, "$1[creds]@");
  // Strip query strings/hashes
  s = s.replace(/(\?|#)[^\s"']*/g, "");
  // Bearer <token> → bearer [redacted]
  s = s.replace(BEARER_RE, "$1 [redacted]");
  // Mask key=value where key is sensitive (works on JSON-ish, header-ish, or query-ish text)
  s = s.replace(/("?\b[\w.-]+"?\s*[:=]\s*)("?)([^",\s}]+)("?)/g, (m, k: string, q1: string, v: string, q2: string) => {
    if (SECRET_KEY_RE.test(k)) return `${k}${q1}[redacted]${q2}`;
    return m;
  });
  // Mask JWT-like (3 dot-separated chunks)
  s = s.replace(JWT_LIKE_RE, "[redacted]");
  // Mask long base64-ish blobs
  s = s.replace(TOKEN_VALUE_RE, "[redacted]");
  // Mask hex blobs (api keys, bridge tokens)
  s = s.replace(HEX_BLOB_RE, "[redacted]");
  // Mask mixed alnum blobs that look like tokens (12+ chars with a digit+letter mix)
  s = s.replace(MIXED_BLOB_RE, "[redacted]");
  return s;
}

export function scrubPath(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const u = new URL(url, typeof window !== "undefined" ? window.location.href : "http://localhost");
    return u.pathname;
  } catch {
    return scrubString(url).split(/[?#]/)[0];
  }
}

export function pushError(ev: Omit<SafeFrontendError, "ts">): void {
  const entry: SafeFrontendError = {
    ts: new Date().toISOString(),
    kind: ev.kind,
    message: scrubString(ev.message ?? "").slice(0, 240),
    ...(ev.path !== undefined ? { path: scrubPath(ev.path) } : {}),
    ...(ev.status !== undefined ? { status: ev.status } : {}),
  };
  buffer.push(entry);
  if (buffer.length > MAX_EVENTS) buffer.splice(0, buffer.length - MAX_EVENTS);
  for (const l of listeners) l();
}

export function getErrors(): SafeFrontendError[] {
  return buffer.slice();
}

export function clearErrors(): void {
  buffer.length = 0;
  for (const l of listeners) l();
}

export function subscribeErrors(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let installed = false;

/**
 * Install global error capture. Idempotent. Safe to call from main.tsx.
 * Wraps window error/unhandledrejection and a fetch hook.
 */
export function installErrorCapture(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (ev) => {
    pushError({
      kind: "uncaught",
      message: ev.message || "Uncaught error",
      path: typeof ev.filename === "string" ? ev.filename : undefined,
    });
  });

  window.addEventListener("unhandledrejection", (ev) => {
    const r = ev.reason;
    const msg = typeof r === "string" ? r : (r && typeof r === "object" && "message" in r ? String((r as { message: unknown }).message) : "Unhandled rejection");
    pushError({ kind: "uncaught", message: msg });
  });

  const origFetch = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const url = typeof args[0] === "string" ? args[0] : (args[0] instanceof Request ? args[0].url : String(args[0]));
    try {
      const res = await origFetch(...args);
      if (!res.ok && res.status >= 400) {
        // Don't record /api/feedback gate probes as failures (they're meant to 403).
        const path = scrubPath(url);
        if (path && !/\/api\/feedback$/.test(path)) {
          pushError({ kind: "fetch", message: `HTTP ${res.status} ${res.statusText || ""}`.trim(), path, status: res.status });
        }
      }
      return res;
    } catch (e) {
      pushError({ kind: "fetch", message: e instanceof Error ? e.message : "fetch failed", path: scrubPath(url) });
      throw e;
    }
  };
}
