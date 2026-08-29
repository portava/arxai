// D2 golden-vector fixture — a RECORDED event window for the byte-equality
// proof (backtest = shadow = live).
//
// WHAT THIS IS
// ------------
// One hour of closed M1 EURUSD bars (61 events, 2026-08-21 09:00–10:00 UTC on
// the repo-wide bar-OPEN time basis), expressed as `CANDLE_CLOSE` event-log
// rows exactly as a backtest would replay them. The bars are produced by a
// fixed LCG random walk WRITTEN OUT IN THIS FILE — every byte of the window is
// a pure function of the constants below, so the window is deterministic,
// self-contained (no DB, no network), and realistic at pip scale.
//
// WHY THE GOLDEN HASHES ARE LITERALS
// ----------------------------------
// The three `GOLDEN_*` constants are the RECORDED truth this fixture pins:
//
//   GOLDEN_HEAD_HASH          — head of the tamper-evident chain over the 61
//                               events (lib/features eventChain canonical form).
//   GOLDEN_SNAPSHOT_DATA_HASH — `dataSnapshotHash` of the FeatureSnapshot the
//                               ONE feature path computes from this window.
//   GOLDEN_SNAPSHOT_ROW_HASH  — row hash of that snapshot appended to the
//                               chain head (position + content covered).
//
// If any of them ever changes, either the canonicaliser, the chain, or the
// feature MATH changed — and every model trained before the change is now
// trained on a different function. That is exactly the drift the parity lane
// exists to catch; do NOT re-record these to silence a red test without a
// deliberate FEATURE_SET_ID bump (see lib/features/src/index.ts).
//
// Re-derivation (only after an INTENTIONAL math/canon change):
//   pnpm --filter @workspace/api-server exec tsx -e '
//     import { computeRowHash } from "@workspace/features";
//     import { buildFeatureSnapshot, latestCloseIso } from "./src/lib/features/featureSnapshot.js";
//     import { goldenWindowEvents, GOLDEN_SYMBOL } from "./src/lib/features/__qa__/goldenWindow.fixture.js";
//     let prev: string | null = null;
//     for (const e of goldenWindowEvents()) prev = computeRowHash(e.fields, prev);
//     console.log("head", prev);
//     const candles = goldenWindowEvents().map((e) => ({
//       time: String(e.fields.time), open: Number(e.fields.open), high: Number(e.fields.high),
//       low: Number(e.fields.low), close: Number(e.fields.close) }));
//     const snap = buildFeatureSnapshot(GOLDEN_SYMBOL, candles, latestCloseIso(candles)!);
//     console.log("data", snap.available ? snap.features.dataSnapshotHash : "REFUSED");
//     console.log("row ", computeRowHash({ kind: "FEATURE_SNAPSHOT", snapshot: snap }, prev));'

export const GOLDEN_SYMBOL = "EURUSD";

/** Bar-OPEN time of the first recorded bar. */
export const GOLDEN_T0_ISO = "2026-08-21T09:00:00.000Z";

/** Number of recorded closed bars. */
export const GOLDEN_BAR_COUNT = 61;

const M1 = 60_000;
const T0 = Date.parse(GOLDEN_T0_ISO);

/** Recorded event-log row shape: fields only — hashes are chain-derived. */
export interface RecordedWindowEvent {
  eventId: string;
  fields: {
    kind: "CANDLE_CLOSE";
    instrument: string;
    /** Bar OPEN time (repo-wide open-time basis). */
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };
}

/** Deterministic 32-bit LCG (Numerical Recipes constants), uniform in [0,1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const round5 = (x: number): number => Number(x.toFixed(5));

/**
 * The recorded window, oldest-first. A fresh deep structure on every call so
 * one test's tamper experiment can never leak into another's pristine copy.
 */
export function goldenWindowEvents(): RecordedWindowEvent[] {
  const rand = lcg(0x5eed_a7c5);
  const out: RecordedWindowEvent[] = [];
  let prevClose = 1.085;
  for (let i = 0; i < GOLDEN_BAR_COUNT; i++) {
    const open = prevClose;
    // ±4-pip-scale per-bar move — realistic M1 EURUSD microstructure.
    const close = round5(open * (1 + (rand() - 0.5) * 2 * 0.0004));
    const high = round5(Math.max(open, close) * (1 + rand() * 0.0001));
    const low = round5(Math.min(open, close) * (1 - rand() * 0.0001));
    out.push({
      eventId: `mkt-${GOLDEN_SYMBOL}-${i}`,
      fields: {
        kind: "CANDLE_CLOSE",
        instrument: GOLDEN_SYMBOL,
        time: new Date(T0 + i * M1).toISOString(),
        open,
        high,
        low,
        close,
        volume: 100 + Math.floor(rand() * 50),
      },
    });
    prevClose = close;
  }
  return out;
}

// ── Recorded golden anchors (see header for what each pins) ─────────────────

export const GOLDEN_HEAD_HASH =
  "e59d488d8df0dcfff480c1bb31c4807fa1d450ab73762c4ec31b326879242ca2";

/** asOf anchor the one feature path derives from this window (newest close). */
export const GOLDEN_ASOF_ISO = "2026-08-21T10:01:00.000Z";

export const GOLDEN_SNAPSHOT_DATA_HASH =
  "d3329a98dd402fa0f603326e0a8fbfa8303b9729dc7b0028c6edf08b6fd018cc";

export const GOLDEN_SNAPSHOT_ROW_HASH =
  "ac0a90871b7cdf8a97bd12483b499a116e15c130fd119c6ab6a527f10cb57c9f";
