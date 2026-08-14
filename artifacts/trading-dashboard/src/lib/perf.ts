// Frontend performance instrumentation.
//
// Lightweight, zero-dependency timing for launch-critical user actions
// (PART A of the speed audit). Intentionally NOT React-bound so it can
// be imported from anywhere — components, hooks, fetch wrappers.
//
// Lifecycle of a single action:
//
//   const id = markActionStart("scanner.openTradeModal", { page: "market-scanner" });
//   markUiFeedback(id);                       // when the spinner/skeleton appears
//   markApiStart(id, "POST /api/scanner/run"); // optional per-API segment
//   markApiEnd(id, "POST /api/scanner/run", 200);
//   markRenderComplete(id);                   // when the user-visible result is painted
//   markActionEnd(id);                        // total complete
//
// Calls are safe to skip (e.g. you can call only start+end), and any
// out-of-order or duplicate calls are silently coalesced — the goal is
// "best-effort timing", not auditing.
//
// Slow rows are flushed to `POST /api/admin/performance/client-action`
// in batches every 5s. The backend gates the endpoint behind requireAdmin
// so non-admin POSTs are no-ops (the server simply refuses), and we
// suppress flush errors so a logged-out tab doesn't spam the console.
//
// Normal users never see diagnostics — there is no UI affordance to
// view this data unless the admin diagnostics page is open.

const usePerfApi: boolean = typeof window !== "undefined" && typeof window.performance?.now === "function";

function now(): number {
  return usePerfApi ? performance.now() : Date.now();
}

export type PerfBottleneck = "db" | "feed" | "api" | "render" | "network" | null;

// Device class for a captured timing row. We deliberately keep this to the
// two buckets the speed audit cares about — "mobile" and "desktop" — so an
// admin can read mobile-vs-desktop exact-ms timings side by side in the
// diagnostics panel. The split is a single CSS-style breakpoint on the live
// viewport width at the moment the row is built; it is best-effort and never
// blocks. `null` when there is no DOM (SSR / tests).
export type PerfViewport = "mobile" | "desktop";
const MOBILE_MAX_WIDTH_PX = 768;
function detectViewport(): PerfViewport | null {
  if (typeof window === "undefined") return null;
  const w = window.innerWidth || document.documentElement?.clientWidth || 0;
  if (w <= 0) return null;
  return w < MOBILE_MAX_WIDTH_PX ? "mobile" : "desktop";
}

interface ActionState {
  id: string;
  action: string;
  page: string | null;
  startedAt: number;
  uiFeedbackAt: number | null;
  renderCompleteAt: number | null;
  endedAt: number | null;
  apiMs: number;
  apiSegments: Map<string, number>; // endpoint -> start time
  feedMs: number;
  feedSegments: Map<string, number>;
  dbMs: number | null;
  cacheHit: boolean | null;
  bottleneck: PerfBottleneck;
}

const SLOW_THRESHOLD_MS = 1000;
const FLUSH_INTERVAL_MS = 5000;
const MAX_PENDING = 200;

const inFlight = new Map<string, ActionState>();
const pendingFlush: ClientPerfRow[] = [];
let counter = 0;

// Transport gate.
//
// Local timing (markActionStart/markActionEnd, dev-only console.warn) is
// always on so a developer can spot a slow action in any environment.
// But background POSTs to `/api/admin/performance/client-action` are
// kept OFF by default so normal users never generate telemetry traffic
// at all — not even traffic that lands in the server's 403 path.
//
// The admin diagnostics page is the only caller that flips this on,
// via `setPerfTransportEnabled(true)`, when it confirms the active
// session has the ADMIN/OWNER role. Closing the page leaves it on for
// the rest of the session, which is fine because by definition only an
// admin could have flipped it.
let transportEnabled = false;
export function setPerfTransportEnabled(enabled: boolean): void {
  transportEnabled = enabled;
  if (!enabled) pendingFlush.length = 0;
}
export function isPerfTransportEnabled(): boolean { return transportEnabled; }

export interface ClientPerfRow {
  action: string;
  page: string | null;
  totalMs: number;
  uiFeedbackMs: number | null;
  frontendRenderMs: number | null;
  apiMs: number | null;
  feedMs: number | null;
  dbMs: number | null;
  cacheHit: boolean | null;
  bottleneck: PerfBottleneck;
  /** Device class the row was captured on — "mobile" | "desktop" | null. */
  viewport: PerfViewport | null;
}

function genId(action: string): string {
  counter += 1;
  return `${action}#${counter}#${Math.floor(now())}`;
}

export function markActionStart(action: string, ctx?: { page?: string }): string {
  const id = genId(action);
  inFlight.set(id, {
    id,
    action,
    page: ctx?.page ?? null,
    startedAt: now(),
    uiFeedbackAt: null,
    renderCompleteAt: null,
    endedAt: null,
    apiMs: 0,
    apiSegments: new Map(),
    feedMs: 0,
    feedSegments: new Map(),
    dbMs: null,
    cacheHit: null,
    bottleneck: null,
  });
  return id;
}

export function markUiFeedback(id: string): void {
  const s = inFlight.get(id);
  if (s && s.uiFeedbackAt === null) s.uiFeedbackAt = now();
}

export function markApiStart(id: string, endpoint: string): void {
  const s = inFlight.get(id);
  if (!s) return;
  s.apiSegments.set(endpoint, now());
}

export function markApiEnd(id: string, endpoint: string, _status?: number): void {
  const s = inFlight.get(id);
  if (!s) return;
  const startedAt = s.apiSegments.get(endpoint);
  if (startedAt == null) return;
  s.apiMs += now() - startedAt;
  s.apiSegments.delete(endpoint);
}

export function markRenderComplete(id: string): void {
  const s = inFlight.get(id);
  if (s && s.renderCompleteAt === null) s.renderCompleteAt = now();
}

export function markDbTiming(id: string, _queryName: string, durationMs: number): void {
  const s = inFlight.get(id);
  if (!s) return;
  s.dbMs = (s.dbMs ?? 0) + durationMs;
}

export function markFeedTiming(id: string, _provider: string, _symbol: string, durationMs: number): void {
  const s = inFlight.get(id);
  if (!s) return;
  s.feedMs += durationMs;
}

export function markCacheHit(id: string, hit: boolean): void {
  const s = inFlight.get(id);
  if (s) s.cacheHit = hit;
}

export function markActionEnd(id: string, opts?: { bottleneck?: PerfBottleneck }): ClientPerfRow | null {
  const s = inFlight.get(id);
  if (!s) return null;
  s.endedAt = now();
  if (opts?.bottleneck !== undefined) s.bottleneck = opts.bottleneck;
  inFlight.delete(id);

  const totalMs = s.endedAt - s.startedAt;
  const uiFeedbackMs = s.uiFeedbackAt !== null ? s.uiFeedbackAt - s.startedAt : null;
  const frontendRenderMs = s.renderCompleteAt !== null ? s.renderCompleteAt - s.startedAt : null;
  const row: ClientPerfRow = {
    action: s.action,
    page: s.page,
    totalMs,
    uiFeedbackMs,
    frontendRenderMs,
    apiMs: s.apiMs > 0 ? s.apiMs : null,
    feedMs: s.feedMs > 0 ? s.feedMs : null,
    dbMs: s.dbMs,
    cacheHit: s.cacheHit,
    bottleneck: s.bottleneck,
    viewport: detectViewport(),
  };
  // Only flush slow rows to the backend ring buffer. In-memory state
  // for fast actions is dropped immediately to keep the wire chatter low.
  if (totalMs >= SLOW_THRESHOLD_MS) {
    enqueueFlush(row);
    if (typeof console !== "undefined" && import.meta.env?.DEV) {
      // Dev-only — never spams production. Helps spot a slow action
      // during local work without opening the admin panel.
      console.warn(`[perf:slow] ${s.action} ${totalMs.toFixed(0)}ms`, row);
    }
  }
  return row;
}

/** Convenience for "fire and forget" wrappers around fetch/etc. */
export async function measureAsync<T>(
  action: string,
  fn: () => Promise<T>,
  ctx?: { page?: string; endpoint?: string },
): Promise<T> {
  const id = markActionStart(action, ctx);
  if (ctx?.endpoint) markApiStart(id, ctx.endpoint);
  try {
    const v = await fn();
    if (ctx?.endpoint) markApiEnd(id, ctx.endpoint);
    markActionEnd(id);
    return v;
  } catch (e) {
    if (ctx?.endpoint) markApiEnd(id, ctx.endpoint);
    markActionEnd(id, { bottleneck: "network" });
    throw e;
  }
}

/** Force-flush hook for tests / page-unload. */
export function reportSlowAction(row: ClientPerfRow): void {
  enqueueFlush(row);
}

function enqueueFlush(row: ClientPerfRow): void {
  if (pendingFlush.length >= MAX_PENDING) pendingFlush.shift();
  pendingFlush.push(row);
}

async function flushNow(): Promise<void> {
  if (!transportEnabled) return;
  if (pendingFlush.length === 0) return;
  const batch = pendingFlush.splice(0, pendingFlush.length);
  const baseUrl = (import.meta.env?.BASE_URL ?? "/").replace(/\/$/, "");
  try {
    await fetch(`${baseUrl}/api/admin/performance/client-action`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: batch }),
      // sendBeacon-equivalent semantics: don't keep the page alive for this.
      keepalive: true,
    });
  } catch {
    // Non-admin sessions will get 403 — that's fine, swallow it. Network
    // failures also swallowed; perf data is best-effort.
  }
}

// ---------------------------------------------------------------------------
// Orval request observer — bridges the central customFetch mutator into
// the ring buffer so every generated API hook is timed for free.
//
// We collapse this into a synthetic action per request so duplicate /
// hung-network detection has a row to look at, but we DON'T enqueue
// individual rows for the slow-flush path unless the call clearly busted
// budget — the action-level instrumentation (markActionStart/End) is the
// canonical PART B/C/G data source. This is the safety net that catches
// API calls fired outside an explicit action (background queries,
// React Query refetches, etc.).
// ---------------------------------------------------------------------------
const API_SLOW_MS = 800;
function urlLabel(url: string, method: string): string {
  // Strip protocol+host, drop the query string, then redact dynamic ids
  // so two requests to /api/me/trades/123 and /api/me/trades/456 collapse
  // to a single bucket (matches the server-side route normalisation).
  let path = url;
  try {
    const parsed = new URL(url, "http://x");
    path = parsed.pathname;
  } catch { /* relative URL — use as-is */ }
  const redacted = path
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return ":id";
      if (/^[0-9a-f]{8,}$/i.test(seg)) return ":id";
      if (seg.length > 32) return ":x";
      return seg;
    })
    .join("/");
  return `${method} ${redacted}`;
}
export function observeOrvalRequest(obs: {
  method: string; url: string; status: number;
  totalMs: number; backendMs: number | null; ok: boolean;
}): void {
  // Only flag truly slow calls; otherwise the noise drowns the signal.
  if (obs.totalMs < API_SLOW_MS) return;
  const action = `api ${urlLabel(obs.url, obs.method)}`;
  const networkMs = obs.backendMs != null ? Math.max(0, obs.totalMs - obs.backendMs) : null;
  enqueueFlush({
    action,
    page: typeof location !== "undefined" ? location.pathname : null,
    totalMs: obs.totalMs,
    uiFeedbackMs: null,
    frontendRenderMs: null,
    apiMs: obs.totalMs,
    feedMs: null,
    dbMs: obs.backendMs,
    cacheHit: null,
    bottleneck: networkMs != null && obs.backendMs != null && networkMs > obs.backendMs ? "network" : "api",
    viewport: detectViewport(),
  });
  if (typeof console !== "undefined" && import.meta.env?.DEV) {
    console.warn(
      `[perf:slow-api] ${action} total=${obs.totalMs.toFixed(0)}ms backend=${obs.backendMs?.toFixed(0) ?? "?"}ms status=${obs.status}`,
    );
  }
}

if (typeof window !== "undefined") {
  // Periodic flush.
  window.setInterval(() => {
    if (!document.hidden) void flushNow();
  }, FLUSH_INTERVAL_MS);
  // Flush on tab hide / unload so we don't lose tail data when the user
  // navigates away. `sendBeacon` would be nicer but fetch+keepalive works
  // identically here.
  window.addEventListener("visibilitychange", () => {
    if (document.hidden) void flushNow();
  });
  window.addEventListener("pagehide", () => { void flushNow(); });
}
