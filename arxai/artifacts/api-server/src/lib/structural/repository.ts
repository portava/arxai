import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, chartDecisionReceiptsTable as receipts, chartDecisionOutcomesTable as outcomes } from "@workspace/db";
import { MODEL_POLICY, FORECAST_HORIZONS, DEFAULT_FORECAST_HORIZON, scenarioIndex, type ForecastPaperGrade, type Triple, type HorizonForecast, forecastStepMs, type StructuralForecast, type ForecastScore, type StructuralModel } from "@workspace/domain/structural";
import type { ForecastRepository, StoredForecast } from "./service.js";
import { sha256Hex, stableStringify } from "@workspace/features";

const SOURCE = "structural_forecast";
export const structuralRepository: ForecastRepository = {
  async list(userId, symbol) {
    const rows = await db.select().from(receipts).where(and(eq(receipts.userId, userId), eq(receipts.symbol, symbol), eq(receipts.source, SOURCE)))
      .orderBy(desc(receipts.createdAt)).limit(250);
    if (!rows.length) return [];
    const evaluations = await db.select().from(outcomes).where(and(eq(outcomes.userId, userId), inArray(outcomes.kind, ["STRUCTURAL_EVALUATION", "STRUCTURAL_PAPER_ISSUED", "STRUCTURAL_PAPER_RESULT"]), inArray(outcomes.receiptRef, rows.map(r => r.receiptId))));
    return rows.map(r => {
      const payload = r.intelligenceSnapshot as { forecast: StructuralForecast; issuedAt: number };
      if (payload?.forecast?.executionAuthority !== "NONE") throw new Error("INVALID_STORED_FORECAST");
      const own = evaluations.filter(e => e.receiptRef === r.receiptId);
      const published = own.find(e => e.kind === "STRUCTURAL_PAPER_ISSUED")?.evidence as { at: number } | undefined;
      const paperGrade = own.find(e => e.kind === "STRUCTURAL_PAPER_RESULT")?.evidence as ForecastPaperGrade | undefined;
      const scores = own.filter(e => e.kind === "STRUCTURAL_EVALUATION").map(e => e.evidence as ForecastScore);
      // One score per horizon; where a late grade was appended beside an
      // older ungraded score, the graded one is read.
      const pick = (h: number) => scores.find(x => x.horizon === h && x.grade) ?? scores.find(x => x.horizon === h)!;
      return { id: r.receiptId, issuedAt: payload.issuedAt, forecast: payload.forecast, paperPublishedAt: published?.at, paperGrade,
        scores: [...new Set(scores.map(s => s.horizon))].map(pick) };
    });
  },
  // Read compact graded anchors across the retained history. A page of 250
  // minute-by-minute updates can contain too few independent windows to learn.
  async calibrationHistory(userId, symbol, provider, version, horizon, asOf) {
    const f = sql`${receipts.intelligenceSnapshot} -> 'forecast'`;
    const rows = await db.select({
      id: receipts.receiptId,
      origin: sql<number>`(${f} ->> 'asOf')::double precision`,
      raw: sql<Triple | null>`${f} #> '{calibration,raw}'`,
      horizons: sql<HorizonForecast[]>`${f} -> 'horizons'`,
      score: outcomes.evidence,
    }).from(receipts).innerJoin(outcomes, and(eq(outcomes.receiptRef, receipts.receiptId),
      eq(outcomes.userId, receipts.userId), eq(outcomes.kind, "STRUCTURAL_EVALUATION")))
      .where(and(eq(receipts.userId, userId), eq(receipts.symbol, symbol), eq(receipts.source, SOURCE),
        sql`(${f} ->> 'update') is null`, sql`${f} #>> '{origin,provider}' = ${provider}`,
        sql`${f} ->> 'version' = ${version}`,
        sql`coalesce(${f} ->> 'horizonId', ${DEFAULT_FORECAST_HORIZON}) = ${horizon.id}`,
        sql`(${outcomes.evidence} ->> 'horizon')::int = ${horizon.bars}`,
        sql`(${outcomes.evidence} ->> 'observedThrough')::double precision <= ${asOf}`))
      .orderBy(desc(receipts.createdAt), desc(outcomes.id)).limit(250);
    const seen = new Set<string>();
    return rows.flatMap(row => {
      const score = row.score as ForecastScore;
      const p = row.raw ?? row.horizons?.find(h => h.minutes === horizon.minutes)?.probabilities;
      if (seen.has(row.id) || !p || !Number.isFinite(row.origin) || row.origin >= asOf) return [];
      seen.add(row.id);
      return [{ p, outcome: scenarioIndex(score.outcome), completedAt: score.observedThrough, asOf: row.origin }];
    });
  },
  async save(userId: number, row: StoredForecast, model: StructuralModel) {
    // Reuse existing append-only receipt storage; no migration. Coefficients,
    // transforms and gate policy are persisted for reproducibility.
    const manifest = { version: model.version, modelId: model.modelId, origin: model.origin,
      trainedThrough: model.trainedThrough, availableAt: model.availableAt, baseline: model.baseline,
      geometry: model.geometry, confirmation: model.confirmation, prebreak: model.prebreak,
      geometryGate: model.geometryGate, confirmationGate: model.confirmationGate, prebreakGate: model.prebreakGate,
      partitions: model.partitions, dataQuality: model.dataQuality, holdout: model.holdout, rangeEngine: model.rangeEngine ?? null, policy: MODEL_POLICY };
    const saved = await db.transaction(async tx => {
      const inserted = await tx.insert(receipts).values({ receiptId: row.id, userId,
        symbol: row.forecast.origin.symbol, timeframe: FORECAST_HORIZONS.find(h => h.stepMs === forecastStepMs(row.forecast))?.timeframe ?? "M1", source: SOURCE,
        marketSentence: "Structural event forecast; ghost paths are illustrations.",
        chartTruthSnapshot: { origin: row.forecast.origin },
        intelligenceSnapshot: { forecast: row.forecast, issuedAt: row.issuedAt, manifest },
        fingerprint: { kind: SOURCE, snapshotSha256: sha256Hex(stableStringify(row.forecast)) },
        expiresAt: new Date(row.forecast.asOf + 60 * forecastStepMs(row.forecast)),
      }).onConflictDoNothing({ target: receipts.receiptId }).returning();
      if (!inserted.length) return null;
      if (row.forecast.origin.provider === "deriv_public" && /^V(10|25|50|75|100)(_1S)?$/.test(row.forecast.origin.symbol) && row.forecast.paperInstruction && row.forecast.paperInstruction.action !== "HOLD") {
        const at = Date.now();
        await tx.insert(outcomes).values({receiptRef:row.id,userId,kind:"STRUCTURAL_PAPER_ISSUED", evidence:{at}});
        return { ...row, paperPublishedAt: at };
      }
      return row;
    });
    if (saved) return saved;
    const existing = (await this.list(userId, row.forecast.origin.symbol)).find(r => r.id === row.id);
    if (!existing) throw new Error("FORECAST_PERSISTENCE_FAILED");
    return existing;
  },
  async savePaperGrade(userId, id, grade) {
    await db.transaction(async tx => {
      const own = await tx.select({id:receipts.id}).from(receipts).where(and(eq(receipts.userId,userId),eq(receipts.receiptId,id),eq(receipts.source,SOURCE))).for("update");
      if (!own.length) throw new Error("FORECAST_NOT_FOUND");
      const old = await tx.select({id:outcomes.id}).from(outcomes).where(and(eq(outcomes.userId,userId),eq(outcomes.receiptRef,id),eq(outcomes.kind,"STRUCTURAL_PAPER_RESULT"))).limit(1);
      if (!old.length) await tx.insert(outcomes).values({userId,receiptRef:id,kind:"STRUCTURAL_PAPER_RESULT",outcome:grade.state,evidence:grade});
    });
  },
  async appendScores(userId, id, scores) {
    // Lock receipt row to serialize idempotent outcomes across workers. The
    // receipt itself is never updated; all evaluations are separate inserts.
    await db.transaction(async tx => {
      const owned = await tx.select({ id: receipts.id }).from(receipts).where(and(eq(receipts.receiptId, id), eq(receipts.userId, userId), eq(receipts.source, SOURCE))).for("update");
      if (!owned.length) throw new Error("FORECAST_NOT_FOUND");
      const old = await tx.select({ evidence: outcomes.evidence }).from(outcomes).where(and(eq(outcomes.receiptRef, id), eq(outcomes.userId, userId), eq(outcomes.kind, "STRUCTURAL_EVALUATION")));
      // New horizons, plus a late grade for a horizon whose rows all lack one.
      const missing = scores.filter(s => {
        const same = old.map(r => r.evidence as ForecastScore).filter(r => r.horizon === s.horizon);
        return !same.length || (s.lateGrade === true && !!s.grade && !same.some(r => r.grade));
      });
      if (missing.length) await tx.insert(outcomes).values(missing.map(score => ({ receiptRef: id, userId,
        kind: "STRUCTURAL_EVALUATION", outcome: score.outcome, evidence: score })));
    });
  },
};
