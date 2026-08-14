// ── Profit Mission Phase 8 — Controlled Compounding (pure, STRICTER-aware) ──────
//
// PLANNING / SIZING-only. Decides whether a mission may compound (scale up risk
// from accumulated profit) and by how much. The multiplier is applied ON TOP of
// the profile risk by the backend; this engine never sizes or places an order.
//
// HARD SAFETY RULES (all must hold to activate):
//   - Compounding uses REALISED CLOSED PROFIT ONLY — never floating/unrealised P/L.
//   - NEVER activates during drawdown (current value below the mission peak, or a
//     non-zero drawdown percentage).
//   - NEVER activates after a single lucky win — a minimum number of realised
//     trades AND a non-negative realised win contribution is required.
//   - Requires the user to have allowed it AND the Risk Governor mode to permit.
//   - The multiplier is capped per mode and is ≥ 1 only when active; when any
//     gate fails the multiplier is exactly 1 (no boost) — fail toward LESS risk.
//
// PURE + DETERMINISTIC + IO-FREE.

import type { MissionMode } from "./missionRisk.js";

export type CompoundingMode = "off" | "conservative" | "balanced" | "aggressive";

/** Maximum risk multiplier each mode may reach at full eligibility. */
const MODE_CEILING: Record<CompoundingMode, number> = {
  off: 1,
  conservative: 1.15,
  balanced: 1.35,
  aggressive: 1.6,
};

/** Minimum realised closed trades before compounding is allowed (not one win). */
const MIN_REALISED_TRADES = 3;

export interface CompoundingInput {
  mode: CompoundingMode;
  /** The user explicitly enabled compounding. */
  userAllowed: boolean;
  /** REALISED closed profit accumulated by the mission, account currency. */
  realisedProfit?: number | null;
  /** Count of CLOSED realised trades (a single win must not trigger compounding). */
  realisedTradeCount?: number | null;
  /** Current mission drawdown percent (0 = at/above peak). Any > 0 blocks. */
  drawdownPct?: number | null;
  /** Risk Governor / mission mode — only calm modes may compound. */
  governorMode: MissionMode;
  /** Agents performing acceptably (advisory health gate). Default true. */
  agentsHealthy?: boolean;
  /** Fraction of realised profit to deploy as extra risk (0..1, default 0.5). */
  reinvestFraction?: number | null;
  /** Mission base capital (to scale the realised-profit boost), account currency. */
  baseCapital?: number | null;
}

export interface CompoundingVerdict {
  active: boolean;
  /** Risk multiplier to apply on top of profile risk (≥ 1; exactly 1 when off). */
  multiplier: number;
  /** Realised profit eligible to be reinvested (never floating). */
  reinvestibleProfit: number;
  reasons: string[];
  blockers: string[];
}

function isNum(n: number | null | undefined): n is number {
  return n != null && Number.isFinite(n);
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Mission modes calm enough to permit compounding. */
function modePermits(mode: MissionMode): boolean {
  return mode === "attack" || mode === "normal";
}

/**
 * Evaluate controlled compounding. Returns multiplier 1 (no boost) whenever any
 * safety gate fails — in particular during ANY drawdown, on floating-only
 * profit, after a single win, or when the user/governor has not permitted it.
 */
export function evaluateCompounding(input: CompoundingInput): CompoundingVerdict {
  const reasons: string[] = [];
  const blockers: string[] = [];

  const inactive = (extra?: string): CompoundingVerdict => {
    if (extra) blockers.push(extra);
    return {
      active: false,
      multiplier: 1,
      reinvestibleProfit: 0,
      reasons,
      blockers,
    };
  };

  if (input.mode === "off") return inactive("Compounding is off.");
  if (input.userAllowed !== true) return inactive("User has not enabled compounding.");
  if (!modePermits(input.governorMode)) {
    return inactive(`Risk Governor mode (${input.governorMode}) does not permit compounding.`);
  }
  if (input.agentsHealthy === false) return inactive("Agent performance below threshold.");

  // NEVER during drawdown.
  if (isNum(input.drawdownPct) && input.drawdownPct > 0) {
    return inactive(`In drawdown (${round2(input.drawdownPct)}%) — compounding disabled.`);
  }

  // REALISED profit only — floating/unknown profit cannot compound.
  const realised = isNum(input.realisedProfit) ? input.realisedProfit : 0;
  if (realised <= 0) {
    return inactive("No realised closed profit to compound (floating P/L is never used).");
  }

  // Not after a single lucky win.
  const trades = isNum(input.realisedTradeCount) ? input.realisedTradeCount : 0;
  if (trades < MIN_REALISED_TRADES) {
    return inactive(
      `Only ${trades} realised trade(s) — need at least ${MIN_REALISED_TRADES} before compounding.`,
    );
  }

  // ── Eligible. Size the boost from realised profit relative to base capital. ──
  const reinvestFraction = clamp(
    isNum(input.reinvestFraction) ? input.reinvestFraction : 0.5,
    0,
    1,
  );
  const reinvestibleProfit = round2(realised * reinvestFraction);

  const ceiling = MODE_CEILING[input.mode];
  let multiplier = ceiling;
  // When base capital is known, scale the boost so a small realised profit only
  // earns a small step toward the ceiling (never the full ceiling off one trade).
  if (isNum(input.baseCapital) && input.baseCapital > 0) {
    const profitRatio = clamp(reinvestibleProfit / input.baseCapital, 0, 1); // 0..1
    multiplier = 1 + (ceiling - 1) * profitRatio;
  }
  multiplier = round2(clamp(multiplier, 1, ceiling));

  reasons.push(
    `Compounding (${input.mode}): reinvesting ${reinvestibleProfit} of realised profit → risk ×${multiplier}.`,
  );

  return {
    active: multiplier > 1,
    multiplier,
    reinvestibleProfit,
    reasons,
    blockers,
  };
}
