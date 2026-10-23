// Test: reconciled / IGNORED ghost positions MUST NOT inflate the live pool.
//
// Pins the runtime contract (the static companion guard
// `scripts/src/ci/check-reconciled-ghost-exposure.ts` only proves the SQL
// filter exists in source). This DB-fixture integration test proves the
// behaviour end-to-end against the REAL functions:
//
//   - recomputeMasterPool() — a reconciled (reconcile_state="IGNORED") open
//     arx_live_position with a large floating LOSS must NOT be summed into
//     the pool's totalUserUnrealizedPnl. Only the genuine open position
//     (reconcile_state IS NULL) contributes.
//   - computeAgentDailyPnlUsd() — the same IGNORED row must not contribute
//     floating P/L nor inflate openPositionsCount for an agent whose FILLED
//     execution carries that broker ticket.
//
// HOW IT PROVES EXCLUSION (not merely "no positions"):
//   We seed TWO open positions for one user:
//     GHOST: floating_pl = -500, reconcile_state = "IGNORED"
//     REAL:  floating_pl = +10,  reconcile_state =  NULL
//   If either function forgot the `reconcile_state IS NULL` filter the result
//   would reflect -490 (and openPositionsCount=2). The assertions demand +10
//   (and openPositionsCount=1), so a regression that re-admits ghosts fails
//   loudly.
//
// ISOLATION / SAFETY:
//   - recomputeMasterPool sums unrealized P/L across ALL allocated users, so
//     the pool total is not deterministic in a shared DB. We therefore take a
//     BASELINE recompute (test user allocated, NO positions yet) and assert the
//     DELTA after inserting the two positions equals +10 — robust to whatever
//     other allocated users exist.
//   - computeAgentDailyPnlUsd is scoped by (agentId, executingUserId), so it is
//     fully isolated to the seeded agent + user — asserted absolutely.
//   - Seeds a single isolated system user (isSystemUser=true) at a fixed email,
//     a throwaway fake mt5_connection, allocation, agent, and executions.
//     Idempotent: deletes any leftovers for the fixed identifiers at start and
//     cleans up everything at the end, even on failure.
//   - The fake master connection id is passed EXPLICITLY to recomputeMasterPool
//     so the active arx_master_account_config pin is never touched.
//   - Never places a trade, never inserts an arx_live_command, never reaches the
//     EA or a broker. Only DATABASE_URL is required.
//
// Run: pnpm --filter @workspace/scripts run test:reconciled-ghost-exposure-db

import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  authUserSessionsTable,
  mt5ConnectionTable,
  userSlotAllocationTable,
  arxLivePositionsTable,
  arxMasterBridgePoolTable,
  selfTradeAgentsTable,
  selfTradeAgentExecutionsTable,
} from "@workspace/db";
import { recomputeMasterPool } from "../../artifacts/api-server/src/lib/live/masterBridgePool.js";
import { computeAgentDailyPnlUsd } from "../../artifacts/api-server/src/lib/selfTrade/executionGate.js";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

const TEST_EMAIL = "qa+reconciled-ghost-exposure@arx.test";
const CONN_NAME = "qa-reconciled-ghost-exposure-fake-master";
const AGENT_KEY = "qa-reconciled-ghost-exposure-agent";
const GHOST_TICKET = "QA-GHOST-IGNORED-1";
const REAL_TICKET = "QA-REAL-OPEN-1";

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

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

async function cleanup(): Promise<void> {
  // Order matters: dependent rows before the rows they reference.
  const leftoverConns = await db.select().from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.connectionName, CONN_NAME));
  for (const c of leftoverConns) {
    await db.delete(arxMasterBridgePoolTable)
      .where(eq(arxMasterBridgePoolTable.masterConnectionId, c.id));
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
    await db.delete(userSlotAllocationTable).where(eq(userSlotAllocationTable.userId, u.id));
    await db.delete(authUserSessionsTable).where(eq(authUserSessionsTable.userId, u.id));
    await db.delete(usersTable).where(eq(usersTable.id, u.id));
  }
}

export async function run(): Promise<CiTestResultLike> {
  passes = 0;
  failures = 0;
  // eslint-disable-next-line no-console
  console.log("reconciledGhostExposureDbTest");
  // eslint-disable-next-line no-console
  console.log("=============================\n");

  // Fresh slate for idempotency.
  await cleanup();

  try {
    // ── Seed isolated system user ──────────────────────────────────────────
    const [user] = await db.insert(usersTable).values({
      email: TEST_EMAIL,
      name: "QA Reconciled Ghost Exposure",
      role: "USER",
      isSystemUser: true,
    }).returning();
    if (!user) throw new Error("test user creation failed");

    // ── Seed a throwaway fake master mt5_connection (fresh heartbeat) ──────
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

    // ── Allocate to the test user so its positions count in the pool ───────
    await db.insert(userSlotAllocationTable).values({
      userId: user.id,
      allocatedFunds: 1000,
      manualAllocatedFunds: 1000,
      accountCurrency: "USD",
    });

    // ── BASELINE recompute: allocation present, NO positions yet ───────────
    // eslint-disable-next-line no-console
    console.log("recomputeMasterPool — baseline (test user allocated, no positions)");
    const baseline = await recomputeMasterPool({ masterConnectionId: conn.id });
    assert(baseline.ok === true, `baseline recompute ok (reason=${(baseline as { reason?: string }).reason ?? "n/a"})`);
    const b0 = Number(baseline.pool?.totalUserUnrealizedPnl ?? 0);

    // ── Seed the two open positions for the test user ──────────────────────
    //   GHOST: -500, reconcile_state="IGNORED"  → must be EXCLUDED
    //   REAL:  +10,  reconcile_state=NULL        → the only contributor
    const openedAt = new Date();
    await db.insert(arxLivePositionsTable).values([
      {
        userId: user.id,
        bridgeConnectionId: conn.id,
        brokerTicket: GHOST_TICKET,
        symbol: "EURUSD",
        side: "BUY",
        volume: 0.01,
        entryPrice: 1.05,
        floatingPl: -500,
        openedAt,
        closedAt: null,
        reconcileState: "IGNORED",
      },
      {
        userId: user.id,
        bridgeConnectionId: conn.id,
        brokerTicket: REAL_TICKET,
        symbol: "EURUSD",
        side: "BUY",
        volume: 0.01,
        entryPrice: 1.05,
        floatingPl: 10,
        openedAt,
        closedAt: null,
        reconcileState: null,
      },
    ]);

    // ── Recompute with both positions present ──────────────────────────────
    // eslint-disable-next-line no-console
    console.log("\nrecomputeMasterPool — with GHOST(-500,IGNORED) + REAL(+10,NULL)");
    const after = await recomputeMasterPool({ masterConnectionId: conn.id });
    assert(after.ok === true, "post-seed recompute ok");
    const b1 = Number(after.pool?.totalUserUnrealizedPnl ?? 0);
    const delta = round2(b1 - b0);
    assert(delta === 10, `pool totalUserUnrealizedPnl delta = +10 (only the REAL +10; got ${delta})`);
    assert(delta !== -490, "pool delta is NOT -490 (the IGNORED -500 ghost is excluded)");

    // ── Agent daily-P/L gate: IGNORED ghost must not contribute ────────────
    const [agent] = await db.insert(selfTradeAgentsTable).values({
      agentKey: AGENT_KEY,
      name: "QA Reconciled Ghost Agent",
      profileTemplate: "ALPHA",
      ownerType: "USER",
      ownerId: user.id,
      status: "ACTIVE",
      mode: "LIVE",
    }).returning();
    if (!agent) throw new Error("test agent creation failed");

    // Two FILLED executions whose broker tickets match the two positions.
    await db.insert(selfTradeAgentExecutionsTable).values([
      {
        agentId: agent.id,
        agentKey: AGENT_KEY,
        symbol: "EURUSD",
        side: "BUY",
        executingUserId: user.id,
        idempotencyKey: `${AGENT_KEY}-ghost`,
        status: "FILLED",
        brokerTicket: GHOST_TICKET,
      },
      {
        agentId: agent.id,
        agentKey: AGENT_KEY,
        symbol: "EURUSD",
        side: "BUY",
        executingUserId: user.id,
        idempotencyKey: `${AGENT_KEY}-real`,
        status: "FILLED",
        brokerTicket: REAL_TICKET,
      },
    ]);

    // eslint-disable-next-line no-console
    console.log("\ncomputeAgentDailyPnlUsd — IGNORED ghost excluded from floating P/L + count");
    const agentPnl = await computeAgentDailyPnlUsd(agent.id, user.id, new Date());
    assert(
      agentPnl.openPositionsCount === 1,
      `openPositionsCount = 1 (only the REAL position; got ${agentPnl.openPositionsCount})`,
    );
    assert(
      agentPnl.dailyPnlUsd === 10,
      `dailyPnlUsd = +10 (IGNORED -500 ghost excluded; got ${agentPnl.dailyPnlUsd})`,
    );
    assert(
      agentPnl.dailyPnlUsd !== -490,
      "dailyPnlUsd is NOT -490 (ghost floating P/L is not summed)",
    );
  } finally {
    await cleanup();
  }

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "reconciledGhostExposureDbTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    async (err) => {
      await cleanup().catch(() => {});
      // eslint-disable-next-line no-console
      console.error("[reconciledGhostExposureDbTest] FAILED:", err);
      process.exit(1);
    },
  );
}
