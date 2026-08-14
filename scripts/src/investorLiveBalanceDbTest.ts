// DB-fixture integration test for the ASYNC path of the canonical investor
// live-balance snapshot (Task #439).
//
// The pure composer `composeInvestorBalance(parts)` is already proven by
// `investorLiveBalanceTest.ts`. This test exercises the OTHER half — the real
// I/O of `buildInvestorLiveBalanceSnapshot(userId)` end-to-end against the live
// DB: mode resolution (getUserModeScope), per-user/role-scoped reads of slot
// allocation, the virtual-ledger realized P/L, and the open live positions, plus
// the honest freshness derived from real `last_synced_at` timestamps.
//
// WHAT IT PROVES
//   1) CORRECTNESS — seeds a master pool + multiple armed (LIVE_SHARED)
//      investors with open live positions and asserts each investor's
//      allocatedBalance / realizedPnL / floatingPnL / liveEquity is computed
//      from THAT user's rows only.
//   2) MASTER ≠ INVESTOR — the master pool's aggregate floating P/L
//      (recomputeMasterPool.totalUserUnrealizedPnl, measured baseline-delta so
//      it is robust to whatever other allocated users exist) equals the SUM of
//      the investors' floating P/L and therefore differs from every single
//      investor's number — the per-user snapshot is never the pool total.
//   3) PER-USER ISOLATION — user A's snapshot contains ONLY A's broker tickets
//      and never a row belonging to user B (and vice-versa); open-trade counts
//      are per-user.
//   4) FRESHNESS HONESTY — a stale `last_synced_at` surfaces
//      freshness.status="stale" (never "fresh"), and a position with no broker
//      floating P/L surfaces "unavailable" with floatingPnL=null (never 0-faked).
//
// ISOLATION / SAFETY
//   - Seeds isolated system users (isSystemUser=true) at fixed emails + one
//     throwaway fake master mt5_connection. Idempotent: deletes any leftovers
//     for the fixed identifiers at start and cleans up everything at the end,
//     even on failure.
//   - recomputeMasterPool sums across ALL allocated users, so the pool total is
//     not deterministic in a shared DB — we take a BASELINE recompute (users
//     allocated, NO positions yet) and assert the DELTA after inserting the
//     positions, robust to other rows.
//   - Never places a trade, never inserts an arx_live_command, never reaches the
//     EA or a broker. Only DATABASE_URL is required.
//
// Run: pnpm --filter @workspace/scripts run test:investor-live-balance-db

import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  authUserSessionsTable,
  mt5ConnectionTable,
  userSlotAllocationTable,
  virtualTradingAccountsTable,
  arxLiveArmingTable,
  arxLivePositionsTable,
  arxMasterBridgePoolTable,
} from "@workspace/db";
import { buildInvestorLiveBalanceSnapshot } from "../../artifacts/api-server/src/lib/live/investorLiveBalance.js";
import { recomputeMasterPool } from "../../artifacts/api-server/src/lib/live/masterBridgePool.js";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

const CONN_NAME = "qa-investor-live-balance-db-fake-master";
const EMAIL_A = "qa+investor-live-balance-a@arx.test";
const EMAIL_B = "qa+investor-live-balance-b@arx.test";
const EMAIL_S = "qa+investor-live-balance-stale@arx.test";
const EMAIL_U = "qa+investor-live-balance-unavail@arx.test";
const EMAIL_MASTER = "qa+investor-live-balance-master@arx.test";
const ALL_EMAILS = [EMAIL_A, EMAIL_B, EMAIL_S, EMAIL_U, EMAIL_MASTER];

// Broker tickets — fixed per user so isolation can be asserted by membership.
const TICKET_A1 = "QA-ILB-A1";
const TICKET_A2 = "QA-ILB-A2";
const TICKET_B1 = "QA-ILB-B1";
const TICKET_S1 = "QA-ILB-S1";
const TICKET_U1 = "QA-ILB-U1";

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
  // Master pool rows reference the fake master connection.
  const leftoverConns = await db
    .select()
    .from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.connectionName, CONN_NAME));
  for (const c of leftoverConns) {
    await db
      .delete(arxMasterBridgePoolTable)
      .where(eq(arxMasterBridgePoolTable.masterConnectionId, c.id));
  }

  for (const email of ALL_EMAILS) {
    const users = await db.select().from(usersTable).where(eq(usersTable.email, email));
    for (const u of users) {
      await db.delete(arxLivePositionsTable).where(eq(arxLivePositionsTable.userId, u.id));
      await db.delete(virtualTradingAccountsTable).where(eq(virtualTradingAccountsTable.userId, u.id));
      await db.delete(arxLiveArmingTable).where(eq(arxLiveArmingTable.userId, u.id));
      await db.delete(userSlotAllocationTable).where(eq(userSlotAllocationTable.userId, u.id));
      await db.delete(mt5ConnectionTable).where(eq(mt5ConnectionTable.userId, u.id));
      await db.delete(authUserSessionsTable).where(eq(authUserSessionsTable.userId, u.id));
      await db.delete(usersTable).where(eq(usersTable.id, u.id));
    }
  }
}

async function seedUser(email: string, name: string): Promise<number> {
  const [user] = await db
    .insert(usersTable)
    .values({ email, name, role: "USER", isSystemUser: true })
    .returning();
  if (!user) throw new Error(`test user creation failed: ${email}`);
  // Arm for live — getUserModeScope resolves an armed user to LIVE_SHARED, which
  // is the ONLY mode that lets the snapshot include live positions.
  await db.insert(arxLiveArmingTable).values({
    userId: user.id,
    isArmed: true,
    armedAt: new Date(),
    armedByUserId: user.id,
    killSwitchAcknowledged: true,
    killSwitchEngaged: false,
  });
  return user.id;
}

async function allocate(userId: number, allocatedFunds: number): Promise<void> {
  await db.insert(userSlotAllocationTable).values({
    userId,
    allocatedFunds,
    manualAllocatedFunds: allocatedFunds,
    reservedRisk: 0,
    accountCurrency: "USD",
  });
}

async function seedRealized(userId: number, virtualPnl: number): Promise<void> {
  await db.insert(virtualTradingAccountsTable).values({
    userId,
    routingMode: "SHARED_MASTER_MT5",
    accountType: "live",
    virtualPnl,
    status: "active",
  });
}

export async function run(): Promise<CiTestResultLike> {
  passes = 0;
  failures = 0;
  // eslint-disable-next-line no-console
  console.log("investorLiveBalanceDbTest");
  // eslint-disable-next-line no-console
  console.log("=========================\n");

  // Fresh slate for idempotency.
  await cleanup();

  const NOW = Date.now();
  const FRESH = new Date(NOW - 1_000); // 1s ago → "live"/"fresh"
  const STALE = new Date(NOW - 5 * 60_000); // 5m ago → beyond delayed band → "stale"

  try {
    // ── Seed a master system user + throwaway fake master mt5_connection ─────
    const masterUserId = await seedUser(EMAIL_MASTER, "QA ILB Master");
    const [conn] = await db
      .insert(mt5ConnectionTable)
      .values({
        userId: masterUserId,
        connectionName: CONN_NAME,
        status: "connected",
        accountType: "live",
        accountBalance: 1_000_000,
        accountEquity: 1_000_000,
        freeMargin: 1_000_000,
        margin: 0,
        accountCurrency: "USD",
        lastHeartbeat: new Date(),
      })
      .returning();
    if (!conn) throw new Error("fake master connection creation failed");

    // ── Seed 2 investors (A profit, B loss) + a stale + an unavailable user ──
    const userA = await seedUser(EMAIL_A, "QA ILB Investor A");
    const userB = await seedUser(EMAIL_B, "QA ILB Investor B");
    const userS = await seedUser(EMAIL_S, "QA ILB Investor Stale");
    const userU = await seedUser(EMAIL_U, "QA ILB Investor Unavail");

    await allocate(userA, 5_000);
    await allocate(userB, 3_000);
    await allocate(userS, 2_000);
    await allocate(userU, 1_000);

    await seedRealized(userA, 200);
    await seedRealized(userB, 100);
    await seedRealized(userS, 0);
    await seedRealized(userU, 0);

    // ── BASELINE master-pool recompute: users allocated, NO positions yet ────
    // eslint-disable-next-line no-console
    console.log("recomputeMasterPool — baseline (investors allocated, no positions)");
    const baseline = await recomputeMasterPool({ masterConnectionId: conn.id });
    assert(baseline.ok === true, "baseline recompute ok");
    const b0 = Number(baseline.pool?.totalUserUnrealizedPnl ?? 0);

    // ── Seed each investor's open live positions ─────────────────────────────
    const openedAt = new Date(NOW - 60_000);
    await db.insert(arxLivePositionsTable).values([
      // A: two fresh winners → floating +80
      { userId: userA, bridgeConnectionId: conn.id, brokerTicket: TICKET_A1, symbol: "EURUSD", side: "BUY", volume: 0.1, entryPrice: 1.1, floatingPl: 50, openedAt, closedAt: null, lastSyncedAt: FRESH },
      { userId: userA, bridgeConnectionId: conn.id, brokerTicket: TICKET_A2, symbol: "GBPUSD", side: "BUY", volume: 0.1, entryPrice: 1.27, floatingPl: 30, openedAt, closedAt: null, lastSyncedAt: FRESH },
      // B: one fresh loser → floating -40
      { userId: userB, bridgeConnectionId: conn.id, brokerTicket: TICKET_B1, symbol: "USDJPY", side: "SELL", volume: 0.1, entryPrice: 150.0, floatingPl: -40, openedAt, closedAt: null, lastSyncedAt: FRESH },
      // S: a STALE winner → broker P/L known but snapshot stale → freshness stale
      { userId: userS, bridgeConnectionId: conn.id, brokerTicket: TICKET_S1, symbol: "EURUSD", side: "BUY", volume: 0.1, entryPrice: 1.1, floatingPl: 10, openedAt, closedAt: null, lastSyncedAt: STALE },
      // U: fresh sync but NO broker floating P/L → unavailable, null (not 0-faked)
      { userId: userU, bridgeConnectionId: conn.id, brokerTicket: TICKET_U1, symbol: "EURUSD", side: "BUY", volume: 0.1, entryPrice: 1.1, floatingPl: null, openedAt, closedAt: null, lastSyncedAt: FRESH },
    ]);

    // ── (1) CORRECTNESS — per-user snapshots from the REAL async path ────────
    const a = await buildInvestorLiveBalanceSnapshot(userA, { now: NOW });
    const bb = await buildInvestorLiveBalanceSnapshot(userB, { now: NOW });
    const s = await buildInvestorLiveBalanceSnapshot(userS, { now: NOW });
    const u = await buildInvestorLiveBalanceSnapshot(userU, { now: NOW });

    // eslint-disable-next-line no-console
    console.log("\n(1) per-user correctness — allocation, realized, floating, equity");
    assert(a.source === "live_shared", `A source=live_shared (got ${a.source})`);
    assert(a.allocatedBalance === 5_000, `A allocatedBalance=5000 (got ${a.allocatedBalance})`);
    assert(a.realizedPnL === 200, `A realizedPnL=200 (got ${a.realizedPnL})`);
    assert(a.floatingPnL === 80, `A floatingPnL=+80 (got ${a.floatingPnL})`);
    assert(a.openTradeCount === 2, `A openTradeCount=2 (got ${a.openTradeCount})`);
    assert(a.liveEquity === 5_280, `A liveEquity=5000+200+80=5280 (got ${a.liveEquity})`);
    assert(a.freshness.status === "fresh", `A freshness=fresh (got ${a.freshness.status})`);

    assert(bb.allocatedBalance === 3_000, `B allocatedBalance=3000 (got ${bb.allocatedBalance})`);
    assert(bb.realizedPnL === 100, `B realizedPnL=100 (got ${bb.realizedPnL})`);
    assert(bb.floatingPnL === -40, `B floatingPnL=-40 (got ${bb.floatingPnL})`);
    assert(bb.openTradeCount === 1, `B openTradeCount=1 (got ${bb.openTradeCount})`);
    assert(bb.liveEquity === 3_060, `B liveEquity=3000+100-40=3060 (got ${bb.liveEquity})`);
    assert(bb.freshness.status === "fresh", `B freshness=fresh (got ${bb.freshness.status})`);

    // ── (2) MASTER ≠ INVESTOR — pool aggregate is the SUM, not any single ────
    // eslint-disable-next-line no-console
    console.log("\n(2) master pool aggregate != any single investor");
    const after = await recomputeMasterPool({ masterConnectionId: conn.id });
    assert(after.ok === true, "post-seed recompute ok");
    const b1 = Number(after.pool?.totalUserUnrealizedPnl ?? 0);
    const poolDelta = round2(b1 - b0);
    // A(+80) + B(-40) + S(+10) + U(null→0) = +50
    assert(poolDelta === 50, `pool floating delta = +50 (sum of all investors; got ${poolDelta})`);
    assert(
      poolDelta !== a.floatingPnL &&
        poolDelta !== bb.floatingPnL &&
        poolDelta !== s.floatingPnL,
      `master total (+50) differs from each investor (A=${a.floatingPnL}, B=${bb.floatingPnL}, S=${s.floatingPnL})`,
    );
    assert(
      a.liveEquity !== bb.liveEquity &&
        bb.liveEquity !== s.liveEquity &&
        a.liveEquity !== s.liveEquity,
      "each investor's liveEquity is distinct (no shared/master figure)",
    );

    // ── (3) PER-USER ISOLATION — A never sees B's rows and vice-versa ────────
    // eslint-disable-next-line no-console
    console.log("\n(3) per-user isolation — no cross-user position leakage");
    const aTickets = a.positions.map((p) => p.brokerTicket).sort();
    const bTickets = bb.positions.map((p) => p.brokerTicket).sort();
    assert(
      aTickets.length === 2 && aTickets.includes(TICKET_A1) && aTickets.includes(TICKET_A2),
      `A sees only its own tickets (${JSON.stringify(aTickets)})`,
    );
    assert(
      !aTickets.includes(TICKET_B1) && !aTickets.includes(TICKET_S1) && !aTickets.includes(TICKET_U1),
      "A never sees B/S/U tickets",
    );
    assert(
      bTickets.length === 1 && bTickets[0] === TICKET_B1,
      `B sees only its own ticket (${JSON.stringify(bTickets)})`,
    );
    assert(
      !bTickets.includes(TICKET_A1) && !bTickets.includes(TICKET_A2),
      "B never sees A's tickets",
    );

    // ── (4) FRESHNESS HONESTY — stale stays stale, missing-PL stays null ─────
    // eslint-disable-next-line no-console
    console.log("\n(4) freshness honesty — stale never relabelled fresh; null not 0-faked");
    assert(s.freshness.status === "stale", `S freshness=stale (got ${s.freshness.status})`);
    assert(s.freshness.status !== "fresh", "S freshness is NEVER fresh");
    assert(
      s.freshness.ageMs != null && s.freshness.ageMs >= 4 * 60_000,
      `S freshness.ageMs reflects the stale snapshot (got ${s.freshness.ageMs})`,
    );
    // Stale broker P/L is still the last-known value (10), surfaced but stale.
    assert(s.floatingPnL === 10, `S floatingPnL=last-known +10 (got ${s.floatingPnL})`);
    assert(s.liveEquity === 2_010, `S liveEquity=2000+0+10=2010 (got ${s.liveEquity})`);

    assert(u.floatingPnL === null, `U floatingPnL=null (unavailable, NOT 0-faked; got ${u.floatingPnL})`);
    assert(u.freshness.status === "unavailable", `U freshness=unavailable (got ${u.freshness.status})`);
    assert(u.openTradeCount === 1, `U openTradeCount=1 (got ${u.openTradeCount})`);
    assert(u.liveEquity === 1_000, `U liveEquity=allocation-only 1000 (got ${u.liveEquity})`);
  } finally {
    await cleanup();
  }

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "investorLiveBalanceDbTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    async (err) => {
      await cleanup().catch(() => {});
      // eslint-disable-next-line no-console
      console.error("[investorLiveBalanceDbTest] FAILED:", err);
      process.exit(1);
    },
  );
}
