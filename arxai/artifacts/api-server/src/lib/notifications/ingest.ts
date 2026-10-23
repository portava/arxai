// Build LL — Ingest scanner.
//
// Pulls recent rows from existing AA..KK event/log tables and feeds them
// through the rule engine via notify(). Idempotent: every call passes
// `idempotent: true` AND a stable `sourceEventId` per source row, so re-running
// ingest on unchanged data produces SKIPPED results (no repeat_count inflation).
//
// SAFETY: read-only against source tables; writes only to LL tables.

import {
  db,
  riskGovernorEvaluationsTable,
  paperOrdersTable,
  autopilotCyclesTable,
  brokerReadonlyLogsTable,
  brokerReadonlySnapshotsTable,
  dataImportsTable,
  postTradeDebriefsTable,
  learningEventsTable,
  mistakePatternsTable,
  tradeDecisionLogsTable,
} from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { notify, type NotifyResult } from "./service.js";
import {
  ruleGovernorEvaluation, rulePaperExecution, ruleAutopilot,
  ruleDebrief, ruleLearning, ruleImport, ruleBroker, ruleAADecision,
  type NotifyInput,
} from "./rules.js";

interface IngestStats { source: string; scanned: number; created: number; updated: number; skipped: number; }

function tally(stats: IngestStats, r: NotifyResult) {
  stats.scanned++;
  if (r.status === "CREATED") stats.created++;
  else if (r.status === "UPDATED") stats.updated++;
  else stats.skipped++;
}

function ts(d: Date | null | undefined): string {
  return d ? String((d as Date).getTime()) : "0";
}

async function fire(
  s: IngestStats,
  inp: NotifyInput | null,
  sourceEventId: string,
) {
  if (!inp) return;
  inp.sourceEventId = sourceEventId;
  tally(s, await notify(inp, { idempotent: true }));
}

export async function ingest(opts: { limitPerSource?: number; userId?: number } = {}) {
  const lim = opts.limitPerSource ?? 50;
  const stats: IngestStats[] = [];

  // HH governor evaluations
  {
    const s: IngestStats = { source: "HH:risk_governor_evaluations", scanned: 0, created: 0, updated: 0, skipped: 0 };
    const rows = await db.select().from(riskGovernorEvaluationsTable).orderBy(desc(riskGovernorEvaluationsTable.createdAt)).limit(lim);
    for (const r of rows) {
      const inp = ruleGovernorEvaluation({
        governorId: r.governorId,
        overallStatus: r.overallStatus,
        liveTradingAllowed: r.liveTradingAllowed ?? false,
        hardBlocks: (r.hardBlocks as Array<{ code: string; severity: string; message: string }>) ?? [],
        metrics: (r.metrics as { dailyPnl?: number; dailyLossLimit?: number }) ?? {},
      });
      await fire(s, inp, `HH:eval:${r.governorId}:${ts(r.createdAt)}`);
    }
    stats.push(s);
  }

  // EE paper orders
  {
    const s: IngestStats = { source: "EE:paper_orders", scanned: 0, created: 0, updated: 0, skipped: 0 };
    const rows = await db.select().from(paperOrdersTable).orderBy(desc(paperOrdersTable.createdAt)).limit(lim);
    for (const r of rows) {
      await fire(s,
        rulePaperExecution({ paperOrderId: r.id, event: "OPENED", symbol: r.symbol ?? undefined }),
        `EE:open:${r.id}:${ts(r.createdAt)}`);
      const status = (r.status ?? "").toString().toUpperCase();
      const pnl = r.profitLoss ?? null;
      if (r.closedAt && (status === "CLOSED" || status === "TP_HIT" || status === "SL_HIT" || status === "MANUAL_CLOSED")) {
        const evt = status === "TP_HIT" ? "TP_HIT" : status === "SL_HIT" ? "SL_HIT" : "MANUAL_CLOSE";
        await fire(s,
          rulePaperExecution({ paperOrderId: r.id, event: evt as "TP_HIT"|"SL_HIT"|"MANUAL_CLOSE", symbol: r.symbol ?? undefined, pnl }),
          `EE:close:${r.id}:${ts(r.closedAt)}`);
      }
    }
    stats.push(s);
  }

  // FF autopilot cycles
  {
    const s: IngestStats = { source: "FF:autopilot_cycles", scanned: 0, created: 0, updated: 0, skipped: 0 };
    const rows = await db.select().from(autopilotCyclesTable).orderBy(desc(autopilotCyclesTable.createdAt)).limit(lim);
    for (const r of rows) {
      const cycleId = r.autopilotCycleId;
      const status = (r.status ?? "").toString().toUpperCase();
      if (status === "STARTED" || status === "RUNNING")
        await fire(s, ruleAutopilot({ cycleId, event: "STARTED" }), `FF:start:${cycleId}:${ts(r.createdAt)}`);
      if (status === "FINISHED" || status === "STOPPED")
        await fire(s, ruleAutopilot({ cycleId, event: "STOPPED" }), `FF:stop:${cycleId}:${ts(r.createdAt)}`);
      const errs = (r.errors as unknown[]) ?? [];
      if (errs.length)
        await fire(s, ruleAutopilot({ cycleId, event: "PAUSED_BY_GOVERNOR", reason: String(errs[0]).slice(0, 80) }),
          `FF:pause:${cycleId}:${ts(r.createdAt)}`);
    }
    stats.push(s);
  }

  // BB debriefs
  {
    const s: IngestStats = { source: "BB:post_trade_debriefs", scanned: 0, created: 0, updated: 0, skipped: 0 };
    const rows = await db.select().from(postTradeDebriefsTable).orderBy(desc(postTradeDebriefsTable.createdAt)).limit(lim);
    for (const r of rows) {
      await fire(s, ruleDebrief({ debriefId: r.id, event: "CREATED", tradeId: r.tradeId ?? undefined }),
        `BB:created:${r.id}:${ts(r.createdAt)}`);
    }
    stats.push(s);
  }

  // CC learning events
  {
    const s: IngestStats = { source: "CC:learning_events", scanned: 0, created: 0, updated: 0, skipped: 0 };
    const rows = await db.select().from(learningEventsTable).orderBy(desc(learningEventsTable.createdAt)).limit(lim);
    for (const r of rows) {
      await fire(s, ruleLearning({ learningEventId: r.id, event: "PROCESSED", symbol: r.symbol ?? undefined }),
        `CC:processed:${r.id}:${ts(r.createdAt)}`);
    }
    stats.push(s);
  }

  // CC mistake patterns rising
  {
    const s: IngestStats = { source: "CC:mistake_patterns", scanned: 0, created: 0, updated: 0, skipped: 0 };
    const rows = await db.select().from(mistakePatternsTable).orderBy(desc(mistakePatternsTable.updatedAt)).limit(lim);
    for (const r of rows) {
      if ((r.count ?? 0) >= 3) {
        await fire(s,
          ruleLearning({ learningEventId: r.id, event: "REPEATED_MISTAKE_RISING",
            tag: r.tag ?? undefined, count: r.count ?? undefined, symbol: r.symbol ?? undefined }),
          `CC:rising:${r.id}:${r.count ?? 0}:${ts(r.updatedAt)}`);
      }
    }
    stats.push(s);
  }

  // KK data imports
  {
    const s: IngestStats = { source: "KK:data_imports", scanned: 0, created: 0, updated: 0, skipped: 0 };
    const rows = await db.select().from(dataImportsTable).orderBy(desc(dataImportsTable.createdAt)).limit(lim);
    for (const r of rows) {
      const inp = ruleImport({
        importId: r.importId, status: r.status,
        warnings: (r.warnings as string[]) ?? [], errors: (r.errors as string[]) ?? [],
      });
      await fire(s, inp, `KK:import:${r.importId}:${r.status}:${ts(r.createdAt)}`);
    }
    stats.push(s);
  }

  // KK broker logs (unsafe mode)
  {
    const s: IngestStats = { source: "KK:broker_readonly_logs", scanned: 0, created: 0, updated: 0, skipped: 0 };
    // Broker diagnostics are private per-user data. A missing owner scopes to
    // no real user (0), so background/legacy callers fail closed.
    const brokerOwnerId = opts.userId ?? 0;
    const rows = await db.select().from(brokerReadonlyLogsTable)
      .where(eq(brokerReadonlyLogsTable.userId, brokerOwnerId))
      .orderBy(desc(brokerReadonlyLogsTable.createdAt)).limit(lim);
    for (const r of rows) {
      if (r.eventType === "BROKER_MODE_UNSAFE" || (r.severity === "CRITICAL" && /BROKER_MODE/i.test(r.message))) {
        const det = (r.details as Record<string, unknown>) ?? {};
        const inp = ruleBroker({ event: "UNSAFE_MODE_REJECTED", brokerModeEnv: String(det.brokerModeEnv ?? det.env ?? "unknown") });
        if (inp) {
          inp.sourceEventId = `KK:brokerlog:${r.id}:${ts(r.createdAt)}`;
          inp.dedupeKey = `${inp.dedupeKey}:USER:${brokerOwnerId}`;
          tally(s, await notify({ ...inp, userId: brokerOwnerId }, { idempotent: true }));
        }
      }
    }
    stats.push(s);
  }

  // KK broker snapshots (info)
  {
    const s: IngestStats = { source: "KK:broker_readonly_snapshots", scanned: 0, created: 0, updated: 0, skipped: 0 };
    const brokerOwnerId = opts.userId ?? 0;
    const rows = await db.select().from(brokerReadonlySnapshotsTable)
      .where(eq(brokerReadonlySnapshotsTable.userId, brokerOwnerId))
      .orderBy(desc(brokerReadonlySnapshotsTable.createdAt)).limit(lim);
    for (const r of rows) {
      const inp = ruleBroker({ event: "SNAPSHOT_CREATED", snapshotId: r.snapshotId });
      if (inp) {
        inp.sourceEventId = `KK:snapshot:${r.snapshotId}:${ts(r.createdAt)}`;
        inp.dedupeKey = `${inp.dedupeKey}:USER:${brokerOwnerId}`;
        tally(s, await notify({ ...inp, userId: brokerOwnerId }, { idempotent: true }));
      }
    }
    stats.push(s);
  }

  // AA decisions
  {
    const s: IngestStats = { source: "AA:trade_decision_logs", scanned: 0, created: 0, updated: 0, skipped: 0 };
    const rows = await db.select().from(tradeDecisionLogsTable).orderBy(desc(tradeDecisionLogsTable.createdAt)).limit(lim);
    for (const r of rows) {
      const inp = ruleAADecision({
        decisionId: r.id, symbol: r.symbol ?? undefined,
        shouldTrade: r.shouldTrade ?? false,
        reason: r.invalidationReason ?? r.tradeWindowReason ?? undefined,
        riskScore: r.riskScore ?? undefined,
      });
      await fire(s, inp, `AA:decision:${r.id}:${ts(r.createdAt)}`);
    }
    stats.push(s);
  }

  return { stats, totals: stats.reduce((a, b) => ({
    scanned: a.scanned + b.scanned, created: a.created + b.created,
    updated: a.updated + b.updated, skipped: a.skipped + b.skipped,
  }), { scanned: 0, created: 0, updated: 0, skipped: 0 }) };
}
