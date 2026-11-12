// Calibration refit worker.
//
// Every cycle it rebuilds the graded samples from their sources, fits each
// strategy × symbol × timeframe key (plus pooled keys), appends a new version
// for any key whose evidence changed, and reloads the in-memory cache that
// payloads read from.
//
// Sources (all real, all graded on evidence; nothing is graded on time alone):
//   eleanor_outcomes   live: resolved WIN/LOSS directional eleanor_signal_outcomes
//   scanner_outcomes   live: the same rows that originated in the scanner
//   agent_predictions  live: each agent's own graded predictions (agent trust)
//   strategy_replay    replay: strategies + replayable agents on STORED broker candles
//   historical_replay  replay: the same on every verified committed real-history
//                      fixture (scripts/fixtures/real-history-*), see
//                      historicalBootstrap.ts
// Per fit key the live and replay samples are combined by the precedence rule
// in provenance.ts (live only once live N >= 30) and the fit is persisted with
// its provenance, so every served number says where its N came from.
//
// BOOTSTRAP: on start the worker runs one refit right away (after a short
// delay), so a fresh deploy serves replay-measured fits instead of reading
// "unmeasured" until live outcomes accrue. Idempotent: unchanged evidence
// writes no new version. ARX_CALIBRATION_BOOTSTRAP=0 turns the startup run off.
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
import { POOLED } from "@workspace/domain/calibration";
import { startIntervalWorker } from "../perf/intervalWorker.js";
import { logger } from "../logger.js";
import { persistFit, reloadCalibrationCache } from "./store.js";
import type { EvidenceComponent, TimedSample } from "./provenance.js";
import { buildFitGroups } from "./fitGroups.js";
import { historicalReplayEvidence, replaySeries, type ReplayEvidence, type ReplaySeriesInput } from "./historicalBootstrap.js";
import type { FixtureDiscovery } from "./historicalFixtures.js";
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

export type { TimedSample } from "./provenance.js";

export interface FitGroupResult {
  keys: number;
  written: number;
}

/**
 * Fit one strategy's samples at three levels: exact symbol × timeframe, pooled
 * symbols per timeframe, and pooled all. Within each key the live and replay
 * samples are combined by the precedence rule (provenance.composeEvidence).
 */
export async function fitAndPersistGroups(
  strategy: string,
  samples: TimedSample[],
  opts: { exact?: boolean } = {},
): Promise<FitGroupResult> {
  const groups = buildFitGroups(strategy, samples, opts);
  let written = 0;
  for (const g of groups) {
    const r = await persistFit(g);
    if (r.written) written++;
  }
  return { keys: groups.length, written };
}

const ELEANOR_LIVE: EvidenceComponent = { id: "eleanor_outcomes", kind: "live", source: "eleanor_outcomes" };
const SCANNER_LIVE: EvidenceComponent = { id: "scanner_outcomes", kind: "live", source: "scanner_outcomes" };
const AGENT_LIVE: EvidenceComponent = { id: "agent_predictions", kind: "live", source: "agent_predictions" };

async function eleanorSamples(): Promise<{ all: TimedSample[]; scanner: TimedSample[] }> {
  const rows = await db
    .select({
      symbol: eleanorSignalOutcomesTable.symbol,
      timeframe: eleanorSignalOutcomesTable.timeframe,
      confidenceScore: eleanorSignalOutcomesTable.confidenceScore,
      outcomeStatus: eleanorSignalOutcomesTable.outcomeStatus,
      scannerSignalId: eleanorSignalOutcomesTable.scannerSignalId,
      createdAt: eleanorSignalOutcomesTable.createdAt,
      resolvedAt: eleanorSignalOutcomesTable.resolvedAt,
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
    const s = {
      score: r.confidenceScore,
      outcome: (r.outcomeStatus === "WIN" ? 1 : 0) as 0 | 1,
      at: r.createdAt,
      resolvedAt: r.resolvedAt ?? undefined,
      symbol: r.symbol,
      timeframe: r.timeframe || POOLED,
    };
    all.push({ ...s, component: ELEANOR_LIVE });
    if (r.scannerSignalId) scanner.push({ ...s, component: SCANNER_LIVE });
  }
  return { all, scanner };
}

/** Strategies + replayable agents replayed on stored broker candles. */
async function brokerReplayEvidence(): Promise<ReplayEvidence> {
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
  const inputs: ReplaySeriesInput[] = [];
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
    inputs.push({
      candles,
      symbol: s.symbol,
      timeframe: s.timeframe,
      component: {
        id: `strategy_replay:broker_candles:${s.symbol}:${s.timeframe}`,
        kind: "replay",
        source: "strategy_replay",
        symbol: s.symbol,
        timeframe: s.timeframe,
        ranges: "ohlc",
      },
    });
  }
  return replaySeries(inputs);
}

/** Live graded agent predictions, keyed by agent calibration key. */
async function agentSamples(): Promise<Map<string, TimedSample[]>> {
  const rows = await db
    .select({
      agentKey: agentsTable.agentKey,
      confidenceScore: agentPredictionsTable.confidenceScore,
      outcomeStatus: agentPredictionsTable.outcomeStatus,
      at: agentPredictionsTable.timestampCreated,
      resolvedAt: agentPredictionsTable.outcomeReviewedAt,
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
    const k = agentCalibrationKey(r.agentKey);
    let list = by.get(k);
    if (!list) {
      list = [];
      by.set(k, list);
    }
    list.push({
      score: r.confidenceScore,
      outcome: r.outcomeStatus === "WIN" ? 1 : 0,
      at: r.at,
      resolvedAt: r.resolvedAt ?? undefined,
      symbol: POOLED,
      timeframe: POOLED,
      component: AGENT_LIVE,
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
  /** Real-history fixtures replayed this cycle (id, dataset hash, series). */
  historical: { fixtures: { fixtureId: string; datasetHash: string; pinned: boolean; series: number }[]; skipped: { fixtureId: string; reason: string }[] } | null;
}

export interface RefitOptions {
  /** Replay the committed real-history fixtures (default true). */
  historical?: boolean;
  /** Override fixture discovery (tests). */
  discovery?: FixtureDiscovery;
  /** Read live + broker sources from the DB (default true). */
  dbSources?: boolean;
}

const BOOTSTRAP_DELAY_MS = Number(process.env["ARX_CALIBRATION_BOOTSTRAP_DELAY_MS"] ?? 20_000);

let lastReport: RefitCycleReport | null = null;
let started = false;
let worker: ReturnType<typeof startIntervalWorker> | undefined;
let inFlight: Promise<RefitCycleReport> | null = null;
let bootstrapTimer: ReturnType<typeof setTimeout> | null = null;

export function getCalibrationRefitStatus() {
  return { running: started, intervalMs: INTERVAL_MS, lastCycle: lastReport };
}

function mergeInto(target: Map<string, TimedSample[]>, src: Map<string, TimedSample[]>) {
  for (const [k, list] of src) {
    const t = target.get(k);
    if (t) t.push(...list);
    else target.set(k, [...list]);
  }
}

/** One full refit. Each source fails soft on its own. Concurrent calls share one run. */
export function runCalibrationRefit(opts: RefitOptions = {}): Promise<RefitCycleReport> {
  if (inFlight) return inFlight;
  inFlight = refitOnce(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function refitOnce(opts: RefitOptions): Promise<RefitCycleReport> {
  const t0 = Date.now();
  let keys = 0;
  let written = 0;
  const errors: string[] = [];
  const tally = (r: FitGroupResult) => {
    keys += r.keys;
    written += r.written;
  };
  const useDb = opts.dbSources !== false;
  if (useDb) {
    try {
      const { all, scanner } = await eleanorSamples();
      tally(await fitAndPersistGroups(ELEANOR_CALIBRATION_KEY, all));
      tally(await fitAndPersistGroups(SCANNER_CALIBRATION_KEY, scanner));
    } catch (e) {
      errors.push(`eleanor:${String(e).slice(0, 160)}`);
    }
  }
  const strategies = new Map<string, TimedSample[]>();
  const agents = new Map<string, TimedSample[]>();
  let historical: RefitCycleReport["historical"] = null;
  if (opts.historical !== false) {
    try {
      const h = await historicalReplayEvidence(opts.discovery);
      mergeInto(strategies, h.strategies);
      mergeInto(agents, h.agents);
      historical = {
        fixtures: h.discovery.fixtures.map((f) => ({ fixtureId: f.fixtureId, datasetHash: f.datasetHash, pinned: f.pinned, series: f.series.length })),
        skipped: h.discovery.skipped,
      };
    } catch (e) {
      errors.push(`historical:${String(e).slice(0, 160)}`);
    }
  }
  if (useDb) {
    try {
      const b = await brokerReplayEvidence();
      mergeInto(strategies, b.strategies);
      mergeInto(agents, b.agents);
    } catch (e) {
      errors.push(`replay:${String(e).slice(0, 160)}`);
    }
    try {
      mergeInto(agents, await agentSamples());
    } catch (e) {
      errors.push(`agents:${String(e).slice(0, 160)}`);
    }
  }
  try {
    for (const [strategy, samples] of strategies) tally(await fitAndPersistGroups(strategy, samples));
  } catch (e) {
    errors.push(`strategies:${String(e).slice(0, 160)}`);
  }
  try {
    for (const [agentKey, samples] of agents) tally(await fitAndPersistGroups(agentKey, samples, { exact: false }));
  } catch (e) {
    errors.push(`agent_fits:${String(e).slice(0, 160)}`);
  }
  let cached = 0;
  try {
    cached = await reloadCalibrationCache();
  } catch (e) {
    errors.push(`cache:${String(e).slice(0, 160)}`);
  }
  lastReport = { at: new Date().toISOString(), ms: Date.now() - t0, keys, written, cached, errors, historical };
  if (errors.length) logger.warn({ errors }, "[calibration] refit cycle had source errors");
  return lastReport;
}

/**
 * Startup-safe bootstrap step: one refit (historical replay included) shortly
 * after start. Fail-soft and idempotent. Called only from
 * startCalibrationRefitWorker, which app.ts starts behind isPreviewSafeStart().
 */
export async function runCalibrationBootstrap(opts: RefitOptions = {}): Promise<RefitCycleReport> {
  const r = await runCalibrationRefit(opts);
  logger.info(
    { keys: r.keys, written: r.written, cached: r.cached, ms: r.ms, fixtures: r.historical?.fixtures, skipped: r.historical?.skipped, errors: r.errors },
    "[calibration] bootstrap refit done",
  );
  return r;
}

export function startCalibrationRefitWorker(): void {
  if (started) return;
  started = true;
  // Serve the persisted fits right away, then bootstrap from real history.
  void reloadCalibrationCache().catch((e) =>
    logger.warn({ err: String(e).slice(0, 160) }, "[calibration] initial cache load failed"),
  );
  if (process.env["ARX_CALIBRATION_BOOTSTRAP"] !== "0") {
    bootstrapTimer = setTimeout(() => {
      bootstrapTimer = null;
      void runCalibrationBootstrap().catch((e) =>
        logger.warn({ err: String(e).slice(0, 160) }, "[calibration] bootstrap refit failed"),
      );
    }, BOOTSTRAP_DELAY_MS);
    bootstrapTimer.unref?.();
  }
  const tick = async () => {
    await runCalibrationRefit();
  };
  if (worker) worker.start();
  else worker = startIntervalWorker(tick, INTERVAL_MS, (err) => logger.error({ err }, "[calibration] refit worker failure"));
  logger.info({ intervalMs: INTERVAL_MS, bootstrapDelayMs: BOOTSTRAP_DELAY_MS }, "[calibration] refit worker started");
}

export function stopCalibrationRefitWorker(): void {
  worker?.stop();
  if (bootstrapTimer) clearTimeout(bootstrapTimer);
  bootstrapTimer = null;
  started = false;
}
