/** Reproduce the 15-bar first-break comparison on verified public candle history.
 * Each series has its own chronological fit. The outcome windows are disjoint
 * within a series, but markets and intervals can overlap in clock time.
 */
import { fileURLToPath } from "node:url";
import { brier, favoredScenario, fitStructuralModel, observeStructure, predictMass, probabilities,
  scenarioIndex, scenarioOf, structuralFeatures, type DataOrigin, type StructuralBar,
  type StructuralModel, type Triple } from "@workspace/domain/structural";
import { loadVerifiedIntradayFixture, TIMEFRAME_SECONDS, type LoadedIntradayInstrument } from "./intradayHistoryFixture.js";

const windowBars = 15;
const warmBars = 120;
const priorWeight = 15;
const hash = "a5f9b3cc7147bdae0e95eb7052397b2e478e018634c01bb13580a35fca9725dc";

function groupOf(read: ReturnType<typeof observeStructure>, close: number) {
  if (read.precursor) return read.precursor.direction === 1 ? "precursor up" : "precursor down";
  if (!read.high || !read.low) return "unclassified";
  const above = Math.abs(read.high.price - close), below = Math.abs(read.low.price - close);
  if (above === below) return "unclassified";
  return above < below ? "near high" : "near low";
}

function* windows(bars: StructuralBar[], start: number, end: number) {
  for (let i = start; i + windowBars <= end; i += windowBars) {
    const sequence = bars.slice(i - warmBars, i + windowBars);
    if (sequence.some((bar, j) => j > 0 && bar.openTime !== sequence[j - 1]!.closeTime)) continue;
    const prefix = sequence.slice(0, warmBars), last = prefix[warmBars - 1]!;
    const features = structuralFeatures(prefix, last.closeTime);
    const group = groupOf(features.structure, last.close);
    const outcome = scenarioOf(observeStructure(sequence).events.find(e => e.time > last.closeTime));
    yield { group, asOf: last.closeTime, features, outcome };
  }
}

function study({ spec, dates, bars }: LoadedIntradayInstrument) {
  const step = TIMEFRAME_SECONDS[spec.timeframe] * 1000;
  const series = bars.map((bar, i) => {
    const openTime = Date.parse(dates[i]!);
    return { ...bar, openTime, closeTime: openTime + step, isFinal: true };
  });
  const cutoff = spec.timeframe === "M5" ? 2700 : 2600;
  const counts = new Map<string, Triple>();
  const overall: Triple = [0, 0, 0];
  for (const sample of windows(series, warmBars, cutoff)) {
    const group = counts.get(sample.group) ?? [0, 0, 0];
    const outcome = scenarioIndex(sample.outcome) as 0 | 1 | 2;
    overall[outcome]++;
    group[outcome]++;
    counts.set(sample.group, group);
  }
  const n = overall.reduce((a, b) => a + b, 0);
  const base = overall.map(x => (x + 1) / (n + 3)) as Triple;
  const training = series.slice(0, cutoff);
  const source: DataOrigin = { symbol: spec.symbol, provider: "deriv_history", kind: "BROKER_HISTORY",
    historicalArrivalTimesKnown: false, fetchedAt: new Date(series.at(-1)!.closeTime).toISOString() };
  let model: StructuralModel | undefined;
  let unavailable: string | undefined;
  try { model = fitStructuralModel(training, source); }
  catch (e) { unavailable = e instanceof Error ? e.message : String(e); }
  const scores = [];
  for (const { group, asOf, features, outcome } of windows(series, cutoff, series.length)) {
    const observed = counts.get(group) ?? [0, 0, 0];
    const total = observed.reduce((a, b) => a + b, 0);
    const weighted: Triple = group === "unclassified" ? base
      : observed.map((x, i) => (x + priorWeight * base[i]!) / (total + priorWeight)) as Triple;
    const y = scenarioIndex(outcome);
    if (model && model.availableAt > asOf) throw new Error("Model unavailable at forecast origin");
    const released = model ? probabilities(predictMass(model, features.values, features.eligible).mass, windowBars) : null;
    scores.push({ asOf, group, outcome, weighted, frequency: base, released, correct: favoredScenario(weighted) === outcome,
      brier: brier(weighted, y), frequencyBrier: brier(base, y), releasedBrier: released ? brier(released, y) : null });
  }
  return { symbol: spec.symbol, timeframe: spec.timeframe, assetClass: spec.assetClass, trainingWindows: n,
    trainedThrough: training.at(-1)!.closeTime, groups: Object.fromEntries(counts), unavailable, scores };
}
const fixture = loadVerifiedIntradayFixture(fileURLToPath(new URL("../../fixtures/real-history-intraday-v1/", import.meta.url)), hash);
process.stdout.write(JSON.stringify({ datasetHash: fixture.manifest.datasetHash, horizon: windowBars,
  evidence: "Historical candles; probability scoring only", series: fixture.instruments.map(study) }) + "\n");
