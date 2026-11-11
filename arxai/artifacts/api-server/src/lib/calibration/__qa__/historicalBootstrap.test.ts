// Historical bootstrap on REAL committed history — measured, with provenance.
//
//   1. Fixture discovery verifies every real-history-* fixture (pinned hash,
//      file sha256) and refuses a tampered or re-hashed copy.
//   2. Replaying the committed fixtures gives every strategy that fires on
//      daily bars a MEASURED fit with N >= 30; strategies that cannot fire on
//      daily bars say why. Results are printed as measured.
//   3. Every calibration stamp read after the bootstrap carries provenance
//      (source, fixture id + dataset hash, live vs replay N); a stamp with no
//      fit carries basis "none".
//   4. The precedence rule: live only once live N >= 30, else live + replay.
//   5. Driftless GBM through the same replay path converges to the base rate
//      with edgeDetected false (strategies and agents).
//   6. Planted momentum is DETECTED through the same path (a momentum probe
//      read on the replayed scanner calls), so "no edge" on real history is a
//      finding, not a blind test.
//   7. Agents: the replayable ones get a graded record; the rest report the
//      reason they have none; noise agents on the real outcomes end at 0.
//   8. Session Breakout reads the session of the bar's own time.
//
// Run: pnpm --filter @workspace/api-server run test:calibration

import "./_offlineEnv.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { stableStringify } from "@workspace/features/event-chain";
import {
  CALIBRATION_MIN_SAMPLE,
  gbmBars,
  measureAgentTrust,
  momentumBars,
  POOLED,
  fitKey,
  seededRandom,
} from "@workspace/domain/calibration";
import { CORE_AGENTS } from "@workspace/domain/agent-system";
import { discoverRealHistoryFixtures, findFixturesRoot, PINNED_REAL_HISTORY } from "../historicalFixtures.js";
import { historicalReplayEvidence, replaySeries, type HistoricalEvidence } from "../historicalBootstrap.js";
import { agentReport, formatReport, strategyReport } from "../bootstrapReport.js";
import { buildFitGroups } from "../fitGroups.js";
import { composeEvidence, type TimedSample } from "../provenance.js";
import {
  agentCalibrationKey,
  calibrate,
  clearCalibrationCache,
  replaceCalibrationCache,
  strategyCalibrationKey,
} from "../cache.js";
import { AGENT_REPLAY_SPECS, REPLAYABLE_AGENT_KEYS, replayAgents, type ReplayScorer } from "../agentReplay.js";
import { REPLAYABLE_STRATEGIES } from "../strategyReplay.js";
import { measuredSnapshot } from "../../agentEcosystem/advisoryInfluence.js";
import { sessionBreakoutStrategy, type Candle } from "../../strategyEngine.js";

const V1 = "real-history-v1";
/** Strategies whose rules can fire on daily OHLC / close-fixing bars. */
const DAILY_FIRING = ["Trend Continuation", "Break of Structure", "Liquidity Sweep Reversal", "Volatility Expansion", "Pullback Continuation"];

let ev: HistoricalEvidence;

before(async () => {
  ev = await historicalReplayEvidence(discoverRealHistoryFixtures());
});
after(() => clearCalibrationCache());

describe("real-history fixture discovery", () => {
  it("finds and verifies the pinned committed fixture", () => {
    const d = discoverRealHistoryFixtures();
    const f = d.fixtures.find((x) => x.fixtureId === V1);
    assert.ok(f, `fixture ${V1} under ${d.root}; skipped=${JSON.stringify(d.skipped)}`);
    assert.equal(f.pinned, true);
    assert.equal(f.datasetHash, PINNED_REAL_HISTORY[V1]);
    assert.equal(f.series.length, 10);
    assert.ok(f.series.every((s) => s.timeframe === "D1" && s.candles.length >= 1800));
  });

  it("refuses a tampered file, and a re-hashed copy under the pinned name", () => {
    const root = findFixturesRoot();
    assert.ok(root);
    const tmp = mkdtempSync(join(tmpdir(), "arx-fixtures-"));
    try {
      // (a) a byte changed in one file: sha256 mismatch.
      cpSync(join(root, V1), join(tmp, "real-history-tampered"), { recursive: true });
      const csv = join(tmp, "real-history-tampered", "BTCUSDT.binance.1d.csv");
      writeFileSync(csv, readFileSync(csv, "utf8").replace("13715.65", "13715.66"));
      // (b) the manifest edited and its datasetHash recomputed, under the
      //     pinned name: self-consistent, but not the pinned dataset.
      cpSync(join(root, V1), join(tmp, V1), { recursive: true });
      const mp = join(tmp, V1, "manifest.json");
      const m = JSON.parse(readFileSync(mp, "utf8"));
      m.instruments[0].first = "2018-01-02";
      m.datasetHash = createHash("sha256").update(stableStringify(m.instruments)).digest("hex");
      writeFileSync(mp, JSON.stringify(m));
      // (c) an unpinned verbatim copy verifies, reported pinned=false.
      cpSync(join(root, V1), join(tmp, "real-history-copy"), { recursive: true });
      const d = discoverRealHistoryFixtures(tmp);
      const skipped = Object.fromEntries(d.skipped.map((s) => [s.fixtureId, s.reason]));
      assert.match(skipped["real-history-tampered"] ?? "", /sha256/);
      assert.match(skipped[V1] ?? "", /not the pinned/);
      const copy = d.fixtures.find((f) => f.fixtureId === "real-history-copy");
      assert.ok(copy);
      assert.equal(copy.pinned, false);
      assert.equal(d.fixtures.length, 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("bootstrap on the committed real history", () => {
  it("measures every strategy that fires on daily bars with N >= 30, and says why the others cannot", () => {
    const rows = strategyReport(ev);
    const agents = agentReport(ev);
    process.stdout.write(`[historical-bootstrap] ${ev.discovery.fixtures.map((f) => `${f.fixtureId}@${f.datasetHash.slice(0, 12)}`).join(",")}\n${formatReport(rows, agents)}\n`);
    assert.equal(rows.length, REPLAYABLE_STRATEGIES.length);
    for (const name of DAILY_FIRING) {
      const r = rows.find((x) => x.strategy === name);
      assert.ok(r, name);
      assert.equal(r.status, "measured", `${name}: ${JSON.stringify(r)}`);
      assert.ok(r.n >= CALIBRATION_MIN_SAMPLE, `${name}: N=${r.n}`);
      assert.equal(r.provenance.basis, "replay_only");
      assert.ok(r.provenance.components.every((c) => c.source === "historical_replay" && c.fixtureId && c.datasetHash && c.sha256));
    }
    for (const r of rows.filter((x) => x.n < CALIBRATION_MIN_SAMPLE)) {
      assert.ok(r.note, `${r.strategy} below N=30 must say why`);
    }
    // Session Breakout now replays on bar time and the intraday fixture gives
    // it London/NY bars: it must be MEASURED, not merely explained.
    if (ev.discovery.fixtures.some((f) => f.fixtureId === "real-history-intraday-v1")) {
      const sb = rows.find((x) => x.strategy === "Session Breakout");
      assert.equal(sb?.status, "measured", `Session Breakout: ${JSON.stringify(sb)}`);
      assert.ok((sb?.n ?? 0) >= CALIBRATION_MIN_SAMPLE);
    }
    // Mean Reversion was a KNOWN DEFECT until 2026-11-11: it required RSI(14) < 28
    // AND a 20-bar close range under 1.2 x ATR, which exclude each other, so it
    // fired 0 times. Redesigned (close in the outer 20% of the prior range +
    // RSI exhaustion + wick rejection), it must now be MEASURED on the
    // committed real history like every other firing strategy.
    const mr = rows.find((x) => x.strategy === "Mean Reversion");
    assert.equal(mr?.status, "measured", `Mean Reversion: ${JSON.stringify(mr)}`);
    assert.ok((mr?.n ?? 0) >= CALIBRATION_MIN_SAMPLE, `Mean Reversion: N=${mr?.n}`);
  });

  it("puts provenance on every stamp a payload reads", () => {
    const entries: [string, { fit: ReturnType<typeof buildFitGroups>[number]["fit"]; version: number; source: string; fittedAt: string; provenance: ReturnType<typeof buildFitGroups>[number]["provenance"] }][] = [];
    for (const [strategy, samples] of ev.strategies) {
      for (const g of buildFitGroups(strategy, samples)) {
        entries.push([g.fitKey, { fit: g.fit, version: 1, source: g.source, fittedAt: new Date().toISOString(), provenance: g.provenance }]);
      }
    }
    replaceCalibrationCache(entries);
    const symbols = [...new Set(ev.discovery.fixtures.flatMap((f) => f.series.map((s) => s.symbol))), "NOT_IN_HISTORY"];
    let measured = 0;
    for (const { name } of REPLAYABLE_STRATEGIES) {
      for (const sym of symbols) {
        for (const tf of ["D1", "H4", "M5"]) {
          for (const score of [40, 70, 95]) {
            const st = calibrate(strategyCalibrationKey(name), sym, tf, score);
            assert.ok(st.provenance, `${name} ${sym} ${tf}: provenance`);
            assert.ok(st.source, `${name} ${sym} ${tf}: source`);
            if (st.status === "measured") {
              measured++;
              assert.equal(st.source, "historical_replay");
              assert.equal(st.provenance.basis, "replay_only");
              assert.ok(st.provenance.replayN >= CALIBRATION_MIN_SAMPLE);
              // Every fixture behind a measured number is a discovered,
              // verified real-history fixture named with its PINNED dataset
              // hash. Which ones depends on which fixtures fired for this key
              // (daily real-history-v1, intraday real-history-intraday-v1, …),
              // so pin the provenance contract, not one fixture id.
              const discovered = new Set(ev.discovery.fixtures.map((f) => f.fixtureId));
              assert.ok(st.provenance.fixtures.length > 0, `${name} ${sym} ${tf}: names its fixtures`);
              for (const f of st.provenance.fixtures) {
                assert.ok(discovered.has(f.fixtureId), `${name} ${sym} ${tf}: ${f.fixtureId} was discovered`);
                assert.equal(f.datasetHash, PINNED_REAL_HISTORY[f.fixtureId], `${name} ${sym} ${tf}: ${f.fixtureId} pinned hash`);
              }
              // A borrowed number says it is borrowed.
              if (sym === "NOT_IN_HISTORY") assert.notEqual(st.scope, "exact");
            } else {
              assert.equal(st.provenance.basis, st.fitKey ? st.provenance.basis : "none");
            }
          }
        }
      }
    }
    assert.ok(measured > 0);
    clearCalibrationCache();
    const empty = calibrate(strategyCalibrationKey("Trend Continuation"), "EURUSD", "D1", 80);
    assert.equal(empty.status, "unmeasured");
    assert.equal(empty.source, "none");
    assert.equal(empty.provenance.basis, "none");
  });

  it("is deterministic: the same fixture bytes give the same evidence digests", async () => {
    const { clearHistoricalReplayCache } = await import("../historicalBootstrap.js");
    const digests = (e: HistoricalEvidence) =>
      [...e.strategies].map(([k, s]) => `${k}:${composeEvidence(s).provenance.digest}`).sort();
    const a = digests(ev);
    clearHistoricalReplayCache();
    const b = digests(await historicalReplayEvidence(discoverRealHistoryFixtures()));
    assert.deepEqual(a, b);
  });
});

describe("precedence: live outcomes over replay at the same key", () => {
  const comp = (kind: "live" | "replay", id: string) => ({ id, kind, source: kind === "live" ? "eleanor_outcomes" : "historical_replay" });
  const mk = (n: number, kind: "live" | "replay", t0: number): TimedSample[] =>
    Array.from({ length: n }, (_, i) => ({ score: 50 + (i % 40), outcome: (i % 3 === 0 ? 1 : 0) as 0 | 1, at: new Date(t0 + i * 60_000), symbol: "X", timeframe: "M5", component: comp(kind, `${kind}:x`) }));

  it("live N >= 30 → live only, replay listed as excluded", () => {
    const r = composeEvidence([...mk(500, "replay", 0), ...mk(30, "live", 1e12)]);
    assert.equal(r.provenance.basis, "live_only");
    assert.equal(r.samples.length, 30);
    assert.equal(r.provenance.excluded[0]?.n, 500);
  });
  it("0 < live N < 30 → live + replay, both listed", () => {
    const r = composeEvidence([...mk(500, "replay", 0), ...mk(29, "live", 1e12)]);
    assert.equal(r.provenance.basis, "live_plus_replay");
    assert.equal(r.samples.length, 529);
    assert.deepEqual(r.provenance.components.map((c) => [c.kind, c.n]), [["live", 29], ["replay", 500]]);
  });
  it("no live outcome → replay only", () => {
    const r = composeEvidence(mk(40, "replay", 0));
    assert.equal(r.provenance.basis, "replay_only");
    assert.equal(r.provenance.liveN, 0);
  });
});

const control = (label: string) => ({ id: `control:${label}`, kind: "replay" as const, source: "control" });

/** Reads the last bar's return in the call's direction. Skilled only when
 *  returns persist; on a martingale it is noise. */
const momentumProbe: ReplayScorer = {
  key: "MOMENTUM_PROBE",
  strength: (ctx, c, i) => {
    const r = Math.log(c[i].close / c[i - 1].close) * (ctx.direction === "BUY" ? 1 : -1);
    return 1 / (1 + Math.exp(-r / 0.002));
  },
};

describe("controls through the same replay path", () => {
  it("driftless GBM: every measured strategy and agent converges to the base rate, edgeDetected false", async () => {
    const e = await replaySeries([1, 2, 3].map((seed) => ({ candles: gbmBars(20_000, seed) as Candle[], symbol: `GBM${seed}`, timeframe: "M1", component: control(`gbm${seed}`) })));
    let measured = 0;
    for (const r of strategyReport(e)) {
      if (r.status !== "measured") continue;
      measured++;
      assert.equal(r.model, "base_rate", `${r.strategy}`);
      assert.equal(r.edgeDetected, false, `${r.strategy} lower95=${r.improvementLower95}`);
    }
    assert.ok(measured >= 5, `measured ${measured}`);
    // Session Breakout now replays: intraday bars put it in its sessions.
    assert.ok((strategyReport(e).find((r) => r.strategy === "Session Breakout")?.n ?? 0) >= CALIBRATION_MIN_SAMPLE);
    for (const a of agentReport(e).filter((x) => x.n > 0)) {
      assert.equal(a.edgeDetected, false, `${a.agentKey}: ${a.basis}`);
      assert.equal(a.influence, 0, `${a.agentKey}: ${a.basis}`);
    }
    const probe = measureAgentTrust("probe", [1, 2, 3].flatMap((seed) => replayAgents(gbmBars(20_000, seed) as Candle[], `GBM${seed}`, "M1", { scorers: [momentumProbe] })));
    assert.equal(probe.fit.edgeDetected, false, probe.basis);
    assert.equal(probe.influence, 0);
  });

  it("planted momentum: the probe's edge is detected and earns influence", () => {
    const recs = [1, 2, 3].flatMap((seed) => replayAgents(momentumBars(20_000, seed) as Candle[], `MOM${seed}`, "M1", { scorers: [momentumProbe] }));
    const t = measureAgentTrust("probe", recs);
    process.stdout.write(`[historical-bootstrap] planted momentum probe n=${t.n} ${t.basis} influence=${t.influence}\n`);
    assert.equal(t.fit.edgeDetected, true, t.basis);
    assert.ok(t.influence > 0, t.basis);
    assert.equal(t.fit.model, "isotonic");
  });
});

describe("agents on the committed real history", () => {
  it("every replayable agent gets a graded record; the rest say why they have none", () => {
    const rows = agentReport(ev);
    assert.equal(rows.length, CORE_AGENTS.length);
    for (const r of rows) {
      if (REPLAYABLE_AGENT_KEYS.includes(r.agentKey)) {
        assert.equal(r.status, "measured", r.agentKey);
        assert.ok(r.n >= CALIBRATION_MIN_SAMPLE, `${r.agentKey} N=${r.n}`);
      } else {
        assert.equal(r.n, 0);
        assert.equal(r.influence, 0);
        assert.match(r.basis, /^no_replayable_record:/, r.agentKey);
        assert.equal(AGENT_REPLAY_SPECS[r.agentKey]?.replayable, false);
      }
    }
  });

  it("the served snapshot reads the replayed fit, and influence equals the report", () => {
    const entries: [string, { fit: ReturnType<typeof buildFitGroups>[number]["fit"]; version: number; source: string; fittedAt: string }][] = [];
    for (const [k, samples] of ev.agents) {
      for (const g of buildFitGroups(k, samples, { exact: false })) entries.push([g.fitKey, { fit: g.fit, version: 1, source: g.source, fittedAt: "" }]);
    }
    replaceCalibrationCache(entries);
    const report = new Map(agentReport(ev).map((r) => [r.agentKey, r]));
    for (const a of CORE_AGENTS) {
      const snap = measuredSnapshot({ agentKey: a.agentKey, name: a.name, department: a.department, registryAuthorityWeight: 1, currentStatus: "ACTIVE" });
      assert.equal(snap.measuredTrust.influence, report.get(a.agentKey)?.influence, a.agentKey);
      assert.equal(snap.measuredTrust.n, report.get(a.agentKey)?.n, a.agentKey);
      assert.ok(snap.authorityWeight <= snap.measuredTrust.influence);
      // What the admin agents route serves: an agent with no replayable record
      // carries its stated reason, never a bare "unmeasured".
      if (!REPLAYABLE_AGENT_KEYS.includes(a.agentKey)) {
        assert.equal(snap.measuredTrust.influence, 0, a.agentKey);
        assert.match(snap.measuredTrust.basis, /^no_replayable_record:.{10,}/, a.agentKey);
        assert.equal(snap.measuredTrust.basis, report.get(a.agentKey)?.basis, a.agentKey);
      }
    }
    assert.ok(entries.some(([k]) => k === fitKey(agentCalibrationKey("STRUCT"), POOLED, POOLED)));
    clearCalibrationCache();
  });

  it("noise agents scored on the REAL graded calls still end at zero influence", () => {
    const real = ev.agents.get(agentCalibrationKey("STRUCT")) ?? [];
    assert.ok(real.length >= 100);
    let sum = 0;
    let max = 0;
    for (let seed = 0; seed < 100; seed++) {
      const r = seededRandom(9000 + seed);
      const t = measureAgentTrust(`noise-${seed}`, real.map((s) => ({ score: Math.floor(r() * 101), outcome: s.outcome })));
      sum += t.influence;
      max = Math.max(max, t.influence);
    }
    process.stdout.write(`[historical-bootstrap] noise on real outcomes: mean influence ${(sum / 100).toFixed(4)} max ${max.toFixed(3)} (n=${real.length})\n`);
    assert.ok(sum / 100 < 0.01, `mean ${sum / 100}`);
    assert.ok(max <= 0.25, `max ${max}`);
  });
});

describe("Session Breakout reads the bar's own session", () => {
  // 40 hourly bars: a flat range, then an expanding breakout on the last bars.
  function bars(lastHourUtc: number): Candle[] {
    const out: Candle[] = [];
    const end = Date.UTC(2025, 0, 6, lastHourUtc);
    for (let k = 39; k >= 0; k--) {
      const i = 39 - k;
      const breakout = i >= 34;
      const base = breakout ? 100 + (i - 33) * 1.5 : 100 + Math.sin(i) * 0.2;
      out.push({ time: new Date(end - k * 3_600_000).toISOString(), open: base - 0.1, high: base + (breakout ? 1.2 : 0.3), low: base - (breakout ? 1.2 : 0.3), close: base + 0.1, volume: 1 });
    }
    return out;
  }
  it("fires on a London-session bar and stays inactive on an Asia-session bar, whatever the wall clock", () => {
    const london = sessionBreakoutStrategy(bars(9), "TEST");
    const asia = sessionBreakoutStrategy(bars(3), "TEST");
    assert.equal(london.direction, "BUY", london.reason);
    assert.match(london.reason, /London/);
    assert.equal(asia.direction, "WAIT");
    assert.match(asia.reason, /inactive during Asia/);
  });
});
