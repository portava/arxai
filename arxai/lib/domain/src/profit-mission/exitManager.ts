// ── Profit Mission Phase 8 — Exit Manager Pro (pure, PROTECTIVE/ADVISORY-only) ──
//
// PLANNING / ADVISORY ONLY. Given the state of an OPEN mission trade plus the
// live signals a caller can honestly observe, this engine decides the next
// protective exit ACTION (move to break-even, trail the stop, take a partial,
// close, or adjust the target). It NEVER places an order itself — the backend
// maps the returned decision onto the EXISTING instant-trade actions
// (CLOSE / CLOSE+closeVolume / MODIFY_SL_TP). It can only protect or reduce
// exposure; it can never open, add, or relax a gate.
//
// HONESTY CONTRACT:
//   - No exit is invented from missing data. When entry/current price are
//     unknown the engine returns NONE with an "unknown" note rather than a
//     fabricated action.
//   - Scalp mode protects winners FASTER; quality trends are allowed to breathe.
//   - No guaranteed-profit vocabulary — every reason is an estimate/observation.
//
// PURE + DETERMINISTIC + IO-FREE.

export type ExitActionKind =
  | "NONE"
  | "MOVE_BREAKEVEN"
  | "TRAIL"
  | "PARTIAL_CLOSE"
  | "CLOSE"
  | "ADJUST_TARGET";

export type ExitTrigger =
  | "tp1_reached"
  | "target_hit"
  | "structure_break"
  | "invalidation"
  | "agent_disagreement"
  | "order_flow_reversal"
  | "high_impact_news"
  | "unstable_spread"
  | "giveback"
  | "trail_advance"
  | "breakeven_secure";

export interface ExitManagerInput {
  side: "BUY" | "SELL";
  entryPrice?: number | null;
  currentPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  /** Max favourable excursion in price (peak distance reached in your favour). */
  mfePrice?: number | null;
  /** Average true range in price terms (used to size a trail; optional). */
  atr?: number | null;
  /** Scalp trades protect profit faster than swing/trend trades. */
  isScalp?: boolean;
  /** TP1 partial fraction already taken (0..1); used to avoid re-firing TP1. */
  partialTaken?: number | null;
  /** Has the stop already been moved to (or beyond) break-even? */
  breakevenDone?: boolean;
  // ── Honest live signals (default to the SAFE "no anomaly" value) ──
  invalidation?: boolean;
  agentDisagreement?: boolean;
  orderFlowReversal?: boolean;
  highImpactNewsImminent?: boolean;
  unstableSpread?: boolean;
  structureBreak?: boolean;
  /** Fraction of progress from entry → take-profit that should trigger TP1 (default 0.5). */
  tp1ProgressFraction?: number | null;
  /** Fraction of TP1 size to take as the partial (default 0.33 / scalp 0.5). */
  tp1CloseFraction?: number | null;
}

export interface ExitDecision {
  action: ExitActionKind;
  /** For PARTIAL_CLOSE: fraction (0..1) of the remaining position to close. */
  closeFraction: number | null;
  /** For TRAIL / MOVE_BREAKEVEN / ADJUST_TARGET: the new price level. */
  newPrice: number | null;
  trigger: ExitTrigger | null;
  /** Why this trade exit may be justified even if it captures less (no punish). */
  justifiedEarlyExit: boolean;
  reasons: string[];
  warnings: string[];
}

function isNum(n: number | null | undefined): n is number {
  return n != null && Number.isFinite(n);
}
function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

function none(reason: string, warnings: string[] = []): ExitDecision {
  return {
    action: "NONE",
    closeFraction: null,
    newPrice: null,
    trigger: null,
    justifiedEarlyExit: false,
    reasons: [reason],
    warnings,
  };
}

/** Signed favourable progress in price terms (positive = in profit). */
function favourable(side: "BUY" | "SELL", entry: number, price: number): number {
  return side === "BUY" ? price - entry : entry - price;
}

/**
 * Decide the next protective exit action for an open mission trade. Highest-
 * urgency protective triggers (full CLOSE) are evaluated first, then target
 * adjustment, then partial/break-even/trail. Returns NONE when nothing is due
 * or when prices are unknown (never fabricates an exit).
 */
export function decideExit(input: ExitManagerInput): ExitDecision {
  const warnings: string[] = [];
  const scalp = input.isScalp === true;

  if (!isNum(input.entryPrice) || !isNum(input.currentPrice)) {
    return none("Exit unknown — entry/current price not observed.", [
      "Price inputs missing; no exit action inferred.",
    ]);
  }
  const entry = input.entryPrice;
  const price = input.currentPrice;
  const fav = favourable(input.side, entry, price);
  const inProfit = fav > 0;

  // ── 1. Hard protective CLOSE triggers (most urgent first). ───────────────────
  // Invalidation / structure break / order-flow reversal: the thesis is gone —
  // closing is risk-justified even when it captures less than the peak.
  if (input.invalidation === true) {
    return {
      action: "CLOSE",
      closeFraction: 1,
      newPrice: null,
      trigger: "invalidation",
      justifiedEarlyExit: true,
      reasons: ["Setup invalidated — closing to protect capital (justified early exit)."],
      warnings,
    };
  }
  if (input.structureBreak === true) {
    return {
      action: "CLOSE",
      closeFraction: 1,
      newPrice: null,
      trigger: "structure_break",
      justifiedEarlyExit: true,
      reasons: ["Market structure broke against the trade — protective close (justified)."],
      warnings,
    };
  }
  if (input.orderFlowReversal === true) {
    return {
      action: "CLOSE",
      closeFraction: 1,
      newPrice: null,
      trigger: "order_flow_reversal",
      justifiedEarlyExit: true,
      reasons: ["Order flow reversed against the position — protective close (justified)."],
      warnings,
    };
  }
  // High-impact news imminent: exit before the event rather than hold blind.
  if (input.highImpactNewsImminent === true) {
    return {
      action: "CLOSE",
      closeFraction: 1,
      newPrice: null,
      trigger: "high_impact_news",
      justifiedEarlyExit: true,
      reasons: ["High-impact news imminent — exiting before the event (justified early exit)."],
      warnings,
    };
  }
  // Unstable spread: close (scalp) or warn-and-protect (swing). A scalp cannot
  // survive an unstable spread; a trend trade gets a break-even nudge instead.
  if (input.unstableSpread === true) {
    if (scalp) {
      return {
        action: "CLOSE",
        closeFraction: 1,
        newPrice: null,
        trigger: "unstable_spread",
        justifiedEarlyExit: true,
        reasons: ["Spread unstable on a scalp — protective close (justified early exit)."],
        warnings,
      };
    }
    warnings.push("Spread unstable — protecting the stop rather than holding loosely.");
  }
  // Agent disagreement: a team split is a downgrade, not an emergency — protect
  // the stop (break-even if in profit), do not force a close.
  if (input.agentDisagreement === true && inProfit && input.breakevenDone !== true) {
    return {
      action: "MOVE_BREAKEVEN",
      closeFraction: null,
      newPrice: round5(entry),
      trigger: "breakeven_secure",
      justifiedEarlyExit: false,
      reasons: ["Agents disagree while in profit — securing break-even to remove risk."],
      warnings,
    };
  }

  // ── 2. Target reached → CLOSE (capture the planned target). ──────────────────
  if (isNum(input.takeProfit)) {
    const hitTarget =
      input.side === "BUY" ? price >= input.takeProfit : price <= input.takeProfit;
    if (hitTarget) {
      return {
        action: "CLOSE",
        closeFraction: 1,
        newPrice: null,
        trigger: "target_hit",
        justifiedEarlyExit: false,
        reasons: ["Take-profit target reached — capturing the planned target."],
        warnings,
      };
    }
  }

  // ── 3. TP1 partial + break-even (protect winners; scalp faster). ─────────────
  if (isNum(input.takeProfit) && inProfit) {
    const totalToTp = Math.abs(input.takeProfit - entry);
    if (totalToTp > 0) {
      const progress = fav / totalToTp; // 0..1 toward the target
      const tp1Frac = isNum(input.tp1ProgressFraction)
        ? Math.min(0.95, Math.max(0.1, input.tp1ProgressFraction))
        : scalp
          ? 0.4
          : 0.5;
      const alreadyTookTp1 = isNum(input.partialTaken) && input.partialTaken > 0;
      if (progress >= tp1Frac && !alreadyTookTp1) {
        const closeFrac = isNum(input.tp1CloseFraction ?? null)
          ? Math.min(0.9, Math.max(0.1, input.tp1CloseFraction as number))
          : scalp
            ? 0.5
            : 0.33;
        return {
          action: "PARTIAL_CLOSE",
          closeFraction: round5(closeFrac),
          newPrice: null,
          trigger: "tp1_reached",
          justifiedEarlyExit: false,
          reasons: [
            `Reached TP1 (${Math.round(progress * 100)}% to target) — taking ${Math.round(
              closeFrac * 100,
            )}% partial and protecting the rest.`,
          ],
          warnings,
        };
      }
      // After TP1 has been taken, the stop must not stay below entry.
      if (alreadyTookTp1 && input.breakevenDone !== true) {
        return {
          action: "MOVE_BREAKEVEN",
          closeFraction: null,
          newPrice: round5(entry),
          trigger: "breakeven_secure",
          justifiedEarlyExit: false,
          reasons: ["TP1 banked — moving the stop to break-even to protect the runner."],
          warnings,
        };
      }
    }
  }

  // ── 4. Trail the stop on a healthy runner (let quality trends breathe). ──────
  // Only trails when in profit past break-even, using ATR when available so the
  // trail respects volatility rather than choking the trade.
  if (inProfit && input.breakevenDone === true && isNum(input.stopLoss)) {
    const trailDist = isNum(input.atr) && input.atr > 0 ? (scalp ? input.atr * 1.0 : input.atr * 1.5) : null;
    if (trailDist != null) {
      const candidate = input.side === "BUY" ? price - trailDist : price + trailDist;
      const improves =
        input.side === "BUY" ? candidate > input.stopLoss : candidate < input.stopLoss;
      if (improves) {
        return {
          action: "TRAIL",
          closeFraction: null,
          newPrice: round5(candidate),
          trigger: "trail_advance",
          justifiedEarlyExit: false,
          reasons: [`Runner advancing — trailing the stop to ${round5(candidate)} (ATR-based).`],
          warnings,
        };
      }
    } else {
      warnings.push("ATR unknown — holding the existing stop rather than guessing a trail level.");
    }
  }

  return none(
    inProfit
      ? "In profit — no protective action due yet."
      : "No exit trigger — holding within the planned stop.",
    warnings,
  );
}
