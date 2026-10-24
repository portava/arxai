// Position Guardian — post-fill reconciliation (loads facts, corrects, audits).
//
// Runs after every broker fill and after every broker position snapshot:
//   1. the fill is confirmed (a FILLED command with a broker ticket),
//   2. it is tied to the governed order that opened the position,
//   3. the governed stop is loaded (entry stop, as moved by approved modifies),
//   4. the broker-side position and stop are read,
//   5. the two are compared (lib/positionGuardian/assess.ts),
//   6. missing, widened, stale or inconsistent protection is named,
//   7. a missing or widened stop is restored through the SAME governed queue
//      as any other modify (origin automation, so the Risk Governor only lets
//      it tighten),
//   8. anything that cannot be fixed that way is escalated to the trader,
//   9. every check that finds something, and every change of state, is
//      written to user_risk_events.
//
// LIVE reads arx_live_commands (governed) against arx_live_positions (the
// bridge's position snapshots). DEMO reads mt5_demo_commands against the
// trader's live_positions rows.

import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  arxLiveCommandsTable,
  arxLivePositionsTable,
  db,
  livePositionsTable,
  mt5DemoCommandsTable,
  userRiskEventsTable,
} from "@workspace/db";
import { logRiskEvent } from "../riskGovernor/riskEvents.js";
import { logger } from "../logger.js";
import {
  assessProtection,
  GUARDIAN_DEFAULTS,
  type BrokerProtection,
  type GovernedProtection,
  type GuardianAssessment,
} from "./assess.js";

export type GuardianVenue = "DEMO" | "LIVE";
export const GUARDIAN_SOURCE = "POSITION_GUARDIAN";
export const GUARDIAN_EVENT = "position_guardian";

/** Re-audit an unchanged state at most this often. */
const UNCHANGED_AUDIT_INTERVAL_MS = 15 * 60_000;

const LIVE_OPEN_TYPES = ["PLACE_LIVE_MARKET_ORDER", "PLACE_LIVE_PENDING_ORDER"];
const LIVE_NON_TERMINAL = ["LIVE_DRAFT", "LIVE_CONFIRMATION_REQUIRED", "LIVE_APPROVED", "SENT_TO_MT5_LIVE"];
const DEMO_OPEN_TYPES = ["PLACE_MARKET_ORDER", "PLACE_PENDING_ORDER"];
const DEMO_NON_TERMINAL = ["DRAFT", "USER_CONFIRMATION_REQUIRED", "DEMO_APPROVED", "SENT_TO_MT5_DEMO"];

export interface GuardianFacts {
  governed: GovernedProtection;
  broker: BrokerProtection;
  correctionPending: boolean;
}

export interface GuardianRunResult {
  venue: GuardianVenue;
  ticket: string;
  assessment: GuardianAssessment;
  correction: { attempted: boolean; ok: boolean; commandId: string | null; reason: string | null };
  auditEventId: number | null;
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const sideOf = (v: unknown): "BUY" | "SELL" | null => {
  const s = String(v ?? "").toUpperCase();
  return s === "BUY" || s === "SELL" ? s : null;
};

// ── Fact loaders ────────────────────────────────────────────────────────────

async function loadLiveFacts(userId: number, ticket: string): Promise<GuardianFacts | null> {
  const [open] = await db.select().from(arxLiveCommandsTable).where(and(
    eq(arxLiveCommandsTable.userId, userId),
    eq(arxLiveCommandsTable.brokerTicket, ticket),
    eq(arxLiveCommandsTable.status, "LIVE_FILLED"),
    inArray(arxLiveCommandsTable.commandType, LIVE_OPEN_TYPES),
  )).orderBy(desc(arxLiveCommandsTable.id)).limit(1);
  const side = sideOf(open?.side);
  if (!open || !side) return null; // not an ARX-governed position

  const modifies = await db.select().from(arxLiveCommandsTable).where(and(
    eq(arxLiveCommandsTable.userId, userId),
    eq(arxLiveCommandsTable.commandType, "MODIFY_LIVE_SLTP"),
    sql`${arxLiveCommandsTable.payload}->>'brokerTicket' = ${ticket}`,
  )).orderBy(desc(arxLiveCommandsTable.id));
  const lastStop = modifies.find((m) => m.status === "LIVE_FILLED" && m.stopLoss != null);
  const lastTp = modifies.find((m) => m.status === "LIVE_FILLED" && m.takeProfit != null);
  const pending = modifies.some((m) => m.sourcePage === GUARDIAN_SOURCE && LIVE_NON_TERMINAL.includes(m.status));

  const [pos] = await db.select().from(arxLivePositionsTable).where(and(
    eq(arxLivePositionsTable.userId, userId),
    eq(arxLivePositionsTable.brokerTicket, ticket),
  )).orderBy(desc(arxLivePositionsTable.id)).limit(1);
  // A closed position needs no protection.
  if (pos?.closedAt != null || pos?.reconcileState != null) return null;
  const [closed] = await db.select({ id: arxLiveCommandsTable.id }).from(arxLiveCommandsTable).where(and(
    eq(arxLiveCommandsTable.userId, userId),
    eq(arxLiveCommandsTable.commandType, "CLOSE_LIVE_POSITION"),
    eq(arxLiveCommandsTable.status, "LIVE_FILLED"),
    sql`${arxLiveCommandsTable.payload}->>'brokerTicket' = ${ticket}`,
  )).limit(1);
  if (closed) return null;

  return {
    governed: {
      ticket, symbol: open.symbol, side,
      lots: Number(open.executedVolume ?? open.requestedVolume),
      stopLoss: lastStop?.stopLoss ?? open.stopLoss ?? null,
      takeProfit: lastTp?.takeProfit ?? open.takeProfit ?? null,
      sourceCommandId: lastStop?.commandId ?? open.commandId,
      governedAt: (lastStop ?? open).filledAt ?? (lastStop ?? open).resultRecordedAt ?? open.createdAt,
    },
    broker: pos && pos.closedAt == null
      ? {
          present: true, side: pos.side, lots: pos.volume, stopLoss: pos.stopLoss, takeProfit: pos.takeProfit,
          currentPrice: pos.currentPrice, observedAt: pos.lastSyncedAt,
        }
      : { present: false, side: null, lots: null, stopLoss: null, takeProfit: null, currentPrice: null,
          observedAt: pos?.lastSyncedAt ?? null },
    correctionPending: pending,
  };
}

async function loadDemoFacts(userId: number, ticket: string): Promise<GuardianFacts | null> {
  const [open] = await db.select().from(mt5DemoCommandsTable).where(and(
    eq(mt5DemoCommandsTable.userId, userId),
    eq(mt5DemoCommandsTable.brokerTicket, ticket),
    eq(mt5DemoCommandsTable.status, "FILLED_DEMO"),
    inArray(mt5DemoCommandsTable.commandType, DEMO_OPEN_TYPES),
  )).orderBy(desc(mt5DemoCommandsTable.id)).limit(1);
  const p = (open?.payload ?? {}) as Record<string, unknown>;
  const side = sideOf(p["side"]);
  if (!open || !side) return null;

  const modifies = await db.select().from(mt5DemoCommandsTable).where(and(
    eq(mt5DemoCommandsTable.userId, userId),
    eq(mt5DemoCommandsTable.commandType, "MODIFY_SLTP"),
    sql`coalesce(${mt5DemoCommandsTable.payload}->>'ticket', ${mt5DemoCommandsTable.payload}->>'positionTicket') = ${ticket}`,
  )).orderBy(desc(mt5DemoCommandsTable.id));
  const pl = (m: typeof modifies[number]) => (m.payload ?? {}) as Record<string, unknown>;
  const lastStop = modifies.find((m) => m.status === "FILLED_DEMO" && num(pl(m)["stopLoss"]) != null);
  const lastTp = modifies.find((m) => m.status === "FILLED_DEMO" && num(pl(m)["takeProfit"]) != null);
  const pending = modifies.some((m) => pl(m)["sourcePage"] === GUARDIAN_SOURCE && DEMO_NON_TERMINAL.includes(m.status));

  const [pos] = await db.select().from(livePositionsTable).where(and(
    eq(livePositionsTable.userId, userId),
    eq(livePositionsTable.brokerPositionId, ticket),
  )).orderBy(desc(livePositionsTable.id)).limit(1);
  if (pos?.status === "CLOSED") return null;
  const [closed] = await db.select({ id: mt5DemoCommandsTable.id }).from(mt5DemoCommandsTable).where(and(
    eq(mt5DemoCommandsTable.userId, userId),
    eq(mt5DemoCommandsTable.commandType, "CLOSE_POSITION"),
    eq(mt5DemoCommandsTable.status, "FILLED_DEMO"),
    sql`coalesce(${mt5DemoCommandsTable.payload}->>'ticket', ${mt5DemoCommandsTable.payload}->>'positionTicket') = ${ticket}`,
  )).limit(1);
  if (closed) return null;

  return {
    governed: {
      ticket, symbol: String(p["symbol"] ?? ""), side,
      lots: open.fillVolume ?? num(p["lotSize"]) ?? 0,
      stopLoss: (lastStop ? num(pl(lastStop)["stopLoss"]) : null) ?? num(p["stopLoss"]),
      takeProfit: (lastTp ? num(pl(lastTp)["takeProfit"]) : null) ?? num(p["takeProfit"]),
      sourceCommandId: lastStop?.commandId ?? open.commandId,
      governedAt: (lastStop ?? open).filledAt ?? (lastStop ?? open).updatedAt,
    },
    broker: pos && pos.status !== "CLOSED"
      ? {
          present: true, side: pos.direction, lots: pos.lotSize, stopLoss: pos.stopLoss, takeProfit: pos.takeProfit,
          currentPrice: pos.currentPrice, observedAt: pos.lastSyncedAt,
        }
      : { present: false, side: null, lots: null, stopLoss: null, takeProfit: null, currentPrice: null,
          observedAt: pos?.lastSyncedAt ?? null },
    correctionPending: pending,
  };
}

export function loadGuardianFacts(venue: GuardianVenue, userId: number, ticket: string): Promise<GuardianFacts | null> {
  return venue === "LIVE" ? loadLiveFacts(userId, ticket) : loadDemoFacts(userId, ticket);
}

// ── Correction: a governed modify through the venue's own queue ─────────────

export interface CorrectionResult { ok: boolean; commandId: string | null; reason: string | null }
export type CorrectionSubmitter = (venue: GuardianVenue, userId: number, g: GovernedProtection, stopLoss: number,
  takeProfit: number | null) => Promise<CorrectionResult>;

export const submitGovernedStop: CorrectionSubmitter = async (venue, userId, g, stopLoss, takeProfit) => {
  if (venue === "LIVE") {
    const pipe = await import("../live/liveCommandPipeline.js");
    const draft = await pipe.createLiveOpsDraft({
      userId, commandType: "MODIFY_LIVE_SLTP", brokerTicket: g.ticket, symbol: g.symbol, side: g.side,
      volume: g.lots, newStopLoss: stopLoss, newTakeProfit: takeProfit, sourcePage: GUARDIAN_SOURCE,
    });
    if (!draft.ok) return { ok: false, commandId: null, reason: draft.reason };
    const commandId = draft.command.commandId;
    const confirmed = await pipe.confirmLiveCommand({ userId, commandId });
    if (!confirmed.ok) return { ok: false, commandId, reason: confirmed.reason };
    const sent = await pipe.dispatchLiveCommand({ userId, commandId });
    const status = (sent as { command?: { status?: string } }).command?.status ?? null;
    return sent.ok && status !== "LIVE_BLOCKED"
      ? { ok: true, commandId, reason: null }
      : { ok: false, commandId, reason: (sent as { reason?: string }).reason ?? status ?? "DISPATCH_REFUSED" };
  }
  const queue = await import("../mt5/demoCommandQueue.js");
  const draft = await queue.createDraftCommand({
    userId, commandType: "MODIFY_SLTP",
    payload: { symbol: g.symbol, side: g.side, ticket: g.ticket, lotSize: g.lots, stopLoss, takeProfit, sourcePage: GUARDIAN_SOURCE },
  });
  if (!draft.ok || !draft.command) return { ok: false, commandId: null, reason: draft.reason ?? "DRAFT_REFUSED" };
  const commandId = draft.command.commandId;
  const confirmed = await queue.confirmCommand({ userId, commandId });
  if (!confirmed.ok) return { ok: false, commandId, reason: confirmed.reason ?? "CONFIRM_REFUSED" };
  if (confirmed.command?.status === "SENT_TO_MT5_DEMO") return { ok: true, commandId, reason: null };
  const sent = await queue.dispatchApprovedCommand({ userId, commandId });
  return sent.ok && sent.command?.status === "SENT_TO_MT5_DEMO"
    ? { ok: true, commandId, reason: null }
    : { ok: false, commandId, reason: sent.reason ?? sent.command?.status ?? "DISPATCH_REFUSED" };
};

// ── Audit ───────────────────────────────────────────────────────────────────

async function lastGuardianEvent(userId: number, venue: GuardianVenue, ticket: string) {
  const [row] = await db.select().from(userRiskEventsTable).where(and(
    eq(userRiskEventsTable.userId, userId),
    eq(userRiskEventsTable.eventType, GUARDIAN_EVENT),
    sql`${userRiskEventsTable.details}->>'venue' = ${venue}`,
    sql`${userRiskEventsTable.details}->>'ticket' = ${ticket}`,
  )).orderBy(desc(userRiskEventsTable.id)).limit(1);
  return row ?? null;
}

const stateKey = (a: GuardianAssessment) => `${a.action}:${a.findings.join(",")}`;

// ── Entry points ────────────────────────────────────────────────────────────

export interface ReconcileOptions {
  now?: Date;
  trigger: "fill" | "snapshot" | "sweep";
  /** Injected in tests; defaults to the venue's governed queue. */
  submit?: CorrectionSubmitter;
}

export async function reconcilePosition(venue: GuardianVenue, userId: number, ticket: string,
  opts: ReconcileOptions): Promise<GuardianRunResult | null> {
  const facts = await loadGuardianFacts(venue, userId, ticket);
  if (!facts) return null; // opened outside ARX: not governed, not ours to correct
  const now = opts.now ?? new Date();
  const assessment = assessProtection(facts.governed, facts.broker, {
    now, ...GUARDIAN_DEFAULTS, correctionPending: facts.correctionPending,
  });

  let correction: GuardianRunResult["correction"] = { attempted: false, ok: false, commandId: null, reason: null };
  if (assessment.action === "RESTORE_STOP" && assessment.restoreStopTo != null) {
    try {
      const r = await (opts.submit ?? submitGovernedStop)(venue, userId, facts.governed, assessment.restoreStopTo,
        facts.broker.takeProfit ?? facts.governed.takeProfit);
      correction = { attempted: true, ...r };
    } catch (err) {
      correction = { attempted: true, ok: false, commandId: null, reason: String(err).slice(0, 200) };
    }
  }

  const failed = correction.attempted && !correction.ok;
  const escalate = assessment.escalate || failed;
  const reason = failed
    ? `${assessment.reason} The restore was refused (${correction.reason}); please set the stop yourself.`
    : assessment.reason;

  // Audit: every finding that needs action, every correction, and any change
  // of state; an unchanged healthy or waiting state is re-recorded at most
  // every 15 minutes so a snapshot every few seconds does not flood the trail.
  let auditEventId: number | null = null;
  const prev = await lastGuardianEvent(userId, venue, ticket);
  const prevKey = (prev?.details as Record<string, unknown> | null)?.["state"];
  const quiet = !escalate && !correction.attempted && prev != null && prevKey === stateKey(assessment)
    && now.getTime() - new Date(prev.createdAt).getTime() < UNCHANGED_AUDIT_INTERVAL_MS;
  if (!quiet) {
    try {
      const [row] = await logRiskEvent({
        userId,
        eventType: GUARDIAN_EVENT,
        severity: escalate ? "critical" : correction.attempted ? "warning" : "info",
        decision: escalate || correction.attempted ? "warning" : "pass",
        reason,
        details: {
          source: "position_guardian", venue, ticket, trigger: opts.trigger, state: stateKey(assessment),
          findings: assessment.findings, action: assessment.action, escalated: escalate,
          restoreStopTo: assessment.restoreStopTo, correction,
          governed: { ...facts.governed, governedAt: facts.governed.governedAt?.toISOString() ?? null },
          broker: { ...facts.broker, observedAt: facts.broker.observedAt?.toISOString() ?? null },
        },
      });
      auditEventId = row?.id ?? null;
    } catch (err) {
      logger.warn({ err, userId, venue, ticket }, "position guardian audit write failed");
    }
  }
  return { venue, ticket, assessment: { ...assessment, reason }, correction, auditEventId };
}

/** Check every open ARX-governed position the trader holds on this venue. */
export async function reconcileOpenPositions(venue: GuardianVenue, userId: number,
  opts: ReconcileOptions): Promise<GuardianRunResult[]> {
  const tickets = venue === "LIVE"
    ? (await db.select({ t: arxLivePositionsTable.brokerTicket }).from(arxLivePositionsTable).where(and(
        eq(arxLivePositionsTable.userId, userId), isNull(arxLivePositionsTable.closedAt),
        isNull(arxLivePositionsTable.reconcileState)))).map((r) => r.t)
    : (await db.select({ t: livePositionsTable.brokerPositionId }).from(livePositionsTable).where(and(
        eq(livePositionsTable.userId, userId), ne(livePositionsTable.status, "CLOSED")))).map((r) => r.t);
  const out: GuardianRunResult[] = [];
  for (const t of new Set(tickets.filter((x): x is string => typeof x === "string" && x.length > 0))) {
    const r = await reconcilePosition(venue, userId, t, opts);
    if (r) out.push(r);
  }
  return out;
}

/** Fire-and-forget hook for fill and snapshot handlers; never throws. */
export function scheduleGuardian(venue: GuardianVenue, userId: number, ticket: string | null,
  trigger: ReconcileOptions["trigger"]): void {
  void (async () => {
    try {
      if (ticket) await reconcilePosition(venue, userId, ticket, { trigger });
      else await reconcileOpenPositions(venue, userId, { trigger });
    } catch (err) {
      logger.warn({ err, venue, userId, ticket, trigger }, "position guardian run failed");
    }
  })();
}
