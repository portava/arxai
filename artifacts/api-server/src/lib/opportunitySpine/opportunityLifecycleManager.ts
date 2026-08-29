// Opportunity Spine (#17) — the OWNING lifecycle manager.
//
// Subscribes at the EXISTING seams — the self-trade decision cycle
// (decisionEngine.runDecisionCycle, post-persist) and the agent execution
// ledger (self_trade_agent_executions, reconciled by the sweep) — and
// maintains one persisted opportunity object per setup identity plus a
// unified append-only event log (`opportunity_events`).
//
// SAFETY (inviolable):
//  - OBSERVER ONLY. Nothing here places, blocks, modifies, or closes an
//    order; no gate, kill switch, governor, or dispatch surface is touched.
//    The scanner/mission/decision read paths keep working unchanged — the
//    ingest hook is fail-open (a spine failure never breaks the read).
//  - All state movement goes through the PURE state machine
//    (@workspace/domain/opportunity-spine). Terminal objects absorb: expired
//    evidence is never revived; a fresh sighting creates a NEW object (the
//    partial unique index enforces one OPEN object per key).
//  - MISSED accounting is on the same object: an entry window seen open that
//    dies without a fill terminates MISSED, not EXPIRED.
//  - Fills are never fabricated: EXECUTED requires a real FILLED/CLOSED
//    execution row (dispatch alone is only an EXECUTION_DISPATCHED event).

import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  db,
  opportunitiesTable,
  opportunityEventsTable,
  selfTradeAgentExecutionsTable,
  selfTradeDecisionsTable,
  type OpportunityRow,
} from "@workspace/db";
import {
  applyOpportunityEvent,
  deriveOpportunityObservation,
  buildOpportunityKey,
  opportunityKeyFromParts,
  timeframeHorizonClass,
  type OpportunityEvent,
  type OpportunityObservation,
  type OpportunitySnapshot,
  type OpportunityState,
} from "@workspace/domain/opportunity-spine";
import type {
  DecisionCandidate,
  OppositeConflictJournalEntry,
} from "@workspace/domain/self-trade";
import type { DedupJournalEntry } from "@workspace/domain/opportunity-spine";
import { logger } from "../logger.js";

/** Stale-close window: an open object not observed by ANY cycle for this long
 * and carrying no explicit expiry is closed EXPIRED with an honest
 * "stale, no fresh observation" reason (housekeeping, not fabricated market
 * evidence — the reason says exactly what we know). */
export const OPPORTUNITY_STALE_CLOSE_MS = 24 * 60 * 60 * 1000;

/** Executions younger than this are reconciled into the spine each sweep. */
const EXECUTION_LOOKBACK_MS = 48 * 60 * 60 * 1000;

// Change-only journal memory (opportunityId → signature) so a standing
// dedup/conflict/dispatch situation does not append an identical event on
// every 8-second decision poll. In-process only — a restart may journal one
// extra event, never lose one.
const lastEventSignature = new Map<string, string>();

function snapshotOf(row: OpportunityRow): OpportunitySnapshot {
  return {
    state: row.state as OpportunityState,
    entryWindowSeen: row.entryWindowSeen,
    executionAttempted: row.executionAttempted,
    terminal: row.terminalAt != null,
    terminalReason: row.terminalReason,
  };
}

async function appendEvent(args: {
  opportunityId: number;
  eventType: OpportunityEvent["type"];
  fromState: string | null;
  toState: string | null;
  reason: string;
  cycleId?: string | null;
  decisionId?: number | null;
  agentKey?: string | null;
  payload?: Record<string, unknown> | null;
}): Promise<void> {
  await db.insert(opportunityEventsTable).values({
    opportunityId: args.opportunityId,
    eventType: args.eventType,
    fromState: args.fromState,
    toState: args.toState,
    reason: args.reason,
    cycleId: args.cycleId ?? null,
    decisionId: args.decisionId ?? null,
    agentKey: args.agentKey ?? null,
    payload: args.payload ?? null,
  });
}

/** Change-only variant keyed by (opportunityId, kind) signature. */
async function appendEventOnce(
  signatureKey: string,
  signature: string,
  args: Parameters<typeof appendEvent>[0],
): Promise<void> {
  if (lastEventSignature.get(signatureKey) === signature) return;
  lastEventSignature.set(signatureKey, signature);
  await appendEvent(args);
}

/** Apply one pure event to a persisted row: update the row cache + journal.
 * Refused events (terminal absorption) journal NOTHING and change nothing. */
async function applyAndPersist(
  row: OpportunityRow,
  event: OpportunityEvent,
  ctx: { cycleId?: string | null; decisionId?: number | null; agentKey?: string | null; payload?: Record<string, unknown> | null; nowMs: number },
): Promise<OpportunityRow> {
  const r = applyOpportunityEvent(snapshotOf(row), event);
  if (!r.accepted) return row; // terminal no-revival: honest refusal, no write
  const next = r.snapshot;
  const now = new Date(ctx.nowMs);
  const updated: Partial<typeof opportunitiesTable.$inferInsert> = {
    state: next.state,
    entryWindowSeen: next.entryWindowSeen,
    executionAttempted: next.executionAttempted,
    updatedAt: now,
  };
  if (next.terminal && row.terminalAt == null) {
    updated.terminalAt = now;
    updated.terminalReason = next.terminalReason;
  }
  await db.update(opportunitiesTable).set(updated).where(eq(opportunitiesTable.id, row.id));
  await appendEvent({
    opportunityId: row.id,
    eventType: event.type,
    fromState: r.fromState,
    toState: r.toState,
    reason: event.reason,
    cycleId: ctx.cycleId,
    decisionId: ctx.decisionId,
    agentKey: ctx.agentKey,
    payload: ctx.payload,
  });
  return {
    ...row,
    state: next.state,
    entryWindowSeen: next.entryWindowSeen,
    executionAttempted: next.executionAttempted,
    terminalAt: next.terminal ? (row.terminalAt ?? now) : row.terminalAt,
    terminalReason: next.terminalReason ?? row.terminalReason,
    updatedAt: now,
  };
}

async function loadOpenByKeys(keys: string[]): Promise<Map<string, OpportunityRow>> {
  if (keys.length === 0) return new Map();
  const rows = await db
    .select()
    .from(opportunitiesTable)
    .where(and(inArray(opportunitiesTable.opportunityKey, keys), isNull(opportunitiesTable.terminalAt)));
  return new Map(rows.map((r) => [r.opportunityKey, r]));
}

async function ingestObservationGroup(
  key: string,
  group: OpportunityObservation[],
  open: Map<string, OpportunityRow>,
  cycleId: string,
  nowMs: number,
): Promise<void> {
  // Representative = strongest observation this cycle.
  const rep = [...group].sort((a, b) => b.rankScore - a.rankScore)[0]!;
  const now = new Date(nowMs);
  const expiry = group
    .map((o) => (o.setupExpiresAt ? Date.parse(o.setupExpiresAt) : NaN))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => b - a)[0];

  let row = open.get(key) ?? null;
  if (!row) {
    // New owning object. onConflictDoNothing guards a racing writer against the
    // partial unique open-key index; on a race we re-read the winner.
    const inserted = await db
      .insert(opportunitiesTable)
      .values({
        opportunityKey: key,
        symbol: rep.symbol,
        timeframe: rep.timeframe,
        horizonClass: rep.horizonClass,
        side: rep.side,
        setupType: rep.setup,
        state: "WATCHING",
        ownerAgentKey: rep.agentKey,
        bestRankScore: rep.rankScore,
        lastCycleId: cycleId,
        thesis: (rep.thesis ?? null) as Record<string, unknown> | null,
        setupExpiresAt: expiry != null ? new Date(expiry) : null,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoNothing()
      .returning();
    row = inserted[0] ?? (await loadOpenByKeys([key])).get(key) ?? null;
    if (!row) return; // race lost and re-read failed — next cycle retries
    if (inserted[0]) {
      await appendEvent({
        opportunityId: row.id,
        eventType: "OPENED",
        fromState: null,
        toState: "WATCHING",
        reason: `Opportunity opened: ${rep.symbol} ${rep.side} ${rep.setup} (${rep.horizonClass}) first seen by ${rep.agentKey}.`,
        cycleId,
        agentKey: rep.agentKey,
      });
    }
  }

  // Freshness/context updates that are not state transitions.
  await db
    .update(opportunitiesTable)
    .set({
      lastSeenAt: now,
      lastCycleId: cycleId,
      ownerAgentKey: rep.agentKey,
      bestRankScore: Math.max(row.bestRankScore, rep.rankScore),
      thesis: (rep.thesis ?? row.thesis ?? null) as Record<string, unknown> | null,
      setupExpiresAt: expiry != null ? new Date(expiry) : row.setupExpiresAt,
      updatedAt: now,
    })
    .where(eq(opportunitiesTable.id, row.id));

  // Stage observation — journaled change-only (state moves are what matter).
  if (row.state !== rep.observedStage) {
    await applyAndPersist(
      row,
      {
        type: "STAGE_OBSERVED",
        observedStage: rep.observedStage,
        reason: `Observed ${rep.observedStage} (outcome ${rep.outcome}, rank ${rep.rankScore}) by ${rep.agentKey}.`,
      },
      { cycleId, agentKey: rep.agentKey, nowMs },
    );
  }
}

export interface IngestCycleInput {
  cycleId: string;
  candidates: DecisionCandidate[];
  dedupJournal: DedupJournalEntry[];
  conflictJournal: OppositeConflictJournalEntry[];
  nowMs: number;
}

/**
 * Ingest one supervisor-resolved decision cycle into the owning spine.
 * Fail-open BY CALLER: the decision engine wraps this in try/catch — a spine
 * failure must never break the decision read path.
 */
export async function ingestDecisionCycle(input: IngestCycleInput): Promise<{ touched: number }> {
  const { cycleId, candidates, dedupJournal, conflictJournal, nowMs } = input;

  const byKey = new Map<string, OpportunityObservation[]>();
  for (const c of candidates) {
    const obs = deriveOpportunityObservation(c);
    if (!obs) continue;
    const arr = byKey.get(obs.opportunityKey) ?? [];
    arr.push(obs);
    byKey.set(obs.opportunityKey, arr);
  }

  const open = await loadOpenByKeys([...byKey.keys()]);
  let touched = 0;
  for (const [key, group] of byKey) {
    try {
      await ingestObservationGroup(key, group, open, cycleId, nowMs);
      touched += 1;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), key },
        "opportunity_spine ingest failed for one setup (skipped, fail-open)",
      );
    }
  }

  // #18 dedup journal → DUPLICATE_MERGED events (change-only per pair).
  const dedupKeys = dedupJournal.map((j) =>
    opportunityKeyFromParts({ symbol: j.symbol, horizonClass: j.horizonClass, side: j.side, setup: j.setup }),
  );
  const dedupOpen = await loadOpenByKeys(dedupKeys);
  for (let i = 0; i < dedupJournal.length; i++) {
    const j = dedupJournal[i]!;
    const row = dedupOpen.get(dedupKeys[i]!);
    if (!row) continue;
    try {
      await appendEventOnce(
        `dedup:${row.id}:${j.duplicateAgentKey}`,
        `${j.ownerAgentKey}|${j.similarity.score}`,
        {
          opportunityId: row.id,
          eventType: "DUPLICATE_MERGED",
          fromState: row.state,
          toState: row.state,
          reason: j.reason,
          cycleId,
          agentKey: j.duplicateAgentKey,
          payload: { ownerAgentKey: j.ownerAgentKey, similarity: j.similarity },
        },
      );
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "opportunity_spine dedup journal write failed (fail-open)");
    }
  }

  // #19 conflict journal → CONFLICT_RESOLVED events on every open object of
  // the conflicted symbol (both sides are parties to the conflict).
  for (const j of conflictJournal) {
    try {
      const rows = await db
        .select()
        .from(opportunitiesTable)
        .where(and(eq(opportunitiesTable.symbol, j.symbol), isNull(opportunitiesTable.terminalAt)));
      for (const row of rows) {
        await appendEventOnce(
          `conflict:${row.id}`,
          `${j.resolution}|${j.buyAgentKey}|${j.sellAgentKey}|${j.winnerAgentKey ?? ""}`,
          {
            opportunityId: row.id,
            eventType: "CONFLICT_RESOLVED",
            fromState: row.state,
            toState: row.state,
            reason: j.reason,
            cycleId,
            payload: {
              conflictClass: j.conflictClass,
              resolution: j.resolution,
              winnerAgentKey: j.winnerAgentKey,
              rulesConsulted: j.rulesConsulted.map((r) => ({ ruleId: r.ruleId, applied: r.applied, detail: r.detail })),
            },
          },
        );
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "opportunity_spine conflict journal write failed (fail-open)");
    }
  }

  return { touched };
}

// ── Sweep: execution reconciliation + expiry/missed accounting ───────────────

export interface OpportunitySweepResult {
  reconciled: number;
  expired: number;
  missed: number;
  errors: number;
}

/** One sweep pass. Per-item try/catch; never throws for one bad row. */
export async function runOpportunitySweepPass(
  opts: { nowMs?: number } = {},
): Promise<OpportunitySweepResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const result: OpportunitySweepResult = { reconciled: 0, expired: 0, missed: 0, errors: 0 };

  // A. Execution outcomes → terminal EXECUTED/REJECTED (real evidence only).
  try {
    const cutoff = new Date(nowMs - EXECUTION_LOOKBACK_MS);
    const execRows = await db
      .select({
        status: selfTradeAgentExecutionsTable.status,
        agentKey: selfTradeAgentExecutionsTable.agentKey,
        decisionId: selfTradeAgentExecutionsTable.decisionId,
        brokerTicket: selfTradeAgentExecutionsTable.brokerTicket,
        blockReason: selfTradeAgentExecutionsTable.blockReason,
        decSymbol: selfTradeDecisionsTable.symbol,
        decTimeframe: selfTradeDecisionsTable.timeframe,
        decSide: selfTradeDecisionsTable.side,
        decSetup: selfTradeDecisionsTable.setupType,
      })
      .from(selfTradeAgentExecutionsTable)
      .innerJoin(
        selfTradeDecisionsTable,
        eq(selfTradeAgentExecutionsTable.decisionId, selfTradeDecisionsTable.id),
      )
      .where(
        and(
          inArray(selfTradeAgentExecutionsTable.status, [
            "DISPATCHED",
            "FILLED",
            "CLOSED",
            "REJECTED",
            "BLOCKED",
          ]),
          gte(selfTradeAgentExecutionsTable.updatedAt, cutoff),
        ),
      )
      .limit(500);

    const keys: string[] = [];
    for (const e of execRows) {
      if (e.decSide !== "BUY" && e.decSide !== "SELL") continue;
      if (!e.decSetup) continue;
      keys.push(
        buildOpportunityKey({ symbol: e.decSymbol, timeframe: e.decTimeframe, side: e.decSide, setup: e.decSetup }),
      );
    }
    const open = await loadOpenByKeys(keys);
    let ki = 0;
    for (const e of execRows) {
      if (e.decSide !== "BUY" && e.decSide !== "SELL") continue;
      if (!e.decSetup) continue;
      const key = keys[ki]!;
      ki += 1;
      const row = open.get(key);
      if (!row) continue;
      try {
        if (e.status === "FILLED" || e.status === "CLOSED") {
          const next = await applyAndPersist(
            row,
            {
              type: "EXECUTION_FILLED",
              reason: `Real broker fill confirmed (ticket ${e.brokerTicket ?? "recorded"}) by ${e.agentKey}.`,
            },
            { decisionId: e.decisionId, agentKey: e.agentKey, nowMs },
          );
          open.set(key, next);
          result.reconciled += 1;
        } else if (e.status === "REJECTED" || e.status === "BLOCKED") {
          const next = await applyAndPersist(
            row,
            {
              type: e.status === "REJECTED" ? "EXECUTION_REJECTED" : "EXECUTION_BLOCKED",
              reason:
                e.status === "REJECTED"
                  ? `Execution rejected by the pipeline/broker${e.blockReason ? `: ${e.blockReason}` : "."}`
                  : `Execution refused by a gate${e.blockReason ? `: ${e.blockReason}` : "."}`,
            },
            { decisionId: e.decisionId, agentKey: e.agentKey, nowMs },
          );
          open.set(key, next);
          result.reconciled += 1;
        } else if (e.status === "DISPATCHED" && !row.executionAttempted) {
          const next = await applyAndPersist(
            row,
            { type: "EXECUTION_DISPATCHED", reason: `Gated execution attempt dispatched by ${e.agentKey} (not a fill).` },
            { decisionId: e.decisionId, agentKey: e.agentKey, nowMs },
          );
          open.set(key, next);
        }
      } catch (err) {
        result.errors += 1;
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), key },
          "opportunity_spine execution reconcile failed for one row (skipped)",
        );
      }
    }
  } catch (err) {
    result.errors += 1;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "opportunity_spine execution reconcile query failed (pass degraded)",
    );
  }

  // B. Expiry / missed accounting on still-open objects.
  try {
    const now = new Date(nowMs);
    const staleBefore = new Date(nowMs - OPPORTUNITY_STALE_CLOSE_MS);
    const dueRows = await db
      .select()
      .from(opportunitiesTable)
      .where(
        and(
          isNull(opportunitiesTable.terminalAt),
          or(
            and(sql`${opportunitiesTable.setupExpiresAt} IS NOT NULL`, lte(opportunitiesTable.setupExpiresAt, now)),
            lte(opportunitiesTable.lastSeenAt, staleBefore),
          ),
        ),
      )
      .limit(500);

    for (const row of dueRows) {
      try {
        const explicit = row.setupExpiresAt != null && row.setupExpiresAt.getTime() <= nowMs;
        const wasWindowSeen = row.entryWindowSeen;
        const next = await applyAndPersist(
          row,
          {
            type: "EXPIRED",
            reason: explicit
              ? `Setup aged past its validity window (expired ${row.setupExpiresAt!.toISOString()}).`
              : `No fresh observation for ${Math.round(OPPORTUNITY_STALE_CLOSE_MS / 3_600_000)}h and no explicit expiry — closed as stale.`,
          },
          { nowMs },
        );
        if (next.terminalAt != null) {
          if (wasWindowSeen) result.missed += 1;
          else result.expired += 1;
        }
      } catch (err) {
        result.errors += 1;
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), opportunityId: row.id },
          "opportunity_spine expiry failed for one row (skipped)",
        );
      }
    }
  } catch (err) {
    result.errors += 1;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "opportunity_spine expiry query failed (pass degraded)",
    );
  }

  return result;
}
