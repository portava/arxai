// Ruby Flame Scalp — manage-side intelligence (Phase 2), pure & deterministic.
//
// This module reasons about ALREADY-OPEN scalp positions. It answers three
// questions, all as ADVICE ONLY (the system never adds or closes on the user's
// behalf):
//   1. Add-ons   — is it sane to add to this winner, and how much? (0..3 / never)
//   2. Baskets   — group open positions by symbol+direction and aggregate them.
//   3. Exit      — how urgently should the user think about getting out?
//
// HARD RULES honoured here:
//  - No fabrication. With no live flame evidence (blind) we return honest,
//    conservative neutral verdicts — never a confident made-up call.
//  - Recommendations only. ScalpExitVerdict.alertOnly is always true; nothing
//    here closes, modifies, or sizes a real order.
//  - Plain English. No internal gate names, enum tokens, or jargon leak into
//    the user-facing `reason`/`headline`/`detail` strings.
//  - Pure. No I/O, no Date.now() except via an injectable `now` — fully testable.

import type {
  RiskPersonality,
  ScalpAddOnRecommendation,
  ScalpAddOnVerdict,
  ScalpBasket,
  ScalpBasketLeg,
  ScalpBasketSync,
  ScalpDirection,
  ScalpExitAction,
  ScalpExitUrgency,
  ScalpExitVerdict,
  ScalpFlameRead,
} from "./scalpTypes.js";
import { DEFAULT_ASSISTANT_NAME } from "@workspace/domain/assistant-name";

/** A short cool-down after a failed flame before the same side is suggested again. */
export const FAILED_FLAME_LOCKOUT_MS = 3 * 60 * 1000;

/**
 * How old a broker feed sync may be — vs NOW, not vs the newest row — before a
 * basket's prices/floating-P/L must be labeled stale. Beyond this window the
 * bridge is not delivering fresh rows (disconnected, or the sync loop died) and
 * positions may already be closed at the broker without us knowing.
 */
export const BASKET_SYNC_STALE_MS = 90_000;

/**
 * Build the basket sync-freshness block from the feed's newest broker sync time
 * compared to NOW. Pure. A missing/unreported sync time yields the honest
 * "unknown ⇒ stale" block — we never claim freshness we cannot evidence.
 */
export function basketSyncInfo(
  lastSyncedAtMs: number | null,
  now: number = Date.now(),
): ScalpBasketSync {
  if (!num(lastSyncedAtMs) || lastSyncedAtMs <= 0) {
    return { syncedAt: null, ageSeconds: null, stale: true };
  }
  const ageMs = Math.max(0, now - lastSyncedAtMs);
  return {
    syncedAt: new Date(lastSyncedAtMs).toISOString(),
    ageSeconds: Math.round(ageMs / 1000),
    stale: ageMs > BASKET_SYNC_STALE_MS,
  };
}

function num(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// ── Open-position input (mapped from the unified per-user positions feed) ──

export interface OpenPositionInput {
  ticket: string | null;
  symbol: string;
  displayName?: string | null;
  side: string | null; // "BUY" | "SELL" (case-insensitive)
  volume: number | null;
  entryPrice: number | null;
  currentPrice: number | null;
  floatingPl: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: string | null;
  accountMode: "LIVE" | "DEMO";
}

function normalizeDirection(side: string | null): ScalpDirection | null {
  if (!side) return null;
  const s = side.trim().toUpperCase();
  if (s === "BUY" || s === "LONG") return "BUY";
  if (s === "SELL" || s === "SHORT") return "SELL";
  return null;
}

function openedAtMs(v: string | null): number {
  if (!v) return 0;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

interface GroupedLegs {
  symbol: string;
  displayName: string;
  direction: ScalpDirection;
  accountMode: "LIVE" | "DEMO";
  legs: ScalpBasketLeg[];
}

/**
 * Group open positions into baskets keyed by symbol + direction + account mode.
 * Only positions with a real direction, entry price and positive volume are
 * grouped (anything else is honestly dropped, never coerced). Legs are ordered
 * oldest → newest and the newest leg is flagged `isLatest`.
 */
export function groupLegsIntoBaskets(positions: OpenPositionInput[]): GroupedLegs[] {
  const groups = new Map<string, GroupedLegs>();
  for (const p of positions) {
    const dir = normalizeDirection(p.side);
    if (!dir) continue;
    if (!num(p.entryPrice) || !num(p.volume) || p.volume <= 0) continue;
    const key = `${p.accountMode}|${p.symbol}|${dir}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        symbol: p.symbol,
        displayName: p.displayName || p.symbol,
        direction: dir,
        accountMode: p.accountMode,
        legs: [],
      };
      groups.set(key, g);
    }
    g.legs.push({
      ticket: p.ticket,
      volume: p.volume,
      entryPrice: p.entryPrice,
      currentPrice: num(p.currentPrice) ? p.currentPrice : null,
      floatingPl: num(p.floatingPl) ? p.floatingPl : null,
      stopLoss: num(p.stopLoss) ? p.stopLoss : null,
      takeProfit: num(p.takeProfit) ? p.takeProfit : null,
      openedAt: p.openedAt,
      isLatest: false,
    });
  }
  const out: GroupedLegs[] = [];
  for (const g of groups.values()) {
    g.legs.sort((a, b) => openedAtMs(a.openedAt) - openedAtMs(b.openedAt));
    if (g.legs.length > 0) g.legs[g.legs.length - 1]!.isLatest = true;
    out.push(g);
  }
  return out;
}

export interface BasketSummary {
  entryCount: number;
  totalVolume: number;
  averageEntry: number;
  currentPrice: number | null;
  /**
   * Combined floating P/L — non-null ONLY when EVERY leg reported one. A
   * 3-leg basket with a single known leg must never present that leg's P/L
   * as the basket total (and the exit/add-on logic must never reason from
   * such a partial number as if it were the whole).
   */
  combinedFloatingPl: number | null;
  /** How many legs actually reported a floating P/L (vs entryCount total). */
  plKnownLegCount: number;
  breakEvenPrice: number;
  hasUnprotectedLeg: boolean;
}

/** Volume-weighted aggregates for a basket of legs (same symbol+direction). */
export function summarizeBasket(legs: ScalpBasketLeg[]): BasketSummary {
  const entryCount = legs.length;
  let totalVolume = 0;
  let weighted = 0;
  let pl = 0;
  let plKnownLegCount = 0;
  let currentPrice: number | null = null;
  let hasUnprotectedLeg = false;
  for (const leg of legs) {
    totalVolume += leg.volume;
    weighted += leg.volume * leg.entryPrice;
    if (num(leg.floatingPl)) {
      pl += leg.floatingPl;
      plKnownLegCount++;
    }
    if (num(leg.currentPrice)) currentPrice = leg.currentPrice;
    if (!num(leg.stopLoss)) hasUnprotectedLeg = true;
  }
  const averageEntry = totalVolume > 0 ? weighted / totalVolume : 0;
  return {
    entryCount,
    totalVolume,
    averageEntry,
    currentPrice,
    // A partial sum is honestly withheld (null), never shown as the total.
    combinedFloatingPl: entryCount > 0 && plKnownLegCount === entryCount ? pl : null,
    plKnownLegCount,
    breakEvenPrice: averageEntry,
    hasUnprotectedLeg,
  };
}

// ── Flame "health" helpers ────────────────────────────────────────────────

const HEALTHY_STAGES = new Set(["IGNITING", "ACTIVE"]);
const FADING_STAGES = new Set(["WEAKENING", "STRETCH"]);
const DEAD_STAGES = new Set(["EXHAUSTED", "FAILED", "REVERSAL_RISK"]);

function personalityTierShift(p: RiskPersonality): number {
  switch (p) {
    case "AGGRESSIVE":
    case "OWNER_ADMIN":
      return 1;
    case "CONSERVATIVE":
      return -1;
    default:
      return 0;
  }
}

function clampTier(t: number): number {
  return Math.max(0, Math.min(3, t));
}

/**
 * Whether the flame is freshly re-igniting in the basket's favour — the only
 * condition under which adding to a *losing* basket is ever suggested (and only
 * with caution).
 *
 * Extended to include RUN_ON + PULLBACK_REENTRY: a clean re-entry signal during
 * an established run is structurally comparable to a fresh ignition for the
 * purpose of the revenge-trade guard — price pulled back to a zone, the run is
 * healthy, and it qualifies for one cautious add.
 */
function isFreshConfirmation(flame: ScalpFlameRead): boolean {
  if (flame.blind || flame.scalpStatus !== "STRONG" || flame.chaseRisk === "EXTREME") return false;
  // Classic fresh confirmation: igniting or active with a clean timing signal.
  if (HEALTHY_STAGES.has(flame.flameStage) && (flame.entryTiming === "EARLY" || flame.entryTiming === "CLEAN")) return true;
  // Run-on pullback re-entry: a structured re-entry in the direction of an established run.
  if (flame.flameStage === "RUN_ON" && flame.entryTiming === "PULLBACK_REENTRY") return true;
  return false;
}

/** Base add-on tier (0..3) from flame strength alone, before guards/personality. */
function baseAddOnTier(flame: ScalpFlameRead): number {
  if (flame.blind) return 0;
  if (DEAD_STAGES.has(flame.flameStage)) return 0;
  if (flame.scalpStatus === "NOT_A_SCALP" || flame.readDirection === "NO_SCALP") return 0;
  if (flame.chaseRisk === "EXTREME" || flame.runway === "NONE") return 0;
  if (FADING_STAGES.has(flame.flameStage)) return 0;
  // Explicit run-on quality gate: a very low quality score (< 0.3) indicates
  // a choppy or wick-heavy run that doesn't warrant any add-on, even when the
  // stage has not yet degraded to WEAKENING. Fail-closed.
  if (flame.flameStage === "RUN_ON" && flame.runOnTrace && flame.runOnTrace.qualityScore < 0.3) return 0;

  let tier: number;
  if (flame.scalpStatus === "STRONG" && HEALTHY_STAGES.has(flame.flameStage)) tier = 3;
  else if (flame.scalpStatus === "STRONG" && flame.flameStage === "RUN_ON") tier = 2;
  else if (flame.scalpStatus === "POSSIBLE" && HEALTHY_STAGES.has(flame.flameStage)) tier = 2;
  else if (flame.scalpStatus === "POSSIBLE") tier = 1;
  else tier = 1; // WEAK but still a live, non-fading flame

  // Timing / runway / chase soften the ceiling.
  if (flame.entryTiming === "LATE" || flame.entryTiming === "CHASING" || flame.entryTiming === "NO_ENTRY") {
    tier = Math.min(tier, 1);
  }
  if (flame.chaseRisk === "HIGH" || flame.runway === "TIGHT") tier = Math.min(tier, 1);
  return clampTier(tier);
}

/**
 * Add-on permission: how much (0..3) it is sane to add to an open basket on the
 * same side, with a revenge-trade guard and a profit-cushion check. Advice only.
 */
export function evaluateAddOn(
  flame: ScalpFlameRead,
  summary: BasketSummary,
  personality: RiskPersonality = "BALANCED",
): ScalpAddOnVerdict {
  const profitCushion = summary.combinedFloatingPl;
  const usedAddOns = Math.max(0, summary.entryCount - 1);
  const losing = num(profitCushion) && profitCushion < 0;

  // Personality may only widen/narrow a tier that is ALREADY alive. A dead/fading/
  // extreme-chase/no-runway flame forces base 0; an AGGRESSIVE/OWNER_ADMIN +1 must
  // NOT resurrect it (that would be the revenge-trade the engine exists to prevent).
  const baseTier = baseAddOnTier(flame);
  let maxAddOns = baseTier > 0 ? clampTier(baseTier + personalityTierShift(personality)) : 0;
  let revengeGuardTriggered = false;
  let requiresFreshConfirmation = false;
  let recommendation: ScalpAddOnRecommendation;
  let reason: string;

  if (flame.blind) {
    maxAddOns = 0;
    requiresFreshConfirmation = true;
    recommendation = "HOLD";
    reason =
      `${DEFAULT_ASSISTANT_NAME} can't see a live burst on this market right now, so there's nothing to add to yet — hold what you have.`;
  } else if (maxAddOns === 0) {
    recommendation = "DO_NOT_ADD";
    reason = DEAD_STAGES.has(flame.flameStage)
      ? "This move has run out of steam. Don't add here — protect what's open instead."
      : "There's no clean burst to add into right now. Wait for a fresh, strong restart before scaling in.";
  } else if (losing) {
    // Revenge-trade guard: never nudge averaging-down a loser unless the flame
    // is freshly re-igniting in our favour — and even then, with caution.
    revengeGuardTriggered = true;
    requiresFreshConfirmation = true;
    if (isFreshConfirmation(flame)) {
      maxAddOns = 1;
      const remaining = Math.max(0, maxAddOns - usedAddOns);
      recommendation = remaining > 0 ? "ADD_WITH_CAUTION" : "HOLD";
      reason =
        remaining > 0
          ? "You're underwater here. There's a fresh push in your favour, so a single, small add is defensible — but keep it tight and don't chase."
          : "You're underwater and already scaled in. Don't add more — manage what's open.";
    } else {
      maxAddOns = 0;
      recommendation = "DO_NOT_ADD";
      reason =
        "You're losing on this one. Adding now would just be chasing a loser — wait for a clean, fresh restart before even thinking about it.";
    }
  } else {
    const remaining = Math.max(0, maxAddOns - usedAddOns);
    if (remaining <= 0) {
      recommendation = "HOLD";
      reason = "You've already scaled in as far as this burst justifies. Hold and manage the basket.";
    } else {
      // A RUN_ON + PULLBACK_REENTRY is treated as "strong" for the ADD_OK
      // threshold — it is a structured re-entry with a healthy run behind it.
      const strong =
        flame.scalpStatus === "STRONG" &&
        (HEALTHY_STAGES.has(flame.flameStage) ||
          (flame.flameStage === "RUN_ON" && flame.entryTiming === "PULLBACK_REENTRY")) &&
        flame.chaseRisk !== "HIGH" &&
        flame.chaseRisk !== "EXTREME";
      const cushionThin = !num(profitCushion) || profitCushion <= 0;
      if (strong && !cushionThin) {
        recommendation = "ADD_OK";
        const runNote = flame.flameStage === "RUN_ON" ? " after pulling back into a clean zone" : "";
        reason = `This burst is still strong${runNote} and you're already in profit — there's room for up to ${remaining} more small ${remaining === 1 ? "add" : "adds"} if it keeps going.`;
      } else {
        recommendation = "ADD_WITH_CAUTION";
        reason =
          flame.flameStage === "RUN_ON" && flame.entryTiming === "PULLBACK_REENTRY"
            ? "The run is still going and price pulled back into a better zone — a small, careful add is defensible here, but watch for quality to hold."
            : flame.flameStage === "RUN_ON"
            ? "The run is maturing — an add is possible if it holds, but don't pile in; watch for the burst to start fading."
            : cushionThin
            ? "The burst is alive but you've no real profit cushion yet — if you add, keep it small and be ready to bail."
            : "The burst is holding but not at its strongest — a small, careful add is fine; don't pile in.";
      }
    }
  }

  const remainingAddOns = Math.max(0, maxAddOns - usedAddOns);
  const allowed = remainingAddOns > 0 && recommendation !== "DO_NOT_ADD" && recommendation !== "HOLD";

  return {
    recommendation,
    maxAddOns,
    usedAddOns,
    remainingAddOns,
    allowed,
    revengeGuardTriggered,
    requiresFreshConfirmation,
    profitCushion: num(profitCushion) ? profitCushion : null,
    reason,
  };
}

function exit(
  urgency: ScalpExitUrgency,
  action: ScalpExitAction,
  headline: string,
  detail: string,
): ScalpExitVerdict {
  return { urgency, action, headline, detail, alertOnly: true };
}

/**
 * Exit-urgency monitor. Maps the current flame + basket P/L to a rung on the
 * ladder: None → Watch → Protect profit → Close latest → Close partial →
 * Close all → Emergency. ALERT_ONLY — Ruby recommends, it never closes.
 */
export function evaluateExitUrgency(
  flame: ScalpFlameRead,
  summary: BasketSummary,
  personality: RiskPersonality = "BALANCED",
): ScalpExitVerdict {
  void personality; // reserved — exit urgency is risk-personality-neutral for now.
  const pl = summary.combinedFloatingPl;
  const inProfit = num(pl) && pl > 0;
  const losing = num(pl) && pl < 0;
  const multiLeg = summary.entryCount > 1;

  if (flame.blind) {
    return exit(
      "WATCH",
      "HOLD",
      "Watch this one yourself",
      `${DEFAULT_ASSISTANT_NAME} can't see a live burst on this market right now, so manage this position manually and keep your stop in place.`,
    );
  }

  // EMERGENCY — the burst has failed/turned and you're losing on it.
  if ((flame.flameStage === "FAILED" || flame.flameStage === "REVERSAL_RISK") && losing) {
    return exit(
      "EMERGENCY",
      "CLOSE_ALL",
      "Get out now",
      "This burst has failed and is turning against you while you're down. Strongly consider closing the whole basket immediately.",
    );
  }

  // CLOSE_ALL — momentum is done; bank or cut everything.
  if (flame.flameStage === "EXHAUSTED" || flame.flameStage === "FAILED" || flame.flameStage === "REVERSAL_RISK") {
    return exit(
      "CLOSE_ALL",
      "CLOSE_ALL",
      "Time to close everything",
      inProfit
        ? "The move is spent. Consider closing the whole basket and banking what you have before it gives back."
        : "The move is spent and rolling over. Consider closing the whole basket rather than hoping for a bounce.",
    );
  }

  // CLOSE_PARTIAL — fading while in profit on a scaled-in basket: bank some.
  if (flame.flameStage === "WEAKENING" && inProfit && multiLeg) {
    return exit(
      "CLOSE_PARTIAL",
      "CLOSE_PARTIAL",
      "Bank part of it",
      "Momentum is fading while you're up. Consider closing part of the basket to lock in profit and let the rest run on a tight stop.",
    );
  }

  // CLOSE_LATEST — overstretched / chasing: trim the most recent add first.
  if ((flame.flameStage === "STRETCH" || flame.chaseRisk === "EXTREME") && multiLeg) {
    return exit(
      "CLOSE_LATEST",
      "CLOSE_LATEST",
      "Trim your last add",
      "The move is overstretched. Consider closing your most recent entry first — it's the most exposed if this snaps back.",
    );
  }

  // PROTECT_PROFIT — in profit but cooling: move stops to break-even.
  if (inProfit && (flame.flameStage === "WEAKENING" || flame.entryTiming === "LATE" || flame.freshness === "LATE")) {
    return exit(
      "PROTECT_PROFIT",
      "PROTECT",
      "Protect your profit",
      "You're in profit but the burst is cooling. Consider moving your stop up to break-even so a pullback can't turn this into a loss.",
    );
  }

  // WATCH — maturing run-on, or losing-but-not-failed: keep a close eye.
  if (flame.flameStage === "RUN_ON" || flame.flameStage === "STRETCH" || losing) {
    return exit(
      "WATCH",
      "HOLD",
      "Keep a close eye on it",
      losing
        ? "You're slightly underwater but the burst hasn't failed. Watch it closely and respect your stop."
        : "This burst is maturing. It's still going, but watch for it to start cooling so you can protect profit in time.",
    );
  }

  // NONE — fresh, healthy burst: nothing to do.
  return exit(
    "NONE",
    "HOLD",
    "Looking healthy",
    "This burst still looks healthy and is going your way. Nothing to do right now — let it work.",
  );
}

/** Assemble a full ScalpBasket from grouped legs + a flame read. Pure. */
export function assembleBasket(
  group: GroupedLegs,
  flame: ScalpFlameRead,
  opts: {
    personality?: RiskPersonality;
    currentPrice?: number | null;
    now?: number;
    /** Broker-feed sync freshness (from basketSyncInfo). Omitted ⇒ honest unknown-stale, never a fabricated "live". */
    sync?: ScalpBasketSync;
  } = {},
): ScalpBasket {
  const summary = summarizeBasket(group.legs);
  const personality = opts.personality ?? "BALANCED";
  const currentPrice = num(opts.currentPrice) ? opts.currentPrice : summary.currentPrice;
  const generatedAt = new Date(opts.now ?? Date.now()).toISOString();

  // Geometry-honesty disclosure: when the basket carries no stop-loss and/or
  // no take-profit of its own, the manage-side flame judged timing/room against
  // recent volatility (ATR), not user levels. Say so instead of presenting the
  // verdict as if it were anchored to the user's own trade plan.
  let exit = evaluateExitUrgency(flame, summary, personality);
  if (!flame.blind) {
    const hasOwnStop = group.legs.some((l) => num(l.stopLoss));
    const hasOwnTarget = group.legs.some((l) => num(l.takeProfit));
    if (!hasOwnStop || !hasOwnTarget) {
      const missing =
        !hasOwnStop && !hasOwnTarget
          ? "stop-loss or take-profit"
          : !hasOwnStop
          ? "stop-loss"
          : "take-profit";
      exit = {
        ...exit,
        detail: `${exit.detail} (No ${missing} is set on this basket, so timing and room are judged against recent volatility rather than your own levels.)`,
      };
    }
  }

  return {
    symbol: group.symbol,
    displayName: group.displayName,
    direction: group.direction,
    accountMode: group.accountMode,
    entryCount: summary.entryCount,
    totalVolume: summary.totalVolume,
    averageEntry: summary.averageEntry,
    currentPrice,
    combinedFloatingPl: summary.combinedFloatingPl,
    plKnownLegCount: summary.plKnownLegCount,
    breakEvenPrice: summary.breakEvenPrice,
    hasUnprotectedLeg: summary.hasUnprotectedLeg,
    legs: group.legs,
    flame,
    exit,
    addOn: evaluateAddOn(flame, summary, personality),
    generatedAt,
    sync: opts.sync ?? { syncedAt: null, ageSeconds: null, stale: true },
  };
}

// ── Failed-flame lockout (pure helpers; persistence lives in the service) ──

export function lockoutDirectionKey(symbol: string, direction: ScalpDirection): string {
  return `${symbol}|${direction}`;
}

/** Whether a stored lockout expiry is still in the future. */
export function isLockoutActive(
  expiresAt: Date | string | number | null | undefined,
  now: number = Date.now(),
): boolean {
  if (expiresAt == null) return false;
  const t = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
  return Number.isFinite(t) && t > now;
}
