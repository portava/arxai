// Unit tests for the Broad-Market-Flow engine. Run via:
//   node --import tsx --test src/brain/timing/__qa__/broadFlowEngine.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:timing-broadflow`)
//
// Peer directions are injected so the verdict never depends on a live feed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBroadFlow, type BroadFlowDeps } from "../broadFlowEngine.js";

// Build a deterministic peer-direction lookup. Missing keys → null (no data).
function directions(map: Record<string, "BULL" | "BEAR" | "FLAT">): BroadFlowDeps["fetchDirection"] {
  return async (symbol: string) => map[symbol.toUpperCase()] ?? null;
}

test("synthetic symbol → NEUTRAL, self-contained (no peers)", async () => {
  const out = await computeBroadFlow("Volatility 75 Index", "BULL", {
    classify: () => "synthetic",
    fetchDirection: async () => "BULL",
  });
  assert.equal(out.verdict, "NEUTRAL");
  assert.equal(out.institutionalFlowScore, 50);
  assert.deepEqual(out.correlatedAssets, []);
});

test("symbol with no correlation peers → UNAVAILABLE", async () => {
  const out = await computeBroadFlow("AUDUSD", "BULL", {
    classify: () => "forex",
    fetchDirection: async () => "BULL",
  });
  assert.equal(out.verdict, "UNAVAILABLE");
  assert.equal(out.dataQuality, "unavailable");
});

test("all peers confirm self direction → ALIGNED", async () => {
  // EURUSD peers: GBPUSD(SAME), XAUUSD(SAME), USDJPY(INVERSE). Self BULL.
  const out = await computeBroadFlow("EURUSD", "BULL", {
    classify: () => "forex",
    fetchDirection: directions({ GBPUSD: "BULL", XAUUSD: "BULL", USDJPY: "BEAR" }),
  });
  assert.equal(out.verdict, "ALIGNED");
  assert.equal(out.dataQuality, "real");
  assert.equal(out.competingCatalyst, false);
});

test("more conflicts than confirms → CONFLICTED with competing catalyst", async () => {
  // GBPUSD confirms (BULL/SAME); XAUUSD conflicts (BEAR/SAME); USDJPY conflicts (BULL/INVERSE).
  const out = await computeBroadFlow("EURUSD", "BULL", {
    classify: () => "forex",
    fetchDirection: directions({ GBPUSD: "BULL", XAUUSD: "BEAR", USDJPY: "BULL" }),
  });
  assert.equal(out.verdict, "CONFLICTED");
  assert.equal(out.competingCatalyst, true);
});

test("all peers oppose self direction → OPPOSING", async () => {
  const out = await computeBroadFlow("EURUSD", "BULL", {
    classify: () => "forex",
    fetchDirection: directions({ GBPUSD: "BEAR", XAUUSD: "BEAR", USDJPY: "BULL" }),
  });
  assert.equal(out.verdict, "OPPOSING");
});

test("some peers return no data → dataQuality partial", async () => {
  const out = await computeBroadFlow("EURUSD", "BULL", {
    classify: () => "forex",
    fetchDirection: directions({ GBPUSD: "BULL", XAUUSD: "BULL" }), // USDJPY missing
  });
  assert.equal(out.dataQuality, "partial");
});

test("no peer returns data → UNAVAILABLE", async () => {
  const out = await computeBroadFlow("EURUSD", "BULL", {
    classify: () => "forex",
    fetchDirection: async () => null,
  });
  assert.equal(out.verdict, "UNAVAILABLE");
  assert.equal(out.dataQuality, "unavailable");
});
