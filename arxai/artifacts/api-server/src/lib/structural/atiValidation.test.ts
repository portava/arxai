import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATI_SPECIALIST_VERSION, brier, specialistPool, specialistFeatures, evaluateForecast, hazardsToMass, observeStructure, readAtiEarlyBreak,
  type StructuralBar, type StructuralForecast, type Trajectory,
} from "@workspace/domain/structural";
import { reportAtiSpecialists } from "./atiSpecialistReport.js";
import { reportAtiStructuralValidation } from "./atiValidationReport.js";
import { StructuralForecastService, type ForecastRepository, type StoredForecast } from "./service.js";

const step = 60_000, windowBars = 15;
const candle = (openTime: number, close = 100): StructuralBar => ({
  openTime, closeTime: openTime + step, open: close, high: close + .2, low: close - .2, close, isFinal: true,
});
const mass = hazardsToMass(Array.from({ length: 60 }, () => [.01, .005, .012, .003, .97]));

function receipt(asOf = Date.UTC(2026, 1, 1), id = "a"): StoredForecast {
  const history = Array.from({ length: 120 }, (_, i) => candle(asOf - (120 - i) * step));
  history[115]!.high = 101;
  history[119] = candle(asOf - step, 101.5);
  const trajectories: Trajectory[] = (["BULL", "MIDDLE", "BEAR"] as const).map((kind, i) => ({
    kind, percentile: ([75, 50, 25] as const)[i]!, label: "ANALOG_PERCENTILE_PATH",
    candles: Array.from({ length: windowBars }, (_, j) => candle(asOf + j * step, [102, 101.5, 100.5][i]!)),
    endChange: 0, share: .3, analogs: 20, sourceEnd: asOf - step,
  }));
  const forecast: StructuralForecast = {
    asOf, origin: { provider: "deriv_public", symbol: "V75", kind: "BROKER_HISTORY", historicalArrivalTimesKnown: false,
      fetchedAt: new Date(asOf).toISOString() },
    version: "forecast-fixture", modelId: "fixture", featureVersion: "features-1", eventDefinitionVersion: "events-1",
    trainedThrough: asOf - step, features: [], preBreakEligible: false, mode: "POST_PRECURSOR", gateReason: "fixture",
    validation: "NOT_YET_VALIDATED", mass, baselineMass: mass,
    horizons: [{ minutes: windowBars, bars: windowBars, probabilities: [.6, .25, .15] }], paths: [],
    history, trajectories, executionAuthority: "NONE", stepMs: step, horizonBars: windowBars, horizonId: "15m",
    atiEarlyBreak: readAtiEarlyBreak(observeStructure(history), asOf, step),
  };
  return { id, issuedAt: asOf + 1_000, recordedAt: asOf + 2_000, forecast, scores: [] };
}

function future(row: StoredForecast, closes: number[]) {
  return Array.from({ length: windowBars }, (_, i) => candle(row.forecast.asOf + i * step, closes[i] ?? 101.5));
}

function score(row: StoredForecast, bars: StructuralBar[], now = row.forecast.asOf + windowBars * step) {
  return evaluateForecast(row.forecast, bars, now, row.recordedAt).find((r) => r.horizon === windowBars);
}

test("early break completion counts causal checkpoints and resolves only the same next-close candidate", () => {
  const row = receipt(), f = row.forecast;
  const before = f.history.slice(0, -1);
  assert.deepEqual(readAtiEarlyBreak(observeStructure(before), f.asOf - step, step), {
    stage: "OBSERVE", checkpoints: { met: 1, total: 3 }, pivotKnownAt: f.asOf - 2 * step,
  });
  assert.deepEqual(f.atiEarlyBreak, {
    stage: "PREPARE", checkpoints: { met: 2, total: 3 }, cause: "BOS_UP", pivot: 101,
    pivotKnownAt: f.asOf - 2 * step, signalAt: f.asOf, confirmsAt: f.asOf + step,
  });
  const confirmed = future(row, [101.3]);
  const prefix = [...f.history, confirmed[0]!];
  assert.equal(readAtiEarlyBreak(observeStructure(prefix), f.asOf + step, step).stage, "CONFIRMED");
  assert.equal(score(row, confirmed)?.atiValidation?.pattern, "CONFIRMED");
  assert.equal(score(row, future(row, [100.6, 103, 103]))?.atiValidation?.pattern, "INVALIDATED");
  assert.throws(() => score(row, confirmed.slice(1)), /OUTCOME_HISTORY_GAP/);
  assert.equal(score(row, confirmed, f.asOf + (windowBars - 1) * step), undefined);
  assert.equal(score({ ...row, recordedAt: f.asOf + step }, confirmed)?.atiValidation, undefined);
  const mislabeled = structuredClone(row);
  const phase = mislabeled.forecast.atiEarlyBreak;
  assert.equal(phase?.stage, "PREPARE");
  phase.confirmsAt += step;
  assert.equal(score(mislabeled, confirmed)?.atiValidation, undefined);
});

test("Ghost grading separates structural probability from close paths, including boundary order and unavailable paths", () => {
  const row = receipt(), start = row.forecast.asOf;
  const bars = future(row, [101.3, 102, 100.2]);
  bars[0]!.high = 103;
  bars[0]!.low = 100;
  const settled = score(row, bars)!;
  assert.equal(settled.outcome, "UP_FIRST");
  const g = settled.atiValidation!.ghost!;
  assert.deepEqual([g.lower, g.upper, g.firstBoundary, g.firstBoundaryAt], [100.5, 102, "UPPER", start + 2 * step]);
  assert.equal(g.terminalInside, true);
  assert.equal(g.inBandCloses, windowBars - 1);
  assert.equal(score(row, future(row, [100.5, 102]))?.atiValidation?.ghost?.firstBoundary, "LOWER");
  assert.equal(score(row, future(row, []))?.atiValidation?.ghost?.firstBoundary, "NEITHER");
  const invalid = structuredClone(row);
  invalid.forecast.trajectories![0]!.sourceEnd = start + 1;
  assert.equal(score(invalid, bars)?.atiValidation?.ghost, null);
  invalid.forecast.origin.provider = "mt5_broker";
  assert.equal(score(invalid, bars)?.atiValidation, undefined);
});

test("a restart grades only the authorized public symbol and keeps the saved snapshot unchanged", async () => {
  const row = receipt(), asOf = row.forecast.asOf;
  const f = structuredClone(row.forecast);
  let provider = "deriv", symbol = "V75", verified = true;
  const repository: ForecastRepository = {
    async list(owner) { return owner === 17 ? [structuredClone(row)] : []; },
    async save() { throw new Error("not issuing"); },
    async appendScores(owner, id, scores) {
      assert.equal(owner, 17);
      assert.equal(id, row.id);
      row.scores.push(...structuredClone(scores));
    },
  };
  const service = () => new StructuralForecastService({
    now: () => asOf + 60 * step, repository,
    async readFeed(requested, horizon, requiredProvider) {
      assert.deepEqual([requested, horizon?.id, requiredProvider], ["V75", "15m", "deriv_public"]);
      return { bars: future(row, [101.3, 102]), origin: { ...f.origin, provider, symbol },
        ready: false, reason: "LIVE_CHART_UNAVAILABLE", atiHistoricalSourceVerified: verified };
    },
  });
  assert.deepEqual(await service().history(18, "V75"), []);
  await service().history(17, "V75");
  assert.equal(row.scores.length, 0);
  provider = "deriv_public";
  symbol = "V75_1S";
  await service().history(17, "V75");
  assert.equal(row.scores.length, 0);
  symbol = "V75";
  verified = false;
  await service().history(17, "V75");
  assert.equal(row.scores.length, 0);
  verified = true;
  const first = await service().history(17, "V75");
  assert.equal(first[0]!.scores.find((s) => s.horizon === windowBars)?.atiValidation?.pattern, "CONFIRMED");
  assert.deepEqual(first[0]!.forecast, f);
  assert.deepEqual(reportAtiStructuralValidation(first), reportAtiStructuralValidation(await service().history(17, "V75")));
});

test("report selects windows before outcomes and shows legacy, gaps, and probability scope", () => {
  const first = receipt(), asOf = first.forecast.asOf;
  const overlap = receipt(asOf + step, "overlap"), settled = receipt(asOf + windowBars * step, "next");
  overlap.scores = [score(overlap, future(overlap, [102]))!];
  settled.scores = [score(settled, future(settled, [100.4]))!];
  const legacy = receipt(asOf, "old"), privateReceipt = receipt(asOf, "private");
  delete legacy.forecast.atiEarlyBreak;
  privateReceipt.forecast.origin.provider = "mt5_broker";
  const late = { ...receipt(asOf, "late"), recordedAt: asOf + step };
  const report = reportAtiStructuralValidation([overlap, legacy, settled, late, first, privateReceipt]);
  assert.deepEqual([report.unsupportedSource, report.legacy, report.invalidIssuance], [1, 1, 1]);
  const g = report.cohorts[0]!;
  assert.deepEqual([g.independentWindows, g.overlappingOrUpdates, g.scoredWindows, g.unresolvedWindows], [2, 1, 1, 1]);
  assert.deepEqual(g.earlyBreak, { prepared: 2, confirmed: 0, invalidated: 1 });
  assert.equal(g.firstStructuralBreak.scored, 1);
  assert.equal(g.ghostClosePaths.lowerBeforeUpper, 1);
  assert.equal(g.ghostClosePaths.pathProbability, null);
});

function specialistRow(asOf: number, id: string) {
  const row = receipt(asOf, id), f = row.forecast;
  f.atiSpecialists = { version: ATI_SPECIALIST_VERSION, target: "FIRST_STRUCTURAL_BREAK_15_M1",
    asOf, provider: f.origin.provider, symbol: f.origin.symbol, modelId: f.modelId,
    trainedThrough: f.trainedThrough - step, trainedWindows: 80, trend: "UP", frequency: [.2, .2, .6],
    probabilities: { STRUCTURE: [.95, .03, .02], MOMENTUM: [.4, .3, .3],
      LIQUIDITY: [.05, .05, .9], PATTERN: [.4, .3, .3] } };
  row.scores = [score(row, future(row, [101.3]))!];
  return row;
}

test("specialist ablation is paired on the observed label and reconstructs from the saved receipt", () => {
  const row = specialistRow(Date.UTC(2026, 1, 1), "a"), s = row.forecast.atiSpecialists!;
  const result = reportAtiSpecialists([row]);
  assert.deepEqual(reportAtiSpecialists(JSON.parse(JSON.stringify([row]))), result);
  const group = result.cohorts[0]!, paired = group.paired;
  assert.equal(paired.windows, 1);
  assert.equal(paired.poolBrier, brier(specialistPool(s), 0));
  assert.equal(paired.incumbentBrier, row.scores[0]!.shownBrier);
  assert.ok(paired.specialists.find(x => x.id === "STRUCTURE")!.gainFromIncluding! > 0);
  assert.ok(paired.specialists.find(x => x.id === "LIQUIDITY")!.gainFromIncluding! < 0);
  assert.equal(group.poolReliability.reduce((n, bin) => n + bin.n, 0), 1);
  assert.deepEqual(group.byTrend.map(g => g.windows), [1, 0, 0]);
  assert.deepEqual(Object.values(specialistFeatures).flat().sort((a, b) => a - b), Array.from({length:18}, (_, i) => i));
});

test("specialist anchors reserve unresolved and missing windows before inspecting scores", () => {
  const start = Date.UTC(2026, 1, 1);
  const legacy = receipt(start, "legacy"), overlap = specialistRow(start + step, "overlap");
  const pending = specialistRow(start + windowBars * step, "pending");
  pending.scores = [];
  const late = specialistRow(start + 2 * windowBars * step, "late");
  late.recordedAt = late.forecast.asOf + step;
  const clean = specialistRow(start + 3 * windowBars * step, "clean");
  const report = reportAtiSpecialists([clean, pending, overlap, late, legacy]).cohorts[0]!;
  assert.deepEqual([report.anchors, report.overlappingOrUpdates, report.missingSpecialists,
    report.unresolved, report.invalidEvidence, report.paired.windows], [4, 1, 1, 1, 1, 1]);
  for (const corrupt of [
    (r: StoredForecast) => { r.forecast.atiSpecialists!.trainedThrough = start; },
    (r: StoredForecast) => { r.forecast.atiSpecialists!.symbol = "V50"; },
    (r: StoredForecast) => { r.forecast.atiSpecialists!.modelId = "different"; },
    (r: StoredForecast) => { r.forecast.atiSpecialists!.probabilities.PATTERN = [.3,.3,.3]; },
    (r: StoredForecast) => { r.scores[0]!.observedThrough++; },
    (r: StoredForecast) => { delete r.scores[0]!.atiValidation; },
  ]) {
    const row = specialistRow(start, "x");
    corrupt(row);
    const group = reportAtiSpecialists([row]).cohorts[0]!;
    assert.equal(group.invalidEvidence, 1);
    assert.equal(group.paired.gainOverIncumbent, null);
  }
  const wrong = specialistRow(start, "private");
  wrong.forecast.origin.provider = "mt5_broker";
  assert.equal(reportAtiSpecialists([wrong]).outsideScope, 1);
});

test("specialist simulation prices only the first eligible quote on a verified tape and charges both sides", async () => {
  const { readSpecialistTape, specialistPaperPoints } = await import("./atiSpecialistTape.js");
  const start = Date.UTC(2026, 1, 1), streamId = "923bce97-b1fd-4ddd-98e2-0072c524d726";
  const frames = Array.from({ length: 451 }, (_, i) => ({ epoch: start / 1000 + 2 * i,
    bid: 100 + i, ask: 101 + i, releasedAt: start + 2_000 * i + 5, receivedAt: start + 2_000 * i + 3,
    streamId, symbol: "R_75" }));
  const anchor = { ...frames[0]!, version: "fixed-horizon-bid-ask-v1" as const };
  const read = (tape: typeof frames, symbol = "R_75") => readSpecialistTape(anchor, symbol, tape,
    start + 100, start + 2200, start + 900_000);
  const reading = read(frames);
  assert.ok("prices" in reading);
  const p = reading.prices;
  assert.equal(p.entryEpoch, frames[2]!.epoch);
  assert.equal(p.exitEpoch, frames[450]!.epoch);
  assert.deepEqual(specialistPaperPoints([.7,.2,.1], p), { side:"LONG", spreadAdjusted:447, assumedNet:445 });
  assert.deepEqual(specialistPaperPoints([.2,.7,.1], p), { side:"SHORT", spreadAdjusted:-449, assumedNet:-451 });
  assert.deepEqual(specialistPaperPoints([.4,.4,.2], p), { side:"FLAT", spreadAdjusted:0, assumedNet:0 });
  assert.deepEqual(read(structuredClone(frames)), reading);
  assert.deepEqual(read(frames.filter((_, i) => i !== 17)), { reason: "TAPE_DISCONTINUITY" });
  assert.deepEqual(read(frames.slice(0, -1)), { reason: "INCOMPLETE_TAPE" });
  assert.deepEqual(read(frames, "R_50"), { reason: "ANCHOR_UNVERIFIED" });
  for (const patch of [{ streamId:"other" }, { releasedAt:start }, { epoch:frames[3]!.epoch }]) {
    const corrupted = structuredClone(frames);
    Object.assign(corrupted[2]!, patch);
    assert.deepEqual(read(corrupted), { reason:"TAPE_DISCONTINUITY" });
  }
  const missing = structuredClone(frames);
  missing[10]!.ask = NaN;
  assert.deepEqual(read(missing), { reason:"BID_ASK_UNAVAILABLE" });
});

test("cost report reserves unpriced windows, keeps empty denominators null and counts actual side changes", async () => {
  process.env.DATABASE_URL ??= "postgresql://localhost:1/offline";
  const { reportAtiSpecialistCosts } = await import("./atiSpecialistCosts.js");
  const start = Date.UTC(2026, 1, 1), streamId = "923bce97-b1fd-4ddd-98e2-0072c524d726";
  const priced = specialistRow(start, "priced"), missing = specialistRow(start + windowBars * step, "missing");
  const p = priced.forecast.atiSpecialists!;
  p.probabilities = { STRUCTURE:[0,0,1], MOMENTUM:[0,0,1], LIQUIDITY:[1,0,0], PATTERN:[0,0,1] };
  p.quoteStudy = { version:"fixed-horizon-bid-ask-v1", symbol:"R_75", streamId, epoch:start / 1000, bid:100, ask:101 };
  const frames = Array.from({ length:451 }, (_, i) => ({ streamId, symbol:"R_75", epoch:start / 1000 + i * 2,
    receivedAt:start + 2_000 * i + 10, releasedAt:start + 2_000 * i + 15, bid:100 + i, ask:101 + i }));
  let loads = 0;
  const report = await reportAtiSpecialistCosts([priced, missing], async (key, until) => {
    assert.deepEqual(key, { streamId, symbol:"R_75", epoch:start / 1000 });
    assert.equal(until, start + 905_000);
    loads++;
    return frames;
  });
  assert.equal(loads, 1);
  const c = report.cohorts[0]!;
  assert.deepEqual([c.scoredWindows, c.pricedWindows, c.pool.active, c.incumbent.active, c.incumbent.changedSide], [2,1,0,1,1]);
  assert.ok(c.incumbent.poolGainPoints! < 0);
  assert.deepEqual(c.gaps, [{ receiptId:"missing", reason:"NO_ISSUANCE_QUOTE" }]);
  assert.equal(c.byTrend.find(t => t.trend === "DOWN")!.pool.meanAssumedNetPoints, null);
  assert.equal(report.costBasis.observedBrokerCharges, null);
  const failed = await reportAtiSpecialistCosts([priced], async () => frames.slice(0, -1));
  assert.equal(failed.cohorts[0]!.pool.meanAssumedNetPoints, null);
});

test("archived forward V75 receipts reproduce both their scores and their missing execution evidence offline", async () => {
  process.env.DATABASE_URL ??= "postgresql://localhost:1/offline";
  const { reportAtiSpecialistCosts } = await import("./atiSpecialistCosts.js");
  const { readFile } = await import("node:fs/promises");
  const { gunzipSync } = await import("node:zlib");
  const { createHash } = await import("node:crypto");
  const directory = new URL("../../../../../docs/structural-evidence/ati-specialists-v1/", import.meta.url);
  const summary = JSON.parse(await readFile(new URL("forward-smoke-summary.json", directory), "utf8")) as {
    payloadSha256: string; checks: { id:string; poolBrier:number; incumbentBrier:number; frequencyBrier:number; priced:number; unavailable:string[] }[];
  };
  const raw = gunzipSync(await readFile(new URL("forward-smoke.json.gz", directory)));
  assert.equal(createHash("sha256").update(raw).digest("hex"), summary.payloadSha256);
  const samples: {row:StoredForecast; frames:import("../data/atiDerivQuotes.js").AtiDerivQuoteFrame[]}[] = JSON.parse(raw.toString());
  assert.equal(samples.length, 2);
  for (const {row, frames} of samples) {
    const expected = summary.checks.find(s => s.id === row.id)!;
    const paired = reportAtiSpecialists([row]).cohorts[0]!.paired;
    assert.deepEqual([paired.windows, paired.poolBrier, paired.incumbentBrier, paired.frequencyBrier],
      [1, expected.poolBrier, expected.incumbentBrier, expected.frequencyBrier]);
    const costs = (await reportAtiSpecialistCosts([row], async () => frames)).cohorts[0]!;
    assert.equal(costs.pricedWindows, expected.priced);
    assert.deepEqual(costs.gaps.map(g => g.reason), expected.unavailable);
    assert.equal(costs.incumbent.poolGainPoints, null);
  }
});
