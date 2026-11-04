// Heap watch (2026-11-04): the API server ran out of memory twice during long
// page crawls (~35 min of continuous page loads) and nothing in the logs said
// what grew. This logs the process memory on a fixed cadence, warns loudly as
// the heap approaches V8's limit, and reports the sizes of the in-memory
// stores that register a gauge, so the next blow-up names its suspect.
// Observation only: it never evicts, gates or throws, and it runs in preview
// too (that is where the crawl ran).
import v8 from "node:v8";
import { logger } from "../logger.js";

type Gauge = () => number;
const gauges = new Map<string, Gauge>();

/** Register a size gauge for an in-memory store (idempotent by name). */
export function registerHeapWatchGauge(name: string, gauge: Gauge): void {
  gauges.set(name, gauge);
}

export function readHeapWatchGauges(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, g] of gauges) {
    try { out[name] = g(); } catch { out[name] = -1; }
  }
  return out;
}

export interface HeapSample {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  heapLimitBytes: number;
}

export type HeapLevel = "ok" | "elevated" | "critical";

/** Pure: how close the heap is to its limit. Warn at 70%, critical at 85%. */
export function assessHeap(s: HeapSample): { level: HeapLevel; heapUsedPct: number } {
  const pct = s.heapLimitBytes > 0 ? (s.heapUsedBytes / s.heapLimitBytes) * 100 : 0;
  const level: HeapLevel = pct >= 85 ? "critical" : pct >= 70 ? "elevated" : "ok";
  return { level, heapUsedPct: Number(pct.toFixed(1)) };
}

export function sampleHeap(): HeapSample {
  const m = process.memoryUsage();
  return {
    rssBytes: m.rss,
    heapUsedBytes: m.heapUsed,
    heapTotalBytes: m.heapTotal,
    externalBytes: m.external,
    heapLimitBytes: v8.getHeapStatistics().heap_size_limit,
  };
}

const SAMPLE_MS = 60_000;
const QUIET_LOG_EVERY = 5; // one info line per 5 samples while the heap is fine

let timer: NodeJS.Timeout | null = null;
let ticks = 0;
let lastLevel: HeapLevel = "ok";

export function startHeapWatch(): void {
  if (timer) return;
  const tick = () => {
    ticks += 1;
    const s = sampleHeap();
    const a = assessHeap(s);
    const mb = (b: number) => Math.round(b / 1_048_576);
    const fields = {
      rssMb: mb(s.rssBytes), heapUsedMb: mb(s.heapUsedBytes), heapTotalMb: mb(s.heapTotalBytes),
      externalMb: mb(s.externalBytes), heapLimitMb: mb(s.heapLimitBytes), heapUsedPct: a.heapUsedPct,
      stores: readHeapWatchGauges(),
    };
    if (a.level === "critical") logger.error(fields, "Heap watch: heap near V8 limit");
    else if (a.level === "elevated") logger.warn(fields, "Heap watch: heap elevated");
    else if (lastLevel !== "ok") logger.info(fields, "Heap watch: heap back to normal");
    else if (ticks % QUIET_LOG_EVERY === 0) logger.info(fields, "Heap watch");
    lastLevel = a.level;
  };
  timer = setInterval(tick, SAMPLE_MS);
  timer.unref();
}

export function stopHeapWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
