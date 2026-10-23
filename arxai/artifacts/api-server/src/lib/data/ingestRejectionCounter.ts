// In-memory body-parser rejection counter for EA data-ingest routes (Task #500).
//
// A body-parser rejection (413 entity.too.large / 400 entity.parse.failed) on
// an ingest route means the EA batch was bounced at the parser BEFORE the
// handler ran — the bars never stored and the failure was previously only
// logged generically. This counter makes that loud: the app error handler
// records each rejection here, and the admin Market Data diagnostics surface
// reads it back so an operator can see at a glance whether the candle feed is
// silently dropping batches.
//
// Telemetry ONLY. The counter is in-memory and resets on server restart
// (consistent with the other bridge telemetry counters). It touches no
// execution, auth, routing, or gate surface.

export type IngestRejectionRecord = {
  /** Full request path that was rejected, e.g. /api/mt5/candles/ingest. */
  route: string;
  /** Total rejections seen on this route since server start. */
  count: number;
  /** ISO timestamp of the most recent rejection. */
  lastSeenIso: string | null;
  /** Content-Length (bytes) of the most recent rejected request, if reported. */
  lastContentLength: number | null;
  /** body-parser error type of the most recent rejection. */
  lastReason: string | null;
};

const records = new Map<string, IngestRejectionRecord>();

/**
 * True for the EA-facing durable data-ingest routes (e.g.
 * /api/mt5/candles/ingest). A silent batch drop on these is exactly what this
 * counter exists to surface.
 */
export function isIngestRoute(path: string): boolean {
  return path.endsWith("/ingest");
}

export function recordIngestRejection(
  route: string,
  opts: { contentLength: number | null; reason: string | null },
): void {
  const nowIso = new Date().toISOString();
  const existing = records.get(route);
  if (existing) {
    existing.count += 1;
    existing.lastSeenIso = nowIso;
    existing.lastContentLength = opts.contentLength;
    existing.lastReason = opts.reason;
  } else {
    records.set(route, {
      route,
      count: 1,
      lastSeenIso: nowIso,
      lastContentLength: opts.contentLength,
      lastReason: opts.reason,
    });
  }
}

/** Snapshot of all recorded rejections, busiest route first. */
export function getIngestRejections(): IngestRejectionRecord[] {
  return [...records.values()].sort((a, b) => b.count - a.count);
}

/** Test-only reset of the in-memory counter. */
export function __resetIngestRejections(): void {
  records.clear();
}
