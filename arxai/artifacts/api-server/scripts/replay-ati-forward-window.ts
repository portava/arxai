// Re-evaluate a saved issuance using only quotes from its original stream.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { AtiDerivQuoteFrame } from "../src/lib/data/atiDerivQuotes.js";
import { reportAtiSpecialistCosts } from "../src/lib/structural/atiSpecialistCosts.js";
import { reportAtiSpecialists, selectAtiSpecialists } from "../src/lib/structural/atiSpecialistReport.js";
import { specialistPaperPoints } from "../src/lib/structural/atiSpecialistTape.js";
import type { StoredForecast } from "../src/lib/structural/service.js";

const archive = process.argv[2];
assert.ok(archive, "Pass a compressed forward-window archive");
const raw = gunzipSync(readFileSync(archive));
const pack = JSON.parse(raw.toString("utf8")) as {
  planHash: string;
  engineHash: string;
  receiptId: string;
  asOf: number;
  row: StoredForecast;
  frames: AtiDerivQuoteFrame[];
};
assert.match(pack.planHash, /^[a-f0-9]{64}$/);
assert.match(pack.engineHash, /^[a-f0-9]{64}$/);
assert.equal(pack.row.id, pack.receiptId);
assert.ok(Number.isFinite(pack.row.recordedAt));
assert.equal(pack.row.forecast.asOf, pack.asOf);
assert.equal(pack.row.forecast.origin.provider, "deriv_public");
assert.equal(pack.row.forecast.origin.symbol, "V75");

const model = pack.row.forecast.atiSpecialists;
assert.ok(model);
assert.ok(model.quoteStudy || pack.frames.length === 0);
const sample = selectAtiSpecialists([pack.row]).cohorts[0]?.samples[0];
assert.ok(sample, "The window must already have its own observed outcome");
const grading = reportAtiSpecialists([pack.row]).cohorts[0]!.paired;
const end = pack.asOf + 900_000;
const costs = await reportAtiSpecialistCosts([pack.row], async (origin, until) => {
  assert.equal(origin.streamId, model.quoteStudy!.streamId);
  assert.equal(origin.symbol, "R_75");
  assert.equal(until, end + 5000);
  return pack.frames;
});
const cohort = costs.cohorts[0]!;
assert.equal(cohort.scoredWindows, 1);
assert.equal(cohort.pricedWindows + cohort.gaps.length, 1);
let prices = null;
if (cohort.pricedWindows === 1) {
  const { receiptId, ...witness } = cohort.witnesses[0]!;
  assert.equal(receiptId, pack.receiptId);
  const published = Math.max(pack.row.issuedAt, pack.row.recordedAt!);
  const entry = pack.frames.find(f => f.epoch * 1000 > published)!;
  const exit = pack.frames.find(f => f.epoch * 1000 >= end)!;
  assert.equal(entry.epoch, witness.entryEpoch);
  assert.equal(exit.epoch, witness.exitEpoch);
  assert.equal(witness.long, exit.bid! - entry.ask!);
  assert.equal(witness.short, entry.bid! - exit.ask!);
  const incumbent = specialistPaperPoints(sample.incumbent, witness);
  const pool = specialistPaperPoints(sample.pool, witness);
  assert.equal(incumbent.assumedNet, cohort.incumbent.meanAssumedNetPoints);
  assert.equal(pool.assumedNet, cohort.pool.meanAssumedNetPoints);
  prices = { ...witness, entry: { bid: entry.bid, ask: entry.ask }, exit: { bid: exit.bid, ask: exit.ask }, incumbent, pool };
}
console.log(JSON.stringify({
  scope: "ONE_REGISTERED_FORWARD_WINDOW",
  mode: costs.mode,
  costBasis: costs.costBasis,
  executionAuthority: "NONE",
  planHash: pack.planHash,
  engineHash: pack.engineHash,
  archiveSha256: createHash("sha256").update(raw).digest("hex"),
  receiptId: pack.receiptId,
  asOf: new Date(pack.asOf).toISOString(),
  modelId: model.modelId,
  pairedWindows: grading.windows,
  poolBrier: grading.poolBrier,
  incumbentBrier: grading.incumbentBrier,
  priced: cohort.pricedWindows === 1,
  gap: cohort.gaps[0]?.reason ?? null,
  prices,
}, null, 2));
