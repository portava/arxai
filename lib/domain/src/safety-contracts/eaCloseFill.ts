// Shared EA-close-fill boundary (pure, deterministic).
//
// PURPOSE: when a closed trade has pnlStatus="UNKNOWN" the broker did not
// return a usable close fill price, so the numeric P/L cannot be trusted.
// v1.28 is the first EA version that reports the broker's real close fill
// price. The Trade Logs page and the Live Test Cycle panel both surface an
// "EA too old to report close fill — upgrade to v1.28" nudge for UNKNOWN rows
// closed by an EA older than v1.28 (or whose version is unknown). This single
// source of truth keeps both UI sites in lockstep so the boundary cannot drift.
//
// SAFETY: pure function, no IO. It only decides whether to show an upgrade
// hint; it never unlocks execution or weakens any gate.
//
// CONTRACT: returns true when the close fill was missing because the EA is too
// old. A null/empty/unparseable version is treated as "too old" — the close
// fill is missing and we cannot prove a modern EA, so the nudge still applies.
// Versions >= 1.28 are NOT flagged: those UNKNOWN cases are a genuine broker
// issue, not an EA age problem, so showing an upgrade hint would mislead.

export const EA_CLOSE_FILL_MIN_MAJOR = 1 as const;
export const EA_CLOSE_FILL_MIN_MINOR = 28 as const;

export function eaTooOldForCloseFill(version: string | null | undefined): boolean {
  if (!version) return true;
  const m = version.match(/(\d+)\.(\d+)/);
  if (!m) return true;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return true;
  return (
    major < EA_CLOSE_FILL_MIN_MAJOR ||
    (major === EA_CLOSE_FILL_MIN_MAJOR && minor < EA_CLOSE_FILL_MIN_MINOR)
  );
}

// ── Why is this row's P/L UNKNOWN? ─────────────────────────────────────────
//
// pnlStatus="UNKNOWN" is written by two DIFFERENT paths and they have nothing
// to do with each other:
//
//   1. A real broker close whose EA close-result carried no usable fill price
//      (routes/livePositions.ts -> dataQualityFlag="MISSING_CLOSE_FILL_PRICE").
//      Here "the broker did not return a usable close fill price" is TRUE, and
//      an EA older than v1.28 is a real and actionable cause.
//
//   2. A SIMULATED close through POST /trade-management/:id/close
//      (dataQualityFlag="SIMULATED_CLOSE_NO_PRICED_PNL"). That path involves no
//      EA and no broker at all: it refuses to write a dollar P/L because it has
//      no contract size, pip value or quote-currency conversion. `eaCloseFill`
//      never gets a version for these rows, so `reportedEaVersion` is null —
//      and `eaTooOldForCloseFill(null)` is `true` by design.
//
// Rendering path 1's copy for a path 2 row prints a false causal claim: it
// blames an EA that was never involved and tells the user to upgrade to v1.28
// to fix something no EA version can fix, while the tooltip asserts a broker
// close-result that never existed. The governing rule of this repository —
// a surface may never claim more than the code delivers — makes that a defect
// even though the headline "P/L unavailable" is itself honest.
//
// This resolver is the single place that decides which explanation a row gets.

/** dataQualityFlag written by the simulated (non-broker) close path. */
export const PNL_FLAG_SIMULATED_CLOSE = "SIMULATED_CLOSE_NO_PRICED_PNL" as const;

export type UnknownPnlCause = "SIMULATED_CLOSE" | "BROKER_CLOSE_FILL_MISSING";

export interface UnknownPnlExplanation {
  cause: UnknownPnlCause;
  /** Prose shown on the "P/L unavailable" tooltip. Must be true of THIS row. */
  tooltip: string;
  /**
   * Whether to show the "EA too old to report close fill — upgrade to v1.28"
   * nudge. Only ever true for a real broker close: an EA upgrade cannot make a
   * simulated close priceable, so nudging there is a false causal claim.
   */
  showEaUpgradeHint: boolean;
}

export function isSimulatedUnpricedClose(dataQualityFlag: string | null | undefined): boolean {
  return dataQualityFlag === PNL_FLAG_SIMULATED_CLOSE;
}

export const SIMULATED_CLOSE_PNL_TOOLTIP =
  "This trade was closed in-app by the simulator, not by a broker. That path " +
  "has no contract size or currency conversion for this symbol, so no " +
  "profit/loss amount can be computed — the win/loss direction is still real. " +
  "This row is excluded from your totals and win-rate.";

export const BROKER_CLOSE_FILL_PNL_TOOLTIP =
  "The broker did not return a usable close fill price for this trade, so we " +
  "won't show a profit/loss number we can't trust. This row is excluded from " +
  "your totals and win-rate.";

export function explainUnknownPnl(input: {
  dataQualityFlag?: string | null;
  reportedEaVersion?: string | null;
}): UnknownPnlExplanation {
  if (isSimulatedUnpricedClose(input.dataQualityFlag)) {
    return {
      cause: "SIMULATED_CLOSE",
      tooltip: SIMULATED_CLOSE_PNL_TOOLTIP,
      showEaUpgradeHint: false,
    };
  }
  return {
    cause: "BROKER_CLOSE_FILL_MISSING",
    tooltip: BROKER_CLOSE_FILL_PNL_TOOLTIP,
    showEaUpgradeHint: eaTooOldForCloseFill(input.reportedEaVersion),
  };
}
