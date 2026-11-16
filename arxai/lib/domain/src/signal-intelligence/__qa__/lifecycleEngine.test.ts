// Lifecycle engine — entry stages need a scanner-endorsed entry zone.
// Run: pnpm --filter @workspace/api-server run test:truth-component-evidence
// (this file is listed in that script, which root `ci` runs).
//
// levels-withheld-vs-shown RC5: the live producer never mapped the scanner's
// entry zone, so ENTRY_WINDOW_OPEN was unreachable and the market read reported
// "No precise entry level published yet" forever. The zone is now mapped; these
// cases lock that only a BUY/SELL scanner row with a zone can reach the entry
// stages, and that a WAIT row's geometry is never setup evidence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLifecycle } from "../lifecycleEngine.js";
import type {
  EarlyTrendReading,
  FakeoutReading,
  LateDetection,
  SignalScannerInput,
} from "../signalIntelligence.types.js";

const early = (over: Partial<EarlyTrendReading> = {}): EarlyTrendReading => ({
  pressure: "NEUTRAL",
  structure: "RANGE",
  bosChoch: "NONE",
  sweepDetected: false, failedBreakout: false, rejectionDetected: false,
  momentum: "STEADY",
  compression: false, score: 40, notes: [], blind: false,
  ...over,
});
const noTrap: FakeoutReading = { detected: false, kind: "NONE", confidence: 0, reason: null };
const trap: FakeoutReading = { detected: true, kind: "BULL_TRAP", confidence: 60, reason: "trap" };
const notLate: LateDetection = {
  isLate: false, doNotChase: false, reason: null, distanceFromEntryPct: null,
  percentOfMoveComplete: null, remainingRR: null, candleExtensionAtr: null,
} as LateDetection;
const scanner = (over: Partial<SignalScannerInput> = {}): SignalScannerInput => ({
  bias: "bullish", recommendedAction: "BUY", confidenceScore: 70, entrySniperScore: 70,
  setupType: "Trend", entry: 1.1, stopLoss: 1.09, takeProfit: 1.12,
  entryZone: { from: 1.0995, to: 1.1005 },
  ...over,
});
const base = { late: notLate, hasSufficientData: true, invalidated: false, expired: false };

test("BUY + entry zone + no trap → ENTRY_WINDOW_OPEN", () => {
  assert.equal(classifyLifecycle({ ...base, early: early(), fakeout: noTrap, scanner: scanner() }).stage, "ENTRY_WINDOW_OPEN");
});

test("BUY + entry zone + trap (confidence 60) → ENTRY_APPROACHING, never open", () => {
  assert.equal(classifyLifecycle({ ...base, early: early(), fakeout: trap, scanner: scanner() }).stage, "ENTRY_APPROACHING");
});

test("WAIT + entry zone + building pressure + no structure event → SETUP_FORMING (zone is not setup evidence)", () => {
  const v = classifyLifecycle({
    ...base, early: early({ pressure: "BUILDING_BULLISH" }), fakeout: noTrap,
    scanner: scanner({ recommendedAction: "WAIT" }),
  });
  assert.equal(v.stage, "SETUP_FORMING");
});

test("BUY without an entry zone and no structure event → not an entry stage", () => {
  const v = classifyLifecycle({ ...base, early: early(), fakeout: noTrap, scanner: scanner({ entryZone: null }) });
  assert.notEqual(v.stage, "ENTRY_WINDOW_OPEN");
  assert.notEqual(v.stage, "ENTRY_APPROACHING");
});
