// ═══════════════════════════════════════════════════════════════════════════
// Phase 7 — trade-command anomaly + takeover service.
//
// Builds a REAL per-user baseline from `trades` history and composes the PURE
// domain `evaluateTradeCommandAnomaly` / `evaluateTakeoverRisk` engines. Called
// BEFORE an autonomous side effect. Output is advisory-ADDITIVE caution
// (ALLOW / REQUIRE_REVIEW / BLOCK) layered on top of the existing 16-gate /
// Risk Governor path — it never enables a trade and never relaxes a gate.
//
// SAFETY: missing history does NOT manufacture confidence. The baseline carries
// its honest sampleSize so the domain engine only runs ratio checks on a
// trusted baseline (structural + hard-cap checks always apply).
// ═══════════════════════════════════════════════════════════════════════════

import { db, tradesTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import {
  DEFAULT_ANOMALY_POLICY,
  DEFAULT_TAKEOVER_POLICY,
  evaluateTakeoverRisk,
  evaluateTradeCommandAnomaly,
  type AnomalyPolicy,
  type TakeoverPolicy,
  type TakeoverSignals,
  type TakeoverVerdict,
  type TradeCommandAnomalyVerdict,
  type TradeCommandBaseline,
  type TradeCommandObservation,
} from "@workspace/domain/security";
import { logger } from "../logger.js";

const BASELINE_LOOKBACK = 200;

/**
 * Build the actor's trade baseline from REAL `trades` rows (per-user scoped).
 * On any failure returns an empty, UNTRUSTED baseline (sampleSize 0) so the
 * engine skips ratio checks rather than fabricating a profile.
 */
export async function buildTradeBaseline(userId: number): Promise<TradeCommandBaseline> {
  try {
    const rows = await db
      .select({ symbol: tradesTable.symbol, lot: tradesTable.lot })
      .from(tradesTable)
      .where(eq(tradesTable.userId, userId))
      .orderBy(desc(tradesTable.id))
      .limit(BASELINE_LOOKBACK);

    if (rows.length === 0) {
      return { typicalLot: 0, knownSymbols: [], sampleSize: 0 };
    }

    const lots = rows.map((r) => r.lot).filter((l) => Number.isFinite(l) && l > 0).sort((a, b) => a - b);
    const typicalLot = lots.length > 0 ? lots[Math.floor(lots.length / 2)] : 0;
    const knownSymbols = Array.from(new Set(rows.map((r) => r.symbol).filter(Boolean)));

    return { typicalLot, knownSymbols, sampleSize: rows.length };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), userId },
      "trade baseline build failed; using untrusted empty baseline (fail-safe)",
    );
    return { typicalLot: 0, knownSymbols: [], sampleSize: 0 };
  }
}

export interface EvaluateTradeAnomalyInput {
  userId: number;
  observation: TradeCommandObservation;
  policy?: AnomalyPolicy;
}

export async function evaluateTradeAnomalyForUser(
  input: EvaluateTradeAnomalyInput,
): Promise<{ baseline: TradeCommandBaseline; verdict: TradeCommandAnomalyVerdict }> {
  const baseline = await buildTradeBaseline(input.userId);
  const verdict = evaluateTradeCommandAnomaly(input.observation, baseline, input.policy ?? DEFAULT_ANOMALY_POLICY);
  return { baseline, verdict };
}

export function evaluateTakeover(signals: TakeoverSignals, policy: TakeoverPolicy = DEFAULT_TAKEOVER_POLICY): TakeoverVerdict {
  return evaluateTakeoverRisk(signals, policy);
}
