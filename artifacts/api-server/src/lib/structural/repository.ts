import { and, desc, eq, inArray } from "drizzle-orm";
import { db, chartDecisionReceiptsTable as receipts, chartDecisionOutcomesTable as outcomes } from "@workspace/db";
import { MODEL_POLICY, type StructuralForecast, type ForecastScore, type StructuralModel } from "@workspace/domain/structural";
import type { ForecastRepository, StoredForecast } from "./service.js";
import { sha256Hex, stableStringify } from "@workspace/features";

const SOURCE = "structural_forecast";
export const structuralRepository: ForecastRepository = {
  async list(userId, symbol) {
    const rows = await db.select().from(receipts).where(and(eq(receipts.userId, userId), eq(receipts.symbol, symbol), eq(receipts.source, SOURCE)))
      .orderBy(desc(receipts.createdAt)).limit(250);
    if (!rows.length) return [];
    const evaluations = await db.select().from(outcomes).where(and(eq(outcomes.userId, userId), eq(outcomes.kind, "STRUCTURAL_EVALUATION"), inArray(outcomes.receiptRef, rows.map(r => r.receiptId))));
    return rows.map(r => {
      const payload = r.intelligenceSnapshot as { forecast: StructuralForecast; issuedAt: number };
      if (payload?.forecast?.executionAuthority !== "NONE") throw new Error("INVALID_STORED_FORECAST");
      const scores = evaluations.filter(e => e.receiptRef === r.receiptId).map(e => e.evidence as ForecastScore);
      return { id: r.receiptId, issuedAt: payload.issuedAt, forecast: payload.forecast,
        scores: scores.filter((s, i) => scores.findIndex(x => x.horizon === s.horizon) === i) };
    });
  },
  async save(userId: number, row: StoredForecast, model: StructuralModel) {
    // Reuse existing append-only receipt storage; no migration. Coefficients,
    // transforms and gate policy are persisted for reproducibility.
    const manifest = { version: model.version, modelId: model.modelId, origin: model.origin,
      trainedThrough: model.trainedThrough, availableAt: model.availableAt, baseline: model.baseline,
      geometry: model.geometry, confirmation: model.confirmation, prebreak: model.prebreak,
      geometryGate: model.geometryGate, confirmationGate: model.confirmationGate, prebreakGate: model.prebreakGate,
      partitions: model.partitions, dataQuality: model.dataQuality, holdout: model.holdout, policy: MODEL_POLICY };
    const inserted = await db.insert(receipts).values({ receiptId: row.id, userId,
      symbol: row.forecast.origin.symbol, timeframe: "M1", source: SOURCE,
      marketSentence: "Structural event forecast; ghost paths are illustrations.",
      chartTruthSnapshot: { origin: row.forecast.origin },
      intelligenceSnapshot: { forecast: row.forecast, issuedAt: row.issuedAt, manifest },
      fingerprint: { kind: SOURCE, snapshotSha256: sha256Hex(stableStringify(row.forecast)) },
      expiresAt: new Date(row.forecast.asOf + 3_600_000),
    }).onConflictDoNothing({ target: receipts.receiptId }).returning();
    if (inserted.length) return row;
    const existing = (await this.list(userId, row.forecast.origin.symbol)).find(r => r.id === row.id);
    if (!existing) throw new Error("FORECAST_PERSISTENCE_FAILED");
    return existing;
  },
  async appendScores(userId, id, scores) {
    // Lock receipt row to serialize idempotent outcomes across workers. The
    // receipt itself is never updated; all evaluations are separate inserts.
    await db.transaction(async tx => {
      const owned = await tx.select({ id: receipts.id }).from(receipts).where(and(eq(receipts.receiptId, id), eq(receipts.userId, userId), eq(receipts.source, SOURCE))).for("update");
      if (!owned.length) throw new Error("FORECAST_NOT_FOUND");
      const old = await tx.select({ evidence: outcomes.evidence }).from(outcomes).where(and(eq(outcomes.receiptRef, id), eq(outcomes.userId, userId), eq(outcomes.kind, "STRUCTURAL_EVALUATION")));
      const missing = scores.filter(s => !old.some(r => (r.evidence as ForecastScore).horizon === s.horizon));
      if (missing.length) await tx.insert(outcomes).values(missing.map(score => ({ receiptRef: id, userId,
        kind: "STRUCTURAL_EVALUATION", outcome: score.outcome, evidence: score })));
    });
  },
};
