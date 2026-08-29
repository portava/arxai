// ── #59 Minimum-Intelligence Baseline — the running comparator worker ────────
//
// WHY THIS EXISTS: the minimum-intelligence baseline (trustworthy data + one
// edge + hard risk + deterministic execution, NO intelligence layers) was
// required by the promotion gate only as a boolean attestation — nothing
// actually RAN it. This worker is the missing control group: per tick it
//
//   1. evaluates the pure baseline engine (minimumIntelligenceBaseline.ts) on
//      the symbols the full stack is actually trading (recent mission trade
//      drafts), over TRUSTED closed candles only (mt5_broker / deriv rows in
//      market_candles — never synthetic, never assistant reconstructions);
//   2. journals each decision — trade or WAIT — as a durable shadow
//      prediction (source "baseline", strategy MIN_INTEL_BASELINE_STRATEGY),
//      idempotent per (symbol, decision bar);
//   3. deterministically resolves its own open predictions against later
//      candles, cost-adjusted (a declared, conservative spread — labelled
//      declared, never presented as measured);
//   4. leaves the COMPARISON to the EXISTING champion-challenger machinery:
//      resolved baseline rows are picked up by championChallengerWorker and
//      paired against the live champion's closed, realised-R decisions in
//      champion_challenger_pairs (compose, don't duplicate — Ruling 4). The
//      pairs where challengerStrategy = MIN_INTEL_BASELINE_STRATEGY are the
//      blueprint's control-group ledger.
//
// SAFETY / HONESTY (inviolable):
//   * EVIDENCE ONLY — NO EXECUTION. Never imports dispatch, adapters, or the
//     command pipeline. A baseline row can never place, modify, or promote
//     anything.
//   * Trustworthy data or nothing: an untrusted source, a short series, or a
//     malformed bar produces a TYPED refusal (logged, not journaled as a
//     decision) — never a synthesized decision.
//   * Unresolved evidence is not judged: an open prediction past its horizon
//     expires with pnlR NULL (honest UNKNOWN), which the pairing engine then
//     skips — it is never scored as a win or a loss.
//   * FAIL SAFE: per-symbol and per-row try/catch; a crash skips that item
//     and the next tick retries from persisted state. Non-overlapping pass.
//   * Opt-out via ARX_MINIMUM_BASELINE_ENABLED (default enabled; disabling is
//     logged loudly — without it the platform has no running control group).

import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import {
  db,
  marketCandlesTable,
  missionTradeDraftsTable,
  shadowPredictionsTable,
} from "@workspace/db";
import { logger } from "../logger.js";
import {
  BASELINE_TRUSTED_CANDLE_SOURCES,
  DEFAULT_BASELINE_CONFIG,
  decideBaseline,
  resolveBaselineOutcome,
  type BaselineCandle,
  type BaselineConfig,
  type BaselineDecisionTrade,
} from "./minimumIntelligenceBaseline.js";

export const BASELINE_COMPARATOR_INTERVAL_MS = 5 * 60 * 1000;
/** The strategy label pairing keys off. Never reuse for anything else. */
export const MIN_INTEL_BASELINE_STRATEGY = "MIN_INTEL_BASELINE";
/** Provenance for shadow_predictions.source — distinct from scanner/ruby. */
export const BASELINE_SHADOW_SOURCE = "baseline";
export const BASELINE_TIMEFRAME = "M15";
const BASELINE_TIMEFRAME_MS = 15 * 60 * 1000;
/** Symbols the full stack touched this recently form the comparison arena. */
const CHAMPION_ARENA_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SYMBOLS_PER_PASS = 10;
/** An open baseline trade unresolved this long expires with pnlR NULL. */
export const BASELINE_RESOLUTION_HORIZON_MS = 48 * 60 * 60 * 1000;
/**
 * DECLARED round-trip spread cost as a fraction of price (2 basis points),
 * charged to every resolved baseline trade. Declared — not measured — and
 * every journaled reason says so. Conservative: real demo-measured costs
 * replacing this must only come from the C7 cost model's measured path.
 */
export const DECLARED_ROUND_TRIP_SPREAD_FRAC = 0.0002;

const DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

/** PURE — is the baseline comparator enabled? Absent env = ENABLED. */
export function baselineComparatorEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return !DISABLE_VALUES.has(raw.trim().toLowerCase());
}

/** PURE — deterministic shadow id: one row per symbol per decision bar. */
export function baselineShadowId(symbol: string, decisionBarMs: number): string {
  return `minb:${symbol}:${BASELINE_TIMEFRAME}:${decisionBarMs}`;
}

/** PURE — config for one decision, spread declared from the entry price. */
export function baselineConfigForPrice(price: number): BaselineConfig {
  return {
    ...DEFAULT_BASELINE_CONFIG,
    spread: price > 0 ? price * DECLARED_ROUND_TRIP_SPREAD_FRAC : 0,
  };
}

type CandleRow = { barTime: Date; open: number; high: number; low: number; close: number };

function toBaselineCandles(rows: readonly CandleRow[]): BaselineCandle[] {
  return rows.map((r) => ({
    openTimeMs: r.barTime.getTime(),
    open: r.open, high: r.high, low: r.low, close: r.close,
  }));
}

/** CLOSED bars only: a bar whose open time + timeframe is still in the future
 *  is forming, and a forming bar is not evidence. */
function closedBarCutoff(nowMs: number): Date {
  return new Date(nowMs - BASELINE_TIMEFRAME_MS);
}

/**
 * Load the most recent closed-bar series for one symbol from ONE trusted
 * source (the source with the freshest bar wins; sources are never mixed in
 * a single series). Honest null when no trusted source has enough bars.
 */
async function loadTrustedSeries(
  symbol: string,
  nowMs: number,
  minBars: number,
): Promise<{ source: string; candles: BaselineCandle[] } | null> {
  let best: { source: string; candles: BaselineCandle[]; newestMs: number } | null = null;
  for (const source of BASELINE_TRUSTED_CANDLE_SOURCES) {
    const rows = await db
      .select({
        barTime: marketCandlesTable.barTime,
        open: marketCandlesTable.open,
        high: marketCandlesTable.high,
        low: marketCandlesTable.low,
        close: marketCandlesTable.close,
      })
      .from(marketCandlesTable)
      .where(
        and(
          eq(marketCandlesTable.symbol, symbol),
          eq(marketCandlesTable.timeframe, BASELINE_TIMEFRAME),
          eq(marketCandlesTable.source, source),
          lte(marketCandlesTable.barTime, closedBarCutoff(nowMs)),
        ),
      )
      .orderBy(desc(marketCandlesTable.barTime))
      .limit(minBars);
    if (rows.length < minBars) continue;
    const ascending = [...rows].reverse();
    const newestMs = ascending[ascending.length - 1]!.barTime.getTime();
    if (!best || newestMs > best.newestMs) {
      best = { source, candles: toBaselineCandles(ascending), newestMs };
    }
  }
  return best ? { source: best.source, candles: best.candles } : null;
}

export interface BaselinePassResult {
  symbolsExamined: number;
  decisionsJournaled: number;
  refusals: number;
  resolved: number;
  expired: number;
  errors: number;
}

/** One full comparator pass. Injectable clock for tests; DB is real. */
export async function runBaselineComparatorPass(
  opts: { nowMs?: number } = {},
): Promise<BaselinePassResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const result: BaselinePassResult = {
    symbolsExamined: 0, decisionsJournaled: 0, refusals: 0,
    resolved: 0, expired: 0, errors: 0,
  };

  // ── 1+2: decide + journal on the champion's arena ─────────────────────────
  const arenaSince = new Date(nowMs - CHAMPION_ARENA_LOOKBACK_MS);
  const draftSymbols = await db
    .selectDistinct({ symbol: missionTradeDraftsTable.symbol })
    .from(missionTradeDraftsTable)
    .where(gte(missionTradeDraftsTable.createdAt, arenaSince))
    .limit(MAX_SYMBOLS_PER_PASS);

  const minBars = DEFAULT_BASELINE_CONFIG.lookback + 1;
  for (const { symbol } of draftSymbols) {
    result.symbolsExamined += 1;
    try {
      const series = await loadTrustedSeries(symbol, nowMs, minBars);
      if (!series) {
        result.refusals += 1;
        logger.debug({ symbol }, "baseline_comparator: no trusted closed-bar series (typed refusal, nothing journaled)");
        continue;
      }
      const decisionBarMs = series.candles[series.candles.length - 1]!.openTimeMs;
      const shadowId = baselineShadowId(symbol, decisionBarMs);
      const existing = await db
        .select({ id: shadowPredictionsTable.id })
        .from(shadowPredictionsTable)
        .where(eq(shadowPredictionsTable.shadowId, shadowId))
        .limit(1);
      if (existing.length > 0) continue; // idempotent: this bar is journaled

      const lastClose = series.candles[series.candles.length - 1]!.close;
      const config = baselineConfigForPrice(lastClose);
      const decision = decideBaseline(series.candles, series.source, config);

      if (decision.kind === "REFUSAL" && decision.reason !== "NO_BREAKOUT") {
        // Data/risk refusals are logged, not journaled: they are statements
        // about the inputs, not decisions about the market.
        result.refusals += 1;
        logger.debug({ symbol, reason: decision.reason, detail: decision.detail }, "baseline_comparator refusal");
        continue;
      }

      const predictedAt = new Date(decisionBarMs + BASELINE_TIMEFRAME_MS);
      if (decision.kind === "REFUSAL") {
        // NO_BREAKOUT — the baseline's honest WAIT, journaled so pairing can
        // score "the control group would not have traded here".
        await db.insert(shadowPredictionsTable).values({
          shadowId,
          source: BASELINE_SHADOW_SOURCE,
          symbol,
          timeframe: BASELINE_TIMEFRAME,
          strategy: MIN_INTEL_BASELINE_STRATEGY,
          action: "WAIT",
          confidence: 0, opportunity: 0, sniperScore: 0, grade: 0,
          reason: `minimum-intelligence baseline WAIT: ${decision.detail}`,
          status: "SHADOW_WAIT",
          predictedAt,
          resolvedAt: predictedAt, // a WAIT is resolved by definition
        });
      } else {
        await db.insert(shadowPredictionsTable).values({
          shadowId,
          source: BASELINE_SHADOW_SOURCE,
          symbol,
          timeframe: BASELINE_TIMEFRAME,
          strategy: MIN_INTEL_BASELINE_STRATEGY,
          action: decision.action,
          entryPrice: decision.entry,
          stopLoss: decision.stop,
          takeProfit: decision.target,
          confidence: 0, opportunity: 0, sniperScore: 0, grade: 0,
          reason:
            `minimum-intelligence baseline: ${decision.reason}; ` +
            `costs DECLARED at ${DECLARED_ROUND_TRIP_SPREAD_FRAC} round-trip (not measured); source=${series.source}`,
          status: "SHADOW_TRACKING_OUTCOME",
          predictedAt,
          expiresAt: new Date(predictedAt.getTime() + BASELINE_RESOLUTION_HORIZON_MS),
        });
      }
      result.decisionsJournaled += 1;
    } catch (err) {
      result.errors += 1;
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), symbol },
        "baseline_comparator decision failed for one symbol (skipped, fail-safe)",
      );
    }
  }

  // ── 3: resolve open baseline predictions deterministically ────────────────
  const openRows = await db
    .select()
    .from(shadowPredictionsTable)
    .where(
      and(
        eq(shadowPredictionsTable.source, BASELINE_SHADOW_SOURCE),
        eq(shadowPredictionsTable.strategy, MIN_INTEL_BASELINE_STRATEGY),
        eq(shadowPredictionsTable.status, "SHADOW_TRACKING_OUTCOME"),
      ),
    )
    .limit(200);

  for (const row of openRows) {
    try {
      if (
        row.entryPrice == null || row.stopLoss == null || row.takeProfit == null ||
        (row.action !== "BUY" && row.action !== "SELL")
      ) {
        continue; // malformed row: leave it; never guess an outcome
      }
      const decisionBarMs = row.predictedAt.getTime() - BASELINE_TIMEFRAME_MS;
      const riskPerUnit = Math.abs(row.entryPrice - row.stopLoss);
      const trade: BaselineDecisionTrade = {
        kind: "TRADE",
        action: row.action,
        entry: row.entryPrice,
        stop: row.stopLoss,
        target: row.takeProfit,
        riskPerUnit,
        decisionBarOpenTimeMs: decisionBarMs,
        reason: row.reason ?? "",
      };
      const later = await db
        .select({
          barTime: marketCandlesTable.barTime,
          open: marketCandlesTable.open,
          high: marketCandlesTable.high,
          low: marketCandlesTable.low,
          close: marketCandlesTable.close,
        })
        .from(marketCandlesTable)
        .where(
          and(
            eq(marketCandlesTable.symbol, row.symbol),
            eq(marketCandlesTable.timeframe, BASELINE_TIMEFRAME),
            inArray(marketCandlesTable.source, [...BASELINE_TRUSTED_CANDLE_SOURCES]),
            gte(marketCandlesTable.barTime, new Date(decisionBarMs + 1)),
            lte(marketCandlesTable.barTime, closedBarCutoff(nowMs)),
          ),
        )
        .orderBy(marketCandlesTable.barTime)
        .limit(400);

      const outcome = resolveBaselineOutcome(
        trade,
        toBaselineCandles(later),
        baselineConfigForPrice(row.entryPrice),
      );

      if (outcome.status === "OPEN") {
        if (nowMs - row.predictedAt.getTime() > BASELINE_RESOLUTION_HORIZON_MS) {
          // Honest expiry: pnlR stays NULL — unresolved evidence is never
          // scored, and the pairing engine skips it.
          await db
            .update(shadowPredictionsTable)
            .set({ status: "SHADOW_EXPIRED", resolvedAt: new Date(nowMs), updatedAt: new Date(nowMs) })
            .where(eq(shadowPredictionsTable.id, row.id));
          result.expired += 1;
        }
        continue;
      }

      const status = outcome.status === "WIN" ? "SHADOW_WIN" : "SHADOW_LOSS";
      await db
        .update(shadowPredictionsTable)
        .set({
          status,
          pnlR: outcome.pnlR,
          resolvedAt: outcome.resolvedAtBarMs ? new Date(outcome.resolvedAtBarMs + BASELINE_TIMEFRAME_MS) : new Date(nowMs),
          slWouldHaveHit: outcome.status !== "WIN",
          tpWouldHaveHit: outcome.status === "WIN",
          updatedAt: new Date(nowMs),
        })
        .where(eq(shadowPredictionsTable.id, row.id));
      result.resolved += 1;
    } catch (err) {
      result.errors += 1;
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), shadowId: row.shadowId },
        "baseline_comparator resolution failed for one row (skipped, fail-safe)",
      );
    }
  }

  return result;
}

// ── Worker (missionDriver idiom) ────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startBaselineComparatorWorker(): void {
  if (timer) return;
  if (!baselineComparatorEnabled(process.env["ARX_MINIMUM_BASELINE_ENABLED"])) {
    logger.warn(
      { flag: "ARX_MINIMUM_BASELINE_ENABLED" },
      "baseline_comparator_DISABLED_by_env — the minimum-intelligence control group will NOT run; the full stack's edge over the baseline becomes unmeasurable",
    );
    return;
  }
  timer = setInterval(() => {
    if (running) return;
    running = true;
    runBaselineComparatorPass()
      .then((r) => {
        if (r.decisionsJournaled > 0 || r.resolved > 0 || r.expired > 0 || r.errors > 0) {
          logger.info({ ...r }, "baseline_comparator_pass");
        }
      })
      .catch((err) =>
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "baseline_comparator_pass_failed (fail-safe; next tick retries)",
        ),
      )
      .finally(() => { running = false; });
  }, BASELINE_COMPARATOR_INTERVAL_MS).unref();
  logger.info({ intervalMs: BASELINE_COMPARATOR_INTERVAL_MS }, "baseline_comparator_worker_started");
}

export function stopBaselineComparatorWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
