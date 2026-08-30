// Execution-environment scoping for the legacy `trades` money views.
//
// WHY THIS EXISTS
// ---------------
// `trades.mode` is stamped at creation and is either "DEMO" (a simulator
// figure) or "LIVE" (broker-reported realised P/L written by the live close
// seam). Before this module the performance/exposure aggregates summed both
// into a single "Realized P/L" — real broker money added to simulated money,
// with no basis stated anywhere on the page, while the Win/Loss Report told
// the user in writing that "Results are never mixed across environments".
//
// THE RULE
// --------
// A money aggregate is scoped to EXACTLY ONE environment. Never summed.
// The scope is deterministic (same input → same scope) so every route that
// uses this helper agrees, and the chosen scope is reported to the client so
// the UI can render the basis next to the figure.
//
// SCOPE CHOICE
//   LIVE  — the user has at least one non-cancelled LIVE trade. Real money
//           dominates: that is the figure a trader acts on.
//   DEMO  — otherwise (including the no-trades case).
// The count of closed trades in the other environment is reported so the UI
// can say "N DEMO trades not included" instead of silently dropping them.

export type ScopeMode = "LIVE" | "DEMO";
export type ScopeModeReason = "LIVE_TRADES_PRESENT" | "ONLY_DEMO_TRADES" | "NO_TRADES";

export interface ScopeableTrade {
  mode?: string | null;
  status?: string | null;
  pnlStatus?: string | null;
}

/** Normalise the stored mode string. Anything that is not LIVE is DEMO. */
export function normaliseTradeMode(mode: string | null | undefined): ScopeMode {
  return String(mode ?? "DEMO").trim().toUpperCase() === "LIVE" ? "LIVE" : "DEMO";
}

export interface TradeScope {
  mode: ScopeMode;
  reason: ScopeModeReason;
}

/**
 * Pick the single environment every aggregate in a response is scoped to.
 * CANCELLED rows are ignored — they never produced money in any environment.
 */
export function resolveTradeScope(trades: ScopeableTrade[]): TradeScope {
  const relevant = trades.filter((t) => t.status !== "CANCELLED");
  if (relevant.some((t) => normaliseTradeMode(t.mode) === "LIVE")) {
    return { mode: "LIVE", reason: "LIVE_TRADES_PRESENT" };
  }
  return relevant.length > 0
    ? { mode: "DEMO", reason: "ONLY_DEMO_TRADES" }
    : { mode: "DEMO", reason: "NO_TRADES" };
}

/** Rows that belong to the chosen scope. */
export function inScope<T extends ScopeableTrade>(trades: T[], mode: ScopeMode): T[] {
  return trades.filter((t) => normaliseTradeMode(t.mode) === mode);
}

/**
 * How many CLOSED rows were dropped because they belong to the other
 * environment. Surfaced so the exclusion is visible, never silent.
 */
export function countClosedOutOfScope(trades: ScopeableTrade[], mode: ScopeMode): number {
  return trades.filter(
    (t) =>
      t.status !== "OPEN" &&
      t.status !== "CANCELLED" &&
      normaliseTradeMode(t.mode) !== mode,
  ).length;
}
