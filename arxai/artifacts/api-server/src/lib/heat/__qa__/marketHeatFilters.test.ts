// Deterministic lock for the Market Heat view filters (Task step 4): the
// `symbols`, `countries`, and `session` params must FUNCTIONALLY narrow the heat
// universe — they are not decorative. Run via:
//   pnpm --filter @workspace/api-server run test:market-heat-filters
//
// These are presentation filters only: they restrict WHICH markets are shown,
// never relax an honesty rule and never gate a trade. Provider status is always
// reported regardless of the filter so a narrowed view can never look like a
// confident all-clear. Runs offline: the price router is try/caught into an
// honest UNAVAILABLE, so synthetics still appear as price-only verdicts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMarketHeat } from "../marketHeatService.js";

const TF = "M15";
const opts = { timeframe: TF, includeNews: true, includeCalendar: true };

test("symbols filter: a single forex symbol excludes all synthetics", async () => {
  const full = await buildMarketHeat(opts);
  const filtered = await buildMarketHeat({ ...opts, symbols: ["EURUSD"] });

  assert.equal(filtered.synthetics.length, 0);
  // EURUSD only depends on US + Eurozone — never another country.
  const keys = new Set(filtered.countries.map((c) => c.key));
  for (const k of keys) assert.ok(k === "US" || k === "Eurozone", `unexpected ${k}`);
  // Filtering genuinely narrows the universe.
  assert.ok(filtered.countries.length <= full.countries.length);
  assert.ok(full.synthetics.length > 0);
  // Provider honesty is preserved under the filter (price/news/calendar rows
  // are always present so a narrowed view can't look like a confident all-clear).
  assert.ok(filtered.providerStatus.price);
  assert.ok(filtered.providerStatus.news);
  assert.ok(filtered.providerStatus.calendar);
});

test("symbols filter: a single synthetic keeps only that synthetic, no countries", async () => {
  const filtered = await buildMarketHeat({ ...opts, symbols: ["V75"] });
  assert.equal(filtered.synthetics.length, 1);
  assert.equal(filtered.countries.length, 0);
});

test("countries filter: restricts returned country verdicts to the requested key", async () => {
  const filtered = await buildMarketHeat({ ...opts, countries: ["US"] });
  assert.ok(filtered.countries.length >= 1);
  for (const c of filtered.countries) assert.equal(c.key, "US");
});

test("countries filter is case-insensitive on the country key", async () => {
  const lower = await buildMarketHeat({ ...opts, countries: ["us"] });
  for (const c of lower.countries) assert.equal(c.key, "US");
  assert.ok(lower.countries.length >= 1);
});

test("session filter: EURUSD belongs to London, not Tokyo", async () => {
  const london = await buildMarketHeat({ ...opts, symbols: ["EURUSD"], session: "london" });
  const tokyo = await buildMarketHeat({ ...opts, symbols: ["EURUSD"], session: "tokyo" });

  // London session includes EUR markets → EURUSD survives the combined filter.
  assert.ok(london.countries.length >= 1);
  // Tokyo session is JPY/CNY → EURUSD is filtered out entirely.
  assert.equal(tokyo.countries.length, 0);
  assert.equal(tokyo.currencies.length, 0);
});

test("session filter: synthetics are always in-session (24/7)", async () => {
  const tokyo = await buildMarketHeat({ ...opts, session: "tokyo" });
  // Synthetics trade 24/7 and must never be dropped by a session view.
  assert.ok(tokyo.synthetics.length > 0);
});

test("filtered bundle never carries an execution field (advisory only)", async () => {
  const filtered = await buildMarketHeat({ ...opts, symbols: ["EURUSD"] });
  const blob = JSON.stringify(filtered).toLowerCase();
  assert.equal(blob.includes("allowexecution"), false);
  assert.equal(blob.includes("alloworderexecution"), false);
  assert.equal(blob.includes("cantrade"), false);
});
