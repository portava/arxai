// AACI — Post-execution reconciliation + live-position cohesion (Task #231,
// Phase 5). Runs AFTER `reconcileAgentExecutions` has resolved real outcomes
// and BEFORE position management, so a detected incoherence can PAUSE
// management for the cycle (never auto-close, never bypass any gate).
//
// SAFETY / honesty:
// - dispatch ≠ fill. `isRealFill` only trusts LIVE_FILLED + a real brokerTicket.
// - Detected anomalies raise an OPERATOR/fleet alert + a fail-closed audit row.
//   They NEVER close, modify, or open a position.
// - Per-user isolation: broker positions are read per executingUser and matched
//   by (userId, brokerTicket). No cross-user matching.
// - Pre-critical-news exposure is surfaced ONLY when a REAL news calendar is
//   wired (mock provider → no fabricated alert).

import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  selfTradeAgentExecutionsTable,
  arxLiveCommandsTable,
  arxLivePositionsTable,
  type SelfTradeAgentExecution,
} from "@workspace/db";
import { createAlert } from "../alerts/alertManager.js";
import { writeSelfTradeAudit } from "../selfTrade/audit.js";
import { pickNewsProvider } from "../news/calendar/newsProvider.js";
import { logger } from "../logger.js";

// A SENT_TO_MT5_LIVE command older than this with no resolution is treated as a
// lost command (the bridge never reported back this cycle).
export const LOST_COMMAND_STALE_MS = 5 * 60 * 1000;

export type ChainCoherenceVerdict =
  | "COHERENT"
  | "PENDING"
  | "FILL_NO_POSITION"
  | "LOST_COMMAND"
  | "TERMINAL";

/** PURE. A fill is real ONLY on LIVE_FILLED + a genuine broker ticket. */
export function isRealFill(
  cmd: { status: string; brokerTicket: string | null } | null | undefined,
): boolean {
  return !!cmd && cmd.status === "LIVE_FILLED" && !!cmd.brokerTicket;
}

export interface ClassifyChainInput {
  execStatus: string;
  execBrokerTicket: string | null;
  hasOpenBrokerPosition: boolean;
  command: { status: string; brokerTicket: string | null } | null;
  commandAgeMs: number | null;
  staleCommandThresholdMs?: number;
}

/**
 * PURE. Classify one execution row's chain coherence and whether it should
 * pause management. Only genuine incoherence (a recorded fill with no broker
 * position, or a dispatched command that never resolved) pauses.
 */
export function classifyChainCoherence(
  input: ClassifyChainInput,
): { verdict: ChainCoherenceVerdict; shouldPauseManagement: boolean } {
  const staleMs = input.staleCommandThresholdMs ?? LOST_COMMAND_STALE_MS;

  if (input.execStatus === "FILLED") {
    // App believes the trade is open & filled, but the broker shows no open
    // position for that ticket → fill/position mismatch.
    if (input.execBrokerTicket && !input.hasOpenBrokerPosition) {
      return { verdict: "FILL_NO_POSITION", shouldPauseManagement: true };
    }
    return { verdict: "COHERENT", shouldPauseManagement: false };
  }

  if (input.execStatus === "DISPATCHED") {
    if (!input.command) {
      return { verdict: "LOST_COMMAND", shouldPauseManagement: true };
    }
    if (
      input.command.status === "SENT_TO_MT5_LIVE" &&
      input.commandAgeMs != null &&
      input.commandAgeMs > staleMs
    ) {
      return { verdict: "LOST_COMMAND", shouldPauseManagement: true };
    }
    return { verdict: "PENDING", shouldPauseManagement: false };
  }

  // CLOSED / REJECTED / BLOCKED / EXPIRED / PENDING_TICKET → nothing to pause on.
  return { verdict: "TERMINAL", shouldPauseManagement: false };
}

/**
 * PURE. Compare app-side open tickets against broker-reported open tickets.
 * `onlyInApp` = app thinks open but broker doesn't (potential phantom);
 * `onlyInBroker` = broker has a position the app doesn't attribute (orphan).
 */
export function detectPositionMismatch(input: {
  appOpenTickets: string[];
  brokerOpenTickets: string[];
}): { onlyInApp: string[]; onlyInBroker: string[]; hasMismatch: boolean } {
  const broker = new Set(input.brokerOpenTickets);
  const app = new Set(input.appOpenTickets);
  const onlyInApp = [...app].filter((t) => !broker.has(t));
  const onlyInBroker = [...broker].filter((t) => !app.has(t));
  return { onlyInApp, onlyInBroker, hasMismatch: onlyInApp.length > 0 || onlyInBroker.length > 0 };
}

/** PURE. Open symbols that sit under a critical/high news window. */
export function detectPreNewsExposure(input: {
  openSymbols: string[];
  riskySymbols: Set<string>;
}): string[] {
  return [...new Set(input.openSymbols)].filter((s) => input.riskySymbols.has(s));
}

export interface ReconcileAaciChainInput {
  agentId: number;
  actorUserId?: number | null;
  actorRole?: string | null;
  now?: Date;
}

export interface ReconcileAaciChainResult {
  shouldPauseManagement: boolean;
  anomalies: Array<{ executionId: number; verdict: ChainCoherenceVerdict }>;
  positionMismatch: { onlyInApp: string[]; onlyInBroker: string[] };
  preNewsSymbols: string[];
}

/**
 * Audit the AACI execution chain for one agent. Best-effort and advisory: any
 * internal failure returns a calm "do not pause" so reconciliation never breaks
 * the cycle. Raises operator alerts + fail-closed audit rows for real anomalies.
 */
export async function reconcileAaciChain(
  input: ReconcileAaciChainInput,
): Promise<ReconcileAaciChainResult> {
  const now = input.now ?? new Date();
  const empty: ReconcileAaciChainResult = {
    shouldPauseManagement: false,
    anomalies: [],
    positionMismatch: { onlyInApp: [], onlyInBroker: [] },
    preNewsSymbols: [],
  };

  try {
    const execs = await db
      .select()
      .from(selfTradeAgentExecutionsTable)
      .where(
        and(
          eq(selfTradeAgentExecutionsTable.agentId, input.agentId),
          inArray(selfTradeAgentExecutionsTable.status, ["DISPATCHED", "FILLED"]),
        ),
      );
    if (execs.length === 0) return empty;

    // Load matching commands (for DISPATCHED rows) keyed by commandId.
    const commandIds = execs.map((e) => e.commandId).filter((c): c is string => !!c);
    const commands = commandIds.length
      ? await db
          .select()
          .from(arxLiveCommandsTable)
          .where(inArray(arxLiveCommandsTable.commandId, commandIds))
      : [];
    const cmdById = new Map(commands.map((c) => [c.commandId, c]));

    // Open broker positions per executingUser (per-user isolation).
    const userIds = [...new Set(execs.map((e) => e.executingUserId).filter((u): u is number => u != null))];
    const openByUserTicket = new Set<string>();
    const brokerOpenTickets: string[] = [];
    if (userIds.length) {
      const positions = await db
        .select()
        .from(arxLivePositionsTable)
        .where(
          and(
            inArray(arxLivePositionsTable.userId, userIds),
            isNull(arxLivePositionsTable.closedAt),
          ),
        );
      for (const p of positions) {
        openByUserTicket.add(`${p.userId}:${p.brokerTicket}`);
        brokerOpenTickets.push(p.brokerTicket);
      }
    }

    const anomalies: ReconcileAaciChainResult["anomalies"] = [];
    let shouldPauseManagement = false;
    const appOpenTickets: string[] = [];
    const openSymbols: string[] = [];

    for (const e of execs) {
      const cmd = e.commandId ? cmdById.get(e.commandId) ?? null : null;
      const commandAgeMs = cmd
        ? Math.max(0, now.getTime() - new Date(cmd.sentToMt5At ?? cmd.createdAt).getTime())
        : null;
      const hasOpenBrokerPosition =
        e.executingUserId != null && e.brokerTicket != null
          ? openByUserTicket.has(`${e.executingUserId}:${e.brokerTicket}`)
          : false;

      if (e.status === "FILLED" && e.brokerTicket) {
        appOpenTickets.push(e.brokerTicket);
        openSymbols.push(e.symbol);
      }

      const { verdict, shouldPauseManagement: pause } = classifyChainCoherence({
        execStatus: e.status,
        execBrokerTicket: e.brokerTicket,
        hasOpenBrokerPosition,
        command: cmd ? { status: cmd.status, brokerTicket: cmd.brokerTicket } : null,
        commandAgeMs,
      });

      if (verdict === "FILL_NO_POSITION" || verdict === "LOST_COMMAND") {
        anomalies.push({ executionId: e.id, verdict });
        shouldPauseManagement = shouldPauseManagement || pause;
        await raiseChainAnomaly(e, verdict, input);
      }
    }

    // ── Live position cohesion (T004) ─────────────────────────────────────────
    const positionMismatch = detectPositionMismatch({ appOpenTickets, brokerOpenTickets });
    if (positionMismatch.hasMismatch) {
      await createAlert({
        type: "POSITION_WARNING",
        priority: "HIGH",
        severity: "warning",
        actionRequired: true,
        title: "Live position mismatch",
        message:
          "The autonomous system's open positions do not fully match the broker's open positions. Review before any further action — no positions were changed.",
        dedupeKey: `aaci-posmismatch-${input.agentId}`,
      });
      await writeSelfTradeAudit(db, {
        agentId: input.agentId,
        eventType: "AACI_POSITION_MISMATCH",
        actorUserId: input.actorUserId ?? null,
        actorRole: input.actorRole ?? null,
        severity: "WARNING",
        afterState: { onlyInApp: positionMismatch.onlyInApp, onlyInBroker: positionMismatch.onlyInBroker },
        reason: "AACI detected an app/broker open-position mismatch (advisory only).",
      });
    }

    // Pre-critical-news exposure — ONLY when a real news calendar is wired.
    const preNewsSymbols = await assessPreNewsExposure(openSymbols);
    if (preNewsSymbols.length) {
      await createAlert({
        type: "NEWS_RISK",
        priority: "HIGH",
        severity: "warning",
        actionRequired: true,
        title: "Open exposure into critical news",
        message: `Open autonomous exposure on ${preNewsSymbols.join(", ")} ahead of a critical news event. Consider protecting these positions — no action was taken automatically.`,
        dedupeKey: `aaci-prenews-${input.agentId}-${preNewsSymbols.join(",")}`,
      });
      await writeSelfTradeAudit(db, {
        agentId: input.agentId,
        eventType: "AACI_PRE_NEWS_EXPOSURE",
        actorUserId: input.actorUserId ?? null,
        actorRole: input.actorRole ?? null,
        severity: "WARNING",
        afterState: { symbols: preNewsSymbols },
        reason: "AACI detected open exposure into a critical news window (advisory only).",
      });
    }

    return { shouldPauseManagement, anomalies, positionMismatch, preNewsSymbols };
  } catch (err) {
    logger.warn({ err, agentId: input.agentId }, "aaci: chain reconciliation failed (advisory, no pause)");
    return empty;
  }
}

async function raiseChainAnomaly(
  e: SelfTradeAgentExecution,
  verdict: ChainCoherenceVerdict,
  input: ReconcileAaciChainInput,
): Promise<void> {
  const isFillGap = verdict === "FILL_NO_POSITION";
  await createAlert({
    type: "EXECUTION_SAFETY",
    priority: "HIGH",
    severity: "warning",
    actionRequired: true,
    symbol: e.symbol,
    title: isFillGap ? "Fill recorded without an open position" : "Live command did not resolve",
    message: isFillGap
      ? `A recorded fill on ${e.symbol} has no matching open broker position. Position management is paused for this agent until reviewed — nothing was closed.`
      : `A dispatched live command on ${e.symbol} never reported back. Position management is paused for this agent until reviewed — nothing was closed.`,
    dedupeKey: `aaci-${verdict}-${e.id}`,
  });
  await writeSelfTradeAudit(db, {
    agentId: e.agentId,
    eventType: verdict === "FILL_NO_POSITION" ? "AACI_FILL_NO_POSITION" : "AACI_LOST_COMMAND",
    actorUserId: input.actorUserId ?? null,
    actorRole: input.actorRole ?? null,
    severity: "WARNING",
    afterState: { executionId: e.id, symbol: e.symbol, brokerTicket: e.brokerTicket, commandId: e.commandId },
    reason:
      verdict === "FILL_NO_POSITION"
        ? "AACI: recorded fill with no broker position — management paused (advisory)."
        : "AACI: dispatched live command never resolved — management paused (advisory).",
  });
}

/**
 * Best-effort pre-critical-news exposure read. Honest: only consults a REAL
 * news provider. The default mock provider is treated as "no calendar wired"
 * so we never fabricate a news alert.
 */
async function assessPreNewsExposure(openSymbols: string[]): Promise<string[]> {
  if (openSymbols.length === 0) return [];
  const provider = pickNewsProvider();
  if (provider.name === "mock") return []; // no real calendar → honest no-op
  try {
    const events = await provider.fetchEvents(1);
    const now = Date.now();
    const risky = new Set<string>();
    for (const ev of events) {
      if (ev.impactLevel !== "CRITICAL" && ev.impactLevel !== "HIGH") continue;
      const minutesAway = (new Date(ev.eventTime).getTime() - now) / 60000;
      if (minutesAway < -15 || minutesAway > 60) continue; // imminent window only
      for (const sym of ev.affectedSymbols ?? []) risky.add(sym);
    }
    return detectPreNewsExposure({ openSymbols, riskySymbols: risky });
  } catch (err) {
    logger.warn({ err }, "aaci: pre-news exposure read failed (advisory, ignored)");
    return [];
  }
}
