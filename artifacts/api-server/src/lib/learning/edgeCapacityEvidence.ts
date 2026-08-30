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

const log = logger.child({ component: "edgeCapacityEvidence" });

/** The two command types that OPEN exposure. Mirrors the dispatch pipeline's
 *  own `isEntryCommand`; capacity governs entries, never closes. */
const ENTRY_COMMAND_TYPES = ["PLACE_LIVE_MARKET_ORDER", "PLACE_LIVE_PENDING_ORDER"] as const;

function finite(x: unknown): number | null {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

/** Reads payload.referencePrice — the draft-time price the user approved —
 *  without trusting the payload's shape. Anything that is not a positive
 *  finite number is absent, not zero. */
function referencePriceOf(payload: unknown): number | null {
  if (payload == null || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>)["referencePrice"];
  const n = finite(v);
  return n != null && n > 0 ? n : null;
}

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
    const specByKey = new Map<string, { contractSize: number | null; profitCurrency: string | null }>();
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
        specByKey.set(`${s.userId}:${s.symbol}`, {
          contractSize: s.contractSize,
          profitCurrency: s.profitCurrency,
        });
      }
    }

    const rMultiples: number[] = [];
    const drops = new Map<string, number>();
    const drop = (reason: string) => drops.set(reason, (drops.get(reason) ?? 0) + 1);
    let venueFailures = 0;

    for (const p of closed) {
      // Venue-failure observable: the broker closed it but reported no usable
      // numbers, or it was reconciled as absent from the broker entirely.
      if (p.reconcileState === "RECONCILED_BROKER_ABSENT"
        || (p.closeReportedAt != null && finite(p.realisedPnl) == null)) {
        venueFailures += 1;
      }

      const pnl = finite(p.realisedPnl);
      if (pnl == null) { drop("no broker-reported realised P&L (outcome UNRECONCILED)"); continue; }
      const stop = finite(p.stopLoss);
      if (stop == null || stop <= 0) { drop("no stop-loss recorded, so the position has no planned risk"); continue; }
      const entry = finite(p.entryPrice);
      if (entry == null || entry <= 0) { drop("no entry price recorded"); continue; }
      const vol = finite(p.volume);
      if (vol == null || vol <= 0) { drop("no volume recorded"); continue; }
      const spec = specByKey.get(`${p.userId}:${p.symbol}`);
      if (spec == null) { drop("no broker contract spec for this user+symbol"); continue; }
      const contractSize = finite(spec.contractSize);
      if (contractSize == null || contractSize <= 0) { drop("contract size missing from the broker spec"); continue; }
      if (spec.profitCurrency !== "USD") {
        // A non-USD profit currency needs an FX rate at close time that this
        // system does not store. Converting with today's rate would be a
        // fabricated number wearing a historical label.
        drop(`profit currency ${spec.profitCurrency ?? "UNKNOWN"} — no close-time FX rate is recorded, so P&L cannot be normalised`);
        continue;
      }
      const plannedRiskUsd = Math.abs(entry - stop) * contractSize * vol;
      if (!(plannedRiskUsd > 0)) { drop("entry equals stop-loss, so planned risk is zero"); continue; }
      rMultiples.push(pnl / plannedRiskUsd);
    }

    ev.realizedRMultiples = rMultiples;
    ev.closedPositionsDropped = Array.from(drops.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);
    ev.venueFailureObservations = { failures: venueFailures, ofClosed: closed.length };
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

    let filled = 0, rejected = 0, expired = 0, stillInFlight = 0;
    const partialRatios: number[] = [];
    const slippage: number[] = [];

    for (const c of cmds) {
      if (c.filledAt != null) filled += 1;
      else if (c.rejectedAt != null) rejected += 1;
      else if (c.expiredAt != null) expired += 1;
      else { stillInFlight += 1; continue; }

      if (c.filledAt == null) continue;

      const req = finite(c.requestedVolume);
      const exec = finite(c.executedVolume);
      if (req != null && req > 0 && exec != null && exec > 0) {
        partialRatios.push(Math.min(1, exec / req));
      }

      const fill = finite(c.fillPrice);
      const ref = referencePriceOf(c.payload);
      const stop = finite(c.stopLoss);
      if (fill != null && fill > 0 && ref != null && stop != null && stop > 0) {
        const riskDistance = Math.abs(fill - stop);
        // Slippage in planned-risk R. Contract size and volume appear in both
        // numerator and denominator and cancel exactly, so no spec lookup is
        // needed and no spec gap can silently zero this out.
        if (riskDistance > 0) slippage.push(Math.abs(fill - ref) / riskDistance);
      }
    }

    ev.dispatch = { filled, rejected, expired, stillInFlight };
    ev.slippageRSamples = slippage;
    ev.partialFillSamples = partialRatios.length;
    ev.partialFillMean01 = partialRatios.length > 0
      ? partialRatios.reduce((s, x) => s + x, 0) / partialRatios.length
      : null;
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
