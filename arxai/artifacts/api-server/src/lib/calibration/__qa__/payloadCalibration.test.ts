// Every confidence-shaped payload carries a calibration reading.
//
//   - strategy engine: calibratedProbability + calibration{status,n,scope,…};
//     null + "unmeasured" with N when no fit is measured; WAIT is N=0
//   - AI review: calibratedProbability null + calibration unmeasured N=0
//     (a post-trade review makes no forecast); `calibrated:false` kept
//   - scanner rows: calibration with the cross-timeframe fallback; ranking
//     puts measured above unmeasured
//   - radar scans every standard chart timeframe, picks by calibration
//   - agents: influence comes only from the agent's own scored record; no
//     record, or a noise record, moves nothing
//   - refit worker started behind isPreviewSafeStart; trader route is scoped
//
// Run: pnpm --filter @workspace/api-server run test:calibration

import "./_offlineEnv.js";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeAgentAdvisory,
} from "@workspace/domain/agent-system";
import {
  fitCalibration,
  fitKey,
  gbmBars,
  POOLED,
  seededRandom,
  type CalibrationFit,
} from "@workspace/domain/calibration";
import {
  agentCalibrationKey,
  calibrate,
  clearCalibrationCache,
  replaceCalibrationCache,
  SCANNER_CALIBRATION_KEY,
} from "../cache.js";
import { runStrategyScan, type Candle } from "../../strategyEngine.js";
import { reviewTrade } from "../../aiReviewEngine.js";
import { rankScannerOpportunities, scannerCalibrationFields, type ScannerOpportunity } from "../../marketScanner.js";
import { measuredSnapshot } from "../../agentEcosystem/advisoryInfluence.js";
import { buildCalibrationSummary } from "../../../routes/calibration.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(resolve(here, "../../..", p), "utf8");

function noise(n: number, seed: number) {
  const r = seededRandom(seed);
  return Array.from({ length: n }, () => ({ score: Math.floor(r() * 50) + 45, outcome: (r() < 0.45 ? 1 : 0) as 0 | 1 }));
}
function skilled(n: number, seed: number) {
  const r = seededRandom(seed);
  return Array.from({ length: n }, () => {
    const score = r() * 100;
    return { score, outcome: (r() < 0.1 + 0.8 * (score / 100) ? 1 : 0) as 0 | 1 };
  });
}
function cache(entries: [string, CalibrationFit][], source = "test") {
  replaceCalibrationCache(entries.map(([k, fit]) => [k, { fit, version: 2, source, fittedAt: "2026-11-09T00:00:00.000Z" }]));
}

afterEach(() => clearCalibrationCache());

describe("strategy engine payload", () => {
  it("directional calls carry null + unmeasured with N when no fit exists; WAIT carries N=0", () => {
    const bars = gbmBars(4000, 5) as Candle[];
    let directional = 0;
    for (let i = 300; i < bars.length; i += 37) {
      const s = runStrategyScan("EURUSD", bars.slice(i - 250, i), 0, "forex", { timeframe: "M15" });
      assert.ok(s.calibration, "calibration always present");
      assert.equal(typeof s.calibration.n, "number");
      assert.equal(s.calibratedProbability, null);
      assert.equal(s.calibration.status, "unmeasured");
      assert.match(s.calibration.label, /^unmeasured \(N=\d+\)$/);
      assert.equal(s.advisory, "ADVISORY_UNCALIBRATED", "raw confidence still labelled uncalibrated");
      if (s.direction !== "WAIT") directional++;
    }
    assert.ok(directional > 0);
    const wait = runStrategyScan("EURUSD", [], 65);
    assert.equal(wait.calibration?.n, 0);
    assert.equal(wait.calibratedProbability, null);
  });

  it("a measured fit is served with its N, scope and version", () => {
    const fit = fitCalibration(noise(300, 1));
    cache([[fitKey("strategy:trend_continuation", POOLED, POOLED), fit]]);
    const c = calibrate("strategy:trend_continuation", "EURUSD", "M15", 88);
    assert.equal(c.status, "measured");
    assert.equal(c.n, 300);
    assert.equal(c.scope, "pooled_all");
    assert.equal(c.fitVersion, 2);
    assert.equal(c.probability, fit.baseRate);
  });
});

describe("AI review payload", () => {
  it("is null + unmeasured with N=0 and keeps calibrated:false", () => {
    const r = reviewTrade({
      trade: {
        symbol: "EURUSD", direction: "BUY", entryType: "MARKET", entryPrice: 1.1, exitPrice: 1.11,
        stopLoss: 1.09, takeProfit: 1.12, plannedEntryPrice: 1.1, riskAmount: 10, strategyTag: "x",
        reasonForEntry: "a", reasonForExit: "b", pnl: 10, status: "CLOSED",
      } as never,
    } as never);
    assert.equal(r.calibrated, false);
    assert.equal(r.calibratedProbability, null);
    assert.equal(r.calibration.status, "unmeasured");
    assert.equal(r.calibration.n, 0);
    assert.equal(r.calibration.label, "unmeasured (N=0)");
  });
});

describe("scanner rows", () => {
  it("read through the cross-timeframe fallback and say so", () => {
    cache([[fitKey(SCANNER_CALIBRATION_KEY, "EURUSD", "H1"), fitCalibration(noise(120, 2))]]);
    const f = scannerCalibrationFields("EURUSD", "M30", "BUY", 77);
    assert.equal(f.calibration.scope, "timeframe_fallback:H1");
    assert.equal(f.calibration.n, 120);
    assert.equal(typeof f.calibratedProbability, "number");
    const wait = scannerCalibrationFields("EURUSD", "M30", "WAIT", 77);
    assert.equal(wait.calibratedProbability, null);
    assert.equal(wait.calibration.n, 0);
  });

  it("rank measured rows above unmeasured rows across timeframes", () => {
    const row = (tf: string, score: number, p: number | null) =>
      ({ symbol: "EURUSD", timeframe: tf, opportunity: { score }, calibratedProbability: p } as unknown as ScannerOpportunity);
    const ranked = rankScannerOpportunities([row("M1", 95, null), row("H4", 40, 0.52), row("D1", 60, 0.47), row("M5", 70, null)]);
    assert.deepEqual(ranked.map((r) => r.timeframe), ["H4", "D1", "M1", "M5"]);
    assert.deepEqual(ranked.map((r) => r.rankBasis), ["calibrated_probability", "calibrated_probability", "unmeasured_raw_order", "unmeasured_raw_order"]);
  });

  it("the radar scans every standard chart timeframe and picks the primary one by calibration", () => {
    const radar = src("lib/opportunityRadar/radar.ts");
    assert.match(radar, /RADAR_TIMEFRAMES = \["M1", "M5", "M15", "M30", "H1", "H4", "D1"\] as const/);
    assert.match(radar, /rankScannerOpportunities\(rows\)\[0\]/);
    assert.match(radar, /rankByCalibration\(/);
  });
});

describe("agent influence comes only from the agent's scored record", () => {
  const base = { name: "Structure", department: "MARKET_STRUCTURE", registryAuthorityWeight: 1, currentStatus: "ACTIVE" };

  it("no record: zero influence even with full registry authority", () => {
    const s = measuredSnapshot({ agentKey: "structure-1", ...base });
    assert.equal(s.authorityWeight, 0);
    assert.equal(s.trustScore, 50);
    const adv = computeAgentAdvisory({ baseScore: 60, direction: "BUY", agents: [{ ...s, alignment: "SUPPORT" }] });
    assert.equal(adv.netDelta, 0);
    assert.equal(adv.influencingAgentCount, 0);
  });

  it("a noise agent with a long record ends at about zero influence", () => {
    cache([[fitKey(agentCalibrationKey("noise-1"), POOLED, POOLED), fitCalibration(noise(2000, 9))]], "agent_predictions");
    const s = measuredSnapshot({ agentKey: "noise-1", ...base });
    assert.equal(s.measuredTrust.n, 2000);
    assert.ok(s.authorityWeight <= 0.02, `influence ${s.authorityWeight}`);
    const adv = computeAgentAdvisory({ baseScore: 60, direction: "BUY", agents: [{ ...s, alignment: "SUPPORT" }] });
    assert.ok(Math.abs(adv.netDelta) <= 0.1, `netDelta ${adv.netDelta}`);
  });

  it("a skilled agent earns influence; registry authority can only lower it", () => {
    cache([[fitKey(agentCalibrationKey("skilled-1"), POOLED, POOLED), fitCalibration(skilled(1500, 10))]], "agent_predictions");
    const s = measuredSnapshot({ agentKey: "skilled-1", ...base });
    assert.ok(s.authorityWeight > 0.2, `influence ${s.authorityWeight}`);
    const muted = measuredSnapshot({ agentKey: "skilled-1", ...base, registryAuthorityWeight: 0 });
    assert.equal(muted.authorityWeight, 0);
  });

  it("the advisory snapshot no longer reads the registry trustScore", () => {
    const f = src("lib/agentEcosystem/advisoryInfluence.ts");
    assert.doesNotMatch(f, /trustScore:\s*r\.trustScore/);
    assert.match(f, /measuredSnapshot\(/);
  });
});

describe("worker gating and trader route scope", () => {
  it("the refit worker starts only behind isPreviewSafeStart", () => {
    assert.match(src("app.ts"), /if \(!isPreviewSafeStart\(\)\) startCalibrationRefitWorker\(\);/);
  });

  it("the trader summary lists replay fits per market, outcome fits pooled only, and never agents", () => {
    const fit = fitCalibration(noise(200, 11));
    replaceCalibrationCache([
      [fitKey("strategy:trend_continuation", "EURUSD", "M15"), { fit, version: 1, source: "strategy_replay", fittedAt: "" }],
      [fitKey("eleanor", "EURUSD", "M15"), { fit, version: 1, source: "eleanor_outcomes", fittedAt: "" }],
      [fitKey("eleanor", POOLED, POOLED), { fit, version: 1, source: "eleanor_outcomes", fittedAt: "" }],
      [fitKey(agentCalibrationKey("a"), POOLED, POOLED), { fit, version: 1, source: "agent_predictions", fittedAt: "" }],
    ]);
    const keys = buildCalibrationSummary().fits.map((f) => f.fitKey).sort();
    assert.deepEqual(keys, ["eleanor|*|*", "strategy:trend_continuation|EURUSD|M15"]);
    for (const f of buildCalibrationSummary().fits) {
      assert.ok(f.reliability.length > 0);
      assert.equal(typeof f.brier, "number");
      assert.equal(typeof f.n, "number");
    }
  });
});
