// Self-Trade AI — Autonomous Cycle Orchestrator (Task #213).
//
// One controlled, admin-triggered pass:
//   1. Run the #212 decision cycle (force) to produce + persist decisions.
//   2. Build the fleet safety context (governor + handshake) ONCE.
//   3. For every persisted APPROVED / APPROVED_REDUCED / PREPARE_ONLY decision
//      in this cycle, execute it through the agent executor (existing pipeline).
//   4. For every distinct agent touched (decisions ∪ active executions),
//      manage open positions, reconcile real outcomes, post realized P/L, and
//      soft-audit any missed daily-minimum quota.
//   5. Run the protective-action candidates every agent's manager queued, once,
//      after all ordinary dispatches (one wait budget per cycle, bridges
//      concurrently).
//
// Under the route, the cycle runs while holding the cross-process cycle lock
// with bounded database waits (cycleCoordinator.ts). Before each decision,
// each agent's management and the protective drain it re-verifies the lock
// (input.guard) and stops there if it was lost. `completion` says whether the
// cycle finished: a step that threw, a bounded wait that expired, a lost
// database connection, a protective outcome that is not proven or a stop is
// never reported as COMPLETED.
//
// SAFETY (inviolable): no always-on loop, no new MT5 path, no gate bypass, no
// fabricated fills. This orchestrator only sequences the existing, gated steps.

import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  selfTradeAgentsTable,
  selfTradeAgentSettingsTable,
  selfTradeAgentLedgerTable,
  selfTradeDecisionsTable,
  selfTradeAgentExecutionsTable,
  type SelfTradeAgent,
  type SelfTradeAgentSettings,
  type SelfTradeAgentLedger,
  type SelfTradeDecision,
} from "@workspace/db";
import { logger } from "../logger.js";
import { runDecisionCycle, buildFleetSafetyContext } from "./decisionEngine.js";
import { executeAgentDecision, reconcileAgentExecutions, type AgentExecutionStatus } from "./agentExecutor.js";
import { manageAgentPositions } from "./livePositionManager.js";
import { createProtectiveCycle, drainProtectiveCycle } from "./protectiveActionPath.js";
import { applyRealizedFromFills } from "./agentLedger.js";
import { countAgentFilledTradesToday } from "./agentQuotaEngine.js";
import { writeSelfTradeAudit } from "./audit.js";
import { listAgents, type AgentScope } from "./service.js";
import { reconcileAaciChain } from "../aaci/reconciliationAudit.js";
import { ingestAgentOutcomes } from "../aaci/learning/outcomeIngestion.js";
import { evaluateEntityDrift } from "../aaci/learning/driftService.js";
import { getOperationalMode } from "../security/operationalMode.js";
import { evaluateTradeAnomalyForUser } from "../security/anomalyService.js";
import { DEFAULT_ANOMALY_POLICY } from "@workspace/domain/security";
import { isDbConnectionLost, isDbWaitTimeout, type CycleGuard } from "./cycleCoordinator.js";

const EXECUTABLE_OUTCOMES = ["APPROVED", "APPROVED_REDUCED", "PREPARE_ONLY"] as const;
const ACTIVE_EXEC_STATUSES = ["PENDING_TICKET", "DISPATCHED", "FILLED"] as const;

export interface RunAutonomousCycleInput {
  scope?: AgentScope;
  actorUserId: number;
  actorRole?: string | null;
  force?: boolean;
  reason?: string | null;
  /** Cross-process lock checks and wait accounting (route); omitted, the cycle runs unguarded. */
  guard?: CycleGuard;
}

/**
 * Whether the cycle finished. COMPLETED only when every step ran and none
 * threw, hit a bounded database wait, lost its database connection or left a
 * protective outcome unproven (PROTECTIVE_HOLD_OUTCOME_UNCERTAIN /
 * PROTECTIVE_HOLD_INTERNAL_ERROR / PROTECTIVE_DRAIN_FAILED). A failed step's outcome is not proven
 * by the cycle: a decision whose executor threw may have created a command
 * (its reservation, if any, is kept), so the operator checks the execution
 * feed rather than reading the tallies as the whole truth.
 */
export interface CycleCompletion {
  status: "COMPLETED" | "INCOMPLETE" | "STOPPED";
  /** LEASE_LOST: the cross-process lock was lost, so the cycle stopped at a safe point. */
  stopReason: "LEASE_LOST" | null;
  /** Executor threw; whether a command was created is not proven here. */
  decisionsFailed: number;
  /** Not reached because the cycle stopped. */
  decisionsNotStarted: number;
  /** Reconcile/manage threw for the agent. */
  agentsFailed: number;
  agentsNotStarted: number;
  /** Loading the agents to manage failed, so no agent was managed. */
  managementStepFailed: boolean;
  /** Queued protective candidates not drained because the cycle stopped (nothing claimed or sent). */
  protectiveNotRun: number;
  /** Connection, statement, lock, idle-transaction or client-read timeouts seen during the cycle. */
  dbWaitTimeouts: number;
  /**
   * Database connections lost during the cycle (terminated backend, restart,
   * network failure). A lower layer may have turned one into an "outcome
   * uncertain" hold, so the cycle is not COMPLETED.
   */
  dbConnectionFailures: number;
}

export interface RunAutonomousCycleResult {
  cycleId: string;
  decisionsConsidered: number;
  executed: Record<AgentExecutionStatus, number>;
  agentsManaged: number;
  positionsModified: number;
  positionsClosed: number;
  reconciled: { filled: number; rejected: number; closed: number; expired: number };
  realizedPosted: number;
  /**
   * Management holds by structured reason: ordinary observation holds
   * (MANAGEMENT_OBSERVATION_*), protective-path holds (PROTECTIVE_*) and the
   * per-agent AACI pause. Read-only visibility for the operator surface.
   */
  managementHeld: Record<string, number>;
  /** Protective-action drain (step 5); holds are also counted in managementHeld. */
  protective: {
    considered: number;
    acted: number;
    bridges: number;
    elapsedMs: number;
  };
  completion: CycleCompletion;
}

export async function runAutonomousCycle(
  input: RunAutonomousCycleInput,
): Promise<RunAutonomousCycleResult> {
  const { scope, actorUserId, actorRole, reason, guard } = input;
  const completion: CycleCompletion = {
    status: "COMPLETED",
    stopReason: null,
    decisionsFailed: 0,
    decisionsNotStarted: 0,
    agentsFailed: 0,
    agentsNotStarted: 0,
    managementStepFailed: false,
    protectiveNotRun: 0,
    dbWaitTimeouts: 0,
    dbConnectionFailures: 0,
  };
  const caught = { timeouts: 0, connectionFailures: 0 };
  const noteFailure = (err: unknown) => {
    if (isDbWaitTimeout(err)) caught.timeouts++;
    else if (isDbConnectionLost(err)) caught.connectionFailures++;
  };
  // Safe point: false once the cross-process lock is gone (stop, never continue unguarded).
  const mayContinue = async (): Promise<boolean> => {
    if (completion.stopReason) return false;
    if (!guard || (await guard.stillHeld())) return true;
    completion.stopReason = "LEASE_LOST";
    return false;
  };

  // 0. Fail-closed invocation audit: a durable record of WHO triggered this
  // controlled run, with what reason and scope, BEFORE any side effect. If the
  // audit insert throws, the whole run aborts (no execution without evidence).
  await writeSelfTradeAudit(db, {
    eventType: "AUTONOMOUS_CYCLE_RUN",
    scope: scope?.ownerType ?? "FLEET",
    actorUserId,
    actorRole: actorRole ?? null,
    severity: "WARNING",
    afterState: {
      requestedScope: scope ?? null,
      force: input.force ?? true,
    },
    reason: reason ?? "Admin-triggered autonomous cycle.",
  });

  // Resolve the agent ids visible to this run's scope (admin/fleet = all). Used
  // to keep step-4 management/reconciliation from acting outside the scope.
  const scopedAgentIds: Set<number> | null = scope
    ? new Set((await listAgents(scope)).map((a) => a.id))
    : null;

  // 1. Decision cycle (force a fresh evaluation for controlled operation).
  const cycle = await runDecisionCycle(scope, actorUserId, { force: true });

  // 2. Fleet safety context — built once, reused for every decision.
  const fleet = await buildFleetSafetyContext();

  const executed: Record<AgentExecutionStatus, number> = {
    DISPATCHED: 0,
    PREPARED: 0,
    BLOCKED: 0,
    LOG_ONLY: 0,
    SKIPPED_DUPLICATE: 0,
    AACI_DEFERRED: 0,
  };

  // 2b. Phase-7 operational-mode posture. An admin can put security into
  // LOCKDOWN / INCIDENT to pause NEW autonomous entries during an incident.
  // This is ADDITIVE caution: it never relaxes a gate. Protective actions
  // (reconcile, manage/close, post realized P/L in step 4) ALWAYS still run so
  // the system can de-risk; only new entries are paused. Unknown mode resolves
  // to the safest (INCIDENT) posture upstream.
  const opMode = await getOperationalMode();
  const entriesPaused = opMode.posture.pauseAutonomousEntries;

  // 3. Load persisted executable decisions for THIS cycle.
  const decisions = await db
    .select()
    .from(selfTradeDecisionsTable)
    .where(
      and(
        eq(selfTradeDecisionsTable.cycleId, cycle.cycleId),
        inArray(selfTradeDecisionsTable.outcome, EXECUTABLE_OUTCOMES as unknown as string[]),
      ),
    );

  const bundles = await loadAgentBundles(decisions.map((d) => d.agentId));

  if (entriesPaused && decisions.length > 0) {
    // Audit the pause once (visibility) — every executable decision is held.
    await writeSelfTradeAudit(db, {
      eventType: "AUTONOMOUS_ENTRIES_PAUSED",
      scope: scope?.ownerType ?? "FLEET",
      actorUserId,
      actorRole: actorRole ?? null,
      severity: "WARNING",
      afterState: { operationalMode: opMode.mode, heldDecisions: decisions.length },
      reason: opMode.posture.reason,
    });
  }

  for (const [index, decision] of decisions.entries()) {
    if (!(await mayContinue())) {
      completion.decisionsNotStarted = decisions.length - index;
      break;
    }
    const bundle = bundles.get(decision.agentId);
    if (!bundle || !bundle.settings) {
      logger.warn({ agentId: decision.agentId }, "self-trade: missing agent/settings for decision");
      continue;
    }

    // 3a. Operational-mode pause: hold every NEW entry without touching the
    // existing pipeline (protective management in step 4 still runs below).
    if (entriesPaused) {
      executed.BLOCKED += 1;
      continue;
    }

    // 3b. Phase-7 trade-command anomaly review BEFORE any side effect. Builds a
    // REAL baseline from the owning user's trade history and screens the planned
    // command for behavioural anomalies (lot far above baseline / over the hard
    // cap, agent not permitted, repeated attempts). A BLOCK adds a refusal on
    // top of the unchanged 16-gate / Risk Governor path; it never enables a
    // trade. Stop-loss is enforced authoritatively by gate #16 downstream, so
    // this pre-execution screen disables the SL check to avoid false caution at
    // a stage where the concrete SL is not yet computed.
    const ownerUserId = bundle.agent.ownerType === "USER" ? bundle.agent.ownerId : null;
    if (ownerUserId != null) {
      try {
        const hourUtc = new Date().getUTCHours();
        const { verdict } = await evaluateTradeAnomalyForUser({
          userId: ownerUserId,
          observation: {
            lot: bundle.settings.maxLotPerTrade,
            symbol: decision.symbol,
            hasStopLoss: true,
            hourUtc,
            source: "self-trade",
            expectedSources: ["self-trade"],
            recentAttempts: 0,
            agentPermitted: bundle.agent.status === "ACTIVE",
            payloadChangedAfterApproval: false,
          },
          policy: { ...DEFAULT_ANOMALY_POLICY, requireStopLoss: false },
        });
        if (verdict.recommendedAction === "BLOCK") {
          executed.BLOCKED += 1;
          await writeSelfTradeAudit(db, {
            agentId: decision.agentId,
            eventType: "TRADE_COMMAND_ANOMALY_BLOCK",
            scope: scope?.ownerType ?? "FLEET",
            actorUserId,
            actorRole: actorRole ?? null,
            severity: "CRITICAL",
            afterState: { reasonCode: verdict.reasonCode, anomalies: verdict.anomalies.map((a) => a.code), symbol: decision.symbol },
            reason: verdict.adminMessage,
          });
          continue;
        }
      } catch (err) {
        // FAIL-SAFE: an unevaluable anomaly screen must add caution, never wave
        // the command through. Hold this entry (count it BLOCKED + audit) so an
        // anomaly-service error can only reduce risk, never silently allow a
        // command we could not screen. The 16-gate / Risk Governor path is
        // unchanged either way; this is an additive refusal.
        executed.BLOCKED += 1;
        logger.warn({ err, decisionId: decision.id }, "self-trade: anomaly review unevaluable — holding decision (fail-safe)");
        await writeSelfTradeAudit(db, {
          agentId: decision.agentId,
          eventType: "TRADE_COMMAND_ANOMALY_UNEVALUABLE",
          scope: scope?.ownerType ?? "FLEET",
          actorUserId,
          actorRole: actorRole ?? null,
          severity: "WARNING",
          afterState: { reasonCode: "ANOMALY_UNEVALUABLE", symbol: decision.symbol },
          reason: "Anomaly screen could not be evaluated; entry held as a precaution.",
        }).catch((auditErr) => {
          logger.error({ err: auditErr, decisionId: decision.id }, "self-trade: failed to audit anomaly-unevaluable hold");
        });
        continue;
      }
    }

    try {
      const outcome = await executeAgentDecision({
        agent: bundle.agent,
        settings: bundle.settings,
        ledger: bundle.ledger,
        decision,
        fleet,
        actorUserId,
        actorRole,
      });
      executed[outcome.status] = (executed[outcome.status] ?? 0) + 1;
    } catch (err) {
      completion.decisionsFailed++;
      noteFailure(err);
      logger.error({ err, decisionId: decision.id }, "self-trade: executeAgentDecision threw");
    }
  }

  // 4. Distinct agents to manage/reconcile: decision agents ∪ agents with any
  // active execution row. Entries may already be dispatched, so a failure from
  // here on is reported in `completion` instead of discarding the tallies.
  let agentIds = new Set<number>();
  let manageBundles = new Map<number, AgentBundle>();
  if (!completion.stopReason) {
    try {
      const activeExecAgents = await db
        .selectDistinct({ agentId: selfTradeAgentExecutionsTable.agentId })
        .from(selfTradeAgentExecutionsTable)
        .where(inArray(selfTradeAgentExecutionsTable.status, ACTIVE_EXEC_STATUSES as unknown as string[]));

      agentIds = new Set<number>([
        ...decisions.map((d) => d.agentId),
        ...activeExecAgents.map((r) => r.agentId),
      ]);

      // A scoped run must never manage/reconcile an out-of-scope agent: the active
      // execution query is fleet-wide, so intersect with the scope's visible ids.
      if (scopedAgentIds) {
        for (const id of [...agentIds]) {
          if (!scopedAgentIds.has(id)) agentIds.delete(id);
        }
      }

      manageBundles = await loadAgentBundles([...agentIds]);
    } catch (err) {
      completion.managementStepFailed = true;
      noteFailure(err);
      agentIds = new Set();
      logger.error({ err }, "self-trade: loading agents to manage failed; no agent managed this cycle");
    }
  }

  const result: RunAutonomousCycleResult = {
    cycleId: cycle.cycleId,
    decisionsConsidered: decisions.length,
    executed,
    agentsManaged: 0,
    positionsModified: 0,
    positionsClosed: 0,
    reconciled: { filled: 0, rejected: 0, closed: 0, expired: 0 },
    realizedPosted: 0,
    managementHeld: {},
    protective: { considered: 0, acted: 0, bridges: 0, elapsedMs: 0 },
    completion,
  };
  // Protective candidates are only collected per agent below and run in step 5,
  // so a justified ordinary exit for a later agent never waits behind them.
  const protectiveCycle = createProtectiveCycle();

  let agentsReached = 0;
  for (const agentId of agentIds) {
    if (!(await mayContinue())) {
      completion.agentsNotStarted = agentIds.size - agentsReached;
      break;
    }
    agentsReached++;
    const bundle = manageBundles.get(agentId);
    if (!bundle) continue;
    result.agentsManaged++;
    try {
      // 1. Reconcile real outcomes first (dispatch→fill, close→realized P/L) so
      //    cohesion is judged against freshly-resolved state.
      const rec = await reconcileAgentExecutions(agentId);
      result.reconciled.filled += rec.filled;
      result.reconciled.rejected += rec.rejected;
      result.reconciled.closed += rec.closed;
      result.positionsClosed += rec.closed;
      result.reconciled.expired += rec.expired;

      // 2. AACI chain audit (advisory): fill-no-position / lost-command /
      //    position mismatch / pre-news exposure → operator alert + audit. May
      //    PAUSE management for this agent this cycle (never auto-closes).
      const chain = await reconcileAaciChain({ agentId, actorUserId, actorRole });

      // 3. Manage open positions (L2 alert-only / L3+ act) — SKIPPED when AACI
      //    detected an incoherent chain that needs operator review first.
      if (!chain.shouldPauseManagement) {
        const managed = await manageAgentPositions(bundle.agent, actorUserId, actorRole, {
          protectiveCycle,
        });
        result.positionsModified += managed.modified;
        result.positionsClosed += managed.closed;
        for (const [reason, count] of Object.entries(managed.heldReasons))
          result.managementHeld[reason] = (result.managementHeld[reason] ?? 0) + count;
      } else {
        result.managementHeld.MANAGEMENT_PAUSED_AACI_REVIEW =
          (result.managementHeld.MANAGEMENT_PAUSED_AACI_REVIEW ?? 0) + 1;
      }

      // 4. Post realized P/L from real closed fills into the ledger.
      const posted = await applyRealizedFromFills(agentId, actorUserId);
      result.realizedPosted += posted.posted;

      // 4b. AACI learning (advisory): feed the SAME real reconciled outcomes
      //     into per-entity Bayesian trust, then re-evaluate drift. Idempotent
      //     (keyed by execution id) and fail-open — learning never blocks a
      //     decision, modifies a position, or weakens a gate.
      try {
        const ingested = await ingestAgentOutcomes(agentId, actorUserId);
        // Re-evaluate drift for EVERY entity dimension whose trust moved this
        // cycle (agent / symbol / strategy / timeframe) — not symbols only.
        for (const ent of ingested.touchedEntities) {
          await evaluateEntityDrift({
            entityType: ent.entityType,
            entityKey: ent.entityKey,
            userId: 0,
            actorUserId,
            actorRole: actorRole ?? null,
          });
        }
      } catch (err) {
        logger.warn({ err, agentId }, "aaci-learning: ingest/drift skipped this cycle");
      }

      // Soft-audit a missed daily minimum (visibility only — never forces a trade).
      if (bundle.settings) {
        const taken = await countAgentFilledTradesToday(agentId);
        if (taken < bundle.settings.dailyMinTrades) {
          await writeSelfTradeAudit(db, {
            agentId,
            eventType: "QUOTA_BELOW_DAILY_MIN",
            actorUserId,
            actorRole: actorRole ?? null,
            severity: "INFO",
            afterState: { taken, dailyMinTrades: bundle.settings.dailyMinTrades },
            reason: `Daily minimum not yet met (${taken}/${bundle.settings.dailyMinTrades}).`,
          });
        }
      }
    } catch (err) {
      completion.agentsFailed++;
      noteFailure(err);
      logger.error({ err, agentId }, "self-trade: manage/reconcile threw");
    }
  }

  // 5. Protective-action candidates queued above (only from agents whose
  //    management was not paused). Each re-reads the platform stop, arming and
  //    kill switch at run time and dispatches through the same gated pipeline.
  const protectiveQueued = protectiveCycle.candidates.length;
  if (completion.stopReason || (protectiveQueued > 0 && !(await mayContinue()))) {
    // Not drained: no protective claim was taken, so nothing was sent.
    completion.protectiveNotRun = protectiveQueued;
    return finishCompletion(result, guard, caught);
  }
  try {
    const drained = await drainProtectiveCycle(protectiveCycle);
    result.protective = {
      considered: drained.considered,
      acted: drained.acted,
      bridges: drained.bridges,
      elapsedMs: drained.elapsedMs,
    };
    for (const [reason, count] of Object.entries(drained.held))
      result.managementHeld[reason] = (result.managementHeld[reason] ?? 0) + count;
  } catch (err) {
    // The drain guards each candidate itself, so this is a setup/accounting
    // failure. Report it instead of a silent 0/0/0: every queued candidate is
    // counted under PROTECTIVE_DRAIN_FAILED, whose text claims neither
    // "nothing was sent" nor a dispatch (the outcome is unknown here).
    logger.error({ err, queued: protectiveQueued }, "self-trade: protective drain threw");
    noteFailure(err);
    if (protectiveQueued > 0) {
      result.protective = { considered: protectiveQueued, acted: 0, bridges: 0, elapsedMs: 0 };
      result.managementHeld.PROTECTIVE_DRAIN_FAILED =
        (result.managementHeld.PROTECTIVE_DRAIN_FAILED ?? 0) + protectiveQueued;
    }
  }

  return finishCompletion(result, guard, caught);
}

/** Protective holds whose outcome the cycle did not establish (a command may exist, or a step broke). */
const UNPROVEN_PROTECTIVE_HOLDS = [
  "PROTECTIVE_HOLD_OUTCOME_UNCERTAIN",
  "PROTECTIVE_HOLD_INTERNAL_ERROR",
  "PROTECTIVE_DRAIN_FAILED",
] as const;

/** Settle `completion.status` from what happened; never COMPLETED after a failure or stop. */
function finishCompletion(
  result: RunAutonomousCycleResult,
  guard: CycleGuard | undefined,
  caught: { timeouts: number; connectionFailures: number },
): RunAutonomousCycleResult {
  const c = result.completion;
  // The guard also counts errors a lower layer absorbed into a refusal or hold.
  const stats = guard?.stats();
  c.dbWaitTimeouts = Math.max(caught.timeouts, stats?.dbWaitTimeouts ?? 0);
  c.dbConnectionFailures = Math.max(caught.connectionFailures, stats?.dbConnectionFailures ?? 0);
  const failed =
    c.decisionsFailed > 0 ||
    c.agentsFailed > 0 ||
    c.managementStepFailed ||
    c.dbWaitTimeouts > 0 ||
    c.dbConnectionFailures > 0 ||
    UNPROVEN_PROTECTIVE_HOLDS.some((reason) => (result.managementHeld[reason] ?? 0) > 0);
  c.status = c.stopReason ? "STOPPED" : failed ? "INCOMPLETE" : "COMPLETED";
  return result;
}

interface AgentBundle {
  agent: SelfTradeAgent;
  settings: SelfTradeAgentSettings | null;
  ledger: SelfTradeAgentLedger | null;
}

async function loadAgentBundles(agentIds: number[]): Promise<Map<number, AgentBundle>> {
  const ids = [...new Set(agentIds)];
  const map = new Map<number, AgentBundle>();
  if (ids.length === 0) return map;

  const [agents, settings, ledgers] = await Promise.all([
    db.select().from(selfTradeAgentsTable).where(inArray(selfTradeAgentsTable.id, ids)),
    db.select().from(selfTradeAgentSettingsTable).where(inArray(selfTradeAgentSettingsTable.agentId, ids)),
    db.select().from(selfTradeAgentLedgerTable).where(inArray(selfTradeAgentLedgerTable.agentId, ids)),
  ]);
  const settingsBy = new Map(settings.map((s) => [s.agentId, s]));
  const ledgerBy = new Map(ledgers.map((l) => [l.agentId, l]));
  for (const agent of agents) {
    map.set(agent.id, {
      agent,
      settings: settingsBy.get(agent.id) ?? null,
      ledger: ledgerBy.get(agent.id) ?? null,
    });
  }
  return map;
}

// Keep the persisted-decision type greppable for downstream consumers.
export type { SelfTradeDecision };
