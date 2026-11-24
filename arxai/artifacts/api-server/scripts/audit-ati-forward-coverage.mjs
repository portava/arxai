// Regrade elapsed scheduled slots from archived receipts without a database or a feed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [kind, cohortDir, archiveDir, through, option] = process.argv.slice(2);
assert.ok(process.argv.length === 6 || (process.argv.length === 7 && option === "--comparisons"));
assert.ok(["original", "renewal"].includes(kind) && cohortDir && archiveDir && through?.endsWith("Z"));
const planName = kind === "renewal" ? "forward-renewal-plan.json" : "forward-plan.json";
const bytes = readFileSync(join(archiveDir, planName));
const digest = createHash("sha256").update(bytes).digest("hex");
const plan = JSON.parse(bytes);
const read = name => JSON.parse(readFileSync(join(cohortDir, name + ".json")));
const registration = read("registration"), engine = read("engine"), snapshot = read("summary");
const start = Date.parse(plan.start), end = Date.parse(plan.lastOutcomeDue), step = plan.minutesPerWindow * 60_000;
const cutoff = Date.parse(through);
assert.equal(start + plan.plannedWindows * step, end);
assert.ok(cutoff >= start && cutoff <= end && cutoff <= snapshot.checkedAt && (cutoff - start) % step === 0);
assert.ok(registration.registeredAt < start && engine.sealedAt < start);
assert.deepEqual(registration.plan, plan);
for (const seal of [registration, engine, snapshot]) assert.equal(seal.digest, digest);
assert.equal(engine.engineDigest, snapshot.engineDigest);
assert.equal(snapshot.executionAuthority, "NONE");
assert.equal(snapshot.windows.length, plan.plannedWindows);
const ids = new Set();
const windows = [];
const replay = fileURLToPath(new URL("./replay-ati-forward-window.ts", import.meta.url));
const server = fileURLToPath(new URL("../", import.meta.url));
for (const [index, slot] of snapshot.windows.entries()) {
  assert.equal(slot.asOf, start + index * step);
  if (slot.asOf + step > cutoff) continue;
  const asOf = new Date(slot.asOf).toISOString();
  const label = asOf.slice(0,16).replace(/[-:]/g, "");
  const file = label + "-" + kind + ".json.gz";
  if (!existsSync(join(archiveDir, file))) {
    windows.push({ asOf, state: "UNVERIFIED", receiptId: slot.receiptId ?? null });
    continue;
  }
  assert.ok(slot.receiptId && !ids.has(slot.receiptId) && slot.status === "ISSUED");
  ids.add(slot.receiptId);
  assert.ok(slot.attempt.attemptAt >= slot.asOf && slot.attempt.attemptAt <= slot.asOf + plan.latestAttemptSecondsAfterBoundary * 1000);
  const result = JSON.parse(execFileSync(process.execPath, ["--import","tsx",replay,resolve(archiveDir,file)], {
    cwd: server, env: { PATH: process.env.PATH, DATABASE_URL: "postgresql://offline@127.0.0.1:1/offline", LOG_LEVEL: "error" },
    encoding: "utf8", timeout: 30_000 }));
  assert.equal(result.asOf, asOf);
  assert.equal(result.planHash, digest);
  assert.equal(result.engineHash, engine.engineDigest);
  assert.equal(result.receiptId, slot.receiptId);
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.pairedWindows, 1);
  assert.equal(result.costBasis.observedBrokerCharges, null);
  assert.ok(result.priced ? result.prices && !result.gap : result.gap && !result.prices);
  windows.push({ asOf, file, receiptId: slot.receiptId, archiveSha256: result.archiveSha256,
    state: result.priced ? "PRICED" : "UNPRICED", gap: result.gap,
    poolBrier: result.poolBrier, incumbentBrier: result.incumbentBrier,
    assumedNet: result.priced ? { pool: result.prices.pool.assumedNet, incumbent: result.prices.incumbent.assumedNet,
      differentSide: result.prices.pool.side !== result.prices.incumbent.side } : null });
}
const reviewed = windows.filter(w => w.state !== "UNVERIFIED");
const priced = reviewed.flatMap(w => w.assumedNet ? [w.assumedNet] : []);
const unpriced = reviewed.filter(w => w.state === "UNPRICED").length;
const maxPriced = plan.plannedWindows - unpriced;
function mean(values) {
  assert.ok(values.every(Number.isFinite));
  return values.length ? values.reduce((a,b) => a+b, 0) / values.length : null;
}
// At the collector's current boundary its own multi-window report is an independent
// cross-check. An older cutoff can still be replayed without borrowing later outcomes.
let comparisons;
if (option === "--comparisons") {
  const worker = fileURLToPath(new URL("./replay-ati-specialist-comparisons.ts", import.meta.url));
  const replayed = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", worker], {
    cwd: server, env: { PATH: process.env.PATH, DATABASE_URL: "postgresql://offline@127.0.0.1:1/offline", LOG_LEVEL: "error" },
    input: JSON.stringify({ archiveDir: resolve(archiveDir), windows: reviewed, digest, engineDigest: engine.engineDigest }),
    encoding: "utf8", timeout: 60_000,
  }));
  const atSnapshotBoundary = snapshot.checkedAt < cutoff + step || cutoff === end;
  let verifiedAgainstCollector = false;
  if (atSnapshotBoundary && replayed && reviewed.length === windows.length) {
    assert.equal(snapshot.prediction.cohorts.length, 1);
    assert.equal(snapshot.costs.cohorts.length, 1);
    const forecast = snapshot.prediction.cohorts[0], costs = snapshot.costs.cohorts[0];
    assert.deepEqual(replayed.probability, forecast.paired);
    assert.deepEqual(replayed.probabilityByTrend, forecast.byTrend);
    assert.deepEqual(replayed.poolReliability, forecast.poolReliability);
    assert.deepEqual(replayed.specialistReliability, forecast.specialistReliability);
    for (const [key, value] of Object.entries(replayed.economics)) assert.deepEqual(value, costs[key]);
    assert.deepEqual(replayed.costBasis, snapshot.costs.costBasis);
    assert.equal(replayed.unit, snapshot.costs.unit);
    verifiedAgainstCollector = true;
  }
  comparisons = { verifiedAgainstCollector, replayed };
}
console.log(JSON.stringify({ study: plan.study, planHash: digest, engineHash: engine.engineDigest,
  windowsEndingBy: through, planned: plan.plannedWindows, outcomesReplayed: reviewed.length, priced: priced.length,
  unpriced, unverifiedElapsed: windows.length - reviewed.length, scheduledAfterCutoff: plan.plannedWindows - windows.length,
  maxPricedOnRetainedEvidence: maxPriced, requiredPriced: plan.reviewConditions.minimumPairedQuoteWindows,
  priceCoverageGate: maxPriced < plan.reviewConditions.minimumPairedQuoteWindows ? "UNREACHABLE_ON_RETAINED_EVIDENCE" : "STILL_POSSIBLE",
  meanBrier: { pool: mean(reviewed.map(w => w.poolBrier)), incumbent: mean(reviewed.map(w => w.incumbentBrier)) },
  meanAssumedNetPricePoints: { pool: mean(priced.map(w => w.pool)), incumbent: mean(priced.map(w => w.incumbent)) },
  pricedDifferentSides: priced.filter(w => w.differentSide).length, observedBrokerCosts: null, executionAuthority: "NONE", ...(comparisons && { comparisons }), windows }, null, 2));
