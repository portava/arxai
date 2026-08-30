// ═══════════════════════════════════════════════════════════════════════════
// EDGE CAPACITY PROPOSAL — the machine's half of foundation gate #23.
//
// Gate #23 (EDGE_CAPACITY_EXCEEDED) refuses every driver-placed live entry on
// an edge that has no recorded capacity estimate. Recording one requires
// distribution + friction inputs the ruin/capacity simulator can run on. Until
// now those inputs could only be TYPED BY AN OPERATOR, which means the number
// that unlocks a live entry was an assumption wearing a simulator's clothes.
//
// This module derives those inputs FROM RECORDED EVIDENCE instead, and — this
// is the whole point — refuses to produce a number when the evidence cannot
// support one.
//
// ── THE PRESS BOUNDARY ─────────────────────────────────────────────────────
// Nothing here writes anything. `buildEdgeCapacityProposal` is a pure function
// over an evidence snapshot. Its output is a PROPOSAL: the inputs it used, the
// verdict it reached, and every place where the evidence is thinner than it
// looks. Only an admin press may turn a proposal into a recorded estimate, and
// the USD deployable ceiling is NEVER proposed at all (see
// `proposedMaxDeployedUsd` below) — a learned output may only ever REFUSE, it
// may never set a size.
//
// ── THE HONESTY SPINE ──────────────────────────────────────────────────────
//   * A missing evidence leg is a typed gap with a code, not a default.
//   * An unmeasured friction is never assumed to be zero silently: where the
//     evidence is a LOWER BOUND (an observed zero is not a proven zero) the
//     proposal names the optimism in `optimisticAssumptions` and caps its own
//     confidence.
//   * Confidence is never HIGH. The best this evidence base can honestly
//     support is MODERATE.
// ═══════════════════════════════════════════════════════════════════════════

import {
  estimateStrategyCapacity,
  type FrictionRuinInput,
  type CapacityEstimateResult,
} from "./ruinCapacitySimulation.engine.js";

// ── Sufficiency floors ─────────────────────────────────────────────────────

/** Closed, R-resolvable trades attributed to the edge before a win/loss
 *  distribution may be claimed. Mirrors MIN_REALIZED_SAMPLE in the engine. */
export const CAPACITY_MIN_CLOSED_TRADES = 30;

/** Resolved dispatches (filled + rejected + expired) before a fill
 *  probability may be claimed. Below this, liquidity is UNKNOWN, and an
 *  unknown fill probability may not be read as 1.0 — that would be the most
 *  optimistic possible assumption dressed as a measurement. */
export const CAPACITY_MIN_RESOLVED_DISPATCHES = 20;

/** Slippage samples (fill price vs the draft-time reference price the user
 *  approved, expressed in planned-risk R) before a slippage cost may be
 *  claimed. Slippage only ever REDUCES capacity, so assuming zero is the
 *  optimistic direction and is refused. */
export const CAPACITY_MIN_SLIPPAGE_SAMPLES = 20;

// ── Evidence gaps ──────────────────────────────────────────────────────────

export type CapacityEvidenceGapCode =
  | "EVIDENCE_READ_FAILED"
  | "NO_CLOSED_TRADES_ATTRIBUTED"
  | "TOO_FEW_R_RESOLVABLE_TRADES"
  | "NO_REALIZED_WINS"
  | "NO_REALIZED_LOSSES"
  | "NO_RESOLVED_DISPATCHES"
  | "TOO_FEW_RESOLVED_DISPATCHES"
  | "SLIPPAGE_NOT_MEASURED"
  | "VENUE_FAILURE_MAGNITUDE_UNKNOWN";

export interface CapacityEvidenceGap {
  code: CapacityEvidenceGapCode;
  /** Exactly what is missing, in the operator's language. */
  missing: string;
  /** What would settle it — the thing that must be recorded or happen. */
  wouldBeSettledBy: string;
}

// ── The evidence snapshot the proposal reads ───────────────────────────────

/**
 * Everything the proposal is allowed to look at, gathered by a caller that
 * owns the reads. Every field that could not be established is an explicit
 * null WITH a reason — never a zero standing in for "we did not look".
 */
export interface EdgeCapacityEvidence {
  edgeId: number;
  /** ISO timestamp of the snapshot, supplied by the caller (no clock here). */
  gatheredAt: string;

  /**
   * Realized R-multiples of CLOSED positions attributed to this edge:
   * broker-reported realised P&L ÷ the position's PLANNED risk (entry-to-stop
   * distance × contract size × volume). null = the read itself failed.
   *
   * R is the planned-risk unit throughout this module, so the win/loss
   * distribution and the slippage cost are expressed in the SAME unit and can
   * be handed to the simulator together without a conversion nobody checked.
   */
  realizedRMultiples: readonly number[] | null;
  /** Present only when realizedRMultiples is null. */
  realizedReadFailure: string | null;
  /** Closed positions attributed to the edge, before any usability filter. */
  closedPositionsAttributed: number;
  /** Attributed closed positions dropped, by reason (missing broker P&L,
   *  no stop-loss so no planned risk, no symbol spec, non-USD profit
   *  currency). Counted so the drop is visible, never silently absorbed. */
  closedPositionsDropped: ReadonlyArray<{ reason: string; count: number }>;

  /**
   * Dispatch outcomes for entry commands carrying this edge_id.
   * null = the read failed.
   */
  dispatch: {
    filled: number;
    rejected: number;
    expired: number;
    stillInFlight: number;
  } | null;
  dispatchReadFailure: string | null;

  /**
   * Mean executed/requested volume ratio over filled commands where BOTH
   * numbers were recorded, plus the sample size. null = not measured.
   */
  partialFillMean01: number | null;
  partialFillSamples: number;

  /**
   * Realized slippage in planned-risk R, one sample per filled command that
   * recorded a draft-time reference price, a fill price, a stop-loss and a
   * resolvable contract spec. null = the read failed.
   */
  slippageRSamples: readonly number[] | null;

  /**
   * Venue-failure observations: closed positions attributed to this edge that
   * the broker closed without usable numbers, or that were reconciled as
   * broker-absent. This is the observable that corresponds to the simulator's
   * `brokerFailure` leg (a venue event turning a managed exit into an
   * uncontrolled one). null = not separable from ordinary closes.
   */
  venueFailureObservations: { failures: number; ofClosed: number } | null;

  /**
   * The magnitude of a venue failure (how far the loss leg slips when the
   * venue fails), if it has EVER been measured. Not derivable from the
   * columns this system records today, so it is normally null — which only
   * blocks the proposal when a non-zero failure RATE was actually observed.
   */
  venueFailureSlipMultiplier: number | null;
}

// ── Simulator framing the proposal uses ────────────────────────────────────

/** Fixed, disclosed simulator framing. These are not measurements and are not
 *  presented as any: they are the horizon and ruin depth the proposal reports
 *  its answer FOR, stated up front so two proposals are comparable. */
export const CAPACITY_PROPOSAL_FRAMING = {
  pathsToSimulate: 4000,
  horizonTrades: 250,
  /** Ruin = a cumulative drawdown of 30 planned-risk units. */
  ruinThresholdR: -30,
  seed: 23,
  concurrentPositions: 1,
  correlation01: 0,
} as const;

// ── The proposal ───────────────────────────────────────────────────────────

export type CapacityProposalVerdict = "PROPOSED" | "INSUFFICIENT_EVIDENCE";
export type CapacityProposalConfidence = "NONE" | "LOW" | "MODERATE";

export interface EdgeCapacityProposal {
  edgeId: number;
  gatheredAt: string;
  verdict: CapacityProposalVerdict;
  confidence: CapacityProposalConfidence;

  /**
   * The simulator's capacity status, ONLY when verdict is PROPOSED.
   * null under INSUFFICIENT_EVIDENCE — an insufficient proposal carries no
   * status a press could copy into production_edges.capacity_status.
   */
  proposedCapacityStatus: CapacityEstimateResult["status"] | null;
  /** capacity_risk_r candidate. null under INSUFFICIENT_EVIDENCE. */
  proposedCapacityRiskR: number | null;

  /**
   * ALWAYS null, by construction and on purpose.
   *
   * The simulator answers in planned-risk R. Turning R into a cumulative USD
   * deployable ceiling needs a capital basis attached to the edge, which this
   * system does not hold — and inventing one would be the exact failure the
   * flywheel invariant exists to prevent (a learned output setting a size).
   * The USD ceiling is the owner's number. It is pressed, never proposed.
   */
  proposedMaxDeployedUsd: null;
  maxDeployedUsdReason: string;

  /** The simulator inputs the proposal actually used. null when it did not
   *  run. Shown to the operator verbatim so the number can be re-derived. */
  simulatorInput: Omit<FrictionRuinInput, "candidateRiskR"> | null;
  /** The raw estimator result (probes + reasons) when it ran. */
  estimate: CapacityEstimateResult | null;

  /** Every leg that is missing. Non-empty ⇒ INSUFFICIENT_EVIDENCE. */
  gaps: CapacityEvidenceGap[];
  /** Places where the evidence is a LOWER BOUND and the proposal is therefore
   *  optimistic. Non-empty caps confidence at LOW. */
  optimisticAssumptions: string[];
  /** Sample sizes behind each derived input, for the operator's eye. */
  sampleSizes: {
    rResolvableClosedTrades: number;
    closedPositionsAttributed: number;
    resolvedDispatches: number;
    slippageSamples: number;
    partialFillSamples: number;
  };
  /** Human-readable narration of what happened, in order. */
  reasons: string[];
}

function mean(xs: readonly number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/**
 * Derive a capacity proposal from recorded evidence.
 *
 * PURE. No clock, no RNG of its own (the simulator is seeded from the
 * disclosed framing), no IO, and — the invariant this whole hold exists to
 * protect — NO WRITE. Calling this a thousand times changes nothing anywhere.
 */
export function buildEdgeCapacityProposal(ev: EdgeCapacityEvidence): EdgeCapacityProposal {
  const gaps: CapacityEvidenceGap[] = [];
  const optimisticAssumptions: string[] = [];
  const reasons: string[] = [];

  // ── 1. Realized distribution ────────────────────────────────────────────
  const rs = ev.realizedRMultiples;
  const rCount = rs?.length ?? 0;
  if (rs == null) {
    gaps.push({
      code: "EVIDENCE_READ_FAILED",
      missing: `realized outcomes for edge ${ev.edgeId} could not be read: ${ev.realizedReadFailure ?? "reason not recorded"}`,
      wouldBeSettledBy: "a successful read of the closed positions attributed to this edge",
    });
  } else if (ev.closedPositionsAttributed === 0) {
    gaps.push({
      code: "NO_CLOSED_TRADES_ATTRIBUTED",
      missing: `no closed position anywhere on the platform carries edge ${ev.edgeId} — there is no realized outcome to measure`,
      wouldBeSettledBy: `≥ ${CAPACITY_MIN_CLOSED_TRADES} closed trades placed under this edge (demo counts: they are attributed the same way)`,
    });
  } else if (rCount < CAPACITY_MIN_CLOSED_TRADES) {
    const dropped = ev.closedPositionsDropped.reduce((s, d) => s + d.count, 0);
    gaps.push({
      code: "TOO_FEW_R_RESOLVABLE_TRADES",
      missing: `only ${rCount} of ${ev.closedPositionsAttributed} closed trades on this edge have a resolvable planned-risk basis (${dropped} dropped: ${ev.closedPositionsDropped.map((d) => `${d.count}× ${d.reason}`).join("; ") || "none recorded"}); need ≥ ${CAPACITY_MIN_CLOSED_TRADES}`,
      wouldBeSettledBy: `${CAPACITY_MIN_CLOSED_TRADES - rCount} more closed trades that carry a stop-loss, a broker-reported P&L and a known contract spec`,
    });
  } else {
    const wins = rs.filter((x) => x > 0);
    const losses = rs.filter((x) => x < 0);
    if (wins.length === 0) {
      gaps.push({
        code: "NO_REALIZED_WINS",
        missing: `all ${rCount} realized trades on this edge lost — no win magnitude exists to simulate`,
        wouldBeSettledBy: "at least one winning closed trade on this edge",
      });
    }
    if (losses.length === 0) {
      gaps.push({
        code: "NO_REALIZED_LOSSES",
        missing: `all ${rCount} realized trades on this edge won — an average loss cannot be measured and will not be invented`,
        wouldBeSettledBy: "at least one losing closed trade on this edge",
      });
    }
  }

  // ── 2. Liquidity: fill probability ──────────────────────────────────────
  const resolvedDispatches = ev.dispatch
    ? ev.dispatch.filled + ev.dispatch.rejected + ev.dispatch.expired
    : 0;
  if (ev.dispatch == null) {
    gaps.push({
      code: "EVIDENCE_READ_FAILED",
      missing: `dispatch outcomes for edge ${ev.edgeId} could not be read: ${ev.dispatchReadFailure ?? "reason not recorded"}`,
      wouldBeSettledBy: "a successful read of the live commands carrying this edge",
    });
  } else if (resolvedDispatches === 0) {
    gaps.push({
      code: "NO_RESOLVED_DISPATCHES",
      missing: `no command carrying edge ${ev.edgeId} has ever resolved (filled, rejected or expired) — the fill probability is UNKNOWN, and an unknown fill probability is not 100%`,
      wouldBeSettledBy: `≥ ${CAPACITY_MIN_RESOLVED_DISPATCHES} resolved dispatches on this edge`,
    });
  } else if (resolvedDispatches < CAPACITY_MIN_RESOLVED_DISPATCHES) {
    gaps.push({
      code: "TOO_FEW_RESOLVED_DISPATCHES",
      missing: `only ${resolvedDispatches} resolved dispatch(es) on this edge; need ≥ ${CAPACITY_MIN_RESOLVED_DISPATCHES} before a fill probability means anything`,
      wouldBeSettledBy: `${CAPACITY_MIN_RESOLVED_DISPATCHES - resolvedDispatches} more resolved dispatches on this edge`,
    });
  }

  // ── 3. Liquidity: slippage ──────────────────────────────────────────────
  const slip = ev.slippageRSamples;
  const slipCount = slip?.length ?? 0;
  if (slip == null) {
    gaps.push({
      code: "EVIDENCE_READ_FAILED",
      missing: `slippage samples for edge ${ev.edgeId} could not be read`,
      wouldBeSettledBy: "a successful read of the filled commands carrying this edge",
    });
  } else if (slipCount < CAPACITY_MIN_SLIPPAGE_SAMPLES) {
    gaps.push({
      code: "SLIPPAGE_NOT_MEASURED",
      missing: `only ${slipCount} slippage sample(s) on this edge (a sample needs a draft-time reference price, a fill price, a stop-loss and a contract spec on the same command); need ≥ ${CAPACITY_MIN_SLIPPAGE_SAMPLES}`,
      wouldBeSettledBy: `${CAPACITY_MIN_SLIPPAGE_SAMPLES - slipCount} more fills that recorded payload.referencePrice alongside fill_price — slippage only ever LOWERS capacity, so assuming it is zero would overstate the answer`,
    });
  }

  // ── 4. Venue failure ────────────────────────────────────────────────────
  let failureProb01 = 0;
  if (ev.venueFailureObservations == null) {
    optimisticAssumptions.push(
      "venue-failure rate could not be separated from ordinary closes; the proposal simulates ZERO venue failures, which is the optimistic direction",
    );
  } else {
    const { failures, ofClosed } = ev.venueFailureObservations;
    failureProb01 = ofClosed > 0 ? failures / ofClosed : 0;
    if (failures === 0) {
      optimisticAssumptions.push(
        `venue-failure rate taken as the OBSERVED 0/${ofClosed}; an observed zero is not a proven zero, so the proposal is optimistic in this dimension`,
      );
    } else if (ev.venueFailureSlipMultiplier == null) {
      gaps.push({
        code: "VENUE_FAILURE_MAGNITUDE_UNKNOWN",
        missing: `${failures} venue failure(s) observed on this edge but the slip MAGNITUDE (how far the loss leg runs when the venue fails) has never been measured — the rate alone cannot be simulated`,
        wouldBeSettledBy: "a recorded broker close price for a venue-failed exit, so the realized slip past the intended stop can be measured",
      });
    }
  }

  // ── 5. Partial fills ────────────────────────────────────────────────────
  let partial01 = 1;
  if (ev.partialFillMean01 == null || ev.partialFillSamples === 0) {
    optimisticAssumptions.push(
      "executed-vs-requested volume was never recorded on this edge; the proposal simulates FULL fills, which is the optimistic direction",
    );
  } else {
    partial01 = ev.partialFillMean01;
  }

  const sampleSizes = {
    rResolvableClosedTrades: rCount,
    closedPositionsAttributed: ev.closedPositionsAttributed,
    resolvedDispatches,
    slippageSamples: slipCount,
    partialFillSamples: ev.partialFillSamples,
  };

  // ── INSUFFICIENT: no number, ever ───────────────────────────────────────
  if (gaps.length > 0) {
    reasons.push(
      `Edge ${ev.edgeId}: ${gaps.length} evidence gap(s) — no capacity number is proposed. An insufficient proposal is a refusal to guess, not a pending calculation.`,
    );
    for (const g of gaps) reasons.push(`GAP ${g.code}: ${g.missing}`);
    return {
      edgeId: ev.edgeId,
      gatheredAt: ev.gatheredAt,
      verdict: "INSUFFICIENT_EVIDENCE",
      confidence: "NONE",
      proposedCapacityStatus: null,
      proposedCapacityRiskR: null,
      proposedMaxDeployedUsd: null,
      maxDeployedUsdReason: MAX_DEPLOYED_USD_REASON,
      simulatorInput: null,
      estimate: null,
      gaps,
      optimisticAssumptions,
      sampleSizes,
      reasons,
    };
  }

  // ── PROPOSED: run the simulator on measured inputs ──────────────────────
  const measured = rs as readonly number[];
  const wins = measured.filter((x) => x > 0);
  const losses = measured.filter((x) => x < 0);
  const dispatch = ev.dispatch!;
  const simulatorInput: Omit<FrictionRuinInput, "candidateRiskR"> = {
    winRate01: wins.length / measured.length,
    avgWinR: mean(wins),
    avgLossR: mean(losses),
    pathsToSimulate: CAPACITY_PROPOSAL_FRAMING.pathsToSimulate,
    horizonTrades: CAPACITY_PROPOSAL_FRAMING.horizonTrades,
    ruinThresholdR: CAPACITY_PROPOSAL_FRAMING.ruinThresholdR,
    seed: CAPACITY_PROPOSAL_FRAMING.seed,
    concurrentPositions: CAPACITY_PROPOSAL_FRAMING.concurrentPositions,
    correlation01: CAPACITY_PROPOSAL_FRAMING.correlation01,
    liquidity: {
      fillProbability01: dispatch.filled / resolvedDispatches,
      partialFillMean01: partial01,
      slippageR: mean(slip as readonly number[]),
    },
    brokerFailure: {
      perTradeFailureProb01: failureProb01,
      failureSlipMultiplier: ev.venueFailureSlipMultiplier ?? 1,
    },
  };

  optimisticAssumptions.push(
    `concurrency and correlation are simulated at ${CAPACITY_PROPOSAL_FRAMING.concurrentPositions} position / ρ=${CAPACITY_PROPOSAL_FRAMING.correlation01}: this edge's real concurrent-position behaviour has not been measured, and correlated concurrency can only make ruin WORSE`,
  );

  const estimate = estimateStrategyCapacity(simulatorInput);

  reasons.push(
    `Edge ${ev.edgeId}: distribution from ${measured.length} closed trades (win rate ${(simulatorInput.winRate01 * 100).toFixed(1)}%, avg win ${simulatorInput.avgWinR.toFixed(2)}R, avg loss ${simulatorInput.avgLossR.toFixed(2)}R), fill probability ${(simulatorInput.liquidity!.fillProbability01 * 100).toFixed(1)}% from ${resolvedDispatches} resolved dispatches, slippage ${simulatorInput.liquidity!.slippageR.toFixed(3)}R from ${slipCount} samples.`,
  );
  reasons.push(...estimate.reasons);
  reasons.push(
    "PROPOSAL ONLY: this has not been recorded on the edge and cannot be. Gate #23 still refuses until an admin presses the estimate AND a USD ceiling.",
  );

  // Confidence never reaches HIGH: this evidence base cannot support it.
  const bigSample = measured.length >= CAPACITY_MIN_CLOSED_TRADES * 3
    && resolvedDispatches >= CAPACITY_MIN_RESOLVED_DISPATCHES * 3;
  const confidence: CapacityProposalConfidence =
    optimisticAssumptions.length > 1 || !bigSample ? "LOW" : "MODERATE";

  return {
    edgeId: ev.edgeId,
    gatheredAt: ev.gatheredAt,
    verdict: "PROPOSED",
    confidence,
    proposedCapacityStatus: estimate.status,
    proposedCapacityRiskR: estimate.status === "ESTIMATED" ? estimate.capacityRiskR : null,
    proposedMaxDeployedUsd: null,
    maxDeployedUsdReason: MAX_DEPLOYED_USD_REASON,
    simulatorInput,
    estimate,
    gaps,
    optimisticAssumptions,
    sampleSizes,
    reasons,
  };
}

export const MAX_DEPLOYED_USD_REASON =
  "Not proposed, by construction. The simulator answers in planned-risk R; converting R into a cumulative USD deployable ceiling needs a capital basis attached to the edge, which this system does not hold. Inventing one would be a learned output setting a size — the exact thing the flywheel invariant forbids. The USD ceiling is the owner's press.";
