// ── ENTRY TRUTH — DISPLAY / DECISION-SUPPORT CONTRACT (Task #652, Phase 2) ─────
//
// SHARED, PURE definition of "what EXACT trigger must fire before a trade is
// valid, and where is that trigger in its lifecycle right now?". EntryTruth never
// says "enter now" without a direction, a level, a confirmation trigger, an
// invalidation, an acceptable reward:risk, timing approval and feed approval. The
// caller supplies the measured trigger facts; this contract folds them into one
// `EntryTruthVerdict` consumed by Scanner, Eleanor, Scalp Builder and Strategy
// evaluation.
//
// This module is PURE: no IO, no DB, no HTTP, no clock, no role/privilege input.
// Same inputs ⇒ same verdict.
//
// ── SAFETY: ENTRY TRUTH IS A *CHILD INPUT*, DISPLAY-ONLY ─────────────────────
// `entryStatus` of `confirmed_candidate` means "the trigger conditions are met to
// SHOW a candidate" — it is NOT trade permission and never produces READY_NOW on
// its own. A breakout needs a real CLOSE beyond the level (never a wick); an
// entry too far from the trigger is `too_late`. The verdict carries NO
// execution-permission field and never influences live-execution permission,
// broker dispatch, the kill switch, owner/admin overrides or the trade button.

export type EntryType =
  | "breakout"
  | "pullback"
  | "retest"
  | "reversal"
  | "continuation"
  | "liquidity_sweep"
  | "trendline_break_retest"
  | "pivot_rejection"
  | "pivot_breakout"
  | "inside_bar_breakout"
  | "none";

export type EntryStatus =
  | "not_available"
  | "forming"
  | "waiting_confirmation"
  | "confirmed_candidate"
  | "missed"
  | "too_late"
  | "invalidated";

export type EntryDirection = "buy" | "sell" | "none";

export type EntryQuality = "high" | "medium" | "low" | "none";

export type TargetRoomStatus = "enough_room" | "limited_room" | "no_room";

export type EntryScannerLabelHint =
  | "none"
  | "context_only"
  | "forming" // setup geometry present, no trigger yet
  | "waiting_confirmation" // waiting for the confirming close/reaction
  | "wick_only_unconfirmed" // a wick poked the level but did not close beyond
  | "confirmed_candidate" // trigger conditions met (still display-only)
  | "missed" // the move already left without a clean entry
  | "too_late_chase" // price ran too far from the trigger
  | "invalidated" // the setup level failed
  | "no_room" // target sits in S/R — no usable reward
  | "supportive"; // confirmed candidate + live feed + good RR → small nudge

export interface EntryDisplayContext {
  feedConfirmed: boolean;
  feedStale: boolean;
  sufficiencyAllowsSetup: boolean;
  chartReadConfidenceLow: boolean;
  /** True when TimingTruth approves the moment (close confirmed, not blocked). */
  timingApproved: boolean;
}

/**
 * Measured trigger facts. The caller derives every flag from closed candles and
 * the level geometry; this contract never invents them. Distances are in price
 * units; `triggerDistanceAtr` lets the contract judge "too far from trigger".
 */
export interface EntryTruthInput {
  entryType: EntryType;
  direction: EntryDirection;
  /** The proposed entry / trigger price (null ⇒ no concrete entry). */
  proposedEntryPrice: number | null;
  entryZone: { low: number; high: number } | null;
  confirmationTrigger: number | null;
  invalidationTrigger: number | null;
  stopLossLevel: number | null;
  targetLevels: number[];
  /** True only when price CLOSED beyond the trigger (never a wick). */
  closedBeyondTrigger: boolean;
  /** True when only a wick poked beyond the trigger (no close). */
  wickOnlyBeyondTrigger: boolean;
  /** True when the setup level has already failed/invalidated. */
  levelFailed: boolean;
  /** Distance of current price from the trigger, in ATR units (null unknown). */
  triggerDistanceAtr: number | null;
  /** True when the move already left without offering a clean entry. */
  alreadyMoved: boolean;
  /** Minimum acceptable reward:risk for this setup (default 1.5 if null). */
  minimumRR: number | null;
}

export interface EntryScannerImpact {
  labelHint: EntryScannerLabelHint;
  confidenceCeiling: number;
  qualityCeiling: EntryQuality;
  conditional: boolean;
  contextOnly: boolean;
  edgeAdjustment: number;
  supportive: boolean;
}

export interface EntryTruthVerdict {
  entryType: EntryType;
  direction: EntryDirection;
  entryStatus: EntryStatus;
  proposedEntryPrice: number | null;
  entryZone: { low: number; high: number } | null;
  confirmationTrigger: number | null;
  invalidationTrigger: number | null;
  stopLossLevel: number | null;
  targetLevels: number[];
  minimumRR: number;
  currentRR: number | null;
  targetRoomStatus: TargetRoomStatus;
  confidence: number;
  quality: EntryQuality;
  confidenceCapReason: string | null;
  scannerTruthImpact: EntryScannerImpact;
  rubyExplanation: string;
  warnings: string[];
}

const QUALITY_RANK: Record<EntryQuality, number> = { none: 0, low: 1, medium: 2, high: 3 };

function minQuality(a: EntryQuality, b: EntryQuality): EntryQuality {
  return QUALITY_RANK[a] <= QUALITY_RANK[b] ? a : b;
}

function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

const DEFAULT_MIN_RR = 1.5;
const CONTEXT_ONLY_CONF_CAP = 35;
const TOO_LATE_CONF_CAP = 30;
const FORMING_CONF_CAP = 55;
const WAITING_CONF_CAP = 60;
/** Distance (in ATR) past the trigger beyond which an entry is a chase. */
const TOO_LATE_ATR = 1.5;

function computeRR(input: EntryTruthInput): number | null {
  const entry = input.proposedEntryPrice ?? input.confirmationTrigger;
  const stop = input.stopLossLevel ?? input.invalidationTrigger;
  const target = input.targetLevels[0];
  if (
    entry == null ||
    stop == null ||
    target == null ||
    !Number.isFinite(entry) ||
    !Number.isFinite(stop) ||
    !Number.isFinite(target)
  ) {
    return null;
  }
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  if (risk <= 0) return null;
  return Math.round((reward / risk) * 100) / 100;
}

/**
 * Build the ONE shared entry verdict. A breakout `confirmed_candidate` REQUIRES a
 * real close beyond the trigger; a wick-only poke stays `waiting_confirmation`.
 * `scannerTruthImpact` is downgrade-only with a small bounded supportive nudge
 * gated on a confirmed candidate, good RR AND a live-confirmed feed.
 */
export function resolveEntryTruth(
  input: EntryTruthInput,
  display: EntryDisplayContext,
): EntryTruthVerdict {
  const warnings: string[] = [];
  const contextOnly =
    !display.feedConfirmed || display.feedStale || !display.sufficiencyAllowsSetup;
  const minimumRR = input.minimumRR ?? DEFAULT_MIN_RR;
  const currentRR = computeRR(input);

  // ── Target room ────────────────────────────────────────────────────────────
  let targetRoomStatus: TargetRoomStatus = "enough_room";
  if (input.targetLevels.length === 0) targetRoomStatus = "no_room";
  else if (currentRR != null && currentRR < 1) targetRoomStatus = "no_room";
  else if (currentRR != null && currentRR < minimumRR) targetRoomStatus = "limited_room";

  // ── Entry status lifecycle (confirmation-gated) ────────────────────────────
  let entryStatus: EntryStatus;
  if (input.entryType === "none" || input.direction === "none" || input.confirmationTrigger == null) {
    entryStatus = "not_available";
  } else if (input.levelFailed) {
    entryStatus = "invalidated";
  } else if (input.alreadyMoved && !input.closedBeyondTrigger) {
    entryStatus = "missed";
  } else if (
    input.triggerDistanceAtr != null &&
    input.triggerDistanceAtr > TOO_LATE_ATR
  ) {
    entryStatus = "too_late";
  } else if (input.closedBeyondTrigger) {
    // A real close beyond the trigger is required to be a candidate.
    entryStatus = "confirmed_candidate";
  } else if (input.wickOnlyBeyondTrigger) {
    // A wick poked the level but did NOT close beyond it — not confirmed.
    entryStatus = "waiting_confirmation";
  } else {
    entryStatus = "forming";
  }

  // ── Display caps + label, downgrade-only ───────────────────────────────────
  let confidenceCeiling = 100;
  let qualityCeiling: EntryQuality = "high";
  let conditional = true; // entries are conditional until everything aligns
  let edgeAdjustment = 0;
  let supportive = false;
  let labelHint: EntryScannerLabelHint = "none";
  let confidenceCapReason: string | null = null;
  let confidence = 40;

  switch (entryStatus) {
    case "not_available":
      labelHint = "none";
      confidenceCeiling = 20;
      qualityCeiling = "none";
      confidence = 0;
      confidenceCapReason = "No concrete entry trigger on this timeframe yet.";
      break;
    case "invalidated":
      labelHint = "invalidated";
      confidenceCeiling = Math.min(confidenceCeiling, 20);
      qualityCeiling = "none";
      edgeAdjustment = -25;
      confidence = 10;
      confidenceCapReason = "Entry invalidated — the setup level failed.";
      warnings.push(confidenceCapReason);
      break;
    case "missed":
      labelHint = "missed";
      confidenceCeiling = Math.min(confidenceCeiling, TOO_LATE_CONF_CAP);
      qualityCeiling = minQuality(qualityCeiling, "low");
      edgeAdjustment = -15;
      confidence = 25;
      confidenceCapReason = "The move already left without a clean entry — entry missed.";
      warnings.push(confidenceCapReason);
      break;
    case "too_late":
      labelHint = "too_late_chase";
      confidenceCeiling = Math.min(confidenceCeiling, TOO_LATE_CONF_CAP);
      qualityCeiling = minQuality(qualityCeiling, "low");
      edgeAdjustment = -15;
      confidence = 25;
      confidenceCapReason = "Price ran too far from the trigger — entering now would be a chase.";
      warnings.push(confidenceCapReason);
      break;
    case "forming":
      labelHint = "forming";
      confidenceCeiling = Math.min(confidenceCeiling, FORMING_CONF_CAP);
      qualityCeiling = minQuality(qualityCeiling, display.chartReadConfidenceLow ? "low" : "medium");
      edgeAdjustment = -5;
      confidence = 45;
      confidenceCapReason = "Setup is forming — no entry trigger has fired yet.";
      break;
    case "waiting_confirmation":
      labelHint = input.wickOnlyBeyondTrigger ? "wick_only_unconfirmed" : "waiting_confirmation";
      confidenceCeiling = Math.min(confidenceCeiling, WAITING_CONF_CAP);
      qualityCeiling = minQuality(qualityCeiling, "medium");
      edgeAdjustment = -5;
      confidence = 50;
      confidenceCapReason = input.wickOnlyBeyondTrigger
        ? "Only a wick poked the level — waiting for a confirming close."
        : "Waiting for the confirming close/reaction.";
      break;
    case "confirmed_candidate": {
      labelHint = "confirmed_candidate";
      confidence = 70;
      // Supportive nudge requires good RR, timing approval, a usable read AND a
      // live-confirmed feed. Never grants READY_NOW.
      const goodRR = currentRR != null && currentRR >= minimumRR;
      const canSupport =
        goodRR &&
        display.timingApproved &&
        !contextOnly &&
        !display.chartReadConfidenceLow &&
        targetRoomStatus === "enough_room";
      if (canSupport) {
        labelHint = "supportive";
        supportive = true;
        edgeAdjustment = 10;
        conditional = false;
      } else {
        qualityCeiling = minQuality(qualityCeiling, "medium");
        if (!goodRR) confidenceCapReason = "Reward:risk is below the minimum — keep it conditional.";
        else if (!display.timingApproved)
          confidenceCapReason = "Timing has not approved the moment yet — keep it conditional.";
      }
      break;
    }
  }

  // Target-room downgrade (never block on its own, but cap quality/edge).
  if (targetRoomStatus === "no_room" && entryStatus !== "invalidated") {
    labelHint = "no_room";
    supportive = false;
    edgeAdjustment = Math.min(edgeAdjustment, -10);
    qualityCeiling = minQuality(qualityCeiling, "low");
    confidenceCapReason ??= "No usable reward to the next target — skip.";
    warnings.push("Nearest target leaves no usable reward.");
  } else if (targetRoomStatus === "limited_room" && entryStatus === "confirmed_candidate") {
    supportive = false;
    edgeAdjustment = Math.min(edgeAdjustment, 0);
    qualityCeiling = minQuality(qualityCeiling, "medium");
    confidenceCapReason ??= "Reward:risk is limited — treat as conditional.";
  }

  // Feed not live-confirmed → entry is CONTEXT ONLY. Highest-precedence cap.
  if (contextOnly) {
    labelHint = "context_only";
    confidenceCeiling = Math.min(confidenceCeiling, CONTEXT_ONLY_CONF_CAP);
    qualityCeiling = minQuality(qualityCeiling, "low");
    conditional = true;
    supportive = false;
    edgeAdjustment = Math.min(edgeAdjustment, 0);
    confidenceCapReason = display.feedStale
      ? "Feed is delayed — entry shown as context only, not live-confirmed."
      : !display.sufficiencyAllowsSetup
        ? "Not enough live data — entry shown as context only."
        : "Feed not live-confirmed — entry shown as context only.";
    warnings.push(confidenceCapReason);
  }

  const cappedConfidence = Math.min(clampConfidence(confidence), confidenceCeiling);
  const baseQuality: EntryQuality =
    cappedConfidence >= 70 ? "high" : cappedConfidence >= 50 ? "medium" : cappedConfidence > 0 ? "low" : "none";
  const quality = minQuality(baseQuality, qualityCeiling);

  return {
    entryType: input.entryType,
    direction: input.direction,
    entryStatus,
    proposedEntryPrice: input.proposedEntryPrice,
    entryZone: input.entryZone,
    confirmationTrigger: input.confirmationTrigger,
    invalidationTrigger: input.invalidationTrigger,
    stopLossLevel: input.stopLossLevel,
    targetLevels: input.targetLevels,
    minimumRR,
    currentRR,
    targetRoomStatus,
    confidence: cappedConfidence,
    quality,
    confidenceCapReason,
    scannerTruthImpact: {
      labelHint,
      confidenceCeiling,
      qualityCeiling,
      conditional,
      contextOnly,
      edgeAdjustment,
      supportive,
    },
    rubyExplanation: buildEntryExplanation({
      entryType: input.entryType,
      entryStatus,
      confirmationTrigger: input.confirmationTrigger,
      invalidationTrigger: input.invalidationTrigger,
      currentRR,
      minimumRR,
      targetRoomStatus,
      contextOnly,
    }),
    warnings: dedupe(warnings),
  };
}

function buildEntryExplanation(args: {
  entryType: EntryType;
  entryStatus: EntryStatus;
  confirmationTrigger: number | null;
  invalidationTrigger: number | null;
  currentRR: number | null;
  minimumRR: number;
  targetRoomStatus: TargetRoomStatus;
  contextOnly: boolean;
}): string {
  const { entryType, entryStatus, confirmationTrigger, invalidationTrigger, currentRR, minimumRR, targetRoomStatus, contextOnly } =
    args;
  const parts: string[] = [];
  const typeLabel = entryType === "none" ? "entry" : entryType.replace(/_/g, " ");
  switch (entryStatus) {
    case "not_available":
      parts.push("No concrete entry trigger is available yet.");
      break;
    case "forming":
      parts.push(`A ${typeLabel} setup is forming — no trigger has fired.`);
      break;
    case "waiting_confirmation":
      parts.push(`A ${typeLabel} entry is waiting for a confirming close — do not act on a wick.`);
      break;
    case "confirmed_candidate":
      parts.push(`A ${typeLabel} entry trigger has met its conditions — a candidate, still pending the other checks.`);
      break;
    case "missed":
      parts.push("The clean entry already left — it was missed.");
      break;
    case "too_late":
      parts.push("Price ran too far from the trigger — entering now would be a chase.");
      break;
    case "invalidated":
      parts.push("The setup level failed — this entry is invalidated.");
      break;
  }
  if (confirmationTrigger != null) parts.push(`Confirms on ${confirmationTrigger}.`);
  if (invalidationTrigger != null) parts.push(`Invalidates at ${invalidationTrigger}.`);
  if (currentRR != null) parts.push(`Reward:risk is about ${currentRR} (min ${minimumRR}).`);
  if (targetRoomStatus === "no_room") parts.push("There is no usable room to the next target.");
  if (contextOnly) parts.push("Feed is not live-confirmed, so treat this entry as context only.");
  return parts.join(" ");
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs.filter((x) => x && x.trim().length > 0))];
}
