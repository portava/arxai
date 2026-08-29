// Capability #35 — as-of reconstruction, IO wrapper.
//
// Fetches the raw rows the pure assembler (asOfCore.ts) needs, each source in
// its own try/catch so one broken table degrades ONLY its section to an
// honest { available: false, reason } — never the whole view, and never a
// synthesized value.
//
// READ-ONLY (inviolable): this module performs SELECTs only. It is a
// debugger/audit surface, not a control surface — nothing here can place,
// modify, or cancel anything, and it writes nothing.

import { desc, lte } from "drizzle-orm";
import {
  db,
  stateTransitionsTable,
  vaultEventsTable,
  learningModelVersionsTable,
  systemHealthChecksTable,
  mt5CommandsTable,
  livePositionsTable,
  recoveryProbationsTable,
  executionPolicyPromotionsTable,
} from "@workspace/db";
import { assembleAsOfView, type AsOfView, type RawAsOfSources, type SourceRows } from "./asOfCore.js";

/** Per-source row window. Bounded so the tool cannot melt the DB; the basis
 *  strings in the assembled view state what was examined. */
export const AS_OF_SOURCE_LIMIT = 2000;

async function fetchRows<Row>(q: () => Promise<Row[]>): Promise<SourceRows<Row>> {
  try {
    return { ok: true, rows: await q() };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Reconstruct the unified system view as-of `asOfMs`. SQL pre-filters to
 * rows known at/before t where the schema allows; the pure core re-filters
 * defensively (no-lookahead is enforced twice).
 */
export async function reconstructSystemAsOf(asOfMs: number): Promise<AsOfView> {
  const asOf = new Date(asOfMs);

  const [stateTransitions, vaultEvents, modelVersions, healthChecks, commands, positions, probations, policyPromotions] =
    await Promise.all([
      fetchRows(() =>
        db.select({
          toState: stateTransitionsTable.toState,
          fromState: stateTransitionsTable.fromState,
          createdAt: stateTransitionsTable.createdAt,
          generatedAtIso: stateTransitionsTable.generatedAtIso,
        }).from(stateTransitionsTable)
          .where(lte(stateTransitionsTable.createdAt, asOf))
          .orderBy(desc(stateTransitionsTable.id)).limit(AS_OF_SOURCE_LIMIT),
      ),
      fetchRows(() =>
        db.select({
          kind: vaultEventsTable.kind,
          summary: vaultEventsTable.summary,
          operationalMode: vaultEventsTable.operationalMode,
          globalState: vaultEventsTable.globalState,
          createdAt: vaultEventsTable.createdAt,
          generatedAtIso: vaultEventsTable.generatedAtIso,
          payload: vaultEventsTable.payload,
        }).from(vaultEventsTable)
          .where(lte(vaultEventsTable.createdAt, asOf))
          .orderBy(desc(vaultEventsTable.id)).limit(AS_OF_SOURCE_LIMIT),
      ),
      fetchRows(() =>
        db.select({
          versionId: learningModelVersionsTable.versionId,
          versionName: learningModelVersionsTable.versionName,
          changeType: learningModelVersionsTable.changeType,
          liveAllowed: learningModelVersionsTable.liveAllowed,
          createdAt: learningModelVersionsTable.createdAt,
        }).from(learningModelVersionsTable)
          .orderBy(desc(learningModelVersionsTable.id)).limit(AS_OF_SOURCE_LIMIT),
      ),
      fetchRows(() =>
        db.select({
          healthCheckId: systemHealthChecksTable.healthCheckId,
          overallStatus: systemHealthChecksTable.overallStatus,
          liveTradingStatus: systemHealthChecksTable.liveTradingStatus,
          mode: systemHealthChecksTable.mode,
          createdAt: systemHealthChecksTable.createdAt,
        }).from(systemHealthChecksTable)
          .where(lte(systemHealthChecksTable.createdAt, asOf))
          .orderBy(desc(systemHealthChecksTable.id)).limit(AS_OF_SOURCE_LIMIT),
      ),
      fetchRows(() =>
        db.select({
          id: mt5CommandsTable.id,
          userId: mt5CommandsTable.userId,
          action: mt5CommandsTable.action,
          symbol: mt5CommandsTable.symbol,
          status: mt5CommandsTable.status,
          createdAt: mt5CommandsTable.createdAt,
          completedAt: mt5CommandsTable.completedAt,
          failedAt: mt5CommandsTable.failedAt,
          expiresAt: mt5CommandsTable.expiresAt,
          updatedAt: mt5CommandsTable.updatedAt,
        }).from(mt5CommandsTable)
          .where(lte(mt5CommandsTable.createdAt, asOf))
          .orderBy(desc(mt5CommandsTable.id)).limit(AS_OF_SOURCE_LIMIT),
      ),
      fetchRows(() =>
        db.select({
          id: livePositionsTable.id,
          userId: livePositionsTable.userId,
          symbol: livePositionsTable.symbol,
          direction: livePositionsTable.direction,
          lotSize: livePositionsTable.lotSize,
          stopLoss: livePositionsTable.stopLoss,
          takeProfit: livePositionsTable.takeProfit,
          status: livePositionsTable.status,
          openedAt: livePositionsTable.openedAt,
          closedAt: livePositionsTable.closedAt,
          lastSyncedAt: livePositionsTable.lastSyncedAt,
        }).from(livePositionsTable)
          .where(lte(livePositionsTable.openedAt, asOf))
          .orderBy(desc(livePositionsTable.id)).limit(AS_OF_SOURCE_LIMIT),
      ),
      fetchRows(() =>
        db.select({
          status: recoveryProbationsTable.status,
          stageOrStatus: recoveryProbationsTable.stage,
          historyJson: recoveryProbationsTable.historyJson,
          createdAt: recoveryProbationsTable.createdAt,
        }).from(recoveryProbationsTable)
          .orderBy(desc(recoveryProbationsTable.id)).limit(50),
      ),
      fetchRows(() =>
        db.select({
          status: executionPolicyPromotionsTable.status,
          stageOrStatus: executionPolicyPromotionsTable.status,
          historyJson: executionPolicyPromotionsTable.historyJson,
          createdAt: executionPolicyPromotionsTable.createdAt,
        }).from(executionPolicyPromotionsTable)
          .orderBy(desc(executionPolicyPromotionsTable.id)).limit(50),
      ),
    ]);

  const raw: RawAsOfSources = {
    stateTransitions,
    vaultEvents,
    modelVersions,
    healthChecks,
    commands,
    positions,
    probations,
    policyPromotions,
  };
  return assembleAsOfView(asOfMs, raw);
}
