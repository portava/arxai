// Read-only audit of completed browser receipts; never launches a browser/API.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EVIDENCE, SOURCE, BUILD, compareLevels, projectionMatches, levels, fixtureQualified, omittedObservationFixture } from "./fibonacci-ownership.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceTime = seconds => `${new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ")} source clock (UTC unverified)`;
const results = [];
const args = process.argv.slice(2), negative = args[0] === "--omitted-observation";
if (args.length && (!negative || args.length !== 3 || args.slice(1).some(name => !/^omitted-observation-[a-z0-9-]+$/.test(name))))
  throw Error("Usage: audit-fibonacci-evidence.mjs [--omitted-observation <desktop-attempt> <phone-attempt>]");
const negativeResults = [];
for (const viewport of ["desktop", "phone"]) {
  const dir = path.join(EVIDENCE, "fibonacci-ownership-acceptance", negative ? args[viewport === "desktop" ? 1 : 2] : `standalone-${viewport}`);
  const bytes = await fs.readFile(path.join(dir, "journey-result.json"));
  const j = JSON.parse(bytes), terminal = JSON.parse(await fs.readFile(path.join(dir, "terminal.json")));
  assert.equal(j.source, SOURCE);
  assert.equal(j.buildId, BUILD);
  assert.equal(j.unfinished, false);
  assert.equal(j.checks.length, negative ? 57 : 40);
  assert(j.checks.every(c => c.pass));
  assert.equal(terminal.exitCode, 0);
  assert.equal(terminal.ownedBrowserClosed, true);
  if (negative) {
    assert.equal(j.receipts.filter(r => r.negative).length, 2);
    assert.equal(j.network.blocked.filter(r => r.kind !== "mutation" || r.status !== 503).length, 0);
    assert(j.network.requests.filter(r => r.method !== "GET").every(r => r.status === 503));
    assert.equal(j.errors.length, 0);
    assert.equal(j.network.errors.length, 0);
    assert.equal(j.build.bad.length, 0);
    assert.equal(j.build.runtimeBuild, BUILD);
    assert.deepEqual(j.viewport, viewport === "desktop" ? { width: 1440, height: 1100 } : { width: 390, height: 844 });
  }
  for (const role of ["primary", "comparison"]) {
    const receipt = j.receipts.find(r => r.role === role);
    const preview = j.receipts.find(r => r.stage === `${role}: preview`).reply;
    const manual = j.receipts.find(r => r.stage === `${role}: explicit Keep and selected manual`).reply;
    const bars = receipt.before.data.canonical, drawing = receipt.kept.geometry.drawings.find(d => d.kind === "fibonacci");
    const o = drawing.fibonacciOrigin, step = role === "primary" ? 60 : 3600;
    assert.equal(o.windowFrom, bars[0].time);
    assert.equal(o.windowTo, bars.at(-1).time + step);
    assert.equal(o.closedBars, bars.length);
    assert.equal(o.source, "mt5_broker");
    assert.equal(o.sourceIdentity, (role === "primary" ? "a" : "b").repeat(64));
    assert.equal(o.symbol, "EURUSD");
    assert.equal(o.timeframe, role === "primary" ? "M1" : "H1");
    assert(preview.includes(`Source: ${o.source}; source identity ${o.sourceIdentity}.`));
    assert(preview.includes(`Window: ${sourceTime(o.windowFrom)} to ${sourceTime(o.windowTo)} (${bars.length} closed bars).`));
    assert(preview.includes(`later confirmation at ${sourceTime(o.confirmedAt)}`));
    const pivotKinds = [];
    for (const anchor of [drawing.start, drawing.end]) {
      const index = bars.findIndex(b => b.time === anchor.time);
      assert(index >= 2 && index + 2 < bars.length);
      const around = [bars[index - 2], bars[index - 1], bars[index + 1], bars[index + 2]];
      const high = bars[index].high === anchor.price && around.every(b => b.high < anchor.price);
      const low = bars[index].low === anchor.price && around.every(b => b.low > anchor.price);
      assert(high !== low);
      pivotKinds.push(high ? "high" : "low");
    }
    assert.notEqual(pivotKinds[0], pivotKinds[1]);
    const endIndex = bars.findIndex(b => b.time === drawing.end.time);
    assert.equal(o.confirmedAt, bars[endIndex + 2].time + step);
    assert(preview.includes("Prices use the chart reader’s rounded display formatting."));
    assert(preview.includes("not reversal probabilities or price targets"));
    assert(preview.includes("does not independently establish their UTC clock provenance"));
    assert(manual.includes("not revalidated as current advice"));
    assert(manual.includes("Time labels preserve chart source coordinates, not independently proven UTC provenance"));
    assert(!/primary chart/i.test(manual));
    assert(compareLevels(preview, receipt.preview.geometry));
    assert(compareLevels(manual, receipt.kept.geometry));
    assert(projectionMatches(receipt.projection));
    results.push({ viewport, role, sourceIdentity: o.sourceIdentity, windowFrom: o.windowFrom, windowTo: o.windowTo,
      confirmedAt: o.confirmedAt, pivots: pivotKinds, levels: levels(preview), resultSha256: sha(bytes) });
    if (negative) {
      const n = j.receipts.find(r => r.negative && r.role === role), f = omittedObservationFixture(o.timeframe);
      assert(fixtureQualified(n.originalEvidence));
      assert.deepEqual(n.originalEvidence, f.original);
      assert.deepEqual(n.omitted, f.omitted);
      assert.deepEqual(n.original.data.canonical, bars);
      const response = j.network.candleResponses.findLast(r => r.timeframe === o.timeframe && r.sourceIdentity === o.sourceIdentity);
      const request = j.network.requests.find(r => r.id === response.requestId);
      assert.equal(request.status, 200);
      assert(request.fulfilledAt && !request.cancelled);
      assert.deepEqual(response.canonical, bars);
      assert.deepEqual(n.mismatched.data.canonical, f.installed);
      assert.equal(n.mismatched.data.display.length, 159);
      assert(!n.mismatched.data.display.some(c => c.time === f.omitted.time));
      assert(n.reply.includes("The displayed chart omits source observations in this window; automatic drawings are withheld."));
      assert(!n.reply.includes("Prepared an unaccepted Fibonacci preview"));
      assert.equal(n.after.geometry.drawings.length, 1);
      assert.deepEqual(n.mismatched.geometry.drawings, n.original.geometry.drawings);
      assert.deepEqual(n.after.geometry.drawings, receipt.kept.geometry.drawings);
      assert.equal(n.after.geometry.strokes.filter(s => /^Fib \d+(?:\.\d+)?%$/.test(s.label ?? "")).length, 7);
      assert.deepEqual(n.after.data, n.mismatched.data);
      assert.equal(n.after.snapshot.dataRevision, n.mismatched.snapshot.dataRevision);
      assert.deepEqual(n.otherAfter.data, n.otherBefore.data);
      assert.deepEqual(n.otherAfter.geometry.drawings, n.otherBefore.geometry.drawings);
      negativeResults.push({ viewport, role, omitted: n.omitted, originalCount: bars.length,
        installedCount: n.after.data.canonical.length, keptDrawings: n.after.geometry.drawings.length, resultSha256: sha(bytes) });
    }
  }
}
console.log(JSON.stringify({ source: SOURCE, build: BUILD, completedSourceWindowAndCaveatAudits: results.length, results,
  ...(negative ? { completedOmittedObservationAudits: negativeResults.length, negativeResults } : {}) }, null, 2));
