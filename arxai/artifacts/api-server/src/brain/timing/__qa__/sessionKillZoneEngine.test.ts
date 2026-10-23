// Unit tests for the Session / Kill-Zone engine. Run via:
//   node --import tsx --test src/brain/timing/__qa__/sessionKillZoneEngine.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:timing-session`)
//
// The engine reads `new Date()`, so every clock-dependent case pins UTC time
// via node:test mock timers for full determinism.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { computeSessionKillZone } from "../sessionKillZoneEngine.js";

function atUtc(h: number, m = 0): void {
  mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 0, 5, h, m, 0) }); // Mon 2026-01-05
}

test("inside London Open window → kill zone ACTIVE", () => {
  atUtc(7, 30);
  try {
    const out = computeSessionKillZone({ symbol: "EURUSD", isSynthetic: false });
    assert.equal(out.killZone, "LONDON_OPEN");
    assert.equal(out.isKillZoneActive, true);
    assert.equal(out.sessionHeatBonus, 25);
  } finally {
    mock.timers.reset();
  }
});

test("between sessions (04:00 UTC) → kill zone INACTIVE", () => {
  atUtc(4, 0);
  try {
    const out = computeSessionKillZone({ symbol: "EURUSD", isSynthetic: false });
    assert.equal(out.isKillZoneActive, false);
    assert.equal(out.killZone, "OFF_KILLZONE");
    assert.equal(out.sessionName, "Asia");
  } finally {
    mock.timers.reset();
  }
});

test("London/NY overlap (14:00 UTC) → kill zone active with overlap heat", () => {
  atUtc(14, 0);
  try {
    const out = computeSessionKillZone({ symbol: "EURUSD", isSynthetic: false });
    assert.equal(out.isKillZoneActive, true);
    assert.ok(out.sessionHeatBonus > 0);
  } finally {
    mock.timers.reset();
  }
});

test("synthetic instruments are 24/7 — no kill zone", () => {
  atUtc(7, 30); // even inside a forex kill-zone window
  try {
    const out = computeSessionKillZone({ symbol: "Volatility 75 Index", isSynthetic: true });
    assert.equal(out.sessionName, "24/7 Synthetic");
    assert.equal(out.isKillZoneActive, false);
    assert.equal(out.killZone, "OFF_KILLZONE");
    assert.equal(out.sessionHeatBonus, 10);
  } finally {
    mock.timers.reset();
  }
});

test("valid user timezone resolves a local-time string", () => {
  atUtc(12, 0);
  try {
    const out = computeSessionKillZone({ symbol: "EURUSD", isSynthetic: false, userTimezone: "America/New_York" });
    assert.notEqual(out.userLocalTime, null);
  } finally {
    mock.timers.reset();
  }
});

test("invalid user timezone fails soft to null local time", () => {
  atUtc(12, 0);
  try {
    const out = computeSessionKillZone({ symbol: "EURUSD", isSynthetic: false, userTimezone: "Not/AZone" });
    assert.equal(out.userLocalTime, null);
  } finally {
    mock.timers.reset();
  }
});
