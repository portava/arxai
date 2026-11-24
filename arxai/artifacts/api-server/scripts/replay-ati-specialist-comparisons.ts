// Called by the schedule auditor after per-window identity, outcome and quote replay.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { AtiDerivQuoteFrame } from "../src/lib/data/atiDerivQuotes.js";
import { reportAtiSpecialistCosts } from "../src/lib/structural/atiSpecialistCosts.js";
import { reportAtiSpecialists } from "../src/lib/structural/atiSpecialistReport.js";
import type { StoredForecast } from "../src/lib/structural/service.js";

type ReviewedWindow = { file: string; receiptId: string; asOf: string; archiveSha256: string; state: "PRICED" | "UNPRICED" };
type Archive = { receiptId: string; row: StoredForecast; asOf: number; frames: AtiDerivQuoteFrame[]; planHash: string; engineHash: string };
const input: { archiveDir: string; windows: ReviewedWindow[]; digest: string; engineDigest: string } =
  JSON.parse(readFileSync(0, "utf8"));
const rows: StoredForecast[] = [];
const tapes = new Map<number, Archive>();
for (const window of input.windows) {
  const bytes = gunzipSync(readFileSync(join(input.archiveDir, window.file)));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), window.archiveSha256);
  const archive: Archive = JSON.parse(bytes.toString("utf8"));
  assert.equal(archive.planHash, input.digest);
  assert.equal(archive.engineHash, input.engineDigest);
  assert.equal(archive.receiptId, window.receiptId);
  assert.equal(archive.row.id, window.receiptId);
  assert.equal(archive.asOf, Date.parse(window.asOf));
  assert.equal(archive.row.forecast.asOf, archive.asOf);
  assert.ok(!tapes.has(archive.asOf));
  tapes.set(archive.asOf, archive);
  rows.push(archive.row);
}

const prediction = reportAtiSpecialists(rows);
const costs = await reportAtiSpecialistCosts(rows, async (origin, until) => {
  const archive = tapes.get(until - (15 * 60_000 + 5000));
  assert.ok(archive);
  const anchor = archive.row.forecast.atiSpecialists?.quoteStudy;
  assert.ok(anchor);
  assert.deepEqual(origin, { streamId: anchor.streamId, symbol: anchor.symbol, epoch: anchor.epoch });
  return archive.frames;
});
if (!rows.length) {
  assert.equal(prediction.cohorts.length, 0);
  assert.equal(costs.cohorts.length, 0);
  console.log("null");
} else {
  assert.equal(prediction.cohorts.length, 1);
  assert.equal(costs.cohorts.length, 1);
  const forecast = prediction.cohorts[0]!;
  const economics = costs.cohorts[0]!;
  assert.equal(forecast.paired.windows, rows.length);
  assert.equal(economics.pricedWindows, input.windows.filter(w => w.state === "PRICED").length);
  assert.deepEqual(economics.witnesses.map(w => w.receiptId).sort(),
    input.windows.filter(w => w.state === "PRICED").map(w => w.receiptId).sort());
  const { pricedWindows, pool, incumbent, frequency, specialists, byTrend } = economics;
  console.log(JSON.stringify({ probability: forecast.paired, probabilityByTrend: forecast.byTrend,
    poolReliability: forecast.poolReliability, specialistReliability: forecast.specialistReliability,
    economics: { pricedWindows, pool, incumbent, frequency, specialists, byTrend }, unit: costs.unit, costBasis: costs.costBasis }));
}
