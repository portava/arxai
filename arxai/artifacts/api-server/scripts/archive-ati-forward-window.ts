// Export one scored window from either registered V75 forward cohort.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { pool } from "@workspace/db";
import { selectAtiSpecialists } from "../src/lib/structural/atiSpecialistReport.js";
import { structuralRepository } from "../src/lib/structural/repository.js";
import { loadAtiDerivReplayQuotes } from "../src/lib/selfTrade/atiDerivQuoteReplay.js";

const [directory, sourceRoot, boundary, output] = process.argv.slice(2);
assert.ok(directory && sourceRoot && boundary && output && process.argv.length === 6,
  "Pass the cohort directory, sealed source tree, window start in UTC and output .json.gz path");
const asOf = Date.parse(boundary);
assert.ok(boundary.endsWith("Z") && Number.isSafeInteger(asOf));
const url = new URL(process.env.DATABASE_URL ?? "");
const renewal = url.pathname === "/ati_specialist_forward_renewal";
assert.ok(url.hostname === "localhost" && url.searchParams.get("host")?.startsWith("/") &&
  (renewal || url.pathname === "/ati_specialist_forward_v1"), "Dedicated local study database required");
const planName = renewal ? "forward-renewal-plan.json" : "forward-plan.json";
const planBytes = await readFile(new URL("../../../docs/structural-evidence/ati-specialists-v1/" + planName, import.meta.url));
const plan = JSON.parse(planBytes.toString("utf8"));
const planHash = createHash("sha256").update(planBytes).digest("hex");
const readJson = async (filename: string) => JSON.parse(await readFile(join(directory, filename), "utf8"));
const [registration, engine, summary, attempt] = await Promise.all([
  readJson("registration.json"), readJson("engine.json"), readJson("summary.json"), readJson(asOf + ".attempt"),
]);
assert.deepEqual(registration.plan, plan);
for (const seal of [engine, registration, summary]) assert.equal(seal.digest, planHash);
const start = Date.parse(plan.start);
const step = plan.minutesPerWindow * 60_000;
assert.equal(step, 900_000);
assert.ok(registration.registeredAt < start && engine.sealedAt < start);
assert.ok(asOf >= start && (asOf - start) % step === 0 && asOf < start + step * plan.plannedWindows);
assert.ok(attempt.attemptAt >= asOf && attempt.attemptAt <= asOf + plan.latestAttemptSecondsAfterBoundary * 1000);
assert.ok(summary.checkedAt >= asOf + step && summary.checkedAt <= Date.now());
const scheduled = summary.windows.filter((w: { asOf: number }) => w.asOf === asOf);
assert.equal(scheduled.length, 1);
assert.equal(scheduled[0].status, "ISSUED");
assert.deepEqual(scheduled[0].attempt, attempt);
const root = resolve(sourceRoot);
const hash = createHash("sha256");
assert.ok(Array.isArray(engine.engineFiles) && engine.engineFiles.length > 0);
for (const file of engine.engineFiles) {
  const resolved = resolve(root, file);
  assert.ok(resolved.startsWith(root + sep));
  hash.update(file).update("\0").update(await readFile(resolved)).update("\0");
}
const engineHash = hash.digest("hex");
assert.equal(engineHash, engine.engineDigest);
assert.equal(engineHash, summary.engineDigest);

try {
  const email = renewal ? "ati-specialist-renewal@example.invalid" : "ati-specialist-forward-v1@example.invalid";
  const { rows } = await pool.query("SELECT id FROM users WHERE email=$1 AND is_system_user=true", [email]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, registration.ownerId);
  const records = await structuralRepository.list(registration.ownerId, plan.symbol);
  const issued = records.filter(r => r.id === scheduled[0].receiptId && r.forecast.asOf === asOf);
  assert.equal(issued.length, 1);
  const row = issued[0]!;
  assert.equal(row.forecast.origin.provider, plan.provider);
  assert.equal(row.forecast.origin.symbol, plan.symbol);
  const model = row.forecast.atiSpecialists;
  assert.equal(model?.version, plan.policy);
  const score = row.scores.find(s => s.horizon === 15);
  assert.ok(score && row.recordedAt != null, "The registered outcome is still pending");
  assert.equal(selectAtiSpecialists([row]).cohorts[0]?.samples[0]?.row.id, row.id, "The scorer cannot verify the registered outcome");
  const anchor = model?.quoteStudy;
  const frames = anchor ? (await loadAtiDerivReplayQuotes(anchor, asOf + step + 5000))
    .map(({ streamId, symbol, epoch, receivedAt, releasedAt, bid, ask }) => ({ streamId, symbol, epoch, receivedAt, releasedAt, bid, ask })) : [];
  assert.ok(!anchor || anchor.symbol === "R_75");
  assert.ok(frames.every(f => f.streamId === anchor?.streamId && f.symbol === anchor?.symbol));
  const frozen = { id: row.id, issuedAt: row.issuedAt, recordedAt: row.recordedAt, forecast: row.forecast, scores: [score] };
  const archive = gzipSync(JSON.stringify({ planHash, engineHash, receiptId: row.id, asOf, row: frozen, frames }));
  const temp = await mkdtemp(join(dirname(resolve(output)), ".ati-window-"));
  try {
    const staged = join(temp, "archive");
    await writeFile(staged, archive);
    try {
      await link(staged, output);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      assert.ok((await readFile(output)).equals(archive), "The existing archive has different evidence");
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ receiptId: row.id, asOf: boundary, frames: frames.length, output }));
} finally {
  await pool.end();
}
