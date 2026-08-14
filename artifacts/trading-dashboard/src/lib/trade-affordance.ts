// ── Trade affordance (feed-truth honesty for trade surfaces) ─────────────────
//
// Task #464. A pure, deterministic helper every trade surface (Scanner result
// modal, chart instant place, live tickets, selected-market panel) consults so
// a user can never act on a read that ISN'T live while believing it is.
//
// SAFETY CONTRACT — this helper NEVER disables a trade and NEVER bypasses a
// gate. `canTrade` (the account-mode/permission resolver) stays the SOLE
// enable/disable authority, so the owner/admin controlled-live-testing path is
// completely untouched. All this does is decide whether a surface should:
//   • show a plain-English warning banner, and/or
//   • require a one-tap acknowledgement before the final Confirm.
//
// It is driven ONLY by the shared ScannerTruth (the single honest market
// source) and is mode-aware:
//   • truth null / still loading  → no warning, no ack (don't nag prematurely)
//   • read_only mode              → no warning, no ack (no trade buttons render)
//   • truth.actionable === true   → no warning, no ack. This INCLUDES the
//                                   GBPUSD case (genuinely live, but via ARX
//                                   market data rather than the broker chart
//                                   feed): the data is fresh enough to trade,
//                                   so source honesty is the dataHealth panel's
//                                   job — never trade friction.
//   • truth && !actionable        → warn (stale / delayed-composite / historical
//                                   / unavailable). The explicit ack checkbox is
//                                   DEMO-scoped only, so live one-click stays
//                                   frictionless; the warning still shows in both
//                                   demo and live.

import type { ScannerTruth } from "./scannerTruth";

export type TradeAffordanceMode = "demo" | "live" | "read_only";

export interface TradeAffordance {
  /**
   * When true, the surface should require a one-tap acknowledgement before the
   * final Confirm — because the read is NOT actionable (stale / delayed /
   * historical / unavailable). This NEVER disables the button on its own;
   * canTrade remains the sole enable/disable authority. Demo-scoped only.
   */
  requireAck: boolean;
  /** Short, plain-English banner title (empty string when there's no warning). */
  warningTitle: string;
  /** Plain-English banner detail: source honesty + the exact reason. Empty when none. */
  warningDetail: string;
  // ── Shared trade-health / readiness (DISPLAY-ONLY) ─────────────────────────
  // Mirrors `ScannerTruth.readiness` (the ONE Trade-Health contract verdict that
  // Ruby's chart read also composes) so every trade surface shows an IDENTICAL
  // read-quality label + trust line and the SAME display affordance ceilings for
  // the same symbol+timeframe.
  //
  // SAFETY: these are DISPLAY CEILINGS. They NEVER enable a trade and must NEVER
  // be ANDed into the live Confirm / one-click button — `canTrade` (and the
  // backend 18-gate pipeline) stay the sole execution authority, so the
  // owner/admin controlled-live path is untouched. Callers AND these flags only
  // with NON-authoritative affordances (e.g. an AI "Use this setup" offer, a
  // scanner plan button) and use `readinessLabel` / `readinessTrustLine` purely
  // for wording. They can hide an affordance, never reveal one.
  /** Short read-state label (e.g. "Live-confirmed", "Historical read only"). */
  readinessLabel: string;
  /** Plain-English read-quality one-liner — identical across surfaces per input. */
  readinessTrustLine: string;
  /** Display ceiling: UI may present a concrete directional setup narrative. */
  mayDescribeSetup: boolean;
  /** Display ceiling: UI may render a place-order button (still AND canTrade/mode). */
  mayShowTradeButton: boolean;
  /** Display ceiling: UI may render the one-click affordance (still AND armed). */
  mayShowOneClickButton: boolean;
  /** Display ceiling: UI may OFFER a live-execution request (still AND live/approval). */
  mayOfferLiveExecutionRequest: boolean;
}

const NONE: TradeAffordance = {
  requireAck: false,
  warningTitle: "",
  warningDetail: "",
  readinessLabel: "",
  readinessTrustLine: "",
  mayDescribeSetup: false,
  mayShowTradeButton: false,
  mayShowOneClickButton: false,
  mayOfferLiveExecutionRequest: false,
};

export function resolveTradeAffordance(
  truth: ScannerTruth | null,
  tradeMode: TradeAffordanceMode,
): TradeAffordance {
  // No resolved truth yet → nothing to say (don't nag prematurely).
  if (!truth) return NONE;

  // The shared read-quality label + trust line are surfaced regardless of mode
  // (read honesty applies even in read-only). The display affordance ceilings,
  // however, are forced OFF in read_only mode since that mode renders no trade
  // affordances at all — never an upgrade, only a tighter cap.
  const r = truth.readiness;
  const ceilingActive = tradeMode !== "read_only";
  const readinessFields = {
    readinessLabel: r.displayLabel,
    readinessTrustLine: r.userFacingTrustLine,
    mayDescribeSetup: ceilingActive && r.mayDescribeSetup,
    mayShowTradeButton: ceilingActive && r.mayShowTradeButton,
    mayShowOneClickButton: ceilingActive && r.mayShowOneClickButton,
    mayOfferLiveExecutionRequest: ceilingActive && r.mayOfferLiveExecutionRequest,
  };

  // read_only renders no trade buttons → no warning/ack, just the read label.
  if (tradeMode === "read_only") return { ...NONE, ...readinessFields };

  // Genuinely live, actionable read → no friction. (GBPUSD-live-via-ARX lands
  // here: actionable is true, so we don't warn; the dataHealth panel still tells
  // the user the bars are ARX market data, not the broker chart feed.)
  if (truth.actionable) return { ...NONE, ...readinessFields };

  // Not actionable: surface the honest headline + source + exact reason so the
  // user never mistakes a stale/historical/composite read for a live one.
  const dh = truth.dataHealth;
  const warningTitle = dh.headline;
  const warningDetail = `${dh.sourceNote} ${truth.candles.reason}`.trim();

  // The ack checkbox is DEMO-only. Live stays ack-free so owner/admin one-click
  // is never gated by this helper — the warning still renders, and the backend
  // 18-gate pipeline plus canTrade remain the real authorities.
  return {
    requireAck: tradeMode === "demo",
    warningTitle,
    warningDetail,
    ...readinessFields,
  };
}
