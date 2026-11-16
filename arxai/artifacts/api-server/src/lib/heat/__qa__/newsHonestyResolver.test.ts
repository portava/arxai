// Deterministic tests for the fail-closed news-provider honesty resolver
// (Task #611). Run via:
//   pnpm --filter @workspace/api-server run test:market-heat-news-honesty
//
// These lock the NON-NEGOTIABLE rule that a news provider which CLAIMS connected
// but cannot positively confirm it (live probe fails / returns disconnected, or
// the provider sits in an ERROR freshness state) is NEVER reported as connected
// or `live`. A broken provider must surface as unavailable/error — never as a
// quiet "live with 0 items" that downstream reads as fake low news risk.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveNewsHonesty } from "@workspace/domain/market-heat";

test("fully-confirmed provider is live + connected", () => {
  const r = resolveNewsHonesty({
    configured: true,
    statusConnected: true,
    freshnessState: "FRESH",
    probeConnected: true,
    probeFailed: false,
  });
  assert.equal(r.connected, true);
  assert.equal(r.freshness, "LIVE");
  assert.equal(r.sourceStatus, "live");
});

test("status claims connected but the live probe FAILS => not connected, error (never live)", () => {
  const r = resolveNewsHonesty({
    configured: true,
    statusConnected: true,
    freshnessState: "FRESH",
    probeConnected: false,
    probeFailed: true,
  });
  assert.equal(r.connected, false);
  assert.equal(r.freshness, "UNAVAILABLE");
  assert.equal(r.sourceStatus, "error");
  assert.notEqual(r.sourceStatus, "live");
});

test("status claims connected but the probe returns DISCONNECTED => not connected (never live)", () => {
  const r = resolveNewsHonesty({
    configured: true,
    statusConnected: true,
    freshnessState: "FRESH",
    probeConnected: false,
    probeFailed: false,
  });
  assert.equal(r.connected, false);
  assert.equal(r.freshness, "UNAVAILABLE");
  assert.equal(r.sourceStatus, "unavailable");
  assert.notEqual(r.sourceStatus, "live");
});

test("ERROR freshness state can NEVER resolve to live, even when status+probe claim connected", () => {
  const r = resolveNewsHonesty({
    configured: true,
    statusConnected: true,
    freshnessState: "ERROR",
    probeConnected: true,
    probeFailed: false,
  });
  assert.equal(r.connected, false);
  assert.equal(r.freshness, "UNAVAILABLE");
  assert.equal(r.sourceStatus, "error");
  assert.notEqual(r.sourceStatus, "live");
});

test("unconfigured provider => missing, never connected", () => {
  const r = resolveNewsHonesty({
    configured: false,
    statusConnected: false,
    freshnessState: undefined,
    probeConnected: false,
    probeFailed: false,
  });
  assert.equal(r.connected, false);
  assert.equal(r.sourceStatus, "missing");
});

test("connected-but-STALE stays connected at a capped stale status (legit degraded, not fake)", () => {
  const r = resolveNewsHonesty({
    configured: true,
    statusConnected: true,
    freshnessState: "STALE",
    probeConnected: true,
    probeFailed: false,
  });
  assert.equal(r.connected, true);
  assert.equal(r.freshness, "STALE");
  assert.equal(r.sourceStatus, "stale");
});

test("connected with an unknown/non-FRESH freshness => delayed (capped), still connected", () => {
  const r = resolveNewsHonesty({
    configured: true,
    statusConnected: true,
    freshnessState: "DELAYED",
    probeConnected: true,
    probeFailed: false,
  });
  assert.equal(r.connected, true);
  assert.equal(r.freshness, "DELAYED");
  assert.equal(r.sourceStatus, "delayed");
});
