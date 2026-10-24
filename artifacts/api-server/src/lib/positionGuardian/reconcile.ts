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

import { livePositionLedger, demoPositionLedger, livePositionColumns, demoPositionColumns } from "../positions/ledger.js";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { arxLiveCommandsTable, db, mt5DemoCommandsTable, userRiskEventsTable } from "@workspace/db";
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
/** Entry states that leave real exposure at the broker (a cancelled remainder keeps the filled part). */
const LIVE_EXPOSED = ["LIVE_FILLED", "LIVE_PARTIALLY_FILLED", "LIVE_CANCELLED"];
/** Close states that took volume off the position. */
const LIVE_CLOSED_VOLUME = ["LIVE_FILLED", "LIVE_PARTIALLY_FILLED", "LIVE_CLOSED"];
const LOT_EPS = 1e-6;
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

/**
 * Lots still governed after approved closes. A close that reports no volume
 * is a full close (the old behaviour), never a guess at a partial.
 */
const latest = (ds: Array<Date | null>): Date | null =>
  ds.reduce<Date | null>((m, d) => (d != null && (m == null || d > m) ? d : m), null);

export function remainingLots(filled: number, closed: Array<number | null | undefined>): number {
  let left = filled;
  for (const v of closed) {
    if (v == null || !Number.isFinite(v)) return 0;
    left -= v;
  }
  return Math.max(0, Math.round(left * 1e8) / 1e8);
}

async function loadLiveFacts(userId: number, ticket: string): Promise<GuardianFacts | null> {
  const [open] = await db.select().from(arxLiveCommandsTable).where(and(
    eq(arxLiveCommandsTable.userId, userId),
    eq(arxLiveCommandsTable.brokerTicket, ticket),
    inArray(arxLiveCommandsTable.status, LIVE_EXPOSED),
    inArray(arxLiveCommandsTable.commandType, LIVE_OPEN_TYPES),
  )).orderBy(desc(arxLiveCommandsTable.id)).limit(1);
  const side = sideOf(open?.side);
  if (!open || !side) return null; // not an ARX-governed position
  // A cancelled entry is exposure only if part of it filled.
  if (open.status === "LIVE_CANCELLED" && !((open.executedVolume ?? 0) > 0)) return null;

  const modifies = await db.select().from(arxLiveCommandsTable).where(and(
    eq(arxLiveCommandsTable.userId, userId),
    eq(arxLiveCommandsTable.commandType, "MODIFY_LIVE_SLTP"),
    sql`${arxLiveCommandsTable.payload}->>'brokerTicket' = ${ticket}`,
  )).orderBy(desc(arxLiveCommandsTable.id));
  const lastStop = modifies.find((m) => m.status === "LIVE_FILLED" && m.stopLoss != null);
  const lastTp = modifies.find((m) => m.status === "LIVE_FILLED" && m.takeProfit != null);
  const pending = modifies.some((m) => m.sourcePage === GUARDIAN_SOURCE && LIVE_NON_TERMINAL.includes(m.status));

  const [pos] = await livePositionLedger.read({
    where: and(eq(livePositionColumns.userId, userId), eq(livePositionColumns.brokerTicket, ticket)),
    orderBy: [desc(livePositionColumns.id)],
    limit: 1,
  });
  // A closed position needs no protection.
  if (pos?.closedAt != null || pos?.reconcileState != null) return null;
  // Approved closes take volume off: a full close ends protection, a partial
  // close leaves the remainder governed (and still protected by its stop).
  const closes = await db.select({ executed: arxLiveCommandsTable.executedVolume, requested: arxLiveCommandsTable.requestedVolume,
    at: arxLiveCommandsTable.filledAt })
    .from(arxLiveCommandsTable).where(and(
      eq(arxLiveCommandsTable.userId, userId),
      eq(arxLiveCommandsTable.commandType, "CLOSE_LIVE_POSITION"),
      inArray(arxLiveCommandsTable.status, LIVE_CLOSED_VOLUME),
      sql`${arxLiveCommandsTable.payload}->>'brokerTicket' = ${ticket}`,
    ));
  const filledLots = Number(open.executedVolume ?? open.requestedVolume);
  const lots = remainingLots(filledLots, closes.map((c) => c.executed ?? c.requested));
  if (lots <= LOT_EPS) return null;

  return {
    governed: {
      ticket, symbol: open.symbol, side, lots,
      requestedLots: open.requestedVolume, filledLots,
      sizeChangedAt: latest(closes.map((c) => c.at)),
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

  const [pos] = await demoPositionLedger.read({
    where: and(eq(demoPositionColumns.userId, userId), eq(demoPositionColumns.brokerPositionId, ticket)),
    orderBy: [desc(demoPositionColumns.id)],
    limit: 1,
  });
  if (pos?.status === "CLOSED") return null;
  const closes = await db.select({ fill: mt5DemoCommandsTable.fillVolume, payload: mt5DemoCommandsTable.payload,
    at: mt5DemoCommandsTable.filledAt })
    .from(mt5DemoCommandsTable).where(and(
      eq(mt5DemoCommandsTable.userId, userId),
      eq(mt5DemoCommandsTable.commandType, "CLOSE_POSITION"),
      eq(mt5DemoCommandsTable.status, "FILLED_DEMO"),
      sql`coalesce(${mt5DemoCommandsTable.payload}->>'ticket', ${mt5DemoCommandsTable.payload}->>'positionTicket') = ${ticket}`,
    ));
  const filledLots = open.fillVolume ?? num(p["lotSize"]) ?? 0;
  const lots = remainingLots(filledLots, closes.map((c) => c.fill ?? num(((c.payload ?? {}) as Record<string, unknown>)["lotSize"])));
  if (lots <= LOT_EPS) return null;

  return {
    governed: {
      ticket, symbol: String(p["symbol"] ?? ""), side, lots,
      requestedLots: num(p["lotSize"]), filledLots,
      sizeChangedAt: latest(closes.map((c) => c.at)),
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
  // Through the guardian's exit door to the one governed modify path
  // (lib/positions/governedOps.ts); the Guardian source makes the origin
  // automation, so the Risk Governor only lets it tighten.
  const { guardianRestoreStop } = await import("./manage.js");
  return guardianRestoreStop({
    ruleId: "position-protection", userId,
    position: { venue, ticket: g.ticket, symbol: g.symbol, side: g.side, lots: g.lots },
    stopLoss, takeProfit, sourcePage: GUARDIAN_SOURCE,
  });
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
  trigger: "fill" | "snapshot" | "sweep" | "reconnect";
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
  // After a bridge reconnect every governed position is re-recorded once.
  const quiet = opts.trigger !== "reconnect" && !escalate && !correction.attempted && prev != null && prevKey === stateKey(assessment)
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
    ? (await livePositionLedger.select(
      { t: livePositionColumns.brokerTicket },
      {
        where: and(
          eq(livePositionColumns.userId, userId),
          isNull(livePositionColumns.closedAt),
          isNull(livePositionColumns.reconcileState),
        ),
      },
    )).map((r) => r.t)
    : (await demoPositionLedger.select(
      { t: demoPositionColumns.brokerPositionId },
      { where: and(eq(demoPositionColumns.userId, userId), ne(demoPositionColumns.status, "CLOSED")) },
    )).map((r) => r.t);
  const out: GuardianRunResult[] = [];
  for (const t of new Set(tickets.filter((x): x is string => typeof x === "string" && x.length > 0))) {
    const r = await reconcilePosition(venue, userId, t, opts);
    if (r) out.push(r);
  }
  return out;
}

// ── Reconnect reconciliation ────────────────────────────────────────────────
//
// A bridge that comes back after a gap may have missed fills, closes and stop
// changes. The heartbeat marks the trader; the first full position snapshot
// after it reconciles every governed position (trigger "reconnect") and
// records each one in the audit trail, whatever its state.

/** A heartbeat gap longer than this is a reconnect. */
export const RECONNECT_GAP_MS = 60_000;
const pendingReconnect = new Set<string>();

export function noteBridgeHeartbeat(venue: GuardianVenue, userId: number, previousHeartbeat: Date | null, now = new Date()): boolean {
  const reconnect = previousHeartbeat == null || now.getTime() - previousHeartbeat.getTime() > RECONNECT_GAP_MS;
  if (reconnect) pendingReconnect.add(`${venue}:${userId}`);
  return reconnect;
}

/** True once per reconnect: the snapshot sweep that should run as "reconnect". */
export function takeReconnect(venue: GuardianVenue, userId: number): boolean {
  return pendingReconnect.delete(`${venue}:${userId}`);
}

/** Fire-and-forget hook for fill and snapshot handlers; never throws. */
export function scheduleGuardian(venue: GuardianVenue, userId: number, ticket: string | null,
  trigger: ReconcileOptions["trigger"]): void {
  void (async () => {
    try {
      if (ticket) await reconcilePosition(venue, userId, ticket, { trigger });
      else await reconcileOpenPositions(venue, userId, { trigger: trigger === "snapshot" && takeReconnect(venue, userId) ? "reconnect" : trigger });
    } catch (err) {
      logger.warn({ err, venue, userId, ticket, trigger }, "position guardian run failed");
    }
  })();
}
