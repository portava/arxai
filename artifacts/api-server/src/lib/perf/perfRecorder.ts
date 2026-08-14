// Backend performance ring buffer.
//
// Records the last N server-side action timings AND any client-reported
// slow actions, in a single in-memory ring buffer. Admin-only readout via
// `/api/admin/performance/recent-actions`.
//
// Design constraints:
//   - Zero allocation per request beyond the row itself; ring buffer is
//     a fixed-size array we overwrite in place.
//   - No PII / secrets / tokens. Records: method, route template, status,
//     userId (numeric only), totalMs, dbMs (if reported), cacheHit, source.
//   - Pure in-memory; intentionally does NOT persist across restarts.
//     Performance debugging is a live signal — for historical analysis
//     use the existing logger.
//   - Default capacity small enough to never matter for memory (1024
//     rows × ~200 bytes ≈ 200KB).
//
// The recorder is the single source of truth for the admin slow-actions
// panel. Both the backend perfTimer middleware and the frontend
// `/admin/performance/client-action` ingest endpoint push into the same
// buffer so an operator can see one merged timeline.

import { logger } from "../logger.js";

export type PerfSource = "server" | "client";

export interface PerfRow {
  /** Monotonic id so the UI can sort/dedupe deterministically. */
  id: number;
  /** Wall-clock when the row was recorded (ms since epoch). */
  recordedAt: number;
  /** "server" for Express requests, "client" for browser-side actions. */
  source: PerfSource;
  /** Short human-readable action label, e.g. "scanner.scan" or "GET /api/me/account-mode". */
  action: string;
  /** Page slug / route the action originated from. Optional. */
  page?: string | null;
  /** HTTP method when source=server. */
  method?: string | null;
  /** HTTP status when source=server. */
  status?: number | null;
  /** Numeric user id if available — never any other identifier. */
  userId?: number | null;
  /** Total user-perceived ms for the action. */
  totalMs: number;
  /** Optional sub-timings. */
  uiFeedbackMs?: number | null;
  frontendRenderMs?: number | null;
  apiMs?: number | null;
  dbMs?: number | null;
  feedMs?: number | null;
  /** Whether the React Query / server cache served this. */
  cacheHit?: boolean | null;
  /** Free-form short bottleneck tag, e.g. "db", "feed", "render", "network". */
  bottleneck?: string | null;
  /** Device class for client rows — "mobile" | "desktop" | null. Never set for server rows. */
  viewport?: string | null;
  /** True if the row tripped the slow threshold for its action class. */
  slow: boolean;
}

const CAPACITY = 1024;
const buffer: (PerfRow | undefined)[] = new Array(CAPACITY);
let writeCursor = 0;
let nextId = 1;

/**
 * Per-action slow threshold (ms). Anything above this gets `slow=true` and
 * also emits a structured logger.warn line so the row is captured in the
 * server log even if the ring buffer wraps. Thresholds are deliberately
 * conservative — they match the PRD targets in `replit.md` perf audit.
 */
const DEFAULT_SLOW_MS = 1000;
const SLOW_THRESHOLDS: Record<string, number> = {
  "GET /api/me/account-mode": 150,
  "GET /api/me/alerts/unread-count": 150,
  "GET /api/alerts/unread-count": 150,
  "GET /api/me/allocation": 300,
  "GET /api/me/positions/all": 500,
  "GET /api/me/live/profile": 300,
  "GET /api/me/performance-calendar": 500,
};

function classifyBottleneck(row: Pick<PerfRow, "dbMs" | "feedMs" | "apiMs" | "totalMs" | "frontendRenderMs">): string | null {
  const t = row.totalMs;
  if (t <= 0) return null;
  const db = row.dbMs ?? 0;
  const feed = row.feedMs ?? 0;
  const api = row.apiMs ?? 0;
  const render = row.frontendRenderMs ?? 0;
  // Pick the dominant contributor — must be ≥40% of total to be called out.
  const candidates: Array<[string, number]> = [
    ["db", db],
    ["feed", feed],
    ["api", api],
    ["render", render],
  ];
  candidates.sort((a, b) => b[1] - a[1]);
  const [tag, value] = candidates[0]!;
  if (value > 0 && value / t >= 0.4) return tag;
  return null;
}

function thresholdFor(action: string): number {
  return SLOW_THRESHOLDS[action] ?? DEFAULT_SLOW_MS;
}

/**
 * Record a single perf row. Pure side-effect; never throws.
 *
 * Slow rows are also emitted to the structured logger at WARN so they
 * survive a process restart and are surfaceable in deployment logs.
 */
export function recordPerf(input: Omit<PerfRow, "id" | "recordedAt" | "slow" | "bottleneck"> & {
  bottleneck?: string | null;
}): PerfRow {
  const totalMs = Math.max(0, Math.round(input.totalMs));
  const threshold = thresholdFor(input.action);
  const slow = totalMs >= threshold;
  const bottleneck =
    input.bottleneck ??
    classifyBottleneck({
      dbMs: input.dbMs ?? null,
      feedMs: input.feedMs ?? null,
      apiMs: input.apiMs ?? null,
      totalMs,
      frontendRenderMs: input.frontendRenderMs ?? null,
    });

  const row: PerfRow = {
    id: nextId++,
    recordedAt: Date.now(),
    source: input.source,
    action: input.action,
    page: input.page ?? null,
    method: input.method ?? null,
    status: input.status ?? null,
    userId: input.userId ?? null,
    totalMs,
    uiFeedbackMs: input.uiFeedbackMs ?? null,
    frontendRenderMs: input.frontendRenderMs ?? null,
    apiMs: input.apiMs ?? null,
    dbMs: input.dbMs ?? null,
    feedMs: input.feedMs ?? null,
    cacheHit: input.cacheHit ?? null,
    bottleneck,
    viewport: input.viewport ?? null,
    slow,
  };
  buffer[writeCursor] = row;
  writeCursor = (writeCursor + 1) % CAPACITY;

  if (slow) {
    logger.warn(
      {
        perfAction: row.action,
        page: row.page,
        totalMs: row.totalMs,
        apiMs: row.apiMs,
        dbMs: row.dbMs,
        feedMs: row.feedMs,
        bottleneck: row.bottleneck,
        userId: row.userId,
        source: row.source,
        thresholdMs: threshold,
      },
      "perf:slow",
    );
  }
  return row;
}

/**
 * Read out the most recent rows, newest first. The optional filter trims
 * to slow rows only.
 */
export function readRecentPerf(opts: { limit?: number; slowOnly?: boolean } = {}): PerfRow[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, CAPACITY));
  const out: PerfRow[] = [];
  // Walk the ring in reverse from the write cursor.
  for (let i = 1; i <= CAPACITY && out.length < limit; i += 1) {
    const idx = (writeCursor - i + CAPACITY) % CAPACITY;
    const row = buffer[idx];
    if (!row) continue;
    if (opts.slowOnly && !row.slow) continue;
    out.push(row);
  }
  return out;
}

/**
 * Aggregate by action — useful for the admin "top offenders" view.
 */
export function summariseByAction(): Array<{
  action: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  slowCount: number;
}> {
  const groups = new Map<string, number[]>();
  const slowByAction = new Map<string, number>();
  for (const row of buffer) {
    if (!row) continue;
    const list = groups.get(row.action) ?? [];
    list.push(row.totalMs);
    groups.set(row.action, list);
    if (row.slow) slowByAction.set(row.action, (slowByAction.get(row.action) ?? 0) + 1);
  }
  const out: ReturnType<typeof summariseByAction> = [];
  for (const [action, times] of groups) {
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length * 0.5)] ?? 0;
    const p95 = times[Math.floor(times.length * 0.95)] ?? 0;
    const max = times[times.length - 1] ?? 0;
    out.push({
      action,
      count: times.length,
      p50Ms: p50,
      p95Ms: p95,
      maxMs: max,
      slowCount: slowByAction.get(action) ?? 0,
    });
  }
  out.sort((a, b) => b.p95Ms - a.p95Ms);
  return out;
}

/** Test-only reset. */
export function _resetPerfRecorderForTest(): void {
  for (let i = 0; i < CAPACITY; i += 1) buffer[i] = undefined;
  writeCursor = 0;
  nextId = 1;
}
