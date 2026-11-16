// Task #542 — per-symbol Deriv synthetic feed honesty.
//
// Phase 1B: getDerivSymbolFeedStatus must tell ONE honest per-symbol story —
// LIVE_FEED / hasRecentTick is gated on THIS symbol's own cached tick, never a
// sibling synthetic's. This locks the fix to be ACCURATE: it fixes the
// false-negative (a genuinely-ticking symbol reads LIVE) WITHOUT introducing a
// false-positive (a stale tick, or a sibling ticking, never reads THIS symbol
// as live).
//
// Phase 2 (copy/category side): the new live-entry-floor reason
// SYNTHETIC_FEED_NOT_LIVE_CONFIRMED is classified as a TRANSIENT TECHNICAL
// state — never the permanent broker-enforced data-only floor.
//
// Determinism: the WS client is a fresh singleton in this test process. We
// stub ensureConnection() so no real socket opens, force the connected /
// active-symbols state, and seed the per-symbol tick cache directly. No DB or
// network is touched (categorizeLiveBlock is a pure map lookup).

import { test } from "node:test";
import assert from "node:assert/strict";

import { getDerivWsClient } from "../derivWsClient.js";
import { getDerivSymbolFeedStatus, resolveDerivSymbol } from "../derivProvider.js";
import { categorizeLiveBlock } from "../../../governance/effectiveGovernance.js";

// Force "configured" and keep the AUTH_FAILED branch out of play (no token).
const ORIGINAL_APP_ID = process.env.DERIV_APP_ID;
const ORIGINAL_TOKEN = process.env.DERIV_API_TOKEN;
process.env.DERIV_APP_ID = ORIGINAL_APP_ID && ORIGINAL_APP_ID.trim() ? ORIGINAL_APP_ID : "test-app-id";
delete process.env.DERIV_API_TOKEN;

// Seed a deterministic, fully-connected client with NO real socket.
const client = getDerivWsClient() as unknown as {
  ensureConnection: () => void;
  connected: boolean;
  activeSymbolsCount: number | null;
  authorized: boolean;
  lastAuthorizeError: string | null;
  lastTickAt: number | null;
  lastTickBySymbol: Map<string, { symbol: string; epoch: number; quote: number }>;
};
client.ensureConnection = () => {};
client.connected = true;
client.activeSymbolsCount = 14; // active_symbols loaded → HISTORY_READY when no tick
client.authorized = false;
client.lastAuthorizeError = null;
client.lastTickAt = null;
client.lastTickBySymbol = new Map();

const liveSym = resolveDerivSymbol("V75");
const otherSym = resolveDerivSymbol("V100");
assert.ok(liveSym && otherSym && liveSym.derivId !== otherSym.derivId, "V75/V100 resolve to distinct deriv ids");

const nowSec = Math.floor(Date.now() / 1000);
const seedTick = (derivId: string, ageSec: number) =>
  client.lastTickBySymbol.set(derivId, { symbol: derivId, epoch: nowSec - ageSec, quote: 100 });

test("the ticking symbol reads LIVE_FEED (false-negative fixed)", () => {
  client.lastTickBySymbol.clear();
  seedTick(liveSym!.derivId, 0);
  const s = getDerivSymbolFeedStatus("V75");
  assert.equal(s.resolved, true);
  assert.equal(s.derivId, liveSym!.derivId);
  assert.equal(s.hasRecentTick, true);
  assert.equal(s.feedReadinessState, "LIVE_FEED");
  assert.ok(s.lastTickAt && s.lastTickAgeMs != null && s.lastTickAgeMs >= 0);
});

test("a SIBLING ticking never promotes THIS symbol (one per-symbol story)", () => {
  client.lastTickBySymbol.clear();
  seedTick(liveSym!.derivId, 0); // V75 is live...
  const other = getDerivSymbolFeedStatus("V100"); // ...but V100 has no tick of its own
  assert.equal(other.resolved, true);
  assert.equal(other.hasRecentTick, false);
  assert.notEqual(other.feedReadinessState, "LIVE_FEED");
  // Connected + active_symbols loaded but awaiting THIS symbol's first tick.
  assert.equal(other.feedReadinessState, "HISTORY_READY_AWAITING_LIVE_TICK");
  assert.equal(other.lastTickAt, null);
});

test("a fresh GLOBAL tick clock never promotes a symbol without its OWN tick", () => {
  // Regression guard for the exact end-to-end bug: while V75 ticks, the global
  // last-tick clock is fresh. A symbol without its own tick (V100) must NOT
  // read LIVE_FEED off that global clock — the verdict is per-symbol only.
  client.lastTickBySymbol.clear();
  seedTick(liveSym!.derivId, 0); // V75 has its own tick
  client.lastTickAt = Date.now(); // global clock is fresh (a sibling just ticked)
  try {
    const other = getDerivSymbolFeedStatus("V100");
    assert.equal(other.hasRecentTick, false);
    assert.notEqual(other.feedReadinessState, "LIVE_FEED");
    assert.equal(other.lastTickAt, null);
  } finally {
    client.lastTickAt = null;
  }
});

test("a STALE tick is never live (no false-positive)", () => {
  client.lastTickBySymbol.clear();
  seedTick(liveSym!.derivId, 120); // 2 minutes old
  const s = getDerivSymbolFeedStatus("V75");
  assert.equal(s.hasRecentTick, false);
  assert.notEqual(s.feedReadinessState, "LIVE_FEED");
  assert.ok(s.lastTickAgeMs != null && s.lastTickAgeMs >= 120_000);
});

test("maxAgeMs window is honoured", () => {
  client.lastTickBySymbol.clear();
  seedTick(liveSym!.derivId, 20); // 20s old
  assert.equal(getDerivSymbolFeedStatus("V75").hasRecentTick, true); // default 30s
  assert.equal(getDerivSymbolFeedStatus("V75", 10_000).hasRecentTick, false); // tighter 10s
});

test("an unknown symbol resolves false and never reads live", () => {
  client.lastTickBySymbol.clear();
  const s = getDerivSymbolFeedStatus("NOT_A_SYNTHETIC");
  assert.equal(s.resolved, false);
  assert.equal(s.derivId, null);
  assert.equal(s.hasRecentTick, false);
  assert.equal(s.lastTickAt, null);
});

test("unconfigured app id reads UNCONFIGURED (honest, no socket)", () => {
  const saved = process.env.DERIV_APP_ID;
  delete process.env.DERIV_APP_ID;
  try {
    const s = getDerivSymbolFeedStatus("V75");
    assert.equal(s.feedReadinessState, "UNCONFIGURED");
  } finally {
    process.env.DERIV_APP_ID = saved;
  }
});

test("SYNTHETIC_FEED_NOT_LIVE_CONFIRMED is a transient TECHNICAL state, not a broker floor", () => {
  const notLive = categorizeLiveBlock("SYNTHETIC_FEED_NOT_LIVE_CONFIRMED");
  assert.equal(notLive.category, "TECHNICAL");
  assert.equal(notLive.brokerEnforced, false);
  assert.equal(notLive.changeableInGovernance, false);

  // The LIVE_BLOCKED:<reason> envelope strips to the same classification.
  const wrapped = categorizeLiveBlock("LIVE_BLOCKED:SYNTHETIC_FEED_NOT_LIVE_CONFIRMED");
  assert.equal(wrapped.category, "TECHNICAL");
  assert.equal(wrapped.brokerEnforced, false);

  // It must stay DISTINCT from the permanent data-only floor.
  const dataOnly = categorizeLiveBlock("SYMBOL_NOT_LIVE_TRADABLE");
  assert.equal(dataOnly.category, "BROKER");
  assert.equal(dataOnly.brokerEnforced, true);
  assert.notEqual(notLive.category, dataOnly.category);
});

test("teardown: restore env", () => {
  if (ORIGINAL_APP_ID === undefined) delete process.env.DERIV_APP_ID;
  else process.env.DERIV_APP_ID = ORIGINAL_APP_ID;
  if (ORIGINAL_TOKEN === undefined) delete process.env.DERIV_API_TOKEN;
  else process.env.DERIV_API_TOKEN = ORIGINAL_TOKEN;
});
