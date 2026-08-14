// Test: CLOSED-trade realized P/L is counted correctly in the agent daily-P/L
// gate — and ONLY for trades closed "today" (UTC).
//
// Companion to scripts/src/reconciledGhostExposureDbTest.ts, which only seeds
// FILLED executions with still-OPEN positions and therefore never exercises the
// realized-P/L branch of computeAgentDailyPnlUsd
// (artifacts/api-server/src/lib/selfTrade/executionGate.ts). That branch sums
// realizedPnl from CLOSED executions whose closedAt falls in the current UTC
// day. This test pins that behaviour end-to-end against the REAL function:
//
//   - A CLOSED execution dated TODAY contributes its realizedPnl.
//   - A CLOSED execution dated exactly at the UTC day boundary (00:00:00Z)
//     contributes (the boundary is inclusive: `closedAt < start` is skipped).
//   - A CLOSED execution dated YESTERDAY does NOT contribute (day boundary).
//   - A CLOSED execution with realizedPnl = NULL contributes 0 (not NaN).
//   - Realized + floating combine: realized(today) + floating(open positions).
//
// HOW IT PROVES THE BOUNDARY (not merely "some number"):
//   Today closes sum to +155 (150 + 5-at-boundary). The yesterday close is +999.
//   If the day boundary regressed (e.g. used local time, or `<=`/`>=` flipped),
//   the result would include the 999 and the assertions demand it does NOT.
//
// ISOLATION / SAFETY:
//   - computeAgentDailyPnlUsd is scoped by (agentId, executingUserId), so it is
//     fully isolated to the seeded agent + user — asserted absolutely.
//   - Seeds a single isolated system user (isSystemUser=true) at a fixed email,
//     a throwaway fake mt5_connection, an agent, executions, and one open
//     position. Idempotent: deletes leftovers for the fixed identifiers at start
//     and cleans up everything at the end, even on failure.
//   - Never places a trade, never inserts an arx_live_command, never reaches the
//     EA or a broker. Only DATABASE_URL is required.
//
// Run: pnpm --filter @workspace/scripts run test:realized-daily-pnl

import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  authUserSessionsTable,
  mt5ConnectionTable,
  arxLivePositionsTable,
  selfTradeAgentsTable,
  selfTradeAgentExecutionsTable,
} from "@workspace/db";
import { computeAgentDailyPnlUsd } from "../../artifacts/api-server/src/lib/selfTrade/executionGate.js";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

const TEST_EMAIL = "qa+realized-daily-pnl@arx.test";
const CONN_NAME = "qa-realized-daily-pnl-fake-master";
const AGENT_KEY = "qa-realized-daily-pnl-agent";
const OPEN_TICKET = "QA-RPNL-OPEN-1";

let passes = 0;
let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    passes++;
    // eslint-disable-next-line no-console
    console.log(`  \u2713 ${label}`);
  } else {
    failures++;
    // eslint-disable-next-line no-console
    console.error(`  \u2717 ${label}`);
  }
}

async function cleanup(): Promise<void> {
  // Order matters: dependent rows before the rows they reference.
  const leftoverConns = await db.select().from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.connectionName, CONN_NAME));
  for (const c of leftoverConns) {
    await db.delete(mt5ConnectionTable).where(eq(mt5ConnectionTable.id, c.id));
  }

  const leftoverAgents = await db.select().from(selfTradeAgentsTable)
    .where(eq(selfTradeAgentsTable.agentKey, AGENT_KEY));
  for (const a of leftoverAgents) {
    await db.delete(selfTradeAgentExecutionsTable)
      .where(eq(selfTradeAgentExecutionsTable.agentId, a.id));
    await db.delete(selfTradeAgentsTable).where(eq(selfTradeAgentsTable.id, a.id));
  }

  const users = await db.select().from(usersTable).where(eq(usersTable.email, TEST_EMAIL));
  for (const u of users) {
    await db.delete(arxLivePositionsTable).where(eq(arxLivePositionsTable.userId, u.id));
    await db.delete(authUserSessionsTable).where(eq(authUserSessionsTable.userId, u.id));
    await db.delete(usersTable).where(eq(usersTable.id, u.id));
  }
}

export async function run(): Promise<CiTestResultLike> {
  passes = 0;
  failures = 0;
  // eslint-disable-next-line no-console
  console.log("realizedDailyPnlDbTest");
  // eslint-disable-next-line no-console
  console.log("======================\n");

  // Fresh slate for idempotency.
  await cleanup();

  // Deterministic clock for the whole test: a FIXED UTC literal `now` is passed
  // to the function under test, so the test never flakes around real UTC
  // midnight. Critically, the boundary fixture (`start`) is a hardcoded literal
  // derived BY HAND — not via startOfUtcDay — while the SUT computes its own day
  // boundary from `now` internally via startOfUtcDay. If startOfUtcDay ever
  // regresses (e.g. local time, off-by-one), the SUT boundary desyncs from this
  // literal and the +5 boundary close / +999 yesterday close land on the wrong
  // side, breaking the 155 assertions — i.e. this independently catches a
  // boundary-helper regression instead of shifting in lockstep with it.
  const now = new Date("2026-06-07T12:00:00.000Z");
  const start = new Date("2026-06-07T00:00:00.000Z"); // hand-computed UTC start-of-day
  const yesterday = new Date(start.getTime() - 60 * 60 * 1000); // 1h before today's start

  try {
    // ── Seed isolated system user ──────────────────────────────────────────
    const [user] = await db.insert(usersTable).values({
      email: TEST_EMAIL,
      name: "QA Realized Daily P/L",
      role: "USER",
      isSystemUser: true,
    }).returning();
    if (!user) throw new Error("test user creation failed");

    // ── Seed a throwaway fake master mt5_connection (positions need a bridge) ─
    const [conn] = await db.insert(mt5ConnectionTable).values({
      userId: user.id,
      connectionName: CONN_NAME,
      status: "connected",
      accountType: "live",
      accountBalance: 100_000,
      accountEquity: 100_000,
      freeMargin: 100_000,
      margin: 0,
      accountCurrency: "USD",
      lastHeartbeat: new Date(),
    }).returning();
    if (!conn) throw new Error("fake master connection creation failed");

    // ── Seed the agent ─────────────────────────────────────────────────────
    const [agent] = await db.insert(selfTradeAgentsTable).values({
      agentKey: AGENT_KEY,
      name: "QA Realized Daily P/L Agent",
      profileTemplate: "ALPHA",
      ownerType: "USER",
      ownerId: user.id,
      status: "ACTIVE",
      mode: "LIVE",
    }).returning();
    if (!agent) throw new Error("test agent creation failed");

    // ── Seed executions ────────────────────────────────────────────────────
    //   CLOSED today        (+150) → counts
    //   CLOSED at boundary  (+5 @ 00:00:00Z) → counts (boundary inclusive)
    //   CLOSED yesterday    (+999) → EXCLUDED (different UTC day)
    //   CLOSED today, null realizedPnl → contributes 0 (must not NaN)
    //   FILLED open (ticket) → matched open position contributes floating
    await db.insert(selfTradeAgentExecutionsTable).values([
      {
        agentId: agent.id, agentKey: AGENT_KEY, symbol: "EURUSD", side: "BUY",
        executingUserId: user.id, idempotencyKey: `${AGENT_KEY}-closed-today`,
        status: "CLOSED", realizedPnl: 150, closedAt: now,
      },
      {
        agentId: agent.id, agentKey: AGENT_KEY, symbol: "EURUSD", side: "BUY",
        executingUserId: user.id, idempotencyKey: `${AGENT_KEY}-closed-boundary`,
        status: "CLOSED", realizedPnl: 5, closedAt: start,
      },
      {
        agentId: agent.id, agentKey: AGENT_KEY, symbol: "EURUSD", side: "BUY",
        executingUserId: user.id, idempotencyKey: `${AGENT_KEY}-closed-yesterday`,
        status: "CLOSED", realizedPnl: 999, closedAt: yesterday,
      },
      {
        agentId: agent.id, agentKey: AGENT_KEY, symbol: "EURUSD", side: "BUY",
        executingUserId: user.id, idempotencyKey: `${AGENT_KEY}-closed-null`,
        status: "CLOSED", realizedPnl: null, closedAt: now,
      },
      {
        agentId: agent.id, agentKey: AGENT_KEY, symbol: "EURUSD", side: "BUY",
        executingUserId: user.id, idempotencyKey: `${AGENT_KEY}-filled-open`,
        status: "FILLED", brokerTicket: OPEN_TICKET,
      },
    ]);

    // ── Matching OPEN position for the FILLED execution (floating +10) ───────
    await db.insert(arxLivePositionsTable).values({
      userId: user.id,
      bridgeConnectionId: conn.id,
      brokerTicket: OPEN_TICKET,
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.01,
      entryPrice: 1.05,
      floatingPl: 10,
      openedAt: now,
      closedAt: null,
      reconcileState: null,
    });

    // ── Realized-only branch (executingUserId=null → floating skipped) ───────
    // eslint-disable-next-line no-console
    console.log("computeAgentDailyPnlUsd — realized only (no user → floating skipped)");
    const realizedOnly = await computeAgentDailyPnlUsd(agent.id, null, now);
    assert(
      realizedOnly.dailyPnlUsd === 155,
      `realized-only dailyPnlUsd = +155 (today 150 + boundary 5; got ${realizedOnly.dailyPnlUsd})`,
    );
    assert(
      realizedOnly.dailyPnlUsd !== 1154,
      "yesterday's +999 close is NOT counted toward today (day boundary holds)",
    );
    assert(
      realizedOnly.openPositionsCount === 0,
      `openPositionsCount = 0 when executingUserId is null (got ${realizedOnly.openPositionsCount})`,
    );

    // ── Realized + floating combined ─────────────────────────────────────────
    // eslint-disable-next-line no-console
    console.log("\ncomputeAgentDailyPnlUsd — realized + floating combined");
    const combined = await computeAgentDailyPnlUsd(agent.id, user.id, now);
    assert(
      combined.dailyPnlUsd === 165,
      `dailyPnlUsd = +165 (realized today 155 + floating 10; got ${combined.dailyPnlUsd})`,
    );
    assert(
      combined.dailyPnlUsd !== 1164,
      "combined total still excludes yesterday's +999 (not 1164)",
    );
    assert(
      combined.openPositionsCount === 1,
      `openPositionsCount = 1 (the single matched open position; got ${combined.openPositionsCount})`,
    );
  } finally {
    await cleanup();
  }

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "realizedDailyPnlDbTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    async (err) => {
      await cleanup().catch(() => {});
      // eslint-disable-next-line no-console
      console.error("[realizedDailyPnlDbTest] FAILED:", err);
      process.exit(1);
    },
  );
}
