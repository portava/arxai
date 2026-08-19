// Deterministic honesty lock for the Market Impact Radar. Run via:
//   pnpm --filter @workspace/api-server run test:market-heat-radar-honesty
//
// NON-NEGOTIABLE HONESTY: with no live economic-calendar provider connected the
// radar NEVER fabricates a scheduled event and NEVER reads as a confident
// all-clear. The disconnected note must say events are not fabricated, the event
// list must be empty, and the summary must name the missing provider rather than
// implying "no events". Synthetic instruments are never driven by macro events.
// Advisory only — the radar carries no execution field of any kind.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMarketImpactRadar } from "../marketImpactRadar.js";

const NOW = Date.parse("2026-06-19T12:00:00.000Z");

test("radar: disconnected calendar yields zero fabricated events + honest note", async () => {
  const { radar } = await buildMarketImpactRadar("EURUSD", NOW);
  // This environment has no live economic-calendar provider connected.
  assert.equal(radar.provider.connected, false);
  assert.deepEqual(radar.events, []);
  // The absence of a warning is NOT an all-clear — the note must say so by
  // explicitly stating events are not fabricated.
  assert.match(radar.provider.note, /none are fabricated/i);
  // The summary must name the missing provider, never imply a confident
  // "no events" all-clear.
  assert.match(radar.summary, /no live economic-calendar provider is connected/i);
  assert.doesNotMatch(radar.summary, /low risk/i);
});

test("radar: disconnected calendar reports no high-impact window + null top severity", async () => {
  const { radar } = await buildMarketImpactRadar("XAUUSD", NOW);
  assert.equal(radar.highImpactWindowActive, false);
  assert.equal(radar.topSeverity, null);
});

test("radar: synthetic instrument is never driven by macro events", async () => {
  const { radar } = await buildMarketImpactRadar("Volatility 75 Index", NOW);
  assert.deepEqual(radar.events, []);
  assert.match(radar.summary, /synthetic instrument/i);
  assert.match(radar.summary, /not driven by real-world economic events/i);
});

test("radar: result is advisory-only — carries no execution field", async () => {
  const result = await buildMarketImpactRadar("EURUSD", NOW);
  const blob = JSON.stringify(result).toLowerCase();
  assert.equal(blob.includes("allowexecution"), false);
  assert.equal(blob.includes("alloworderexecution"), false);
  assert.equal(blob.includes("cantrade"), false);
  assert.equal(blob.includes("liveunlock"), false);
});
