// Market Replay must step through its OWN candles (audit rank 45).
//
// What was wrong: replayStep never looked at the session's candles. It called
// analyzeMarket(s.symbol, s.timeframe), which re-fetches the CURRENT simulator
// state, and labelled the identical result with an increasing candleIndex — so
// the decision log was near-identical calls wearing different candle numbers.
// s.candles was used only for `.length`. A symbol outside the simulator's eight
// yielded candles = [] and the session opened anyway, reading "candle 0 of 0"
// and silently producing nothing on every Step.
//
// SAFETY: offline. Replay is observation only — it never places, modifies, or
// closes anything.

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";

const { replayStart, replayStep, replayStop } = await import("../aiBrain.js");
const { marketSimulator } = await import("../marketSimulator.js");

const COVERED = marketSimulator.symbols()[0]!.symbol;

test("a symbol with no simulator candles is refused with the reason and coverage", () => {
  const r = replayStart("V75", "M15") as Record<string, unknown>;
  assert.ok(r["error"], "an unreplayable symbol must be refused, not opened as an empty session");
  assert.match(String(r["error"]), /simulator candles/i);
  assert.ok(Array.isArray(r["availableSymbols"]), "the refusal must say what CAN be replayed");
  assert.ok((r["availableSymbols"] as string[]).length > 0);
  assert.ok(!("replayId" in r), "no session may be created for an unreplayable symbol");
});

test("stepping analyses a growing window of the session's own candles", () => {
  const started = replayStart(COVERED, "M15") as Record<string, unknown>;
  const replayId = String(started["replayId"]);
  assert.ok(replayId && replayId !== "undefined", "a covered symbol must open a session");
  assert.equal(started["strategyHonoured"], false, "replay must not claim to honour a strategy it ignores");

  try {
    const a = replayStep(replayId) as Record<string, unknown>;
    const b = replayStep(replayId) as Record<string, unknown>;
    const c = replayStep(replayId) as Record<string, unknown>;

    // The candle index advances over the session's real bar positions...
    assert.equal(Number(b["candleIndex"]) - Number(a["candleIndex"]), 1);
    assert.equal(Number(c["candleIndex"]) - Number(b["candleIndex"]), 1);

    // ...and each step is anchored to a DIFFERENT bar of that session, with the
    // bar's own timestamp and close. Under the old implementation these were
    // three reads of the same current tick.
    const times = [a, b, c].map((x) => String(x["candleTime"]));
    assert.equal(new Set(times).size, 3, "each step must be anchored to a distinct candle");
    for (const x of [a, b, c]) {
      assert.equal(typeof x["candleClose"], "number");
      assert.ok(Number(x["candleClose"]) > 0);
    }
    assert.ok(Number(a["stepsRemaining"]) > Number(c["stepsRemaining"]));
  } finally {
    replayStop(replayId);
  }
});

test("the replay finishes at the end of its candles instead of stepping forever", () => {
  const started = replayStart(COVERED, "M15") as Record<string, unknown>;
  const replayId = String(started["replayId"]);
  const steps = Number(started["steps"]);
  assert.ok(steps > 0 && Number.isFinite(steps));
  try {
    for (let i = 0; i < steps; i++) {
      const r = replayStep(replayId) as Record<string, unknown>;
      assert.ok(!r["finished"], `step ${i} should not report finished`);
    }
    const past = replayStep(replayId) as Record<string, unknown>;
    assert.equal(past["finished"], true, "stepping past the last candle must report finished");
  } finally {
    replayStop(replayId);
  }
});
