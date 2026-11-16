// Test: session/time-of-day DIRECTION research, the strategy families on the deep
// real-markets set, and the redesigned Mean Reversion rule.
//
// Claims:
//   1. THE METHOD CAN SEE AN EDGE. On a seeded hourly series with a planted
//      drift at one UTC hour, that hour survives discovery AND confirmation.
//   2. IT DOES NOT INVENT ONE. On a seeded driftless series, nothing survives.
//   3. THE PUBLISHED REAL-MARKET RESULTS ARE THE MEASURED ONES: the session
//      research, the seven strategy families (net and gross of cost) and the
//      Mean Reversion replay reproduce their pinned result hashes, and
//      docs/SESSION_EDGE_RESULTS.md carries exactly the generated numbers.
//   4. THE REDESIGNED MEAN REVERSION RULE FIRES (the old one could not) and is
//      reported with its real, cost-adjusted record.
//
// Reads the pinned fixture and a seeded temp fixture. No DB, no network.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { serialiseBarsCsv, type FixtureBar } from "./research/realHistoryFixture.js";
import { intradayDatasetHashOf, type IntradayInstrumentSpec } from "./research/intradayHistoryFixture.js";
import { MARKETS_FIXTURE_DIR_NAME, MARKETS_MANIFEST_VERSION } from "./research/marketsHistoryFixture.js";
import { runSessionResearch, renderSessionMarkdown } from "./research/sessionEdgeResearch.js";
import { runMeanReversionReplay, renderMeanReversionMarkdown } from "./research/meanReversionReplayResearch.js";
import { runRealDataValidation, MARKETS_RUNNER_PARAMS, grossParams, findingDigest } from "./research/realDataValidation.js";
import { marketsFixtureInstruments } from "./research/runRealDataValidation.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = join(HERE, "..", "..", "docs", "SESSION_EDGE_RESULTS.md");

/** Pinned from the one research run on the pinned fixture. Change only on purpose. */
const PINNED = {
  session: { family: 406, discoveries: 0, survivors: 0, resultHash: "ccc7a76ee9f182a3651b6a24afba6ae087eb65ececfbb728e0c62e32e3183a76" },
  familiesNet: { survivors: 0, digest: "aaf3ff8de87d8446f89eb6c282914ec906d3732109a837db0fd34d9b2b3551fc" },
  familiesGross: { survivors: 0, digest: "46ef5df02e26b3c649ae5ad9cab83e3912f1d9653b2eb9542899e6acac346f23" },
  meanReversion: { resultHash: "93b74705f31025eb2e4063ed145be8bf14d284ad41f1547fe66f040bf8f3bd74" },
};

let passed = 0;
const t = (name: string, fn: () => void) => { fn(); passed++; console.log(`ok - ${name}`); };

/** A seeded weekday-only H1 fixture; `drift(hour)` is added to every bar's log return at that UTC hour. */
function seededFixture(seed: number, drift: (hour: number) => number): { root: string; hash: string } {
  const root = join(process.env.TMPDIR ?? tmpdir(), `session-edge-${seed}-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  const dir = join(root, MARKETS_FIXTURE_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const bars: FixtureBar[] = [];
  let tm = Date.parse("2025-01-06T00:00:00Z");
  let p = 1.1;
  while (bars.length < 6000) {
    const d = new Date(tm);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
      const o = p;
      p = p * Math.exp(gauss() * 0.001 + drift(d.getUTCHours()));
      bars.push({ t: d.toISOString().replace(".000", ""), o: o.toFixed(6), h: (Math.max(o, p) * 1.0002).toFixed(6), l: (Math.min(o, p) * 0.9998).toFixed(6), c: p.toFixed(6) });
    }
    tm += 3600_000;
  }
  const body = serialiseBarsCsv(bars, "ohlc");
  writeFileSync(join(dir, "SIM.H1.csv"), body);
  const instruments = [{ symbol: "frxSIMSIM", assetClass: "fx", timeframe: "H1", ohlc: "ohlc", file: "SIM.H1.csv",
    sha256: createHash("sha256").update(body, "utf8").digest("hex"), bars: bars.length, first: bars[0]!.t, last: bars.at(-1)!.t,
    source: { name: "seeded", url: "-", request: "-", upstreamVerification: "-", upstreamDigest: "-", dropped: { partial: 0, outsideWindow: 0 } } }] as unknown as IntradayInstrumentSpec[];
  const hash = intradayDatasetHashOf(instruments);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: MARKETS_MANIFEST_VERSION, retrievedOn: "2026-11-11", windowEnd: "2030-01-01T00:00:00Z",
    barCapPerSeries: 0, datasetHash: hash, syntheticData: false, instruments, excluded: [] }));
  return { root, hash };
}

t("positive control: a planted 8bp drift at 14:00 UTC is discovered AND confirmed", () => {
  const { root, hash } = seededFixture(11, (h) => (h === 14 ? 0.0008 : 0));
  const r = runSessionResearch(root, hash);
  const hit = r.rows.find((x) => x.hypothesis.startsWith("hour 14:00"));
  assert.ok(hit?.survives, `planted hour not found: ${JSON.stringify(hit)}`);
  rmSync(root, { recursive: true, force: true });
});

t("negative control: a driftless series yields no survivor", () => {
  const { root, hash } = seededFixture(29, () => 0);
  const r = runSessionResearch(root, hash);
  assert.equal(r.survivors, 0, r.rows.filter((x) => x.survives).map((x) => x.key).join(","));
  rmSync(root, { recursive: true, force: true });
});

const session = runSessionResearch();
const mr = runMeanReversionReplay();
const { datasetHash, instruments } = marketsFixtureInstruments();
const familiesNet = runRealDataValidation({ instruments, datasetHash, params: MARKETS_RUNNER_PARAMS });
const familiesGross = runRealDataValidation({ instruments, datasetHash, params: grossParams(MARKETS_RUNNER_PARAMS) });

t("session research on real markets reproduces its pinned result", () => {
  assert.equal(session.family, PINNED.session.family);
  assert.equal(session.discoveries, PINNED.session.discoveries);
  assert.equal(session.survivors, PINNED.session.survivors);
  assert.equal(session.resultHash, PINNED.session.resultHash);
});

t("the seven strategy families on real markets reproduce their pinned result, net and gross of cost", () => {
  assert.equal(familiesNet.survivors.length, PINNED.familiesNet.survivors);
  assert.equal(findingDigest(familiesNet), PINNED.familiesNet.digest);
  assert.equal(familiesGross.survivors.length, PINNED.familiesGross.survivors);
  assert.equal(findingDigest(familiesGross), PINNED.familiesGross.digest);
  // The doc states these; pin them.
  for (const r of [familiesNet, familiesGross]) {
    assert.equal(r.fdr.familySize, 1512);
    assert.equal(r.instruments.length, 28);
    assert.equal(r.checks.cpcvViolations, 0);
    assert.equal(r.checks.walkForwardViolations, 0);
    assert.equal(r.checks.lookaheadViolations.length, 0);
  }
  for (const s of [...familiesNet.survivors, ...familiesGross.survivors]) {
    assert.equal(s.promotionCeiling, "SHADOW");
    assert.equal(s.liveAllowed, false);
  }
});

t("the redesigned Mean Reversion rule fires on real markets and its record is the pinned one", () => {
  assert.ok(mr.all.n >= 1000, `Mean Reversion fired only ${mr.all.n} times`);
  assert.equal(mr.resultHash, PINNED.meanReversion.resultHash);
  // Every group's net-of-spread mean is below its gross mean: costs were charged.
  for (const g of mr.groups) assert.ok(g.netR < g.grossR, `${g.timeframe}/${g.assetClass}: net ${g.netR} >= gross ${g.grossR}`);
});

t("the results doc is exactly what the code measures", () => {
  const generated = `${renderSessionMarkdown(session)}\n${renderMeanReversionMarkdown(mr)}`.trimEnd();
  assert.equal(readFileSync(DOC, "utf8").split("\n## The seven strategy families on the same data")[0]!.trimEnd(), generated);
});

console.log(`\n${passed} passed`);
