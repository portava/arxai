// Client-side stop-loss assessment.
//
// Reasonable SL must respect:
//   - broker minimum stop distance (broker stop level)
//   - spread + slippage buffer
//   - market structure (recent swing high/low) when available
//   - volatility (ATR) when available
//   - symbol pip/tick size — ONLY from the broker spec (digits/point via
//     stopLossInputsFromBrokerSpec). The pip size is never guessed from the
//     symbol name: when it is unknown, the pip-based floor and slippage buffer
//     are not applied, and the result says the distance could not be checked
//     (distanceChecked=false) instead of claiming it was. An MT5 spec defines a
//     pip only for forex; for crypto, metals, indices and synthetics its point
//     is a price step, not a pip, and an 8-"pip" floor built from it is 10–100x
//     too small — those specs give no pip size.
//
// SL must never default to the same value as entry. If the proposed SL
// is too tight, the assessment returns a safer adjusted SL plus a human
// reason. If no safe SL can be derived, returns { ok:false, blockReason }.
//
// All math is in price units (not pips). Callers convert as needed.

export interface AssessStopLossInput {
  symbol: string;
  side: "BUY" | "SELL";
  entry: number;
  proposedSl?: number | null;
  // Optional market structure (use whatever scanner provides).
  recentSwingLow?: number | null;
  recentSwingHigh?: number | null;
  atr?: number | null;
  // Broker constraints.
  spread?: number | null;          // current spread in price units
  minStopDistance?: number | null; // broker stop-level in price units
  freezeLevel?: number | null;     // broker freeze level in price units
  // Symbol metadata — from the broker spec only (stopLossInputsFromBrokerSpec).
  // Omitted/invalid means unknown; it is never inferred from the symbol name.
  pipSize?: number | null;
  /** Why the spec gives no pip size (stopLossInputsFromBrokerSpec.pipSizeNote). */
  pipSizeNote?: string | null;
  /** The broker's price step (point), used only for the one-step nudge beyond structure. */
  priceStep?: number | null;
  // Buffers.
  slippageBufferPips?: number | null; // extra protection above min-distance
}

export interface AssessStopLossResult {
  ok: boolean;
  /** Final recommended SL (may equal proposedSl if it was already safe). */
  sl: number | null;
  /** True if the proposed SL was adjusted to a safer value. */
  adjusted: boolean;
  /** Human-readable explanation for the UI / Ruby. */
  reason: string;
  /** SL distance in price units. */
  stopDistance: number | null;
  /** Spread buffer applied. */
  spreadBuffer: number | null;
  /** Pip size from the broker spec; null when it was not supplied. */
  pipSize: number | null;
  /**
   * True only when the stop distance was checked against the broker-spec pip
   * floor. False means the pip size was unknown, so the distance could not be
   * checked (only the side of entry and any supplied broker figures were).
   */
  distanceChecked: boolean;
  /** When ok=false, why no safe SL is possible. */
  blockReason?: string;
}

/** The subset of a broker symbol spec (Mt5SymbolView) the assessor can use. */
export interface BrokerSymbolSpecForStops {
  digits?: number | null;
  point?: number | null;
  category?: string | null;
  stopsLevel?: number | null;   // points
  freezeLevel?: number | null;  // points
  spreadPoints?: number | null; // points
  freshness?: "FRESH" | "STALE" | "MISSING" | null;
}

export interface StopLossSpecInputs {
  pipSize: number | null;
  /** The broker's price step (point); null when the spec has none. */
  priceStep: number | null;
  /** Why pipSize is null although the spec has a point; null otherwise. */
  pipSizeNote: string | null;
  minStopDistance: number | null;
  freezeLevel: number | null;
  spread: number | null;
}

function positive(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

function roundPrice(n: number): number {
  return Number(n.toPrecision(12));
}

/**
 * Turn the broker's reported symbol spec into assessor inputs (price units).
 * A pip exists only for forex: 10 points on 3/5-digit quotes (MT5 fractional
 * pricing), else one point. Crypto, metals, indices, synthetics and a spec with
 * no category get no pip size (their point is a price step; using it as a pip
 * made the 8-pip floor 10–100x too small). No point → no pip size. The spread
 * is used only from a FRESH spec
 * (a stale spread is not the current spread); stop/freeze levels are used from
 * any spec that is not MISSING.
 */
export function stopLossInputsFromBrokerSpec(spec: BrokerSymbolSpecForStops | null | undefined): StopLossSpecInputs {
  const none: StopLossSpecInputs = {
    pipSize: null, priceStep: null, pipSizeNote: null, minStopDistance: null, freezeLevel: null, spread: null,
  };
  if (!spec || !positive(spec.point)) return none;
  const point = spec.point;
  const category = typeof spec.category === "string" ? spec.category.trim() : "";
  const isForex = /^forex/i.test(category);
  const pipSize = !isForex ? null : spec.digits === 3 || spec.digits === 5 ? roundPrice(point * 10) : point;
  const pipSizeNote = isForex
    ? null
    : category
      ? `the broker spec gives ${category} symbols a ${point} price step but no pip size`
      : `the broker spec gives a ${point} price step but no market category, so no pip size`;
  const usable = spec.freshness !== "MISSING";
  const levels = (pts: number | null | undefined): number | null =>
    usable && positive(pts) ? roundPrice(pts * point) : null;
  return {
    pipSize,
    priceStep: point,
    pipSizeNote,
    minStopDistance: levels(spec.stopsLevel),
    freezeLevel: levels(spec.freezeLevel),
    spread: spec.freshness === "FRESH" && typeof spec.spreadPoints === "number"
      && Number.isFinite(spec.spreadPoints) && spec.spreadPoints >= 0
      ? roundPrice(spec.spreadPoints * point)
      : null,
  };
}

/** Compute the minimum *safe* distance from entry the SL must respect. */
function computeMinSafeDistance(input: AssessStopLossInput, pip: number | null): number {
  const spread = Math.max(0, input.spread ?? 0);
  const minBroker = Math.max(0, input.minStopDistance ?? 0);
  const freeze = Math.max(0, input.freezeLevel ?? 0);
  const slipPips = Math.max(0, input.slippageBufferPips ?? 3);
  // Without a broker-spec pip size there is no pip floor or slippage buffer to
  // apply — inventing one is what produced the wrong advice.
  const slipPrice = pip != null ? slipPips * pip : 0;
  // Atr-floor: at least 0.5 ATR if ATR is known.
  const atrFloor = input.atr != null && Number.isFinite(input.atr) ? input.atr * 0.5 : 0;
  // Pip floor: at least 8 pips (typical FX spread + buffer); other classes
  // already have larger floors via ATR.
  const pipFloor = pip != null ? 8 * pip : 0;
  return Math.max(spread + slipPrice, minBroker, freeze, atrFloor, pipFloor);
}

/** Plain list of what the stop distance was actually checked against. */
function describeChecks(input: AssessStopLossInput, pip: number | null): string {
  const parts: string[] = [];
  if (pip != null) {
    const slipPips = Math.max(0, input.slippageBufferPips ?? 3);
    parts.push(`an 8-pip floor and ${slipPips}-pip slippage buffer (pip ${pip} from the broker spec)`);
  }
  if (positive(input.minStopDistance)) parts.push("the broker's stop level");
  if (positive(input.freezeLevel)) parts.push("the broker's freeze level");
  if (input.spread != null && Number.isFinite(input.spread)) parts.push("the current spread");
  if (positive(input.atr)) parts.push("half the ATR");
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

const MIN_SAFE_LABEL = "the minimum safe distance";

function notCheckedNote(input: AssessStopLossInput): string {
  const why = (input.pipSizeNote ?? "").trim() || `the broker's pip size for ${input.symbol} is not available`;
  return `Its distance from entry could not be checked: ${why}.`;
}

export function assessStopLoss(input: AssessStopLossInput): AssessStopLossResult {
  const pip = positive(input.pipSize) ? input.pipSize : null;
  const distanceChecked = pip != null;
  if (!Number.isFinite(input.entry) || input.entry <= 0) {
    return {
      ok: false,
      sl: null,
      adjusted: false,
      reason: "Entry price is invalid.",
      stopDistance: null,
      spreadBuffer: input.spread ?? null,
      pipSize: pip,
      distanceChecked,
      blockReason: "INVALID_ENTRY",
    };
  }

  const isBuy = input.side === "BUY";
  const minSafe = computeMinSafeDistance(input, pip);
  const checks = describeChecks(input, pip);
  // Floating-point tolerance for "distance >= minSafe": entry - minSafe is not
  // exactly minSafe away in binary (1.085 - 0.0008), which made the min-safe
  // candidate fail its own check. Scaled to the price, ~1e-15 relative.
  const tol = Number.EPSILON * 16 * Math.max(1, Math.abs(input.entry));

  // Structural target: swing low for BUY, swing high for SELL — plus one
  // broker-spec pip (or, where the spec defines no pip, one broker price step)
  // so SL sits just *beyond* the level. With neither there is no honest
  // "one step beyond", so no structural candidate.
  const nudge = pip ?? (positive(input.priceStep) ? input.priceStep : null);
  let structuralSl: number | null = null;
  if (nudge != null && isBuy && input.recentSwingLow != null && input.recentSwingLow < input.entry) {
    structuralSl = input.recentSwingLow - nudge;
  }
  if (nudge != null && !isBuy && input.recentSwingHigh != null && input.recentSwingHigh > input.entry) {
    structuralSl = input.recentSwingHigh + nudge;
  }

  // ATR fallback: 1.5 ATR beyond entry.
  let atrSl: number | null = null;
  if (input.atr != null && Number.isFinite(input.atr) && input.atr > 0) {
    const dist = 1.5 * input.atr;
    atrSl = isBuy ? input.entry - dist : input.entry + dist;
  }

  // Pick the best candidate: prefer structural if it respects minSafe,
  // then ATR, then minSafe-only (only when some known figure gives a
  // non-zero minimum — a zero minimum would put the stop at entry).
  const candidates: Array<{ value: number; label: string }> = [];
  if (structuralSl != null) candidates.push({ value: structuralSl, label: "market structure (swing)" });
  if (atrSl != null) candidates.push({ value: atrSl, label: "ATR volatility" });
  if (minSafe > 0) {
    candidates.push({ value: isBuy ? input.entry - minSafe : input.entry + minSafe, label: MIN_SAFE_LABEL });
  }

  // Validate the proposed SL first.
  let proposedValid = false;
  let proposedDistance: number | null = null;
  if (input.proposedSl != null && Number.isFinite(input.proposedSl)) {
    proposedDistance = Math.abs(input.entry - input.proposedSl);
    const directionOk = isBuy ? input.proposedSl < input.entry : input.proposedSl > input.entry;
    proposedValid = directionOk && proposedDistance + tol >= minSafe;
  }
  if (proposedValid) {
    let reason: string;
    if (distanceChecked) {
      reason = `Proposed stop loss is beyond ${checks}.`;
    } else {
      reason = `Stop loss is on the correct side of entry${checks ? ` and beyond ${checks}` : ""}. ${notCheckedNote(input)}`;
    }
    return {
      ok: true,
      sl: input.proposedSl!,
      adjusted: false,
      reason,
      stopDistance: proposedDistance,
      spreadBuffer: input.spread ?? null,
      pipSize: pip,
      distanceChecked,
    };
  }

  // Choose the first candidate whose distance >= minSafe AND is on the
  // correct side of entry.
  for (const c of candidates) {
    const dist = Math.abs(input.entry - c.value);
    const directionOk = isBuy ? c.value < input.entry : c.value > input.entry;
    if (directionOk && dist > 0 && dist + tol >= minSafe) {
      const tooClose = input.proposedSl != null && proposedDistance != null && proposedDistance + tol < minSafe;
      const where = c.label === MIN_SAFE_LABEL
        ? `${c.label} (${checks})`
        : checks ? `${c.label}, beyond ${checks}` : c.label;
      const base = tooClose
        ? `Stop loss too close to entry. Adjusted to ${where}.`
        : `Suggested SL placed at ${where}.`;
      return {
        ok: true,
        sl: c.value,
        adjusted: tooClose || input.proposedSl == null,
        reason: distanceChecked ? base : `${base} ${notCheckedNote(input)}`,
        stopDistance: dist,
        spreadBuffer: input.spread ?? null,
        pipSize: pip,
        distanceChecked,
      };
    }
  }

  return {
    ok: false,
    sl: null,
    adjusted: false,
    reason: "A valid stop loss is required before review.",
    stopDistance: null,
    spreadBuffer: input.spread ?? null,
    pipSize: pip,
    distanceChecked,
    blockReason: "NO_SAFE_STOP_LOSS_AVAILABLE",
  };
}

/** Convenience: compute R:R from validated SL/TP only. Returns null if
 *  risk is near-zero (avoids absurd R:R from invalid SL), or when the pip size
 *  is unknown (a near-zero risk cannot then be ruled out). */
export function computeValidatedRR(entry: number, sl: number, tp: number, pipSize: number | null): number | null {
  if (!positive(pipSize)) return null;
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  // Reject if risk is less than 1 pip — that's the bug we're fixing.
  if (risk < pipSize) return null;
  if (!Number.isFinite(reward) || reward <= 0) return null;
  return reward / risk;
}
