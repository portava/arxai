// Task #30 — Clock-drift detection (pure, deterministic).
//
// PURPOSE: the EA host (often a VPS) can have a wrong wall-clock. If ARX trusts
// the EA's timestamps blindly it will mis-measure heartbeat latency and could
// let a "fresh" command fire late. The EA heartbeat reports its own GMT clock;
// ARX compares that to its own receive time, flags drift / stale / future
// timestamps, stops trusting latency stats when drift is significant, and may
// block the Live Test Cycle on severe drift.
//
// SAFETY: pure function, no IO. Severe drift can ONLY add a refusal (it never
// relaxes any gate). Broker server time is reported for display only and is
// intentionally NOT used for drift, because brokers run their own timezone and
// would always show a whole-hour "offset" that is not a clock error.

export const CLOCK_DRIFT_WARN_SECONDS = 30 as const;
export const CLOCK_DRIFT_SEVERE_SECONDS = 120 as const;

export type ClockDriftSeverity = "OK" | "WARN" | "SEVERE";

export type ClockDriftFlag =
  | "EA_CLOCK_BEHIND"        // EA GMT clock is behind ARX (positive drift)
  | "EA_CLOCK_AHEAD"         // EA GMT clock is ahead of ARX (negative drift)
  | "TIMESTAMP_IN_FUTURE"    // EA stamped a time after ARX received it
  | "TIMESTAMP_UNPARSEABLE"; // EA time missing / unparseable

export interface ClockDriftInput {
  /** EA host's idea of GMT at send (epoch ms). null/NaN => unparseable. */
  eaGmtMs: number | null;
  /** ARX server clock when the heartbeat was received (epoch ms). */
  serverReceivedMs: number;
  warnSeconds?: number;
  severeSeconds?: number;
}

/**
 * Defensively normalise an EA-reported epoch to milliseconds. MQL5 `TimeGMT()`
 * returns SECONDS; the EA now multiplies by 1000 before sending, but older EAs
 * (and any second-scale value) must still be interpreted correctly so we don't
 * compute a ~1000x drift and false-trip SEVERE on a healthy clock.
 *
 * Heuristic: a real epoch in milliseconds is >= 1e12 (year 2001+); a real epoch
 * in seconds is ~1e9–1e10 for any plausible current date, far below 1e12. So any
 * positive finite value below 1e12 is treated as seconds and scaled up.
 */
export function normalizeEaEpochToMs(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return value < 1e12 ? value * 1000 : value;
}

export interface ClockDriftResult {
  /** serverReceived - eaGmt, in seconds. Positive = EA clock behind ARX. */
  driftSeconds: number | null;
  severity: ClockDriftSeverity;
  flags: ClockDriftFlag[];
  /** false when drift is WARN/SEVERE or unparseable — latency stats untrusted. */
  trustLatency: boolean;
  /** Severe drift => callers should block the Live Test Cycle. */
  blockLiveTestCycle: boolean;
  detail: string | null;
}

/**
 * Evaluate clock drift between the EA host (GMT) and the ARX server.
 * A small positive drift is normal network latency; anything beyond the warn
 * threshold is treated as a real clock problem.
 */
export function evaluateClockDrift(input: ClockDriftInput): ClockDriftResult {
  const warn = input.warnSeconds ?? CLOCK_DRIFT_WARN_SECONDS;
  const severe = input.severeSeconds ?? CLOCK_DRIFT_SEVERE_SECONDS;

  if (input.eaGmtMs == null || !Number.isFinite(input.eaGmtMs) || input.eaGmtMs <= 0) {
    return {
      driftSeconds: null,
      severity: "WARN",
      flags: ["TIMESTAMP_UNPARSEABLE"],
      trustLatency: false,
      blockLiveTestCycle: false,
      detail: "EA did not report a parseable GMT timestamp.",
    };
  }

  const driftSeconds = (input.serverReceivedMs - input.eaGmtMs) / 1000;
  const absDrift = Math.abs(driftSeconds);

  const flags: ClockDriftFlag[] = [];
  // A timestamp meaningfully after receive time means the EA clock is ahead.
  if (driftSeconds < -warn) flags.push("EA_CLOCK_AHEAD");
  else if (driftSeconds > warn) flags.push("EA_CLOCK_BEHIND");
  if (driftSeconds < -1) flags.push("TIMESTAMP_IN_FUTURE");

  let severity: ClockDriftSeverity = "OK";
  if (absDrift >= severe) severity = "SEVERE";
  else if (absDrift >= warn) severity = "WARN";

  return {
    driftSeconds,
    severity,
    flags,
    trustLatency: severity === "OK",
    blockLiveTestCycle: severity === "SEVERE",
    detail:
      severity === "OK"
        ? null
        : `EA host clock differs from ARX by ${driftSeconds.toFixed(1)}s (warn ${warn}s / severe ${severe}s).`,
  };
}
