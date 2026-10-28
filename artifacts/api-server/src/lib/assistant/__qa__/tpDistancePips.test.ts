// Truth regression: TP distancePips is labelled "pips", so it must use the
// symbol's own pip size. The old formula was price distance × 10000 for every
// symbol (USDJPY 0.25 → 2500 "pips"). Unknown pip size ⇒ null, never a guess.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTpTargets } from "../liveScanner.js";
import { deriveTakeProfitTargets } from "../../data/opportunityAdapters.js";

test("liveScanner TP targets: USDJPY 0.25 stop distance is 25 pips, not 2500", () => {
  const out = buildTpTargets("USDJPY", "BUY", 150.0, 0.25, 151, 149, 0);
  const tp1 = out.targets.find((t) => t.label === "TP1")!;
  assert.equal(tp1.price, 150.25);
  assert.equal(tp1.distancePips, 25);
  const tp2 = out.targets.find((t) => t.label === "TP2")!;
  assert.equal(tp2.distancePips, 50);
});

test("liveScanner TP targets: EURUSD keeps the 4-digit pip count", () => {
  const out = buildTpTargets("EURUSD", "SELL", 1.085, 0.002, 1.09, 1.08, 0);
  const tp1 = out.targets.find((t) => t.label === "TP1")!;
  assert.equal(tp1.distancePips, 20);
});

test("liveScanner TP targets: unknown symbol gives null pips, not a forex guess", () => {
  const out = buildTpTargets("NOTAREALSYMBOL", "BUY", 100, 1, 110, 90, 0);
  for (const t of out.targets) assert.equal(t.distancePips, null);
});

test("opportunity adapter TP targets: USDJPY is 25 pips; XAUUSD is not ×10000", () => {
  const jpy = deriveTakeProfitTargets("BUY", 150.0, 149.75, "USDJPY");
  assert.equal(jpy.targets.find((t) => t.label === "TP1")!.distancePips, 25);
  const gold = deriveTakeProfitTargets("BUY", 2380, 2370, "XAUUSD");
  const g1 = gold.targets.find((t) => t.label === "TP1")!;
  assert.notEqual(g1.distancePips, 100000);
  assert.equal(g1.distancePoints, 10);
});

test("opportunity adapter TP targets without a symbol: pips null", () => {
  const out = deriveTakeProfitTargets("BUY", 1.1, 1.099);
  for (const t of out.targets) assert.equal(t.distancePips, null);
});
