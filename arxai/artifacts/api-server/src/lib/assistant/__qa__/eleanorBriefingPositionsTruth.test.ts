// Truth regression: Eleanor's briefing must not say "No positions are currently
// open" when the open-positions read failed (0 then means "could not count"),
// nor when rows exist that the broker has not verified yet.
//
// The first test runs the REAL buildEleanorContext with no reachable database, so
// every account read fails exactly as it would in an outage.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EleanorContext } from "../eleanorContext.js";

// The outage case needs a database that refuses connections. Forced, not
// defaulted: CI sets a real DATABASE_URL for the other tests in this lane.
process.env["DATABASE_URL"] = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const { buildEleanorContext, composeEleanorBriefing } = await import("../eleanorContext.js");

function baseCtx(account: Partial<EleanorContext["account"]>): EleanorContext {
  return {
    generatedAt: "2026-10-28T09:00:00.000Z",
    page: { key: "/", label: "Cockpit" },
    role: "USER",
    isPrivileged: false,
    timeOfDay: "morning",
    serverUtcHour: 9,
    session: null,
    symbol: null,
    bridge: { availability: "HEALTHY", connected: true, message: "" },
    account: {
      mt5: null, allocation: null, openPositions: 0, openPL: null, snapshotFreshness: null, live: null,
      ...account,
    },
    performance: { hasTrades: false },
    news: { connected: true, items: [], riskLevel: "low" },
    calendar: { connected: true, next: null },
    weather: { available: false },
    location: { available: false },
    warnings: [],
  };
}

test("real context with an unreachable store: positions read as not checked, never 'none open'", async () => {
  const ctx = await buildEleanorContext(424242, "USER", "/", null);
  assert.equal(ctx.account.openPositionsChecked, false);
  const lines = composeEleanorBriefing(ctx).lines;
  assert.ok(!lines.includes("No positions are currently open."), lines.join(" | "));
  assert.ok(lines.some((l) => /couldn't check your open positions/.test(l)), lines.join(" | "));
});

test("checked, zero verified but unverified rows exist: says so instead of 'none open'", () => {
  const lines = composeEleanorBriefing(baseCtx({ openPositions: 0, openPositionsChecked: true, unverifiedPositions: 2 })).lines;
  assert.ok(!lines.includes("No positions are currently open."));
  assert.ok(lines.some((l) => /2 positions are waiting for broker verification/.test(l)), lines.join(" | "));
});

test("checked and genuinely empty: 'No positions are currently open.' stays", () => {
  const lines = composeEleanorBriefing(baseCtx({ openPositions: 0, openPositionsChecked: true, unverifiedPositions: 0 })).lines;
  assert.ok(lines.includes("No positions are currently open."));
});
