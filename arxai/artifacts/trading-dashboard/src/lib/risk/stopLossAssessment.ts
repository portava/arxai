// Client-side stop-loss assessment.
//
// Reasonable SL must respect:
//   - broker minimum stop distance (broker stop level)
//   - spread + slippage buffer
//   - market structure (recent swing high/low) when available
//   - volatility (ATR) when available
//   - symbol pip/tick size
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
  // Symbol metadata.
  pipSize?: number | null;         // e.g. 0.0001 FX major, 0.01 JPY, 0.1 V75
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
  /** Pip size assumed. */
  pipSize: number;
  /** When ok=false, why no safe SL is possible. */
  blockReason?: string;
}

/** Best-effort pip-size inference from symbol when not supplied. */
function inferPipSize(symbol: string): number {
  const s = symbol.toUpperCase();
  if (/JPY$/.test(s)) return 0.01;
  if (/^XAU|XAG|GOLD|SILVER/.test(s)) return 0.1;
  if (/^(BTC|ETH|SOL|XRP|LTC|BCH|ADA|DOT)/.test(s)) return 1;
  if (/^(V|VOLATILITY|BOOM|CRASH|STEP)/.test(s)) return 0.1;
  if (/^US30|US500|NAS100|NDX100|GER40|UK100|JP225|SPX500|DJI/.test(s)) return 1;
  return 0.0001; // FX major default
}

/** Compute the minimum *safe* distance from entry the SL must respect. */
function computeMinSafeDistance(input: AssessStopLossInput, pip: number): number {
  const spread = Math.max(0, input.spread ?? 0);
  const minBroker = Math.max(0, input.minStopDistance ?? 0);
  const freeze = Math.max(0, input.freezeLevel ?? 0);
  const slipPips = Math.max(0, input.slippageBufferPips ?? 3);
  const slipPrice = slipPips * pip;
  // Atr-floor: at least 0.5 ATR if ATR is known.
  const atrFloor = input.atr != null && Number.isFinite(input.atr) ? input.atr * 0.5 : 0;
  // Pip floor: at least 8 pips (typical FX spread + buffer); other classes
  // already have larger floors via ATR.
  const pipFloor = 8 * pip;
  return Math.max(spread + slipPrice, minBroker, freeze, atrFloor, pipFloor);
}

export function assessStopLoss(input: AssessStopLossInput): AssessStopLossResult {
  const pip = input.pipSize ?? inferPipSize(input.symbol);
  if (!Number.isFinite(input.entry) || input.entry <= 0) {
    return {
      ok: false,
      sl: null,
      adjusted: false,
      reason: "Entry price is invalid.",
      stopDistance: null,
      spreadBuffer: input.spread ?? null,
      pipSize: pip,
      blockReason: "INVALID_ENTRY",
    };
  }

  const isBuy = input.side === "BUY";
  const minSafe = computeMinSafeDistance(input, pip);

  // Structural target: swing low for BUY, swing high for SELL — minus
  // one extra pip so SL sits just *beyond* the level.
  let structuralSl: number | null = null;
  if (isBuy && input.recentSwingLow != null && input.recentSwingLow < input.entry) {
    structuralSl = input.recentSwingLow - pip;
  }
  if (!isBuy && input.recentSwingHigh != null && input.recentSwingHigh > input.entry) {
    structuralSl = input.recentSwingHigh + pip;
  }

  // ATR fallback: 1.5 ATR beyond entry.
  let atrSl: number | null = null;
  if (input.atr != null && Number.isFinite(input.atr) && input.atr > 0) {
    const dist = 1.5 * input.atr;
    atrSl = isBuy ? input.entry - dist : input.entry + dist;
  }

  // Min-safe fallback: just the minSafe distance.
  const minSafeSl = isBuy ? input.entry - minSafe : input.entry + minSafe;

  // Pick the best candidate: prefer structural if it respects minSafe,
  // then ATR, then minSafe-only.
  const candidates: Array<{ value: number; label: string }> = [];
  if (structuralSl != null) candidates.push({ value: structuralSl, label: "market structure (swing)" });
  if (atrSl != null) candidates.push({ value: atrSl, label: "ATR volatility" });
  candidates.push({ value: minSafeSl, label: "broker minimum + spread buffer" });

  // Validate the proposed SL first.
  let proposedValid = false;
  let proposedDistance: number | null = null;
  if (input.proposedSl != null && Number.isFinite(input.proposedSl)) {
    proposedDistance = Math.abs(input.entry - input.proposedSl);
    const directionOk = isBuy ? input.proposedSl < input.entry : input.proposedSl > input.entry;
    proposedValid = directionOk && proposedDistance >= minSafe;
  }
  if (proposedValid) {
    return {
      ok: true,
      sl: input.proposedSl!,
      adjusted: false,
      reason: "Proposed stop loss is beyond broker minimum + spread buffer.",
      stopDistance: proposedDistance,
      spreadBuffer: input.spread ?? null,
      pipSize: pip,
    };
  }

  // Choose the first candidate whose distance >= minSafe AND is on the
  // correct side of entry.
  for (const c of candidates) {
    const dist = Math.abs(input.entry - c.value);
    const directionOk = isBuy ? c.value < input.entry : c.value > input.entry;
    if (directionOk && dist >= minSafe) {
      const tooClose = input.proposedSl != null && proposedDistance != null && proposedDistance < minSafe;
      return {
        ok: true,
        sl: c.value,
        adjusted: tooClose || input.proposedSl == null,
        reason: tooClose
          ? `Stop loss too close to entry. Adjusted to ${c.label}, beyond broker minimum + spread buffer.`
          : `Suggested SL placed beyond ${c.label} with spread/min-distance buffer.`,
        stopDistance: dist,
        spreadBuffer: input.spread ?? null,
        pipSize: pip,
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
    blockReason: "NO_SAFE_STOP_LOSS_AVAILABLE",
  };
}

/** Convenience: compute R:R from validated SL/TP only. Returns null if
 *  risk is near-zero (avoids absurd R:R from invalid SL). */
export function computeValidatedRR(entry: number, sl: number, tp: number, pipSize: number): number | null {
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  // Reject if risk is less than 1 pip — that's the bug we're fixing.
  if (risk < pipSize) return null;
  if (!Number.isFinite(reward) || reward <= 0) return null;
  return reward / risk;
}
