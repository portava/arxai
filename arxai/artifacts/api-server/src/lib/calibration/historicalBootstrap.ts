// Historical bootstrap: graded samples from REAL committed price history.
//
// Every verified `scripts/fixtures/real-history-*` series (historicalFixtures)
// is replayed through every replayable strategy (strategyReplay) and every
// replayable agent (agentReplay). Each sample carries its evidence component:
// source historical_replay, the fixture id, its dataset hash, the file and the
// file's sha256. The refit worker merges these with the live sources under the
// precedence rule in provenance.ts and persists the fits.
//
// Deterministic: the same fixture bytes give the same samples, so the result
// is cached per dataset hash for the life of the process and a refit over
// unchanged fixtures writes no new fit version (idempotent).

import { discoverRealHistoryFixtures, type FixtureDiscovery, type RealHistorySeries } from "./historicalFixtures.js";
import { replayStrategies } from "./strategyReplay.js";
import { replayAgents } from "./agentReplay.js";
import { agentCalibrationKey } from "./cache.js";
import type { EvidenceComponent, TimedSample } from "./provenance.js";
import type { Candle } from "../strategyEngine.js";

export interface ReplaySeriesInput {
  candles: Candle[];
  symbol: string;
  timeframe: string;
  component: EvidenceComponent;
}

export interface ReplayEvidence {
  /** strategy calibration key → samples */
  strategies: Map<string, TimedSample[]>;
  /** agent calibration key (agent:<KEY>) → samples */
  agents: Map<string, TimedSample[]>;
}

function push(m: Map<string, TimedSample[]>, k: string, s: TimedSample) {
  let list = m.get(k);
  if (!list) {
    list = [];
    m.set(k, list);
  }
  list.push(s);
}

const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

/** Replay strategies + agents over each series. Yields between series. */
export async function replaySeries(series: readonly ReplaySeriesInput[]): Promise<ReplayEvidence> {
  const out: ReplayEvidence = { strategies: new Map(), agents: new Map() };
  for (const s of series) {
    const base = { symbol: s.symbol, timeframe: s.timeframe, component: s.component };
    for (const r of replayStrategies(s.candles, s.symbol)) {
      push(out.strategies, r.strategyKey, { ...base, score: r.score, outcome: r.outcome, at: r.at!, resolvedAt: r.resolvedAt });
    }
    for (const r of replayAgents(s.candles, s.symbol, s.timeframe)) {
      push(out.agents, agentCalibrationKey(r.agentKey), { ...base, score: r.score, outcome: r.outcome, at: r.at!, resolvedAt: r.resolvedAt });
    }
    await yieldToLoop();
  }
  return out;
}

export function fixtureComponent(s: RealHistorySeries): EvidenceComponent {
  return {
    id: `historical_replay:${s.fixtureId}:${s.datasetHash.slice(0, 12)}:${s.spec.symbol}:${s.timeframe}`,
    kind: "replay",
    source: "historical_replay",
    fixtureId: s.fixtureId,
    datasetHash: s.datasetHash,
    file: s.spec.file,
    sha256: s.spec.sha256,
    symbol: s.spec.symbol,
    timeframe: s.timeframe,
    ranges: s.spec.ohlc === "ohlc" ? "ohlc" : "close_fixings",
  };
}

export interface HistoricalEvidence extends ReplayEvidence {
  discovery: Pick<FixtureDiscovery, "root" | "skipped"> & {
    fixtures: { fixtureId: string; datasetHash: string; pinned: boolean; series: { symbol: string; timeframe: string; bars: number; file: string; sha256: string }[] }[];
  };
}

let cached: { key: string; value: HistoricalEvidence } | null = null;

/** Graded replay samples from every verified real-history fixture. */
export async function historicalReplayEvidence(discovery: FixtureDiscovery = discoverRealHistoryFixtures()): Promise<HistoricalEvidence> {
  const key = discovery.fixtures.map((f) => `${f.fixtureId}:${f.datasetHash}`).join("|");
  if (cached && cached.key === key) return cached.value;
  const inputs: ReplaySeriesInput[] = discovery.fixtures.flatMap((f) =>
    f.series.map((s) => ({ candles: s.candles, symbol: s.spec.symbol, timeframe: s.timeframe, component: fixtureComponent(s) })),
  );
  const ev = await replaySeries(inputs);
  const value: HistoricalEvidence = {
    ...ev,
    discovery: {
      root: discovery.root,
      skipped: discovery.skipped,
      fixtures: discovery.fixtures.map((f) => ({
        fixtureId: f.fixtureId,
        datasetHash: f.datasetHash,
        pinned: f.pinned,
        series: f.series.map((s) => ({ symbol: s.spec.symbol, timeframe: s.timeframe, bars: s.candles.length, file: s.spec.file, sha256: s.spec.sha256 })),
      })),
    },
  };
  cached = { key, value };
  return value;
}

export function clearHistoricalReplayCache(): void {
  cached = null;
}
