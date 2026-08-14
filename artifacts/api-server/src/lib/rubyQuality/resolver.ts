// Task #199 — Ruby Quality: fail-closed outcome resolver.
//
// SAFETY / SCOPE:
//   - READ-ONLY over trade results. Fetches evidence (a matched closed trade
//     and/or observed REAL candle movement) and asks the proven domain engine
//     for a verdict. NEVER places / modifies / closes anything.
//   - FAIL-CLOSED: when the engine says `resolvable:false` the row is left
//     PENDING/UNRESOLVED. Elapsed time alone NEVER grades. No fabricated data.
//   - Per-user isolation: only the row's own userId trades are considered.
//   - The locked "at signal" snapshot is never rewritten — only execution /
//     outcome facts are appended.

import { and, desc, eq, gte } from "drizzle-orm";
import {
  db,
  rubySignalOutcomesTable,
  rubyQualityThresholdsTable,
  tradesTable,
  type RubySignalOutcomeRow,
} from "@workspace/db";
import {
  resolveSignalOutcome,
  evaluateNoTradeCredit,
  classifyEntryTiming,
  clampThresholds,
  DEFAULT_RUBY_THRESHOLDS,
  type RubyQualityThresholds,
  type SignalOutcomeEvidence,
} from "@workspace/domain/ruby-quality";
import { getMarketData } from "../data/dataManager.js";

export async function loadThresholds(): Promise<RubyQualityThresholds> {
  const rows = await db.select().from(rubyQualityThresholdsTable).limit(1);
  if (!rows[0]) return { ...DEFAULT_RUBY_THRESHOLDS };
  const r = rows[0];
  return clampThresholds({
    lateEntrySeconds: r.lateEntrySeconds,
    minConfidence: r.minConfidence,
    minEdge: r.minEdge,
    newsLockoutMinutes: r.newsLockoutMinutes,
    maxSpread: r.maxSpread,
    maxSlippage: r.maxSlippage,
    minRiskReward: r.minRiskReward,
    strongMovePct: r.strongMovePct,
    breakevenR: r.breakevenR,
    evidenceExpiryMinutes: r.evidenceExpiryMinutes,
  });
}

interface MoveEvidence {
  favorableMovePct: number | null;
  adverseMovePct: number | null;
}

/** Observed favorable/adverse move from REAL candles after the signal. PURE-ish (reads candles). */
async function observeCandleMove(row: RubySignalOutcomeRow): Promise<MoveEvidence> {
  const reference = row.entryPrice;
  const dir = (row.direction ?? "").toUpperCase();
  if (reference == null || (dir !== "BUY" && dir !== "SELL")) {
    return { favorableMovePct: null, adverseMovePct: null };
  }
  let candles;
  try {
    candles = await getMarketData(row.symbol, row.timeframe || "1m", 300);
  } catch {
    return { favorableMovePct: null, adverseMovePct: null };
  }
  const sinceMs = row.createdAt.getTime();
  const after = candles.filter((c) => Date.parse(c.time) >= sinceMs);
  if (after.length === 0) return { favorableMovePct: null, adverseMovePct: null };

  let maxFav = 0;
  let maxAdv = 0;
  for (const c of after) {
    if (dir === "BUY") {
      maxFav = Math.max(maxFav, ((c.high - reference) / reference) * 100);
      maxAdv = Math.max(maxAdv, ((reference - c.low) / reference) * 100);
    } else {
      maxFav = Math.max(maxFav, ((reference - c.low) / reference) * 100);
      maxAdv = Math.max(maxAdv, ((c.high - reference) / reference) * 100);
    }
  }
  return { favorableMovePct: Math.max(0, maxFav), adverseMovePct: Math.max(0, maxAdv) };
}

/** Find a matched CLOSED trade for this signal (per-user). Returns null when none. */
async function findClosedTrade(row: RubySignalOutcomeRow) {
  if (row.tradeId != null) {
    const t = await db.select().from(tradesTable)
      .where(and(eq(tradesTable.id, row.tradeId), eq(tradesTable.userId, row.userId)))
      .limit(1);
    if (t[0] && (t[0].status === "CLOSED_WIN" || t[0].status === "CLOSED_LOSS")) return t[0];
    return null;
  }
  // Best-effort match: same user + symbol + direction, closed after the signal.
  const dir = (row.direction ?? "").toUpperCase();
  if (dir !== "BUY" && dir !== "SELL") return null;
  const matches = await db.select().from(tradesTable)
    .where(and(
      eq(tradesTable.userId, row.userId),
      eq(tradesTable.symbol, row.symbol),
      eq(tradesTable.direction, dir),
      gte(tradesTable.createdAt, row.createdAt),
    ))
    .orderBy(desc(tradesTable.closedAt))
    .limit(1);
  const t = matches[0];
  if (t && (t.status === "CLOSED_WIN" || t.status === "CLOSED_LOSS")) return t;
  return null;
}

/**
 * Derive a price-based R-multiple from a closed trade's OWN stop/target geometry.
 * Honest only when pnlStatus is COMPUTED (trusted close) and SL≠entry. Returns
 * null otherwise so the verdict falls back to observed-move evidence.
 */
function closedTradePnlR(t: {
  status: string; pnlStatus: string | null;
  entryPrice: number; stopLoss: number; takeProfit: number;
}): number | null {
  if (t.pnlStatus != null && t.pnlStatus !== "COMPUTED") return null;
  const risk = Math.abs(t.entryPrice - t.stopLoss);
  if (!(risk > 0)) return null;
  if (t.status === "CLOSED_LOSS") return -1;
  if (t.status === "CLOSED_WIN") {
    const reward = Math.abs(t.takeProfit - t.entryPrice);
    return reward > 0 ? Math.round((reward / risk) * 100) / 100 : null;
  }
  return null;
}

export interface ResolveResult {
  row: RubySignalOutcomeRow;
  changed: boolean;
}

/**
 * Resolve one outcome row from real evidence and append the result. Returns the
 * (possibly updated) row. Leaves PENDING rows untouched when there is no
 * evidence — never grades on time alone.
 */
export async function resolveOutcomeRow(
  row: RubySignalOutcomeRow,
  thresholds?: RubyQualityThresholds,
): Promise<ResolveResult> {
  if (row.outcomeStatus !== "PENDING") return { row, changed: false };
  const th = thresholds ?? (await loadThresholds());

  const closed = await findClosedTrade(row);
  const move = await observeCandleMove(row);

  const evidence: SignalOutcomeEvidence = {
    closedTradeExists: closed != null,
    closedTradePnlR: closed ? closedTradePnlR(closed) : null,
    favorableMovePct: move.favorableMovePct,
    adverseMovePct: move.adverseMovePct,
    ageMs: Date.now() - row.createdAt.getTime(),
    expiryMs: th.evidenceExpiryMinutes * 60_000,
    userEntered: closed != null,
  };

  const verdict = resolveSignalOutcome(
    { decision: row.decision, direction: row.direction },
    evidence,
  );
  if (!verdict.resolvable) return { row, changed: false };

  const noTradeCredit = evaluateNoTradeCredit({
    decision: row.decision,
    outcomeStatus: verdict.status,
  });

  const timingClass = closed
    ? classifyEntryTiming({
        signalAtMs: row.createdAt.getTime(),
        entryAtMs: (closed.createdAt ?? row.createdAt).getTime(),
        lateEntrySeconds: th.lateEntrySeconds,
      })
    : null;

  const now = new Date();
  const updated = await db
    .update(rubySignalOutcomesTable)
    .set({
      outcomeStatus: verdict.status,
      pnlR: verdict.pnlR,
      exitReason: verdict.exitReason,
      userEntered: closed != null,
      tradeId: closed?.id ?? row.tradeId ?? null,
      timingClass,
      noTradeCredited: noTradeCredit.credited,
      maxFavorableExcursion: move.favorableMovePct,
      maxAdverseExcursion: move.adverseMovePct,
      evidence: {
        method: closed ? "closed_trade" : (move.favorableMovePct != null ? "observed_move" : "none"),
        reason: verdict.reason,
        noTradeCredit: noTradeCredit.reason,
        favorableMovePct: move.favorableMovePct,
        adverseMovePct: move.adverseMovePct,
      },
      resolvedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(rubySignalOutcomesTable.id, row.id),
      eq(rubySignalOutcomesTable.outcomeStatus, "PENDING"),
    ))
    .returning();

  if (!updated[0]) return { row, changed: false };
  return { row: updated[0], changed: true };
}

/** Resolve all PENDING rows for a user (fail-closed). Returns count changed. */
export async function resolvePendingForUser(userId: number, limit = 200): Promise<number> {
  const pending = await db.select().from(rubySignalOutcomesTable)
    .where(and(
      eq(rubySignalOutcomesTable.userId, userId),
      eq(rubySignalOutcomesTable.outcomeStatus, "PENDING"),
    ))
    .orderBy(desc(rubySignalOutcomesTable.createdAt))
    .limit(limit);
  const th = await loadThresholds();
  let changed = 0;
  for (const row of pending) {
    const r = await resolveOutcomeRow(row, th);
    if (r.changed) changed++;
  }
  return changed;
}
