// Read-only audit of extended receipts. No browser, server or application imports.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EVIDENCE, SOURCE, BUILD, compareLevels } from "./fibonacci-ownership.mjs";
import { manualDrawings, previewGeometry, withdrawalSelftest } from "./fibonacci-withdrawal.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
export function audit(j, terminal) {
  assert.equal(j.source, SOURCE);
  assert.equal(j.buildId, BUILD);
  assert.equal(j.unfinished, false);
  assert.equal(j.checks.length, 75);
  assert(j.checks.every(c => c.pass));
  assert.equal(j.errors.length, 0);
  assert.equal(terminal.exitCode, 0);
  assert.equal(terminal.ownedBrowserClosed, true);
  assert.equal(terminal.ownedStaticServerClosed, true);
  assert.equal(j.build.bad.length, 0);
  assert.equal(j.build.runtimeBuild, BUILD);
  assert.equal(j.network.errors.length, 0);
  assert(j.network.blocked.every(b => b.kind === "mutation" && b.status === 503));
  assert(j.network.requests.filter(r => r.method !== "GET").every(r => r.status === 503));
  const withdrawals = j.receipts.filter(r => r.kind === "withdrawal");
  assert.equal(withdrawals.length, 2);
  for (const [index, role, timeframe] of [[0, "primary", "M1"], [1, "comparison", "H1"]]) {
    const r = withdrawals.find(r => r.role === role);
    assert(r);
    assert.equal(r.oldIdentity, (index ? "b" : "a").repeat(64));
    assert.equal(r.newIdentity, (index ? "d" : "c").repeat(64));
    assert.notDeepEqual(r.preview.snapshot.range, r.windowAfter.snapshot.range);
    assert.equal(previewGeometry(r.preview).drawings.length, 1);
    assert.equal(previewGeometry(r.sourcePreview).drawings.length, 1);
    assert.equal(manualDrawings(r.before).length, 1);
    assert.equal(manualDrawings(r.before)[0].fibonacciOrigin.sourceIdentity, r.oldIdentity);
    assert(Object.keys(r.savedStorage).length >= 2);
    for (const state of [r.windowAfter, r.sourceAfter, r.after]) {
      assert.equal(previewGeometry(state).drawings.length, 0);
      assert(!state.geometry.strokes.some(s => s.id.startsWith("fib-preview-")));
      assert.deepEqual(manualDrawings(state), manualDrawings(r.before));
      assert.deepEqual(state.data.canonical, r.before.data.canonical);
    }
    assert.deepEqual(r.otherAfter.geometry.drawings, r.otherBefore.geometry.drawings);
    assert.deepEqual(r.otherAfter.data.canonical, r.otherBefore.data.canonical);
    assert(r.withdrawn.includes("There is no current Fibonacci preview"));
    assert(r.currentReply.includes("There is no current Fibonacci preview"));
    assert(!r.currentReply.includes(r.oldIdentity));
    assert(/Select a ready|source changed|Select the current chart/.test(r.delayedReply));
    assert(!r.delayedReply.includes("Fibonacci kept"));
    const response = j.network.candleResponses.find(q => q.timeframe === timeframe && q.sourceIdentity === r.newIdentity &&
      j.network.requests.some(req => req.id === q.requestId && req.fulfilledAt && !req.cancelled));
    assert(response, "new identity actually fulfilled");
    assert.deepEqual(response.canonical, r.sourceAfter.data.canonical);
    for (const label of ["before window change", "before identity change"]) {
      const evidence = j.checks.find(c => c.label === `${role} ${label}: positive source-owned seven-level preview`);
      assert(evidence?.pass);
      assert(evidence.details.reply.includes(r.oldIdentity));
      assert(compareLevels(evidence.details.reply, previewGeometry(evidence.details.state)));
    }
    for (const label of ["window withdrawal", "identity withdrawal", "delayed Keep", "new-source explanation"]) {
      assert(j.checks.some(c => c.pass && c.label === `${role} ${label}: saved annotations byte-identical`));
      assert(j.checks.some(c => c.pass && c.label === `${role} ${label}: other pane untouched`));
    }
    assert(j.checks.some(c => c.pass && c.label === `${role} delayed Keep held before local dispatch`));
    assert(j.checks.some(c => c.pass && c.label === `${role} delayed command retains original text`));
  }
  return { passed: 75, paneWithdrawals: 2, strictKnownBackgroundAllowlist: j.strictKnownBackgroundAllowlist };
}

const names = process.argv.slice(2);
assert(names.length, "Supply completed immutable attempt directories");
assert.equal(withdrawalSelftest().passed, 3);
for (const name of names) {
  assert(/^[a-z0-9-]+$/.test(name));
  const dir = path.join(EVIDENCE, "fibonacci-ownership-acceptance", name);
  const bytes = await fs.readFile(path.join(dir, "journey-result.json"));
  const j = JSON.parse(bytes), terminal = JSON.parse(await fs.readFile(path.join(dir, "terminal.json")));
  const result = audit(j, terminal);
  // Prove this audit rejects the regressions, rather than trusting green labels.
  const mutations = [
    copy => { copy.receipts.find(r => r.kind === "withdrawal").after.geometry.drawings.push({ id: "fib-preview-stale" }); },
    copy => { copy.receipts.find(r => r.kind === "withdrawal").after.geometry.drawings[0].start.price += 1; },
    copy => { copy.receipts.find(r => r.kind === "withdrawal").currentReply = "Prepared an unaccepted Fibonacci preview"; },
    copy => { copy.receipts.find(r => r.kind === "withdrawal").delayedReply = "Fibonacci kept"; },
    copy => { copy.receipts.find(r => r.kind === "withdrawal").otherAfter.data.canonical[0].close += 1; },
    copy => { copy.network.candleResponses = copy.network.candleResponses.filter(r => !/^[cd]{64}$/.test(r.sourceIdentity)); },
  ];
  for (const mutate of mutations) { const copy = structuredClone(j); mutate(copy); assert.throws(() => audit(copy, terminal)); }
  console.log(JSON.stringify({ name, receiptSha256: sha(bytes), ...result, negativeAuditChecks: mutations.length }));
}
