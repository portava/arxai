// Series SNAPSHOT — freezing a fetched series to a file, with its own identity.
//
// WHY A ONE-SHOT EVALUATION MUST NOT READ A LIVE FEED
// ---------------------------------------------------
// The C8 evaluation is one-shot: a miss retires the niche and charges FDR. Two
// properties of real vendors make a live fetch unsafe for that press:
//
//   * ADJUSTED HISTORY IS RESTATED. Every ex-dividend date rewrites every prior
//     adjusted close. The "same" 2005–2015 series fetched a week apart is not
//     the same numbers.
//   * VENDORS REVISE AND GO DOWN. A retry after a partial read would evaluate a
//     different dataset than the one the plumbing was proven on.
//
// So the flow is: FETCH → INTEGRITY GUARD → SNAPSHOT TO A FILE → and the
// evaluation reads only the file. The snapshot carries its own fingerprint, and
// `parseSnapshot` RECOMPUTES it and refuses on mismatch — a hand-edited price
// in the snapshot file is caught, not evaluated.
//
// Pure: string in, string out. The caller owns the filesystem.

import type { DailyBar, DailySeries, PriceAdjustment, SeriesProvenance } from "./types.js";
import { dataFingerprint } from "./fingerprint.js";

export const SNAPSHOT_FORMAT = "arx-daily-series-snapshot-v1";

export interface SeriesSnapshot {
  format: typeof SNAPSHOT_FORMAT;
  symbol: string;
  fingerprint: string;
  provenance: SeriesProvenance;
  bars: DailyBar[];
}

/** Canonical JSON for a snapshot file. Stable key order, one bar per line. */
export function serialiseSnapshot(series: DailySeries): string {
  const snap: SeriesSnapshot = {
    format: SNAPSHOT_FORMAT,
    symbol: series.symbol,
    fingerprint: dataFingerprint({
      symbol: series.symbol,
      adjustment: series.provenance.adjustment,
      bars: series.bars,
    }),
    provenance: series.provenance,
    bars: series.bars,
  };
  return JSON.stringify(snap, null, 2) + "\n";
}

export type SnapshotParseResult =
  | { ok: true; series: DailySeries; fingerprint: string }
  | { ok: false; code: "NOT_A_SNAPSHOT" | "FINGERPRINT_MISMATCH" | "MALFORMED"; detail: string };

/**
 * Read a snapshot back. The recorded fingerprint is RECOMPUTED from the bars
 * and compared: a snapshot whose file was edited after it was written no longer
 * matches its own identity and is refused.
 */
export function parseSnapshot(text: string): SnapshotParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, code: "MALFORMED", detail: `not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const o = raw as Partial<SeriesSnapshot>;
  if (o?.format !== SNAPSHOT_FORMAT) {
    return { ok: false, code: "NOT_A_SNAPSHOT", detail: `format is ${String(o?.format)}, expected ${SNAPSHOT_FORMAT}` };
  }
  if (typeof o.symbol !== "string" || !Array.isArray(o.bars) || typeof o.provenance !== "object" || o.provenance === null) {
    return { ok: false, code: "MALFORMED", detail: "snapshot is missing symbol, bars, or provenance" };
  }
  const series: DailySeries = {
    symbol: o.symbol,
    bars: o.bars as DailyBar[],
    provenance: o.provenance as SeriesProvenance,
  };
  let recomputed: string;
  try {
    recomputed = dataFingerprint({
      symbol: series.symbol,
      adjustment: (series.provenance.adjustment ?? "unknown") as PriceAdjustment,
      bars: series.bars,
    });
  } catch (e) {
    return { ok: false, code: "MALFORMED", detail: `bars do not fingerprint: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (o.fingerprint !== recomputed) {
    return {
      ok: false,
      code: "FINGERPRINT_MISMATCH",
      detail:
        `snapshot records ${String(o.fingerprint).slice(0, 16)} but its bars hash to ${recomputed.slice(0, 16)} — ` +
        "the file was changed after it was written; a snapshot that does not match its own identity is not evidence",
    };
  }
  return { ok: true, series, fingerprint: recomputed };
}
