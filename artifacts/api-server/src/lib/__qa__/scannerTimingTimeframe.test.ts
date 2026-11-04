// Each scanner row's timing read (grade, Go/Wait permission, heat chips and the
// score boost) must come from that row's OWN timeframe. Before the fix the read
// was computed once per symbol on M15 and copied into every timeframe row, so an
// H4 or M1 card showed an M15 "Go"/grade and had its score and label raised by
// a read from another timeframe.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/__qa__/scannerTimingTimeframe.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { ScannerOpportunity } from "../marketScanner.js";

const calls: string[] = [];
const real = await import("../../brain/timing/marketTimingBrainService.js");
mock.module("../../brain/timing/marketTimingBrainService.js", {
  namedExports: {
    ...real,
    computeTimingRead: async (req: { symbol: string; timeframe?: string }) => {
      const tf = req.timeframe ?? "M15";
      calls.push(`${req.symbol}:${tf}`);
      // Only the M15 read says GO / grade A; other timeframes say STAND_DOWN / F.
      const go = tf === "M15";
      return {
        symbol: req.symbol, timeframe: tf,
        heatScore: go ? 80 : 20, tradeabilityScore: go ? 80 : 20, edgeScore: go ? 70 : 10, dangerScore: go ? 10 : 80,
        timingGrade: go ? "A" : "F", entryPermission: go ? "GO" : "STAND_DOWN",
        heatState: go ? "HOT" : "COLD", bestAction: go ? "ENTER" : "STAND_DOWN", actionReason: "fixture",
        pressureBias: go ? "BUY" : "NEUTRAL",
        newsOverlay: { phase: "NONE" }, broadFlow: { verdict: "NEUTRAL" },
        session: { sessionName: "London", isKillZoneActive: false },
        trapProbability: 10, roomToMove: 60, dataQuality: { label: "real" },
      };
    },
  },
});

const { decorateOpportunitiesWithTimingContext } = await import("../marketScanner.js");

function row(timeframe: string, score: number, label: string): ScannerOpportunity {
  return { symbol: "XAUUSD", timeframe, opportunity: { score, label, factors: {} } } as unknown as ScannerOpportunity;
}

test("each row's timing read is computed on its own timeframe", async () => {
  calls.length = 0;
  const [m1, h4, m15] = await decorateOpportunitiesWithTimingContext([
    row("M1", 66, "WEAK"), row("H4", 66, "WEAK"), row("M15", 66, "WEAK"),
  ]);
  assert.deepEqual([...calls].sort(), ["XAUUSD:H4", "XAUUSD:M1", "XAUUSD:M15"]);
  for (const r of [m1, h4, m15]) {
    assert.ok(r?.timingContext, `${r?.timeframe} has a timing context`);
    assert.equal(r.timingContext.timeframe, r.timeframe, "timing context names the row's own timeframe");
  }
  // H4 and M1 did not inherit the M15 "Go" / grade A.
  assert.notEqual(h4?.timingContext?.entryPermission, "GO");
  assert.notEqual(m1?.timingContext?.timingGrade, "A");
  assert.equal(m15?.timingContext?.entryPermission, "GO");
});

test("a timing read from another timeframe never raises a row's score or label", async () => {
  const [h4] = await decorateOpportunitiesWithTimingContext([row("H4", 66, "WEAK")]);
  assert.ok((h4?.opportunity.score ?? 0) <= 66, `H4 score ${h4?.opportunity.score}`);
  assert.notEqual(h4?.opportunity.label, "ACCEPTABLE");
});

test("a timeframe the timing read does not support gets no timing context", async () => {
  calls.length = 0;
  const [w1] = await decorateOpportunitiesWithTimingContext([row("W1", 66, "WEAK")]);
  assert.equal(w1?.timingContext, undefined);
  assert.equal(w1?.opportunity.score, 66);
  assert.deepEqual(calls, []);
});
