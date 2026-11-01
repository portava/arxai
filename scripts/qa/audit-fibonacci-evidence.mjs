// Read-only audit of completed browser receipts; never launches a browser/API.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EVIDENCE, SOURCE, BUILD, compareLevels, projectionMatches, levels } from "./fibonacci-ownership.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceTime = seconds => `${new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ")} source clock (UTC unverified)`;
const results = [];
for (const viewport of ["desktop", "phone"]) {
  const dir = path.join(EVIDENCE, "fibonacci-ownership-acceptance", `standalone-${viewport}`);
  const bytes = await fs.readFile(path.join(dir, "journey-result.json"));
  const j = JSON.parse(bytes), terminal = JSON.parse(await fs.readFile(path.join(dir, "terminal.json")));
  assert.equal(j.source, SOURCE);
  assert.equal(j.buildId, BUILD);
  assert.equal(j.unfinished, false);
  assert.equal(j.checks.length, 40);
  assert(j.checks.every(c => c.pass));
  assert.equal(terminal.exitCode, 0);
  assert.equal(terminal.ownedBrowserClosed, true);
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
  }
}
console.log(JSON.stringify({ source: SOURCE, build: BUILD, completedSourceWindowAndCaveatAudits: results.length, results }, null, 2));
