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

test("kill-zone description prints clock times, not decimal hours", () => {
  const cases: Array<[number, number, string, string]> = [
    [7, 30, "07:00-08:30 UTC", "8.5:00"],
    [12, 30, "12:00-13:30 UTC", "13.5:00"],
    [1, 0, "00:00-02:30 UTC", "2.5:00"],
  ];
  for (const [h, m, want, bad] of cases) {
    atUtc(h, m);
    try {
      const out = computeSessionKillZone({ symbol: "EURUSD", isSynthetic: false });
      assert.ok(out.sessionDescription.includes(want), `${h}:${m} → ${out.sessionDescription}`);
      assert.ok(!out.sessionDescription.includes(bad), `${h}:${m} → ${out.sessionDescription}`);
    } finally {
      mock.timers.reset();
    }
  }
});

test("16:30 UTC (London closed at 16:00, New York open) → session is New York, not London", () => {
  atUtc(16, 30);
  try {
    const out = computeSessionKillZone({ symbol: "EURUSD", isSynthetic: false });
    assert.equal(out.sessionName, "New York");
  } finally {
    mock.timers.reset();
  }
});

test("14:30 UTC (both London and New York open) → London/NY Overlap", () => {
  atUtc(14, 30);
  try {
    const out = computeSessionKillZone({ symbol: "EURUSD", isSynthetic: false });
    assert.equal(out.sessionName, "London/NY Overlap");
  } finally {
    mock.timers.reset();
  }
});

function atUtcDate(y: number, mo: number, d: number, h: number, m = 0): void {
  mock.timers.enable({ apis: ["Date"], now: Date.UTC(y, mo, d, h, m, 0) });
}

test("Saturday 13:30 UTC → FX closed: no session, no kill zone, no bonuses, no best symbols", () => {
  atUtcDate(2026, 9, 31, 13, 30); // Sat 2026-10-31
  try {
    const out = computeSessionKillZone({ symbol: "EURUSD", isSynthetic: false });
    assert.equal(out.isKillZoneActive, false);
    assert.equal(out.killZone, "OFF_KILLZONE");
    assert.doesNotMatch(out.sessionName, /London|New York|Overlap|Asia|Sydney/);
    assert.match(out.sessionName, /weekend/i);
    assert.equal(out.sessionHeatBonus, 0);
    assert.equal(out.tradeabilityBonus, 0);
    assert.deepEqual(out.bestSymbols, []);
    assert.match(out.sessionDescription, /closed/i);
  } finally {
    mock.timers.reset();
  }
});

test("FX week boundary follows New York 17:00 (Friday close, Sunday open)", () => {
  const closed = (y: number, mo: number, d: number, h: number, m = 0) => {
    atUtcDate(y, mo, d, h, m);
    try {
      return /weekend/i.test(computeSessionKillZone({ symbol: "EURUSD", isSynthetic: false }).sessionName);
    } finally {
      mock.timers.reset();
    }
  };
  // EDT (UTC-4): Friday 2026-10-30 close 21:00 UTC; Sunday 2026-10-25 open 21:00 UTC.
  assert.equal(closed(2026, 9, 30, 20, 59), false);
  assert.equal(closed(2026, 9, 30, 21, 0), true);
  assert.equal(closed(2026, 9, 25, 20, 59), true);
  assert.equal(closed(2026, 9, 25, 21, 0), false);
  // EST (UTC-5): Friday 2026-11-06 close 22:00 UTC; Sunday 2026-11-08 open 22:00 UTC.
  assert.equal(closed(2026, 10, 6, 21, 30), false);
  assert.equal(closed(2026, 10, 6, 22, 0), true);
  assert.equal(closed(2026, 10, 8, 21, 30), true);
  assert.equal(closed(2026, 10, 8, 22, 0), false);
});

test("synthetic instruments still trade on the weekend", () => {
  atUtcDate(2026, 9, 31, 13, 30);
  try {
    const out = computeSessionKillZone({ symbol: "Volatility 75 Index", isSynthetic: true });
    assert.equal(out.sessionName, "24/7 Synthetic");
  } finally {
    mock.timers.reset();
  }
});
