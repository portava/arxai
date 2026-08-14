// Agent Ecosystem — Layer 2: outcome resolution (§5, read-only).
//
// Match a LOCKED prediction to a realized outcome using already-available
// evidence (a matched closed trade and/or observed candle movement). PURE and
// OBSERVATION ONLY: this NEVER places, modifies, or closes anything. The
// api-server resolver fetches the evidence; this decides the verdict.

export type ResolvedOutcomeStatus =
  | "WIN" | "LOSS" | "BREAKEVEN"
  | "NO_TRADE_CORRECT" | "NO_TRADE_MISSED"
  | "EXPIRED" | "UNRESOLVED";

export interface OutcomeEvidence {
  closedTradeExists?: boolean;
  closedTradePnlR?: number | null;      // realized R-multiple of a matched trade
  favorableMovePct?: number | null;     // % move in the predicted direction
  adverseMovePct?: number | null;       // % move against the predicted direction
  ageMs?: number;                       // age of the prediction now
  expiryMs?: number;                    // call EXPIRED past this age with no signal
}

export interface OutcomeResolution {
  status: ResolvedOutcomeStatus;
  pnlR: number | null;
  resolvable: boolean;                  // false => leave PENDING, do not score
  reason: string;
}

const BREAKEVEN_R = 0.25;               // |pnlR| <= this is a breakeven
const STRONG_MOVE_PCT = 0.4;            // candle-only "would have won/lost" floor

/** Decide a prediction's realized outcome from observed evidence. PURE. */
export function resolvePredictionOutcome(
  prediction: { decision: string; direction: string | null },
  ev: OutcomeEvidence,
): OutcomeResolution {
  const decision = prediction.decision;
  const isNoTrade = decision === "no_trade" || decision === "reject";
  const isTrade = decision === "approve" || decision === "caution";
  const aged = (ev.ageMs ?? 0) >= (ev.expiryMs ?? Infinity);
  const fav = ev.favorableMovePct ?? null;
  const adv = ev.adverseMovePct ?? null;

  // ── No-trade prediction: was avoiding the trade correct? ──────────────────
  // FAIL-CLOSED: a no-trade call is only judged against OBSERVED market movement.
  // Without real candle-move evidence we leave it UNRESOLVED forever rather than
  // assuming "correct" just because time elapsed (that would fabricate an outcome).
  if (isNoTrade) {
    if (fav == null) {
      return { status: "UNRESOLVED", pnlR: null, resolvable: false,
        reason: "no observed market-move evidence yet to judge the no-trade call" };
    }
    if (fav >= STRONG_MOVE_PCT && (adv == null || adv < fav)) {
      return { status: "NO_TRADE_MISSED", pnlR: null, resolvable: true,
        reason: `avoided a setup that ran ${fav.toFixed(2)}% favorably` };
    }
    if (aged) {
      return { status: "NO_TRADE_CORRECT", pnlR: null, resolvable: true,
        reason: `observed move stayed below the ${STRONG_MOVE_PCT}% threshold through expiry — avoidance correct` };
    }
    return { status: "UNRESOLVED", pnlR: null, resolvable: false,
      reason: "not enough observed movement yet to judge the no-trade call" };
  }

  // ── Trade prediction: prefer a matched closed trade, else candle movement ─
  // FAIL-CLOSED: resolve ONLY on a real closed trade or real decisive/observed
  // candle movement. Elapsed time with NO evidence never resolves — it stays
  // UNRESOLVED so nothing is graded off fabricated/assumed data.
  if (isTrade) {
    if (ev.closedTradeExists && ev.closedTradePnlR != null) {
      const r = ev.closedTradePnlR;
      if (Math.abs(r) <= BREAKEVEN_R) {
        return { status: "BREAKEVEN", pnlR: r, resolvable: true, reason: `closed flat (${r.toFixed(2)}R)` };
      }
      return r > 0
        ? { status: "WIN", pnlR: r, resolvable: true, reason: `closed +${r.toFixed(2)}R` }
        : { status: "LOSS", pnlR: r, resolvable: true, reason: `closed ${r.toFixed(2)}R` };
    }
    if (fav != null && adv != null) {
      if (fav >= STRONG_MOVE_PCT && fav > adv) {
        return { status: "WIN", pnlR: null, resolvable: true, reason: `moved ${fav.toFixed(2)}% favorably` };
      }
      if (adv >= STRONG_MOVE_PCT && adv > fav) {
        return { status: "LOSS", pnlR: null, resolvable: true, reason: `moved ${adv.toFixed(2)}% against` };
      }
      // Real candle evidence, but no decisive move by expiry => an OBSERVED flat.
      if (aged) {
        return { status: "BREAKEVEN", pnlR: null, resolvable: true, reason: "observed no decisive move through expiry" };
      }
    }
    return { status: "UNRESOLVED", pnlR: null, resolvable: false, reason: "awaiting a closed trade or decisive observed move" };
  }

  // observe / unknown decision — never gradeable as a trade, never resolved on
  // age alone.
  return { status: "UNRESOLVED", pnlR: null, resolvable: false, reason: "observation only — never graded" };
}

/** Map a resolved status onto the agent_predictions.outcomeStatus vocabulary. */
export function toPredictionOutcomeStatus(s: ResolvedOutcomeStatus): string {
  return s; // vocabularies are intentionally identical
}
