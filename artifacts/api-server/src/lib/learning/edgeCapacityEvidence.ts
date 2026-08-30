// ═══════════════════════════════════════════════════════════════════════════
// EDGE CAPACITY EVIDENCE COLLECTOR — the reads behind a capacity proposal.
//
// Gathers, for one edge in production_edges, whatever REAL evidence this
// system has actually recorded, and hands it to the pure proposal engine
// (@workspace/domain decision-intelligence `buildEdgeCapacityProposal`).
//
// ── READ-ONLY BY CONSTRUCTION ──────────────────────────────────────────────
// This module contains no `db.insert`, no `db.update`, no `db.delete`, and it
// never will: a proposal that could write itself into production_edges would
// dissolve the only thing gate #23 protects. The pin is asserted in
// src/lib/learning/__qa__/edgeCapacityProposal.test.ts.
//
// ── WHAT COUNTS AS EVIDENCE ────────────────────────────────────────────────
//   distribution — closed positions whose SOURCE COMMAND carries this edge_id,
//                  with a broker-REPORTED realised P&L, converted to
//                  planned-risk R multiples: pnl ÷ (|entry−stop| × contract
//                  size × volume). A position without a stop-loss has no
//                  planned risk and is DROPPED, counted, and named — never
//                  back-filled with an assumed stop.
//   liquidity    — resolved dispatches (filled / rejected / expired) for the
//                  edge's entry commands, and realized slippage measured as
//                  |fill − payload.referencePrice| ÷ |fill − stop|, which is
//                  already in planned-risk R (contract size and volume cancel).
//   venue        — closed positions the broker closed without usable numbers,
//                  or reconciled as broker-absent: the observable behind the
//                  simulator's broker-failure leg.
//
// Every leg that cannot be read degrades to a typed null WITH a reason. There
// is no path in this file that turns an unreadable leg into a zero.
//
// ── WHERE THE ARITHMETIC LIVES ─────────────────────────────────────────────
// This file owns the READS. Every derivation the reads feed — the R-multiple
// math, the drop classification, the slippage formula, the venue-failure
// heuristic — lives in `edgeCapacityDerivation.ts`, which imports no `db` and
// is covered by behavioural tests. It used to be inline here, inside these try
// blocks, where nothing but a source grep could reach it; valid SQL is not
// correct arithmetic, and a mis-derived R does not throw — it produces a
// plausible WRONG number on the surface the owner is told to read.
//
// That was not hypothetical. The extraction immediately exposed a live
// coercion defect: the old local `finite()` did `Number(x)`, and `Number(null)`
// is 0, so a closed position with NO broker-reported realised P&L was scored as
// a break-even 0R TRADE instead of being dropped, and was never counted as a
// venue failure. Every other leg was accidentally shielded by a `> 0` guard;
// P&L legitimately can be 0, so it was not. See `finite()` in the derivation
// module and the drop tests that now pin it.
// ═══════════════════════════════════════════════════════════════════════════

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  arxLiveCommandsTable,
  arxLivePositionsTable,
  arxSymbolSpecsTable,
} from "@workspace/db/schema";
import type { EdgeCapacityEvidence } from "@workspace/domain/decision-intelligence";
import { logger } from "../logger.js";
import {
  deriveLiquidityEvidence,
  deriveRealizedEvidence,
  specKey,
  type SymbolSpec,
} from "./edgeCapacityDerivation.js";

const log = logger.child({ component: "edgeCapacityEvidence" });

/** The two command types that OPEN exposure. Mirrors the dispatch pipeline's
 *  own `isEntryCommand`; capacity governs entries, never closes. */
const ENTRY_COMMAND_TYPES = ["PLACE_LIVE_MARKET_ORDER", "PLACE_LIVE_PENDING_ORDER"] as const;

/**
 * Gather the evidence snapshot for one edge.
 *
 * `gatheredAt` is passed in rather than read from the clock here, so the
 * snapshot's timestamp is the caller's single, consistent one across a batch.
 */
export async function gatherEdgeCapacityEvidence(
  edgeId: number,
  gatheredAt: Date,
): Promise<EdgeCapacityEvidence> {
  const ev: EdgeCapacityEvidence = {
    edgeId,
    gatheredAt: gatheredAt.toISOString(),
    realizedRMultiples: null,
    realizedReadFailure: null,
    closedPositionsAttributed: 0,
    closedPositionsDropped: [],
    dispatch: null,
    dispatchReadFailure: null,
    partialFillMean01: null,
    partialFillSamples: 0,
    slippageRSamples: null,
    venueFailureObservations: null,
    venueFailureSlipMultiplier: null,
  };

  // ── Distribution + venue failures: closed positions attributed to the edge ─
  try {
    const closed = await db.select({
      userId: arxLivePositionsTable.userId,
      symbol: arxLivePositionsTable.symbol,
      volume: arxLivePositionsTable.volume,
      entryPrice: arxLivePositionsTable.entryPrice,
      stopLoss: arxLivePositionsTable.stopLoss,
      realisedPnl: arxLivePositionsTable.brokerRealisedPnl,
      closeReportedAt: arxLivePositionsTable.brokerCloseReportedAt,
      reconcileState: arxLivePositionsTable.reconcileState,
    }).from(arxLivePositionsTable)
      .innerJoin(
        arxLiveCommandsTable,
        eq(arxLivePositionsTable.sourceCommandId, arxLiveCommandsTable.commandId),
      )
      .where(and(
        eq(arxLiveCommandsTable.edgeId, edgeId),
        isNotNull(arxLivePositionsTable.closedAt),
      ));

    ev.closedPositionsAttributed = closed.length;

    // Contract specs are per (owning user, symbol) — real broker specs only.
    const specByKey = new Map<string, SymbolSpec>();
    if (closed.length > 0) {
      const userIds = Array.from(new Set(closed.map((p) => p.userId)));
      const symbols = Array.from(new Set(closed.map((p) => p.symbol)));
      const specs = await db.select({
        userId: arxSymbolSpecsTable.userId,
        symbol: arxSymbolSpecsTable.symbol,
        contractSize: arxSymbolSpecsTable.contractSize,
        profitCurrency: arxSymbolSpecsTable.profitCurrency,
      }).from(arxSymbolSpecsTable).where(and(
        inArray(arxSymbolSpecsTable.userId, userIds),
        inArray(arxSymbolSpecsTable.symbol, symbols),
      ));
      for (const s of specs) {
        specByKey.set(specKey(s.userId, s.symbol), {
          contractSize: s.contractSize,
          profitCurrency: s.profitCurrency,
        });
      }
    }

    // The arithmetic lives in edgeCapacityDerivation.ts, which imports no db
    // and is pinned by behavioural tests. This function owns the READS only.
    const derived = deriveRealizedEvidence(closed, specByKey);
    ev.realizedRMultiples = derived.rMultiples;
    ev.closedPositionsDropped = derived.dropped;
    ev.venueFailureObservations = { failures: derived.venueFailures, ofClosed: closed.length };
  } catch (err) {
    log.warn({ err, edgeId }, "edge_capacity_evidence_realized_read_failed");
    ev.realizedRMultiples = null;
    ev.realizedReadFailure = err instanceof Error ? err.message : String(err);
    ev.venueFailureObservations = null;
  }

  // ── Liquidity: dispatch outcomes, partial fills, realized slippage ────────
  try {
    const cmds = await db.select({
      commandStatus: arxLiveCommandsTable.status,
      filledAt: arxLiveCommandsTable.filledAt,
      rejectedAt: arxLiveCommandsTable.rejectedAt,
      expiredAt: arxLiveCommandsTable.expiredAt,
      requestedVolume: arxLiveCommandsTable.requestedVolume,
      executedVolume: arxLiveCommandsTable.executedVolume,
      fillPrice: arxLiveCommandsTable.fillPrice,
      stopLoss: arxLiveCommandsTable.stopLoss,
      payload: arxLiveCommandsTable.payload,
    }).from(arxLiveCommandsTable).where(and(
      eq(arxLiveCommandsTable.edgeId, edgeId),
      inArray(arxLiveCommandsTable.commandType, [...ENTRY_COMMAND_TYPES]),
      isNotNull(arxLiveCommandsTable.confirmedAt),
    ));

    // Again: reads here, arithmetic in the behaviourally-tested derivation.
    const derived = deriveLiquidityEvidence(cmds);
    ev.dispatch = derived.dispatch;
    ev.slippageRSamples = derived.slippageRSamples;
    ev.partialFillSamples = derived.partialFillSamples;
    ev.partialFillMean01 = derived.partialFillMean01;
  } catch (err) {
    log.warn({ err, edgeId }, "edge_capacity_evidence_dispatch_read_failed");
    ev.dispatch = null;
    ev.dispatchReadFailure = err instanceof Error ? err.message : String(err);
    ev.slippageRSamples = null;
    ev.partialFillMean01 = null;
    ev.partialFillSamples = 0;
  }

  return ev;
}

/**
 * Cumulative USD already deployed on an edge, or a typed null with the reason.
 * Delegates to the SAME function the dispatch gate uses, so the readout cannot
 * report a headroom the gate would not honour.
 */
export async function readEdgeDeployedUsd(
  edgeId: number,
): Promise<{ deployedUsd: number | null; unknownReason: string | null }> {
  try {
    const { computeEdgeDeployedUsd } = await import("../live/foundationGateInputs.js");
    const v = await computeEdgeDeployedUsd(edgeId);
    if (v == null) {
      return {
        deployedUsd: null,
        unknownReason: "at least one open position or in-flight command on this edge has no resolvable USD notional (missing contract spec or price) — a partial sum is never reported as the total",
      };
    }
    return { deployedUsd: v, unknownReason: null };
  } catch (err) {
    log.warn({ err, edgeId }, "edge_capacity_deployed_usd_read_failed");
    return {
      deployedUsd: null,
      unknownReason: err instanceof Error ? err.message : String(err),
    };
  }
}
