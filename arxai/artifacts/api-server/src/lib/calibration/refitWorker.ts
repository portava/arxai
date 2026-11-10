// Calibration refit worker.
//
// Every cycle it rebuilds the graded samples from their sources, fits each
// strategy × symbol × timeframe key (plus pooled keys), appends a new version
// for any key whose evidence changed, and reloads the in-memory cache that
// payloads read from.
//
// Sources (all real, all graded on evidence; nothing is graded on time alone):
//   eleanor_outcomes   resolved WIN/LOSS directional eleanor_signal_outcomes
//   scanner_outcomes   the same rows that originated in the scanner
//   strategy_replay    the strategy engine replayed on STORED broker candles
//   agent_predictions  each agent's own graded predictions (agent trust)
//
// SAFETY: observation only. Reads outcomes and candles, writes calibration
// fits. Never touches an order, the bridge or the live pipeline. Started from
// app.ts behind isPreviewSafeStart(), like the outcome worker that feeds it.
// Market prices in broker_candles are pooled across bridges for the replay
// source: a strategy's hit rate on a public price series is not account data.

import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  db,
  agentPredictionsTable,
  agentsTable,
  brokerCandlesTable,
  eleanorSignalOutcomesTable,
} from "@workspace/db";
import {
  fitCalibration,
  fitKey,
  POOLED,
  type CalibrationSample,
} from "@workspace/domain/calibration";
import { startIntervalWorker } from "../perf/intervalWorker.js";
import { logger } from "../logger.js";
import { persistFit, reloadCalibrationCache } from "./store.js";
import { replayStrategies } from "./strategyReplay.js";
import {
  ELEANOR_CALIBRATION_KEY,
  SCANNER_CALIBRATION_KEY,
  agentCalibrationKey,
} from "./cache.js";
import type { Candle } from "../strategyEngine.js";

const INTERVAL_MS = Number(process.env["ARX_CALIBRATION_REFIT_INTERVAL_MS"] ?? 30 * 60_000);
const OUTCOME_ROW_CAP = 20_000;
const REPLAY_SERIES_CAP = 24;
const REPLAY_BARS = 3_000;

export interface TimedSample extends CalibrationSample {
  at: Date;
  symbol: string;
  timeframe: string;
}

export interface FitGroupResult {
  keys: number;
  written: number;
}

/**
 * Fit one strategy's samples at three levels: exact symbol × timeframe, pooled
 * symbols per timeframe, and pooled all. Samples must be oldest first.
 */
export async function fitAndPersistGroups(
  source: string,
  strategy: string,
  samples: TimedSample[],
  opts: { exact?: boolean } = {},
): Promise<FitGroupResult> {
  const groups = new Map<string, { symbol: string; timeframe: string; rows: TimedSample[] }>();
  const add = (symbol: string, timeframe: string, s: TimedSample) => {
    const k = fitKey(strategy, symbol, timeframe);
    let g = groups.get(k);
    if (!g) {
      g = { symbol, timeframe, rows: [] };
      groups.set(k, g);
    }
    g.rows.push(s);
  };
  for (const s of samples) {
    if (opts.exact !== false) add(s.symbol, s.timeframe, s);
    if (opts.exact !== false) add(POOLED, s.timeframe, s);
    add(POOLED, POOLED, s);
  }
  let written = 0;
  for (const [key, g] of groups) {
    const rows = g.rows.sort((a, b) => a.at.getTime() - b.at.getTime());
    const fit = fitCalibration(rows);
    const r = await persistFit({
      fitKey: key,
      source,
      strategy,
      symbol: g.symbol,
      timeframe: g.timeframe,
      fit,
      dataFrom: rows[0]?.at ?? null,
      dataTo: rows[rows.length - 1]?.at ?? null,
    });
    if (r.written) written++;
  }
  return { keys: groups.size, written };
}

async function eleanorSamples(): Promise<{ all: TimedSample[]; scanner: TimedSample[] }> {
  const rows = await db
    .select({
      symbol: eleanorSignalOutcomesTable.symbol,
      timeframe: eleanorSignalOutcomesTable.timeframe,
      confidenceScore: eleanorSignalOutcomesTable.confidenceScore,
      outcomeStatus: eleanorSignalOutcomesTable.outcomeStatus,
      scannerSignalId: eleanorSignalOutcomesTable.scannerSignalId,
      createdAt: eleanorSignalOutcomesTable.createdAt,
    })
    .from(eleanorSignalOutcomesTable)
    .where(and(
      inArray(eleanorSignalOutcomesTable.outcomeStatus, ["WIN", "LOSS"]),
      inArray(eleanorSignalOutcomesTable.direction, ["BUY", "SELL"]),
    ))
    .orderBy(asc(eleanorSignalOutcomesTable.createdAt))
    .limit(OUTCOME_ROW_CAP);
  const all: TimedSample[] = [];
  const scanner: TimedSample[] = [];
  for (const r of rows) {
    const s: TimedSample = {
      score: r.confidenceScore,
      outcome: r.outcomeStatus === "WIN" ? 1 : 0,
      at: r.createdAt,
      symbol: r.symbol,
      timeframe: r.timeframe || POOLED,
    };
    all.push(s);
    if (r.scannerSignalId) scanner.push(s);
  }
  return { all, scanner };
}

async function replaySamples(): Promise<Map<string, TimedSample[]>> {
  const series = await db
    .select({
      symbol: brokerCandlesTable.symbol,
      timeframe: brokerCandlesTable.timeframe,
      bridgeConnectionId: brokerCandlesTable.bridgeConnectionId,
      bars: sql<number>`count(*)::int`,
    })
    .from(brokerCandlesTable)
    .where(eq(brokerCandlesTable.isClosedBar, true))
    .groupBy(brokerCandlesTable.symbol, brokerCandlesTable.timeframe, brokerCandlesTable.bridgeConnectionId)
    .orderBy(desc(sql`count(*)`))
    .limit(REPLAY_SERIES_CAP * 4);
  // One series (the longest) per symbol × timeframe.
  const picked = new Map<string, (typeof series)[number]>();
  for (const s of series) {
    const k = `${s.symbol}|${s.timeframe}`;
    if (!picked.has(k) && s.bars >= 400) picked.set(k, s);
    if (picked.size >= REPLAY_SERIES_CAP) break;
  }
  const byStrategy = new Map<string, TimedSample[]>();
  for (const s of picked.values()) {
    const bars = await db
      .select({
        openTimeUtc: brokerCandlesTable.openTimeUtc,
        open: brokerCandlesTable.open,
        high: brokerCandlesTable.high,
        low: brokerCandlesTable.low,
        close: brokerCandlesTable.close,
        tickVolume: brokerCandlesTable.tickVolume,
      })
      .from(brokerCandlesTable)
      .where(and(
        eq(brokerCandlesTable.symbol, s.symbol),
        eq(brokerCandlesTable.timeframe, s.timeframe),
        eq(brokerCandlesTable.bridgeConnectionId, s.bridgeConnectionId),
        eq(brokerCandlesTable.isClosedBar, true),
      ))
      .orderBy(desc(brokerCandlesTable.openTimeUtc))
      .limit(REPLAY_BARS);
    const candles: Candle[] = bars.reverse().map((b) => ({
      time: b.openTimeUtc.toISOString(),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.tickVolume ?? 0,
    }));
    for (const r of replayStrategies(candles, s.symbol)) {
      let list = byStrategy.get(r.strategyKey);
      if (!list) {
        list = [];
        byStrategy.set(r.strategyKey, list);
      }
      list.push({
        score: r.score,
        outcome: r.outcome,
        at: new Date(candles[r.barIndex].time),
        symbol: s.symbol,
        timeframe: s.timeframe,
      });
    }
  }
  return byStrategy;
}

async function agentSamples(): Promise<Map<string, TimedSample[]>> {
  const rows = await db
    .select({
      agentKey: agentsTable.agentKey,
      confidenceScore: agentPredictionsTable.confidenceScore,
      outcomeStatus: agentPredictionsTable.outcomeStatus,
      at: agentPredictionsTable.timestampCreated,
    })
    .from(agentPredictionsTable)
    .innerJoin(agentsTable, eq(agentsTable.id, agentPredictionsTable.agentId))
    .where(and(
      inArray(agentPredictionsTable.outcomeStatus, ["WIN", "LOSS"]),
      inArray(agentPredictionsTable.direction, ["BUY", "SELL"]),
      isNotNull(agentsTable.agentKey),
    ))
    .orderBy(asc(agentPredictionsTable.timestampCreated))
    .limit(OUTCOME_ROW_CAP);
  const by = new Map<string, TimedSample[]>();
  for (const r of rows) {
    let list = by.get(r.agentKey);
    if (!list) {
      list = [];
      by.set(r.agentKey, list);
    }
    list.push({
      score: r.confidenceScore,
      outcome: r.outcomeStatus === "WIN" ? 1 : 0,
      at: r.at,
      symbol: POOLED,
      timeframe: POOLED,
    });
  }
  return by;
}

export interface RefitCycleReport {
  at: string;
  ms: number;
  keys: number;
  written: number;
  cached: number;
  errors: string[];
}

let lastReport: RefitCycleReport | null = null;
let started = false;
let worker: ReturnType<typeof startIntervalWorker> | undefined;

export function getCalibrationRefitStatus() {
  return { running: started, intervalMs: INTERVAL_MS, lastCycle: lastReport };
}

/** One full refit. Each source fails soft on its own. */
export async function runCalibrationRefit(): Promise<RefitCycleReport> {
  const t0 = Date.now();
  let keys = 0;
  let written = 0;
  const errors: string[] = [];
  const tally = (r: FitGroupResult) => {
    keys += r.keys;
    written += r.written;
  };
  try {
    const { all, scanner } = await eleanorSamples();
    tally(await fitAndPersistGroups("eleanor_outcomes", ELEANOR_CALIBRATION_KEY, all));
    tally(await fitAndPersistGroups("scanner_outcomes", SCANNER_CALIBRATION_KEY, scanner));
  } catch (e) {
    errors.push(`eleanor:${String(e).slice(0, 160)}`);
  }
  try {
    for (const [strategy, samples] of await replaySamples()) {
      tally(await fitAndPersistGroups("strategy_replay", strategy, samples));
    }
  } catch (e) {
    errors.push(`replay:${String(e).slice(0, 160)}`);
  }
  try {
    for (const [agentKey, samples] of await agentSamples()) {
      tally(await fitAndPersistGroups("agent_predictions", agentCalibrationKey(agentKey), samples, { exact: false }));
    }
  } catch (e) {
    errors.push(`agents:${String(e).slice(0, 160)}`);
  }
  let cached = 0;
  try {
    cached = await reloadCalibrationCache();
  } catch (e) {
    errors.push(`cache:${String(e).slice(0, 160)}`);
  }
  lastReport = { at: new Date().toISOString(), ms: Date.now() - t0, keys, written, cached, errors };
  if (errors.length) logger.warn({ errors }, "[calibration] refit cycle had source errors");
  return lastReport;
}

export function startCalibrationRefitWorker(): void {
  if (started) return;
  started = true;
  // Serve the persisted fits right away; the first refit runs after one interval.
  void reloadCalibrationCache().catch((e) =>
    logger.warn({ err: String(e).slice(0, 160) }, "[calibration] initial cache load failed"),
  );
  const tick = async () => {
    await runCalibrationRefit();
  };
  if (worker) worker.start();
  else worker = startIntervalWorker(tick, INTERVAL_MS, (err) => logger.error({ err }, "[calibration] refit worker failure"));
  logger.info({ intervalMs: INTERVAL_MS }, "[calibration] refit worker started");
}

export function stopCalibrationRefitWorker(): void {
  worker?.stop();
  started = false;
}
