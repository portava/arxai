// Shadow Mode Persistence Layer
//
// Wraps the existing in-memory shadowMode.ts with DB persistence.
// Every new shadow decision is written to shadow_predictions.
// Outcome updates (WIN/LOSS/EXPIRED) are synced back to DB.
//
// SAFETY: Pure observation. Never places trades. Never touches MT5.
// The existing in-memory store remains the source of truth for the
// running scanner loop — DB is append-only for durability.

import { db } from "@workspace/db";
import { shadowPredictionsTable } from "@workspace/db/schema";
import { eq, desc, and, sql, gte } from "drizzle-orm";
import { logger } from "../logger.js";
import type { ShadowDecision } from "../shadowMode.js";

const log = logger.child({ component: "shadowPersistence" });

// ── Write a new shadow decision to DB ────────────────────────────────────────
export async function persistShadowDecision(
  d: ShadowDecision,
  source: "scanner" | "ruby_chat" = "scanner",
  userId?: number,
): Promise<void> {
  try {
    await db.insert(shadowPredictionsTable).values({
      shadowId:       d.id,
      source,
      userId:         userId ?? null,
      symbol:         d.symbol,
      timeframe:      d.tf,
      strategy:       d.strategy,
      marketCondition: d.marketCondition,
      sessionLabel:   detectSession(),
      action:         d.action,
      entryPrice:     d.entry,
      stopLoss:       d.sl,
      takeProfit:     d.tp,
      confidence:     d.confidence,
      opportunity:    d.opportunity,
      sniperScore:    d.sniper,
      grade:          d.grade,
      reason:         d.reason,
      reasonToAvoid:  d.reasonToAvoid,
      rgApproved:     d.riskGovernor.approved,
      rgLevel:        d.riskGovernor.level,
      rgHardBlocks:   JSON.stringify(d.riskGovernor.hardBlocks),
      predictedAt:    new Date(d.ts),
      expiresAt:      new Date(d.expiresAt),
      status:         d.status,
    }).onConflictDoNothing();
  } catch (e) {
    log.warn({ err: e, shadowId: d.id }, "shadow_persist_write_failed");
  }
}

// ── Update outcome when shadow decision resolves ──────────────────────────────
export async function updateShadowOutcome(d: ShadowDecision): Promise<void> {
  if (
    d.status !== "SHADOW_WIN" &&
    d.status !== "SHADOW_LOSS" &&
    d.status !== "SHADOW_BREAKEVEN" &&
    d.status !== "SHADOW_EXPIRED"
  ) return;

  try {
    await db.update(shadowPredictionsTable)
      .set({
        status:      d.status,
        pnlR:        d.pnlR ?? null,
        resolvedAt:  d.outcomeAt ? new Date(d.outcomeAt) : new Date(),
        updatedAt:   new Date(),
      })
      .where(eq(shadowPredictionsTable.shadowId, d.id));
  } catch (e) {
    log.warn({ err: e, shadowId: d.id }, "shadow_persist_outcome_update_failed");
  }
}

// ── Persist a Ruby chat prediction ────────────────────────────────────────────
// Called when Ruby explicitly predicts direction in a conversation.
export async function persistRubyChatPrediction(opts: {
  userId:      number;
  symbol:      string;
  timeframe:   string;
  action:      "BUY" | "SELL" | "WAIT";
  confidence:  number;
  entryPrice?: number;
  stopLoss?:   number;
  takeProfit?: number;
  reason?:     string;
}): Promise<string> {
  const shadowId = `rch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    await db.insert(shadowPredictionsTable).values({
      shadowId,
      source:      "ruby_chat",
      userId:      opts.userId,
      symbol:      opts.symbol,
      timeframe:   opts.timeframe,
      strategy:    "ruby_chat",
      action:      opts.action,
      entryPrice:  opts.entryPrice ?? null,
      stopLoss:    opts.stopLoss   ?? null,
      takeProfit:  opts.takeProfit ?? null,
      confidence:  opts.confidence,
      opportunity: opts.confidence,
      sniperScore: Math.max(0, opts.confidence - 5),
      grade:       Math.round(opts.confidence / 10),
      reason:      opts.reason ?? null,
      sessionLabel: detectSession(),
      status:      "SHADOW_TRACKING_OUTCOME",
      predictedAt: new Date(),
      expiresAt:   new Date(Date.now() + 4 * 60 * 60_000), // 4 hour window
      rgApproved:  false,
    });
  } catch (e) {
    log.warn({ err: e, symbol: opts.symbol }, "ruby_chat_prediction_persist_failed");
  }
  return shadowId;
}

// ── Query persisted predictions ───────────────────────────────────────────────
export async function getPersistedPredictions(opts: {
  userId?:   number;
  symbol?:   string;
  source?:   "scanner" | "ruby_chat";
  status?:   string;
  limit?:    number;
  daysBack?: number;
}) {
  const limit   = Math.min(opts.limit ?? 100, 500);
  const daysAgo = new Date(Date.now() - (opts.daysBack ?? 7) * 24 * 60 * 60_000);

  const conditions = [gte(shadowPredictionsTable.predictedAt, daysAgo)];
  if (opts.userId) conditions.push(eq(shadowPredictionsTable.userId, opts.userId));
  if (opts.symbol) conditions.push(eq(shadowPredictionsTable.symbol, opts.symbol.toUpperCase()));
  if (opts.source) conditions.push(eq(shadowPredictionsTable.source, opts.source));
  if (opts.status) conditions.push(eq(shadowPredictionsTable.status, opts.status));

  return db.select()
    .from(shadowPredictionsTable)
    .where(and(...conditions))
    .orderBy(desc(shadowPredictionsTable.predictedAt))
    .limit(limit);
}

// ── Confidence calibration from DB history ────────────────────────────────────
export async function getPersistedConfidenceCalibration(daysBack = 30) {
  const daysAgo = new Date(Date.now() - daysBack * 24 * 60 * 60_000);

  const rows = await db.select()
    .from(shadowPredictionsTable)
    .where(and(
      gte(shadowPredictionsTable.predictedAt, daysAgo),
      sql`${shadowPredictionsTable.status} IN ('SHADOW_WIN', 'SHADOW_LOSS')`,
    ));

  if (rows.length < 10) {
    return { label: "NEEDS_MORE_DATA", sample: rows.length, buckets: [] };
  }

  const buckets = [
    { label: "50-60", min: 50, max: 60 },
    { label: "60-70", min: 60, max: 70 },
    { label: "70-80", min: 70, max: 80 },
    { label: "80-90", min: 80, max: 90 },
    { label: "90-100", min: 90, max: 101 },
  ];

  const result = buckets.map((b) => {
    const bucket = rows.filter((r) => r.confidence >= b.min && r.confidence < b.max);
    const wins   = bucket.filter((r) => r.status === "SHADOW_WIN").length;
    const winRate = bucket.length ? (wins / bucket.length) * 100 : 0;
    const avgR    = bucket.length
      ? bucket.reduce((s, r) => s + (r.pnlR ?? 0), 0) / bucket.length
      : 0;
    return {
      bucket:  b.label,
      sample:  bucket.length,
      winRate: Math.round(winRate * 10) / 10,
      avgR:    Math.round(avgR * 100) / 100,
    };
  });

  // Calibration quality
  const highBuckets = result.filter((b) => b.bucket === "80-90" || b.bucket === "90-100");
  const lowBuckets  = result.filter((b) => b.bucket === "50-60" || b.bucket === "60-70");
  const highWR = avg(highBuckets.map((b) => b.winRate));
  const lowWR  = avg(lowBuckets.map((b)  => b.winRate));
  const slope  = highWR - lowWR;

  const label =
    Math.abs(slope) < 5      ? "RANDOM_CONFIDENCE" :
    slope > 15               ? "WELL_CALIBRATED"   :
    highWR > 0 && highWR < 60 ? "OVERCONFIDENT"    : "UNDERCONFIDENT";

  return { label, sample: rows.length, buckets: result };
}

// ── Accuracy summary for a symbol ─────────────────────────────────────────────
export async function getSymbolAccuracy(symbol: string, daysBack = 30) {
  const daysAgo = new Date(Date.now() - daysBack * 24 * 60 * 60_000);

  const rows = await db.select()
    .from(shadowPredictionsTable)
    .where(and(
      eq(shadowPredictionsTable.symbol, symbol.toUpperCase()),
      gte(shadowPredictionsTable.predictedAt, daysAgo),
      sql`${shadowPredictionsTable.status} IN ('SHADOW_WIN', 'SHADOW_LOSS', 'SHADOW_BREAKEVEN')`,
    ));

  if (rows.length === 0) return { symbol, sample: 0, winRate: null, avgR: null };

  const wins   = rows.filter((r) => r.status === "SHADOW_WIN").length;
  const avgR   = rows.reduce((s, r) => s + (r.pnlR ?? 0), 0) / rows.length;
  const avgConf = rows.reduce((s, r) => s + r.confidence, 0) / rows.length;

  return {
    symbol,
    sample:  rows.length,
    winRate: Math.round((wins / rows.length) * 1000) / 10,
    avgR:    Math.round(avgR * 100) / 100,
    avgConfidence: Math.round(avgConf * 10) / 10,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function detectSession(): string {
  const h = new Date().getUTCHours();
  if (h >= 0  && h < 7)  return "asian";
  if (h >= 7  && h < 12) return "london";
  if (h >= 12 && h < 16) return "overlap";
  if (h >= 16 && h < 21) return "newyork";
  return "asian";
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
