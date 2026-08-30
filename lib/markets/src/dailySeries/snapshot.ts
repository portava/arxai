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
// TWO DIGESTS, BECAUSE ONE OF THEM MUST NOT COVER THE PROVENANCE
// --------------------------------------------------------------
// `dataFingerprint` deliberately excludes `fetchedAt`, `source`, `request` and
// `termsOfUse`, because it is the harness's no-respin identity and re-fetching
// the same bars must not mint a new one. The consequence, if nothing else were
// done, is a real hole: `termsOfUse: "UNVERIFIED"` is an owner gate that is
// supposed to ride with the bars so it cannot be forgotten, and a hand-edit of
// that one word to "DOCUMENTED_PUBLIC" would leave the file passing its own
// integrity check. The stamp travelled; nothing proved it arrived intact.
//
// So a snapshot carries BOTH digests and `parseSnapshot` verifies BOTH:
//   fingerprint       — the bars. Stable across a re-fetch. The no-respin key.
//   provenanceDigest  — the whole provenance block, licence gate included.
//                       Changes on a re-fetch, which is why it is separate.
// A snapshot missing `provenanceDigest` is MALFORMED, not tolerated: making the
// field optional would mean an editor could delete the digest instead of
// forging it and land in the same place.
//
// Pure: string in, string out. The caller owns the filesystem.

import type { DailyBar, DailySeries, PriceAdjustment, SeriesProvenance } from "./types.js";
import { dataFingerprint, provenanceDigest } from "./fingerprint.js";

export const SNAPSHOT_FORMAT = "arx-daily-series-snapshot-v1";

export interface SeriesSnapshot {
  format: typeof SNAPSHOT_FORMAT;
  symbol: string;
  fingerprint: string;
  /** sha256 over the whole provenance block — the licence gate's tamper-evidence. */
  provenanceDigest: string;
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
    provenanceDigest: provenanceDigest(series.provenance),
    provenance: series.provenance,
    bars: series.bars,
  };
  return JSON.stringify(snap, null, 2) + "\n";
}

export type SnapshotParseResult =
  | { ok: true; series: DailySeries; fingerprint: string; provenanceDigest: string }
  | {
      ok: false;
      code: "NOT_A_SNAPSHOT" | "FINGERPRINT_MISMATCH" | "PROVENANCE_MISMATCH" | "MALFORMED";
      detail: string;
    };

/**
 * Read a snapshot back. BOTH recorded digests are RECOMPUTED and compared: a
 * snapshot whose bars were edited no longer matches its own identity, and a
 * snapshot whose provenance was edited — an "UNVERIFIED" licence promoted to
 * "DOCUMENTED_PUBLIC", a `fetchedAt` backdated, a `source` swapped — no longer
 * matches its own provenance digest. Either one is a refusal.
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

  // The provenance carries the licence gate, so it gets its own tamper-evidence.
  if (typeof o.provenanceDigest !== "string" || o.provenanceDigest.length === 0) {
    return {
      ok: false,
      code: "MALFORMED",
      detail:
        "snapshot has no provenanceDigest — the provenance block (licence gate included) sits outside the bar " +
        "fingerprint by design, so without its own digest nothing proves it arrived unedited. A snapshot written " +
        "before this field existed must be re-written from its source, not waved through",
    };
  }
  let recomputedProvenance: string;
  try {
    recomputedProvenance = provenanceDigest(series.provenance);
  } catch (e) {
    return {
      ok: false,
      code: "MALFORMED",
      detail: `provenance does not digest: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (o.provenanceDigest !== recomputedProvenance) {
    return {
      ok: false,
      code: "PROVENANCE_MISMATCH",
      detail:
        `snapshot records provenance digest ${o.provenanceDigest.slice(0, 16)} but its provenance block hashes to ` +
        `${recomputedProvenance.slice(0, 16)} — the provenance was edited after the snapshot was written. This is the ` +
        `check that catches a licence stamp promoted by hand; the file claims termsOfUse "${series.provenance.termsOfUse}" ` +
        "and that claim is not the one that was recorded",
    };
  }

  return { ok: true, series, fingerprint: recomputed, provenanceDigest: recomputedProvenance };
}
