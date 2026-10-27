// Self-Trade AI — PROTECTIVE-ACTION PATH (owner decision, 2026-10-27).
//
// "Retain the current stale-position restriction. Do not introduce a blanket
// bypass for protective actions. Implement a separate protective-action path
// that obtains fresh authoritative position evidence, verifies account and
// exact position identity, and guarantees the action cannot increase exposure,
// reverse the position or loosen its stop. If verification fails, hold the
// action and clearly explain why. Preserve manual controls and existing
// broker-side stops."
//
// This module runs only AFTER the ordinary manager refused a stale, future,
// malformed or superseded position snapshot. The refused snapshot is never
// used to act. The path:
//   1. classifies, from the stale row, whether the pending action would be
//      protective at all (invalidation EXIT / break-even / trail) — this only
//      decides whether a wait budget is spent; the provisional verdict is
//      discarded;
//   2. pre-checks what would make waiting pointless (bridge identity, online
//      heartbeat, EA capability, platform stop, user arming / kill switch);
//   3. waits for the next COMPLETE terminal sweep strictly newer than the hold
//      (sweep-provenance, marker, heartbeat, after every ticket command);
//   4. recomputes the decision from the fresh row, re-verifies the exact
//      position identity, requires a fresh heartbeat, proves the geometry
//      invariants, then takes the same compare-and-set claim and dispatches
//      through the same Position Guardian → executeInstant pipeline as the
//      ordinary path (no gate is skipped);
//   5. on any failure holds, audits PROTECTIVE_ACTION_HELD with a plain-English
//      explanation and writes nothing to managementState.
//
// No DB transaction and no row lock are taken here; the only write before the
// dispatch is the JSONB compare-and-set claim. Never imports the live command
// pipeline, the Trade Engine, a position writer or a command table writer.

import { randomUUID } from "node:crypto";
import type { SQL } from "drizzle-orm";
import {
  db,
  type ArxLiveCommand,
  type SelfTradeAgent,
  type SelfTradeAgentExecution,
} from "@workspace/db";
import {
  classifyProtectiveTrigger,
  evaluateManagementAction,
  evaluateProtectiveGeometry,
  explainProtectiveHold,
  redactProtectiveDetail,
  verifyProtectiveBridge,
  verifyProtectivePosition,
  type ProtectiveHoldReason,
  type ProtectiveIntent,
  type ProtectivePositionFacts,
  type ProtectiveTrigger,
  type TradeThesis,
} from "@workspace/domain/self-trade";
import {
  classifyHeartbeatAt,
  heartbeatAllowsExecution,
} from "@workspace/domain/broker-health/heartbeatPolicy";
import { livePositionLedger, type LivePositionRow } from "../positions/ledger.js";
import { getConnection, type BrokerConnection } from "../brokerHub/connections.js";
import { platformStop, preCheckStopRefusal, type PlatformStop } from "../safety/platformSwitches.js";
import { getMyArming } from "../live/liveArming.js";
import { logger } from "../logger.js";
import { writeSelfTradeAudit } from "./audit.js";
import { evaluateProtectiveObservation } from "./freshFacts.js";
import { managementPositionScope } from "./managementConsumers.js";
import {
  stopAtLeastAsProtective,
  type ManagementMemory,
  type PendingManagement,
} from "./executionLifecycle.js";
import {
  dispatchClaimedManagement,
  updateManagement,
  type ClaimedDispatchOutcome,
} from "./livePositionManager.js";

/**
 * How long one manager call waits for the next complete sweep: two v1.54
 * snapshot intervals (SnapshotIntervalSeconds = 10, ARX_AI_Universal_Agent_v154.mq5).
 * Shared by every held position in the call (one sweep refreshes all rows).
 */
export const PROTECTIVE_EVIDENCE_WAIT_MS = 20_000;
/** Poll cadence while waiting (plain reads only). */
export const PROTECTIVE_POLL_MS = 1_000;

export interface ProtectiveSharedDeadline {
  /** Set on first use within a manager call; never extended. */
  deadlineMs: number | null;
}

export interface ProtectivePathContext {
  agent: SelfTradeAgent;
  execution: SelfTradeAgentExecution;
  /** The attributed entry, already verified by the manager (ownedEntryBinding). */
  entry: ArxLiveCommand;
  /** The STALE row the ordinary path refused. Used only to classify the trigger. */
  position: LivePositionRow;
  thesis: TradeThesis | null;
  memory: ManagementMemory;
  /** The ordinary observation hold reason this path starts from. */
  holdReason: string;
  /** The hold time; evidence must be strictly newer. */
  heldAtMs: number;
  actorUserId?: number | null;
  actorRole?: string | null;
  sharedDeadline: ProtectiveSharedDeadline;
}

export interface TicketCommandTimes {
  sentToMt5At: Date | null;
  filledAt: Date | null;
  rejectedAt: Date | null;
}

export interface ProtectivePathDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  waitBudgetMs?: (trigger: ProtectiveTrigger) => number;
  readRowByScope?: (scope: SQL) => Promise<LivePositionRow | undefined>;
  readConnection?: (connectionId: number) => Promise<BrokerConnection | null>;
  readTicketCommands?: () => Promise<TicketCommandTimes[]>;
  readPlatformStop?: () => Promise<PlatformStop>;
  readArming?: (
    userId: number,
  ) => Promise<{ isArmed: boolean; killSwitchEngaged: boolean } | null | undefined>;
  dispatch?: typeof dispatchClaimedManagement;
}

export type ProtectivePathResult =
  | { status: "NOT_APPLICABLE" | "NOT_PROTECTIVE" }
  | {
      status: "HELD";
      reason: ProtectiveHoldReason;
      explanation: string;
      trigger: ProtectiveTrigger | null;
      waitedMs: number;
      polls: number;
    }
  | {
      status: "DISPATCHED";
      trigger: ProtectiveTrigger;
      waitedMs: number;
      polls: number;
      outcome: ClaimedDispatchOutcome;
    };

/** Only an invalidation EXIT is worth waiting for; stop tightening re-evaluates next cycle. */
export function defaultWaitBudgetMs(trigger: ProtectiveTrigger): number {
  return trigger === "EXIT_INVALIDATION" ? PROTECTIVE_EVIDENCE_WAIT_MS : 0;
}

/** Evidence verdicts that no later sweep can cure within this call. */
const TERMINAL_EVIDENCE = new Set<string>([
  "PROTECTIVE_OBSERVATION_POSITION_CLOSED",
  "PROTECTIVE_OBSERVATION_TIMESTAMP_INVALID",
  "PROTECTIVE_OBSERVATION_FUTURE_DATED",
  "PROTECTIVE_BRIDGE_OFFLINE",
  "PROTECTIVE_POSITION_ABSENT_AT_BROKER",
]);
/** At the deadline these mean "nothing newer arrived"; anything else is reported as itself. */
const NOTHING_NEWER = new Set<string>([
  "PROTECTIVE_OBSERVATION_NOT_NEWER",
  "PROTECTIVE_OBSERVATION_STALE",
]);

const INFO_HOLDS = new Set<ProtectiveHoldReason>([
  "PROTECTIVE_HOLD_TRIGGER_CLEARED",
  "PROTECTIVE_HOLD_DEFERRED_TO_NEXT_CYCLE",
]);

const num = (v: unknown): number | null =>
  v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const iso = (v: Date | null | undefined): string =>
  v instanceof Date && Number.isFinite(v.getTime()) ? v.toISOString() : "";

function decide(
  ctx: ProtectivePathContext,
  row: Pick<LivePositionRow, "entryPrice" | "currentPrice" | "stopLoss">,
) {
  const e = ctx.execution;
  const entryPrice = Number(row.entryPrice);
  const currentSl = num(row.stopLoss);
  return evaluateManagementAction({
    side: e.side as "BUY" | "SELL",
    entryPrice,
    currentPrice: Number(row.currentPrice),
    stopLoss: ctx.thesis?.stopLoss ?? (e.slPrice != null ? e.slPrice : null),
    currentSl,
    takeProfits: ctx.thesis?.takeProfits ?? [],
    invalidation: ctx.thesis?.invalidation ?? null,
    beMoved: stopAtLeastAsProtective(e.side, currentSl, entryPrice),
    partialsTaken: ctx.memory.partialsTaken ?? 0,
    autonomyLevel: ctx.agent.autonomyLevel,
  });
}

export async function runProtectiveActionPath(
  ctx: ProtectivePathContext,
  deps: ProtectivePathDeps = {},
): Promise<ProtectivePathResult> {
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const waitBudgetMs = deps.waitBudgetMs ?? defaultWaitBudgetMs;
  const readRowByScope =
    deps.readRowByScope ??
    (async (scope: SQL) => (await livePositionLedger.read({ where: scope, limit: 1 }))[0]);
  const readConnection = deps.readConnection ?? ((id: number) => getConnection(id));
  const readTicketCommands = deps.readTicketCommands ?? (async () => []);
  const readPlatformStop = deps.readPlatformStop ?? (() => platformStop());
  const readArming = deps.readArming ?? ((userId: number) => getMyArming(userId));
  const dispatch = deps.dispatch ?? dispatchClaimedManagement;

  const { agent, execution: e, entry, memory } = ctx;
  const startedAt = now();
  let trigger0: ProtectiveTrigger | null = null;
  let polls = 0;

  const hold = async (
    reason: ProtectiveHoldReason,
    detail: Record<string, unknown>,
  ): Promise<ProtectivePathResult> => {
    const waitedMs = Math.max(0, now() - startedAt);
    const safe = redactProtectiveDetail({ ...detail, waitedMs, polls });
    const explanation = explainProtectiveHold(reason, safe);
    try {
      await writeSelfTradeAudit(db, {
        agentId: agent.id,
        eventType: "PROTECTIVE_ACTION_HELD",
        actorUserId: ctx.actorUserId ?? null,
        actorRole: ctx.actorRole ?? null,
        severity: INFO_HOLDS.has(reason) ? "INFO" : "WARNING",
        afterState: {
          executionId: e.id,
          brokerTicket: e.brokerTicket,
          trigger: trigger0,
          heldReason: ctx.holdReason,
          reason,
          detail: safe,
          explanation,
          waitedMs,
        },
        reason: explanation,
      });
    } catch (err) {
      logger.error({ err, executionId: e.id, reason }, "self-trade: protective hold audit unavailable");
    }
    logger.warn(
      { executionId: e.id, reason, trigger: trigger0, waitedMs, polls, detail: safe },
      "self-trade: protective action held",
    );
    return { status: "HELD", reason, explanation, trigger: trigger0, waitedMs, polls };
  };

  try {
    // 1. Provisional classification from the stale row: decides only whether a
    //    wait budget is spent. The verdict is discarded, never persisted.
    if (agent.autonomyLevel < 3) return { status: "NOT_APPLICABLE" };
    trigger0 = classifyProtectiveTrigger(decide(ctx, ctx.position));
    if (!trigger0) return { status: "NOT_PROTECTIVE" };

    // 2. Pre-checks that make waiting pointless.
    const bridgeId = entry.bridgeConnectionId;
    let conn = bridgeId ? await readConnection(bridgeId) : null;
    const bridgeCheck = verifyProtectiveBridge(
      entry,
      e,
      conn,
      classifyHeartbeatAt(conn?.lastHeartbeat ?? null, now()),
    );
    if (!bridgeCheck.ok)
      return hold(bridgeCheck.reason, {
        ...bridgeCheck.detail,
        ageSec: heartbeatAgeSec(conn, now()),
      });
    const stop = preCheckStopRefusal(await readPlatformStop(), {
      own: "platform_emergency_stop",
      opensNewRisk: false,
      venue: "LIVE",
    });
    if (stop.engaged)
      return hold("PROTECTIVE_HOLD_PLATFORM_STOP_ENGAGED", {
        sources: stop.sources,
        stopReason: stop.reason,
      });
    const arming = await readArming(e.executingUserId!);
    if (!arming?.isArmed) return hold("PROTECTIVE_HOLD_USER_NOT_ARMED", {});
    if (arming.killSwitchEngaged) return hold("PROTECTIVE_HOLD_USER_KILL_SWITCH", {});

    // 3. Obtain evidence: the next complete sweep strictly after the hold.
    const budget = waitBudgetMs(trigger0);
    if (!(budget > 0)) return hold("PROTECTIVE_HOLD_DEFERRED_TO_NEXT_CYCLE", { trigger: trigger0 });
    const shared = ctx.sharedDeadline;
    if (shared.deadlineMs == null) shared.deadlineMs = startedAt + budget;
    const scope = managementPositionScope({
      positionRowId: ctx.position.id,
      userId: e.executingUserId!,
      bridgeConnectionId: entry.bridgeConnectionId!,
      accountLogin: entry.accountLogin!,
      legacyBrokerCompany: entry.brokerServer!,
      brokerTicket: e.brokerTicket!,
      entryCommandId: entry.commandId,
      symbol: entry.symbol,
      side: e.side as "BUY" | "SELL",
    });
    let row: LivePositionRow | undefined;
    let evidence: { observedAtMs: number; sweepAtMs: number } | null = null;
    let lastReason: ProtectiveHoldReason = "PROTECTIVE_OBSERVATION_NOT_NEWER";
    let lastDetail: Record<string, unknown> = {};
    for (;;) {
      row = await readRowByScope(scope);
      if (!row) return hold("PROTECTIVE_IDENTITY_ROW_MISSING", { ticket: e.brokerTicket });
      conn = await readConnection(bridgeId!);
      if (!conn) return hold("PROTECTIVE_BRIDGE_UNVERIFIED", { expectedBridge: bridgeId, bridge: null });
      const ticketCommands = await readTicketCommands();
      const v = evaluateProtectiveObservation({
        row,
        connection: conn,
        mustBeAfterMs: ctx.heldAtMs,
        commandEventTimes: [
          entry.filledAt,
          ...ticketCommands.flatMap((c) => [c.sentToMt5At, c.filledAt, c.rejectedAt]),
        ],
        nowMs: now(),
      });
      if (v.ok) {
        evidence = v;
        break;
      }
      lastReason = v.reason;
      lastDetail = v.detail;
      if (TERMINAL_EVIDENCE.has(v.reason)) return hold(v.reason, v.detail);
      const remaining = shared.deadlineMs - now();
      if (remaining <= 0) break;
      polls++;
      await sleep(Math.min(PROTECTIVE_POLL_MS, remaining));
    }
    if (!evidence || !row) {
      const lastSyncedMs = Date.parse(iso(row?.lastSyncedAt ?? null));
      return hold(NOTHING_NEWER.has(lastReason) ? "PROTECTIVE_HOLD_NO_FRESH_SWEEP" : lastReason, {
        ...lastDetail,
        heldAt: new Date(ctx.heldAtMs).toISOString(),
        lastSyncedAgeMs: Number.isFinite(lastSyncedMs) ? now() - lastSyncedMs : null,
        ageSec: Number.isFinite(lastSyncedMs) ? Math.round((now() - lastSyncedMs) / 1000) : null,
        sweepMarkerAgeMs: conn?.lastPositionsSnapshotAt
          ? now() - conn.lastPositionsSnapshotAt.getTime()
          : null,
        heartbeatAgeMs: conn?.lastHeartbeat ? now() - conn.lastHeartbeat.getTime() : null,
        eaVersion: conn?.eaVersion ?? null,
      });
    }
    const evidenceAtMs = now();
    const verifyStart = performance.now();

    // 4. Fresh decision from the fresh row only.
    const verdict = decide(ctx, row);
    const trigger = classifyProtectiveTrigger(verdict);
    if (!trigger)
      return hold("PROTECTIVE_HOLD_TRIGGER_CLEARED", {
        trigger: trigger0,
        p: row.currentPrice,
        inv: ctx.thesis?.invalidation ?? null,
        verdict: verdict.action,
      });

    // 5. Exact position identity against the fresh row.
    const identity = verifyProtectivePosition(e, entry, row);
    if (!identity.ok) return hold(identity.reason, identity.detail);

    // 6. Fresh heartbeat before a claim (the Phase B gate's own bound).
    if (!heartbeatAllowsExecution(classifyHeartbeatAt(conn!.lastHeartbeat, now())))
      return hold("PROTECTIVE_BRIDGE_HEARTBEAT_NOT_FRESH", { ageSec: heartbeatAgeSec(conn, now()) });

    // 7. The exact intent that will be dispatched, proven against the fresh row.
    const facts: ProtectivePositionFacts = {
      side: e.side as "BUY" | "SELL",
      volume: row.volume,
      entryPrice: Number(row.entryPrice),
      currentPrice: Number(row.currentPrice),
      stopLoss: num(row.stopLoss),
      takeProfit: num(row.takeProfit),
    };
    const action = verdict.action as "EXIT" | "MOVE_TO_BE" | "TIGHTEN_SL";
    const intent: ProtectiveIntent =
      action === "EXIT"
        ? { kind: "CLOSE", side: facts.side, volume: row.volume }
        : {
            kind: "MODIFY_STOP",
            side: facts.side,
            newStopLoss: verdict.newStopLoss as number,
            newTakeProfit: facts.takeProfit,
          };
    const geometry = evaluateProtectiveGeometry(facts, intent);
    if (!geometry.ok) return hold(geometry.reason, geometry.detail);
    const verifyMs = performance.now() - verifyStart;

    // 8. Claim (compare-and-set): the first and only write before dispatch.
    const claim: PendingManagement = {
      claimId: randomUUID(),
      action,
      requestedAt: new Date(now()).toISOString(),
      stopLoss: action === "EXIT" ? null : (verdict.newStopLoss as number),
      protective: {
        trigger,
        heldReason: ctx.holdReason,
        heldAtMs: ctx.heldAtMs,
        evidence: {
          lastSyncedAt: iso(row.lastSyncedAt),
          sweepAt: iso(conn!.lastPositionsSnapshotAt),
          heartbeatAt: iso(conn!.lastHeartbeat),
          serverName: conn!.serverName ?? "",
          currentPrice: facts.currentPrice,
          volume: facts.volume,
          stopLoss: facts.stopLoss,
          takeProfit: facts.takeProfit,
        },
      },
    };
    const claimed: ManagementMemory = { ...memory, pendingManagement: claim };
    const claimStart = performance.now();
    if (!(await updateManagement(e, e.managementState, claimed)))
      return hold("PROTECTIVE_HOLD_CLAIM_RACE", { trigger });
    const claimMs = performance.now() - claimStart;
    const waitedMs = Math.max(0, now() - startedAt);

    // 9./10. Dispatch through the shared Guardian → executeInstant path and
    //        book the outcome exactly as the ordinary path does.
    const outcome = await dispatch({
      agent,
      execution: e,
      position: { id: row.id, stopLoss: facts.stopLoss, takeProfit: facts.takeProfit },
      claim,
      memory,
      claimed,
      reason: `${verdict.reason} (protective path: ${trigger} after ${ctx.holdReason})`,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      ...(action === "EXIT" ? {} : { newTakeProfit: facts.takeProfit }),
      auditAfterState: {
        protective: {
          trigger,
          heldReason: ctx.holdReason,
          heldAtMs: ctx.heldAtMs,
          evidenceAtMs,
          evidenceWaitMs: evidenceAtMs - ctx.heldAtMs,
          waitedMs,
          polls,
          verifyMs,
          claimMs,
          evidence: claim.protective!.evidence,
        },
      },
    });
    switch (outcome.outcome) {
      case "DISPATCHED":
      case "REFUSED_WITH_COMMAND":
        return { status: "DISPATCHED", trigger, waitedMs, polls, outcome };
      case "REFUSED_WITHOUT_COMMAND":
        return hold("PROTECTIVE_HOLD_PIPELINE_REFUSED", { trigger, pipelineReason: outcome.error });
      case "AUDIT_FAILED":
        return hold("PROTECTIVE_HOLD_INTERNAL_ERROR", {
          trigger,
          message: "audit unavailable; no command submitted",
        });
      default:
        return hold("PROTECTIVE_HOLD_OUTCOME_UNCERTAIN", {
          trigger,
          message: outcome.outcome === "UNCERTAIN" ? String(outcome.error) : outcome.outcome,
        });
    }
  } catch (err) {
    return hold("PROTECTIVE_HOLD_INTERNAL_ERROR", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function heartbeatAgeSec(conn: BrokerConnection | null | undefined, nowMs: number): number | null {
  const at = conn?.lastHeartbeat;
  return at instanceof Date && Number.isFinite(at.getTime())
    ? Math.round((nowMs - at.getTime()) / 1000)
    : null;
}
