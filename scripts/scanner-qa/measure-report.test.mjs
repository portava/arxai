// Statistics and summary rules of scripts/scanner-qa/measure.mjs: nearest-rank
// percentiles, the MAD outlier rule, and that breaches, errors and server failures always
// fail a group and appear in the Markdown, with production and development reported apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { percentile, outliers, summarize, markdown, buildMismatch, TARGET_MS } from "./measure-report.mjs";

const run = (cpuRate, samples, breach = false) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { cpuRate, samples, p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1), breach };
};
const iteration = (over) => ({ surface: "fixture", mode: "prod", checkout: "head", round: 1, index: 1, warmup: false, load: { before: [0.2, 0.2, 0.2] }, ...over });
const data = (iterations, serverErrors = []) => ({
  finishedAt: "2026-10-28T00:00:00Z", command: "node measure.mjs",
  config: { surfaces: ["fixture", "app"], modes: ["prod", "dev"] },
  environment: { cpus: 4, cpuModel: "test", platform: "test", node: "v24", playwright: "1", browser: "1", loadBefore: [0.2, 0.2, 0.2], loadAfter: [0.2, 0.2, 0.2] },
  checkouts: [{ label: "head", path: "/repo", git: { head: "abc", branch: "b", dirty: false }, fixtureSha256: {} }],
  iterations, serverErrors,
});
const twenty = v => Array.from({ length: 20 }, (_, i) => v + (i % 5));

test("target stays 100 ms", () => assert.equal(TARGET_MS, 100));

test("percentile is nearest-rank, as the scenarios compute p95", () => {
  const xs = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(percentile(xs, .95), 19);
  assert.equal(percentile(xs, .5), 10);
  assert.equal(percentile(xs, .99), 20);
  assert.equal(percentile([], .95), null);
});

test("outliers use 3 scaled MADs and never fire when MAD is 0", () => {
  assert.deepEqual(outliers([10, 11, 12, 11, 10, 11, 60]).indices, [6]);
  assert.deepEqual(outliers([5, 5, 5, 5, 90]).indices, []);
  assert.deepEqual(outliers([1, 2]).indices, []);
});

test("a breach fails its group and is listed; the other mode is reported separately", () => {
  const its = [
    iteration({ runs: [run(1, twenty(30)), run(4, twenty(130), true)] }),
    iteration({ mode: "dev", runs: [run(1, twenty(30)), run(4, twenty(60))] }),
  ];
  const d = data(its); d.config.surfaces = ["fixture"];
  const groups = summarize(d);
  const prod = groups.find(g => g.mode === "prod"), dev = groups.find(g => g.mode === "dev");
  assert.equal(prod.passed, false);
  assert.equal(prod.perRate.find(r => r.cpuRate === 4).breaches.length, 1);
  assert.equal(dev.passed, true);
  const md = markdown(d, groups);
  assert.match(md, /## Production build[\s\S]*\*\*Breach:\*\* round 1 iteration 1: p95 134 ms[\s\S]*## Development server/);
  assert.match(md, /Overall: FAIL/);
  // The 1x row of the breaching group still reads pass; only the 4x row fails.
  assert.match(md, /\| head \| 1× \| 1 \| 0 \| 0 \/ 1 \|[^\n]*\| pass \|/);
  assert.match(md, /\| head \| 4× \| 1 \| 1 \| 0 \/ 1 \|[^\n]*\| \*\*FAIL\*\* \|/);
});

test("errors, server failures and empty groups fail and are named; warm-ups are excluded", () => {
  const its = [
    iteration({ warmup: true, index: 0, runs: [run(1, twenty(500), true)] }),
    iteration({ runs: [run(1, twenty(30)), run(4, twenty(50))] }),
    iteration({ index: 2, error: "Same-universe selection blanked the results" }),
  ];
  const d = data(its, [{ surface: "app", mode: "dev", checkout: "head", round: 1, error: "server exited (1) before it was ready" }]);
  const groups = summarize(d);
  const fixtureProd = groups.find(g => g.surface === "fixture" && g.mode === "prod");
  assert.equal(fixtureProd.passed, false);
  assert.equal(fixtureProd.perRate.find(r => r.cpuRate === 1).runs, 1, "warm-up excluded");
  for (const g of groups.filter(g => g.surface === "app")) assert.equal(g.passed, false, `${g.mode} app group has no measurements`);
  const md = markdown(d, groups);
  assert.match(md, /\*\*Error\*\* head round 1 iteration 2: Same-universe selection blanked the results/);
  assert.match(md, /\*\*Server failure\*\* head round 1: server exited/);
  assert.match(md, /FAIL\*\* \(no measurements\)/);
  assert.match(md, /Warm-up iterations \(1/);
});

test("outlier clicks are listed, not dropped", () => {
  const samples = [...twenty(30).slice(0, 19), 400];
  const d = data([iteration({ runs: [run(1, samples)] })]); d.config = { surfaces: ["fixture"], modes: ["prod"] };
  const [g] = summarize(d);
  const r = g.perRate[0];
  assert.equal(r.samples.n, 20);
  assert.equal(r.samples.max, 400);
  assert.deepEqual(r.sampleOutliers.items.map(o => o.ms), [400]);
  assert.match(markdown(d, [g]), /Click outliers[^\n]*click 20 400 ms/);
});

test("a busy machine is flagged", () => {
  const d = data([iteration({ load: { before: [3.5, 3, 3] }, runs: [run(1, twenty(30))] })]); d.config = { surfaces: ["fixture"], modes: ["prod"] };
  assert.match(markdown(d, summarize(d)), /Load warning:\*\* 1 of 1 iterations/);
});

test("integrated-page fixture gaps are printed and label the verdict", () => {
  const blocked = [...Array(3).fill({ kind: "mutation", method: "POST", path: "/api/me/chart/ai-alerts/scan" }), { kind: "mutation", method: "POST", path: "/api/me/activity-ping" }, { kind: "websocket", url: "ws://127.0.0.1:4188/" }];
  const appRun = (rate, over = {}) => ({ ...run(rate, twenty(40)), settledBeforeClicks: true, unsettledAfterClicks: [], ...over });
  const d = data([
    iteration({ surface: "app", unknownEndpoints: ["/api/me/notifications", "/api/release/version"], partialModels: ["/api/me/chart/intelligence (minimal)"], blocked, runs: [appRun(1), appRun(4, { unsettledAfterClicks: [3, 7] })] }),
    iteration({ surface: "app", index: 2, unknownEndpoints: ["/api/me/notifications"], blocked: blocked.slice(0, 1), runs: [appRun(1, { settledBeforeClicks: false }), appRun(4)] }),
  ]);
  d.config = { surfaces: ["app"], modes: ["prod"] };
  const groups = summarize(d);
  assert.deepEqual(groups[0].fixtureGaps.unknownEndpoints, ["/api/me/notifications", "/api/release/version"]);
  const md = markdown(d, groups);
  assert.match(md, /Endpoints answered 503 \(not modelled by the fixture\): `\/api\/me\/notifications`, `\/api\/release\/version`/);
  assert.match(md, /Modelled with a minimal shape: \/api\/me\/chart\/intelligence \(minimal\)/);
  assert.match(md, /Blocked requests: 5 mutations \(POST \/api\/me\/chart\/ai-alerts\/scan ×4, POST \/api\/me\/activity-ping ×1\), 1 WebSocket, 0 other-origin/);
  assert.match(md, /2 clicks did not settle within 15 s; 1 run started its clicks before the page settled/);
  assert.match(md, /\| pass \(2 endpoints unavailable\) \|/);
});

test("warm-up breaches are listed with their p95 but do not decide the verdict", () => {
  const d = data([
    iteration({ warmup: true, index: 0, runs: [run(1, twenty(30)), run(4, twenty(137), true)] }),
    iteration({ runs: [run(1, twenty(30)), run(4, twenty(60))] }),
  ]);
  d.config = { surfaces: ["fixture"], modes: ["prod"] };
  const groups = summarize(d);
  assert.equal(groups[0].passed, true);
  const md = markdown(d, groups);
  assert.match(md, /Warm-up iterations \(1[^\n]*\n\n- Production build \/ fixture \/ head round 1: 1× p95 34 ms, 4× p95 141 ms \*\*breach\*\*/);
  assert.match(md, /\*\*1 warm-up run breached the target\*\*/);
});

test("a failed iteration keeps the samples it measured and names them", () => {
  const d = data([iteration({ error: "Same-universe selection blanked the results", partialRuns: [run(1, twenty(30)), { ...run(4, twenty(50).slice(0, 7)), inProgress: true }] })]);
  d.config = { surfaces: ["fixture"], modes: ["prod"] };
  const groups = summarize(d);
  assert.equal(groups[0].passed, false);
  assert.match(markdown(d, groups), /\*\*Error\*\* head round 1 iteration 1: Same-universe selection blanked the results \(samples kept in results\.json: 1× 20 clicks, p95 34 ms; 4× 7 clicks \(run interrupted\), p95 54 ms\)/);
});

test("production groups show the bundle's provenance; a bundle from another commit fails", () => {
  assert.equal(buildMismatch({ source: "/repo", git: { head: "abc", dirty: false, dirtyHash: null } }, { path: "/repo", git: { head: "abc", dirty: false, dirtyHash: null } }), null);
  assert.match(buildMismatch({ source: "/repo", git: { head: "abc", dirty: true, dirtyHash: "h1" } }, { path: "/repo", git: { head: "def", dirty: false, dirtyHash: null } }), /built from abc \(dirty\), checkout is at def/);
  assert.match(buildMismatch({ source: "/repo", git: { head: "abc", dirty: true, dirtyHash: "h1" } }, { path: "/repo", git: { head: "abc", dirty: true, dirtyHash: "h2" } }), /uncommitted changes differ/);
  assert.match(buildMismatch({ source: "/clone", git: { head: "abc", dirty: false } }, { path: "/repo", git: { head: "abc", dirty: false } }), /built from \/clone, not \/repo/);
  assert.match(buildMismatch({ source: "/repo", git: { head: "abc", dirty: "unknown" } }, { path: "/repo", git: { head: "abc", dirty: false } }), /git state unknown/);
  const d = data([iteration({ runs: [run(1, twenty(30)), run(4, twenty(60))] })]);
  d.config = { surfaces: ["fixture"], modes: ["prod"] };
  d.checkouts[0].git.dirtyHash = null;
  d.servers = [{ surface: "fixture", mode: "prod", checkout: "head", round: 1, buildId: "b1", buildInfo: { buildId: "b1", source: "/repo", builtAt: "2026-10-28T09:08:00Z", label: "fixture prod", git: { head: "old", dirty: true, dirtyHash: "x" } } }];
  const groups = summarize(d);
  assert.equal(groups[0].passed, false);
  const md = markdown(d, groups);
  assert.match(md, /Bundle round 1: build b1, built 2026-10-28T09:08:00Z from `old` \(dirty: true\)/);
  assert.match(md, /\*\*Bundle\/checkout mismatch\*\* head round 1: built from old \(dirty\), checkout is at abc/);
});
