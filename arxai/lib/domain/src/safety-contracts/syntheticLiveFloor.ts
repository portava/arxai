// Deriv-synthetic LIVE tradability floor (pure, deterministic).
//
// PURPOSE: a symbol whose data source is a Deriv synthetic / data-only feed is,
// in general, NOT routable on a standard MT5 broker, so dispatching one would
// silently fail or route to the wrong instrument. The live pipeline keeps a hard
// refusal for everyone EXCEPT the owner/admin unrestricted profile, and even
// then ONLY when the connected master broker is Deriv, the symbol is not blocked
// by reported broker truth, AND the symbol is genuinely ticking right now (a
// confirmed per-symbol live tick within the freshness window). The live-tick
// requirement (Task #542) is a TIGHTENING that never relaxes the floor: it adds
// an honest refusal so a stale / historical synthetic read can never become a
// live entry.
//
// SAFETY: pure function, no IO. It decides ONLY which floor verdict applies; it
// never unlocks execution or weakens any gate. The real broker-side symbol /
// margin validation at OrderSend remains the final authority. This is the SINGLE
// source of truth shared by BOTH live chokepoints (createLiveDraft preflight and
// dispatchLiveCommand re-check) so the two can never drift, and it is exercised
// directly by `scripts/src/syntheticLiveFloorUnitTest.ts` in the pre-commit gate.

export type SyntheticLiveFloorVerdict =
  // The symbol is not a Deriv synthetic / data-only market — the floor does not
  // engage and the caller proceeds to the remaining checks.
  | "NOT_ENGAGED"
  // Owner/admin-unrestricted + Deriv broker + not broker-blocked + a confirmed
  // live tick — the synthetic may proceed (still subject to every later gate).
  | "ALLOWED"
  // A tradable synthetic on a Deriv broker, but with NO confirmed live tick
  // right now (transient — awaiting / stale feed). Live entry is refused until
  // a live tick is confirmed.
  | "SYNTHETIC_FEED_NOT_LIVE_CONFIRMED"
  // The permanent data-only floor: a normal user, a non-Deriv broker, or broker
  // truth that blocks the symbol. MT5 live execution is unavailable regardless
  // of risk profile.
  | "SYMBOL_NOT_LIVE_TRADABLE";

export type SymbolFeedVerdict = "LIVE" | "LIVE_DELAYED" | "AWAITING";

export interface SyntheticLiveFloorInput {
  /** True when the symbol classifies as a Deriv synthetic / data-only feed
   *  (`tradability.assetClass === "synthetic" || tradability.dataProvider === "deriv"`). */
  isSyntheticOrDataOnly: boolean;
  /** True only for the owner/admin unrestricted profile (the sole profile the
   *  relaxation can apply to). */
  isOwnerUnrestricted: boolean;
  /** True when the connected active master broker is Deriv. */
  brokerIsDeriv: boolean;
  /** True when reported broker truth blocks the symbol (not tradable / not
   *  visible / trade mode DISABLED or CLOSEONLY). */
  brokerTruthBlocks: boolean;
  feedVerdict: SymbolFeedVerdict;
}

/**
 * Decide which synthetic-floor verdict applies. Mirrors EXACTLY the branch logic
 * at both live chokepoints — extracting it here removes the duplicated logic that
 * could otherwise drift between preflight and dispatch.
 */
export function evaluateSyntheticLiveFloor(
  input: SyntheticLiveFloorInput,
): SyntheticLiveFloorVerdict {
  if (!input.isSyntheticOrDataOnly) return "NOT_ENGAGED";
  // `ownerDerivTradable` can only be true for the owner-unrestricted profile on
  // a Deriv broker that broker truth does not block — matching the pipeline,
  // where these are computed only inside the `isOwnerUnrestricted` branch.
  const ownerDerivTradable =
    input.isOwnerUnrestricted && input.brokerIsDeriv && !input.brokerTruthBlocks;
  const allowDerivSynthetic = ownerDerivTradable && input.feedVerdict === "LIVE";
  if (allowDerivSynthetic) return "ALLOWED";
  // Distinguish "tradable synthetic, but not live-confirmed right now" (transient)
  // from the permanent "data-only market" floor, so the operator sees the true
  // cause.
  if (ownerDerivTradable && input.feedVerdict !== "LIVE") {
    return "SYNTHETIC_FEED_NOT_LIVE_CONFIRMED";
  }
  return "SYMBOL_NOT_LIVE_TRADABLE";
}
