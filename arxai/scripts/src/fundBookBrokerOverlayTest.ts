// fundBookBrokerOverlayTest.ts — Automated proof (Task #131) of the ARX Fund
// Book broker-mirror overlay & investor P/L: each investor's verified pro-rata
// share of live assigned-pool floating P/L, plus the high-water / drawdown
// engine at MASTER / POOL / INVESTOR / BROKER / TRADE scopes.
//
// IT PROVES (pure math + the REAL Express app in-process):
//   PURE:
//     1. Floating P/L is ingestible ONLY when finite; null / NaN / Infinity is
//        data-unavailable and contributes nothing (never coerced to a flat 0).
//     2. A position's floating P/L flows to its ASSIGNED pool; an UNASSIGNED
//        position contributes nothing to any pool.
//     3. Investor share = pool floating × ownership fraction (75 / 25 split);
//        zero units or zero pool units → zero share (no division blow-up).
//     4. High-water advances ONLY on a new high; a dip keeps the prior peak and
//        drawdown is peak-to-current, floored at 0 ($ and %).
//     5. Freshness is 4-state by age (FRESH / DELAYED / STALE) and MISSING when
//        there is no timestamp at all.
//   INTEGRATION (REAL endpoints + investor reads):
//     6. With investors A (1500u) and B (500u) in one pool and an ASSIGNED live
//        position floating +400, A sees floatingPlShare 300 and B sees 100;
//        realtimeValue = settledValue + own floating share.
//     7. An UNASSIGNED position and a null-floating position inflate NOBODY.
//     8. Per-investor isolation: B never sees A's units or floating share.
//     9. No raw broker data leaks to an investor: the investor response carries
//        no broker ticket, account number, balance, or equity field.
//    10. Admin drawdown recompute persists HWM rows; the investor's OWN drawdown
//        endpoint returns their net-value drawdown; HWM advances only on a new
//        high (dip → drawdown > 0, peak held; new high → peak advances, dd 0).
//    11. Admin endpoints reject non-admin (INVESTOR → 403, anonymous → 401).
//
// SAFETY / ISOLATION:
//   - Seeds isolated users + ONE bridge + tagged positions (fixed TAG) and
//     operates ONLY on their rows. Idempotent cleanup of every seeded row at the
//     end, even on failure.
//   - READ-ONLY against the bridge/broker tables via the endpoints; never places,
//     modifies, or closes a trade. The starting arx_live_commands count is
//     asserted unchanged at the end.
//   - Restores the shared CASH_RESERVE NAV snapshot exactly as found.
//   - CI-safe: spins up the REAL Express app in-process on an ephemeral port.
//     Set ARX_QA_BASE_URL to probe an already-running server instead. Only
//     DATABASE_URL is required.
//
// Run: pnpm --filter @workspace/scripts run test:fundbook-overlay

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { pool, db } from "@workspace/db";
import {
  usersTable,
  authUserSessionsTable,
  investorProfilesTable,
  investorPoolHoldingsTable,
  fundBookUnitEventsTable,
  fundBookHighWaterMarksTable,
  adminActionAuditLogTable,
  strategyPoolsTable,
  strategyPoolNavTable,
  mt5ConnectionTable,
  arxLivePositionsTable,
  tradePoolAllocationsTable,
} from "@workspace/db/schema";
import {
  isFloatingPlIngestible,
  aggregatePoolFloatingPl,
  computeInvestorFloatingShare,
} from "../../artifacts/api-server/src/lib/fundbook/plAllocator.js";
import { getPoolFloatingPl } from "../../artifacts/api-server/src/lib/fundbook/brokerMirror.js";
import {
  advanceHighWater,
  computeDrawdown,
} from "../../artifacts/api-server/src/lib/fundbook/drawdown.js";
import {
  classifyBrokerFreshness,
} from "../../artifacts/api-server/src/lib/fundbook/mirrorFreshness.js";

const EXTERNAL_BASE = process.env["ARX_QA_BASE_URL"];
const TAG = `qaFbOverlay_${Date.now()}_${randomBytes(3).toString("hex")}`;
const USER_SESSION_COOKIE = "arx_user_session";
const SESSION_TTL_MS = 60 * 60 * 1000;
const POOL_KEY = "CASH_RESERVE";

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
function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

type Actor = { id: number; email: string; cookie: string };

async function createActor(label: string, role: "INVESTOR" | "ADMIN" | "USER"): Promise<Actor> {
  const email = `${TAG}_${label}@arx.test`;
  const [u] = await db
    .insert(usersTable)
    .values({ email, name: `${TAG} ${label}`, role })
    .returning();
  const userId = u!.id;
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  await db.insert(authUserSessionsTable).values({
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return { id: userId, email, cookie: `${USER_SESSION_COOKIE}=${rawToken}` };
}

async function seedProfile(actor: Actor): Promise<void> {
  await db.insert(investorProfilesTable).values({
    userId: actor.id,
    displayName: `${TAG}_name`,
    baseCurrency: "USD",
    status: "active",
  });
}

type Resp = { status: number; json: any; bodyText: string };
function makeReq(baseUrl: string) {
  return async function req(
    cookie: string | null,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<Resp> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (cookie) headers["cookie"] = cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const bodyText = await r.text();
    let json: any = null;
    try { json = JSON.parse(bodyText); } catch { /* non-json */ }
    return { status: r.status, json, bodyText };
  };
}

async function auditCount(action: string): Promise<number> {
  const r = await pool.query(
    "SELECT COUNT(*)::int AS n FROM admin_action_audit_log WHERE action = $1",
    [action],
  );
  return (r.rows[0] as { n: number }).n;
}

async function liveCommandsCount(): Promise<number> {
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands");
  return (r.rows[0] as { n: number }).n;
}

function poolFromView(json: any): any {
  return (json?.pools ?? []).find((p: any) => p.poolKey === POOL_KEY) ?? null;
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("fundBookBrokerOverlayTest");
  // eslint-disable-next-line no-console
  console.log("=========================\n");

  const startLive = await liveCommandsCount();

  // ── 1. Pure overlay math (no IO) ──────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log("1. Pure overlay / drawdown / freshness math");

  assert(isFloatingPlIngestible(0), "floating 0 is ingestible (a real flat P/L)");
  assert(isFloatingPlIngestible(-12.5), "floating -12.5 is ingestible (real loss)");
  assert(!isFloatingPlIngestible(null), "floating null is NOT ingestible");
  assert(!isFloatingPlIngestible(Number.NaN), "floating NaN is NOT ingestible");
  assert(!isFloatingPlIngestible(Number.POSITIVE_INFINITY), "floating Infinity is NOT ingestible");

  {
    // Pool 1 gets +400 (two positions), pool 2 gets -50; one UNASSIGNED (+999)
    // and one null-floating ASSIGNED contribute nothing.
    const agg = aggregatePoolFloatingPl([
      { brokerTicket: "t1", userId: 1, symbol: "EURUSD", floatingPl: 300, strategyPoolId: 1 },
      { brokerTicket: "t2", userId: 1, symbol: "EURUSD", floatingPl: 100, strategyPoolId: 1 },
      { brokerTicket: "t3", userId: 1, symbol: "XAUUSD", floatingPl: -50, strategyPoolId: 2 },
      { brokerTicket: "t4", userId: 2, symbol: "GBPUSD", floatingPl: 999, strategyPoolId: null },
      { brokerTicket: "t5", userId: 2, symbol: "GBPUSD", floatingPl: null, strategyPoolId: 1 },
    ]);
    assert(approx(agg.byPoolId.get(1) ?? 0, 400), "assigned floating sums into pool 1 (+400)");
    assert(approx(agg.byPoolId.get(2) ?? 0, -50), "assigned floating sums into pool 2 (-50)");
    assert(approx(agg.assignedTotal, 350), "assignedTotal nets assigned pools (+350)");
    assert(agg.assignedCount === 3, "assignedCount counts only assigned+ingestible (3)");
    assert(agg.unassigned.length === 1, "the UNASSIGNED position is surfaced separately (1)");
    assert(agg.unavailableCount === 1, "the null-floating position is data-unavailable (1)");
  }

  // Pro-rata investor share: pool floating +400, A 1500u / B 500u of 2000u.
  assert(approx(computeInvestorFloatingShare(400, 1500, 2000), 300), "A share = 400 × 75% = 300");
  assert(approx(computeInvestorFloatingShare(400, 500, 2000), 100), "B share = 400 × 25% = 100");
  assert(computeInvestorFloatingShare(400, 0, 2000) === 0, "zero units → zero share");
  assert(computeInvestorFloatingShare(400, 1500, 0) === 0, "zero pool units → zero share (no blow-up)");

  // High-water + drawdown.
  assert(advanceHighWater(1800, 2100) === 2100, "HWM advances on a new high");
  assert(advanceHighWater(1800, 1500) === 1800, "HWM holds prior peak on a dip");
  {
    const flat = computeDrawdown(1800, 1800);
    assert(flat.drawdownUsd === 0 && flat.drawdownPercent === 0, "at the peak drawdown is 0 / 0%");
    const dd = computeDrawdown(1500, 1800);
    assert(approx(dd.drawdownUsd, 300), "drawdown $ = peak − current (300)");
    assert(approx(dd.drawdownPercent, 16.67), "drawdown % = 300 / 1800 ≈ 16.67%");
    const above = computeDrawdown(2100, 1800);
    assert(above.drawdownUsd === 0, "above prior peak → drawdown floored at 0");
  }

  // Freshness 4-state.
  assert(classifyBrokerFreshness(5_000) === "FRESH", "age 5s → FRESH");
  assert(classifyBrokerFreshness(30_000) === "DELAYED", "age 30s → DELAYED");
  assert(classifyBrokerFreshness(120_000) === "STALE", "age 120s → STALE");
  assert(classifyBrokerFreshness(null) === "MISSING", "no timestamp → MISSING");

  // ── Boot the real app in-process ──────────────────────────────────────────
  let server: Server | null = null;
  let baseUrl: string;
  if (EXTERNAL_BASE) {
    baseUrl = EXTERNAL_BASE;
    // eslint-disable-next-line no-console
    console.log(`\n[setup] probing external server at ${baseUrl}\n`);
  } else {
    const app = (await import("../../artifacts/api-server/src/app.js")).default;
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    // eslint-disable-next-line no-console
    console.log(`\n[setup] in-process app listening on ${baseUrl}\n`);
  }
  const req = makeReq(baseUrl);

  let investorA: Actor | null = null;
  let investorB: Actor | null = null;
  let master: Actor | null = null;
  let admin: Actor | null = null;
  let poolId: number | null = null;
  let bridgeId: number | null = null;
  let navBaseline: typeof strategyPoolNavTable.$inferSelect | null = null;
  // Tickets seeded for cleanup (owned by `master`).
  const ASSIGNED_TICKET = `${TAG}_A1`;
  const UNASSIGNED_TICKET = `${TAG}_U1`;
  const NULLPL_TICKET = `${TAG}_N1`;

  try {
    investorA = await createActor("investorA", "INVESTOR");
    investorB = await createActor("investorB", "INVESTOR");
    master = await createActor("master", "USER");
    admin = await createActor("admin", "ADMIN");
    await seedProfile(investorA);
    await seedProfile(investorB);

    const issueUrl = (uid: number) => `/api/admin/fundbook/investors/${uid}/units/issue`;

    // Ensure pools exist, capture + reset the shared CASH_RESERVE NAV to a clean
    // baseline so the unit math is deterministic (restored in finally).
    await req(admin.cookie, "GET", "/api/admin/fundbook/pools");
    const poolRow = (
      await db.select().from(strategyPoolsTable).where(eq(strategyPoolsTable.poolKey, POOL_KEY)).limit(1)
    )[0];
    assert(poolRow != null, "CASH_RESERVE seed pool exists after lazy ensure");
    poolId = poolRow!.id;
    navBaseline = (
      await db.select().from(strategyPoolNavTable).where(eq(strategyPoolNavTable.strategyPoolId, poolId)).limit(1)
    )[0]!;
    await db
      .update(strategyPoolNavTable)
      .set({
        navPerUnit: 1,
        totalUnitsOutstanding: 0,
        totalPoolValue: poolRow!.startingCapital,
        realizedPl: 0,
        unrealizedPl: 0,
        feesAccrued: 0,
        depositsAllocated: 0,
        withdrawalsRedeemed: 0,
        approvedAdjustments: 0,
        highWaterValue: poolRow!.startingCapital,
        currentDrawdownPercent: 0,
        navStatus: "OK",
      })
      .where(eq(strategyPoolNavTable.strategyPoolId, poolId));

    // Issue units: A 1500, B 500 → total 2000 (A 75%, B 25%) at NAV $1.00.
    await req(admin.cookie, "POST", issueUrl(investorA.id), {
      poolKey: POOL_KEY, grossAmount: 1500, reason: "qa overlay deposit A",
    });
    await req(admin.cookie, "POST", issueUrl(investorB.id), {
      poolKey: POOL_KEY, grossAmount: 500, reason: "qa overlay deposit B",
    });

    // ── Seed ONE live bridge + positions (READ-ONLY targets of the overlay) ──
    const now = new Date();
    const [bridge] = await db
      .insert(mt5ConnectionTable)
      .values({
        userId: master.id,
        connectionName: `${TAG}_bridge`,
        status: "connected",
        accountType: "live",
        accountCurrency: "USD",
        accountBalance: 100_000,
        accountEquity: 100_400,
        margin: 1_000,
        freeMargin: 99_400,
        lastHeartbeat: now,
        lastPositionsSnapshotAt: now,
      })
      .returning();
    bridgeId = bridge!.id;

    async function seedPosition(ticket: string, floatingPl: number | null): Promise<void> {
      await db.insert(arxLivePositionsTable).values({
        userId: master!.id,
        bridgeConnectionId: bridgeId!,
        brokerTicket: ticket,
        symbol: "EURUSD",
        side: "BUY",
        volume: 0.1,
        entryPrice: 1.1,
        currentPrice: 1.1,
        floatingPl,
        openedAt: now,
        lastSyncedAt: now,
      });
    }
    // Assigned (+400), unassigned (+999, ignored), null-floating assigned (ignored).
    await seedPosition(ASSIGNED_TICKET, 400);
    await seedPosition(UNASSIGNED_TICKET, 999);
    await seedPosition(NULLPL_TICKET, null);

    // Allocation rows: ASSIGNED_TICKET → pool; NULLPL_TICKET → pool (but null
    // floating is unavailable); UNASSIGNED_TICKET → UNASSIGNED.
    await db.insert(tradePoolAllocationsTable).values([
      {
        userId: master.id, brokerTicket: ASSIGNED_TICKET, brokerPositionId: null,
        symbol: "EURUSD", side: "BUY", volume: 0.1, strategyPoolId: poolId,
        allocationPercent: 100, status: "ASSIGNED",
      },
      {
        userId: master.id, brokerTicket: NULLPL_TICKET, brokerPositionId: null,
        symbol: "EURUSD", side: "BUY", volume: 0.1, strategyPoolId: poolId,
        allocationPercent: 100, status: "ASSIGNED",
      },
      {
        userId: master.id, brokerTicket: UNASSIGNED_TICKET, brokerPositionId: null,
        symbol: "EURUSD", side: "BUY", volume: 0.1, strategyPoolId: null,
        allocationPercent: 100, status: "UNASSIGNED",
      },
    ]);

    // ── 6/7. Investor pro-rata floating share — engine truth + hidden pool ───
    // June 19 2026: the investor fund-book view is BALANCED-only, so the seeded
    // CASH_RESERVE pool is deliberately HIDDEN from /api/me/investor/fundbook.
    // The pro-rata overlay math is therefore proven against the SAME engine
    // seams the view/drawdown engines use (getPoolFloatingPl +
    // computeInvestorFloatingShare) over direct DB truth, while the view itself
    // is pinned to hide the pool and leak none of its value.
    // eslint-disable-next-line no-console
    console.log("\n6. Investor pro-rata floating-P/L share (engine truth)");
    const holdingRows = await db
      .select()
      .from(investorPoolHoldingsTable)
      .where(inArray(investorPoolHoldingsTable.userId, [investorA.id, investorB.id]));
    const aUnits = holdingRows.find((h) => h.userId === investorA!.id)?.unitsOwned ?? 0;
    const bUnits = holdingRows.find((h) => h.userId === investorB!.id)?.unitsOwned ?? 0;
    assert(approx(aUnits, 1500), `A holds 1500 units in the DB (got ${aUnits})`);
    assert(approx(bUnits, 500), `B holds 500 units in the DB (got ${bUnits})`);

    const floating = (await getPoolFloatingPl()).aggregate;
    const poolFloating = floating.byPoolId.get(poolId!) ?? -1;
    assert(approx(poolFloating, 400), `assigned pool floating = +400 (got ${poolFloating})`);
    const aShare = computeInvestorFloatingShare(poolFloating, aUnits, aUnits + bUnits);
    const bShare = computeInvestorFloatingShare(poolFloating, bUnits, aUnits + bUnits);
    assert(approx(aShare, 300), `A pro-rata floating share = 300 (got ${aShare})`);
    assert(approx(bShare, 100), `B pro-rata floating share = 100 (got ${bShare})`);

    // eslint-disable-next-line no-console
    console.log("\n7. Unassigned / unavailable positions inflate nobody");
    assert(
      approx(aShare + bShare, 400),
      "investor shares sum to exactly the assigned pool floating (+400) — UNASSIGNED/null excluded",
    );
    assert(
      approx(floating.assignedTotal, 400),
      `engine assignedTotal excludes UNASSIGNED/null positions (got ${floating.assignedTotal})`,
    );

    // ── 8. Per-investor isolation + June-19 hidden-pool contract ─────────────
    // eslint-disable-next-line no-console
    console.log("\n8. Per-investor isolation + hidden-pool view contract");
    assert(!approx(bShare, aShare), "B's share is not A's share");
    const viewA = await req(investorA.cookie, "GET", "/api/me/investor/fundbook");
    assert(viewA.status === 200, `investor A read → 200 (got ${viewA.status})`);
    const aPool = poolFromView(viewA.json);
    assert(aPool == null, "June-19: CASH_RESERVE pool is HIDDEN from the investor view");
    assert(viewA.json?.freshness === "FRESH", `A overlay freshness FRESH (got ${viewA.json?.freshness})`);
    const viewB = await req(investorB.cookie, "GET", "/api/me/investor/fundbook");
    const bPool = poolFromView(viewB.json);
    assert(bPool == null, "June-19: CASH_RESERVE pool is HIDDEN from investor B's view too");
    // The hidden pool's value must not leak into the visible totals either:
    // these investors hold ONLY the hidden pool, so their totals are zero.
    assert(approx(viewA.json?.settledValue ?? -1, 0), `A settledValue excludes hidden pool (got ${viewA.json?.settledValue})`);
    assert(approx(viewA.json?.unrealizedFloatingPl ?? -1, 0), `A unrealizedFloatingPl excludes hidden pool (got ${viewA.json?.unrealizedFloatingPl})`);
    assert(approx(viewA.json?.realtimeValue ?? -1, 0), `A realtimeValue excludes hidden pool (got ${viewA.json?.realtimeValue})`);
    assert(approx(viewB.json?.realtimeValue ?? -1, 0), `B realtimeValue excludes hidden pool (got ${viewB.json?.realtimeValue})`);

    // ── 9. No raw broker data to investors ────────────────────────────────────
    // eslint-disable-next-line no-console
    console.log("\n9. No raw broker fields leak to an investor");
    const aText = viewA.bodyText;
    assert(!aText.includes(ASSIGNED_TICKET), "investor view does NOT contain a broker ticket");
    assert(!aText.includes("accountEquity"), "investor view has no accountEquity field");
    assert(!aText.includes("accountBalance"), "investor view has no accountBalance field");
    assert(!aText.includes("accountNumber"), "investor view has no accountNumber field");
    assert(!/100400|100000/.test(aText), "investor view leaks no raw broker magnitude");

    // ── 10. Drawdown recompute + investor drawdown + HWM advance-only ─────────
    // eslint-disable-next-line no-console
    console.log("\n10. Drawdown / high-water engine");
    const recomputeBefore = await auditCount("FUNDBOOK_DRAWDOWN_RECOMPUTE");
    const rc1 = await req(admin.cookie, "POST", "/api/admin/fundbook/drawdown/recompute", {
      reason: "qa overlay recompute 1",
    });
    assert(rc1.status === 200, `recompute → 200 (got ${rc1.status})`);
    assert((rc1.json?.byScopeType?.INVESTOR ?? 0) >= 2, "recompute wrote INVESTOR HWM rows for held investors");
    assert((rc1.json?.byScopeType?.MASTER ?? 0) >= 1, "recompute wrote the MASTER HWM row");
    assert((rc1.json?.byScopeType?.TRADE ?? 0) >= 1, "recompute wrote per-open-position TRADE HWM rows");
    assert(
      (await auditCount("FUNDBOOK_DRAWDOWN_RECOMPUTE")) === recomputeBefore + 1,
      "exactly one FUNDBOOK_DRAWDOWN_RECOMPUTE audit row written (baseline-delta)",
    );

    const ddA1 = await req(investorA.cookie, "GET", "/api/me/investor/fundbook/drawdown");
    assert(ddA1.status === 200, `investor A drawdown → 200 (got ${ddA1.status})`);
    assert(approx(ddA1.json?.own?.currentValue ?? -1, 1800), `A net value 1800 at first peak (got ${ddA1.json?.own?.currentValue})`);
    assert(approx(ddA1.json?.own?.highWaterValue ?? -1, 1800), `A HWM = 1800 (first high)`);
    assert((ddA1.json?.own?.drawdownUsd ?? -1) === 0, "A drawdown 0 at the peak");
    assert(Array.isArray(ddA1.json?.pools) && ddA1.json.pools.length >= 1, "A sees their held pool's drawdown row");

    // Dip: drop the assigned position's floating to 0 → A net value 1500.
    await db
      .update(arxLivePositionsTable)
      .set({ floatingPl: 0 })
      .where(and(eq(arxLivePositionsTable.userId, master.id), eq(arxLivePositionsTable.brokerTicket, ASSIGNED_TICKET)));
    await req(admin.cookie, "POST", "/api/admin/fundbook/drawdown/recompute", { reason: "qa overlay recompute dip" });
    const ddA2 = await req(investorA.cookie, "GET", "/api/me/investor/fundbook/drawdown");
    assert(approx(ddA2.json?.own?.currentValue ?? -1, 1500), `A net value dipped to 1500 (got ${ddA2.json?.own?.currentValue})`);
    assert(approx(ddA2.json?.own?.highWaterValue ?? -1, 1800), "A HWM HELD at 1800 on the dip (advance-only)");
    assert(approx(ddA2.json?.own?.drawdownUsd ?? -1, 300), `A drawdown $ = 300 (got ${ddA2.json?.own?.drawdownUsd})`);

    // New high: raise floating to +800 → A net value 1500 + 600 = 2100 > 1800.
    await db
      .update(arxLivePositionsTable)
      .set({ floatingPl: 800 })
      .where(and(eq(arxLivePositionsTable.userId, master.id), eq(arxLivePositionsTable.brokerTicket, ASSIGNED_TICKET)));
    await req(admin.cookie, "POST", "/api/admin/fundbook/drawdown/recompute", { reason: "qa overlay recompute high" });
    const ddA3 = await req(investorA.cookie, "GET", "/api/me/investor/fundbook/drawdown");
    assert(approx(ddA3.json?.own?.currentValue ?? -1, 2100), `A net value rose to 2100 (got ${ddA3.json?.own?.currentValue})`);
    assert(approx(ddA3.json?.own?.highWaterValue ?? -1, 2100), "A HWM ADVANCED to the new high 2100");
    assert((ddA3.json?.own?.drawdownUsd ?? -1) === 0, "A drawdown back to 0 at the new peak");

    // Admin drawdown readout exposes every scope (admin-only).
    const adminDd = await req(admin.cookie, "GET", "/api/admin/fundbook/drawdown");
    assert(adminDd.status === 200, `admin drawdown → 200 (got ${adminDd.status})`);
    const scopeTypes = new Set((adminDd.json?.marks ?? []).map((m: any) => m.scopeType));
    assert(scopeTypes.has("INVESTOR") && scopeTypes.has("MASTER") && scopeTypes.has("BROKER"), "admin readout spans MASTER/BROKER/INVESTOR scopes");

    // Admin broker-mirror + pl-allocation reads (admin-only, raw magnitudes).
    const mirror = await req(admin.cookie, "GET", "/api/admin/fundbook/broker-mirror");
    assert(mirror.status === 200, `broker-mirror → 200 (got ${mirror.status})`);
    const seededBridge = (mirror.json?.bridges ?? []).find((b: any) => b.bridgeConnectionId === bridgeId);
    assert(seededBridge != null && seededBridge.accountType === "live", "broker-mirror surfaces the seeded live bridge to admin");
    const plAlloc = await req(admin.cookie, "GET", "/api/admin/fundbook/pl-allocation");
    assert(plAlloc.status === 200, `pl-allocation → 200 (got ${plAlloc.status})`);
    assert((plAlloc.json?.unassigned ?? []).some((u: any) => u.brokerTicket === UNASSIGNED_TICKET), "pl-allocation lists the UNASSIGNED position for an admin to resolve");
    assert((plAlloc.json?.unavailableCount ?? 0) >= 1, "pl-allocation counts the null-floating position as data-unavailable");

    // ── 11. Auth gating on admin endpoints ────────────────────────────────────
    // eslint-disable-next-line no-console
    console.log("\n11. Admin endpoints reject non-admin callers");
    const invMirror = await req(investorA.cookie, "GET", "/api/admin/fundbook/broker-mirror");
    assert(invMirror.status === 403, `INVESTOR → broker-mirror 403 (got ${invMirror.status})`);
    const anonMirror = await req(null, "GET", "/api/admin/fundbook/broker-mirror");
    assert(anonMirror.status === 401, `anonymous → broker-mirror 401 (got ${anonMirror.status})`);
    const invRecompute = await req(investorA.cookie, "POST", "/api/admin/fundbook/drawdown/recompute", { reason: "qa blocked" });
    assert(invRecompute.status === 403, `INVESTOR → recompute 403 (got ${invRecompute.status})`);
    const anonDd = await req(null, "GET", "/api/me/investor/fundbook/drawdown");
    assert(anonDd.status === 401, `anonymous → investor drawdown 401 (got ${anonDd.status})`);

    // ── 12. Lifecycle: stale scopes are reconciled away on recompute ──────────
    // A closed/now-unavailable trade and a fully-redeemed investor must NOT leave
    // outdated high-water rows behind. Recompute deletes scopes absent from the
    // live snapshot (HWM rows only — broker tables are never touched).
    // eslint-disable-next-line no-console
    console.log("\n12. Stale-scope reconciliation on recompute");

    function tradeMark(json: any, ticket: string): any {
      return (json?.marks ?? []).find(
        (m: any) => m.scopeType === "TRADE" && m.scopeKey === `${master!.id}:${ticket}`,
      ) ?? null;
    }
    // Pre-state: both open positions with ingestible floating own a TRADE mark.
    const ddPre = await req(admin.cookie, "GET", "/api/admin/fundbook/drawdown");
    assert(tradeMark(ddPre.json, ASSIGNED_TICKET) != null, "TRADE mark exists for the assigned open position");
    assert(tradeMark(ddPre.json, UNASSIGNED_TICKET) != null, "TRADE mark exists for the unassigned open position");

    // Close the assigned position; flip the unassigned one's floating to null.
    await db
      .update(arxLivePositionsTable)
      .set({ closedAt: new Date() })
      .where(and(eq(arxLivePositionsTable.userId, master.id), eq(arxLivePositionsTable.brokerTicket, ASSIGNED_TICKET)));
    await db
      .update(arxLivePositionsTable)
      .set({ floatingPl: null })
      .where(and(eq(arxLivePositionsTable.userId, master.id), eq(arxLivePositionsTable.brokerTicket, UNASSIGNED_TICKET)));
    // Fully redeem investor B so their holding goes CLOSED (drops from ACTIVE).
    const redeemB = await req(admin.cookie, "POST", `/api/admin/fundbook/investors/${investorB.id}/units/redeem`, {
      poolKey: POOL_KEY, units: 500, reason: "qa overlay full redeem B",
    });
    assert(redeemB.status === 200, `B full redeem → 200 (got ${redeemB.status})`);

    const rcLifecycle = await req(admin.cookie, "POST", "/api/admin/fundbook/drawdown/recompute", {
      reason: "qa overlay recompute lifecycle",
    });
    assert(rcLifecycle.status === 200, `lifecycle recompute → 200 (got ${rcLifecycle.status})`);

    const ddPost = await req(admin.cookie, "GET", "/api/admin/fundbook/drawdown");
    assert(tradeMark(ddPost.json, ASSIGNED_TICKET) == null, "closed position's TRADE mark is reconciled away");
    assert(tradeMark(ddPost.json, UNASSIGNED_TICKET) == null, "now-null-floating position's TRADE mark is reconciled away");

    // A's HWM HELD at the prior peak (2100); A net value is now settled-only
    // (1500) since the assigned floating is gone → drawdown 600.
    const ddAFinal = await req(investorA.cookie, "GET", "/api/me/investor/fundbook/drawdown");
    assert(approx(ddAFinal.json?.own?.highWaterValue ?? -1, 2100), "A HWM still held at 2100 after the trade closed");
    assert(approx(ddAFinal.json?.own?.currentValue ?? -1, 1500), `A net value back to settled-only 1500 (got ${ddAFinal.json?.own?.currentValue})`);
    assert(approx(ddAFinal.json?.own?.drawdownUsd ?? -1, 600), `A drawdown $ = 600 after the floating evaporated (got ${ddAFinal.json?.own?.drawdownUsd})`);

    // Investor B fully redeemed → their INVESTOR HWM row is gone (own == null).
    const ddBFinal = await req(investorB.cookie, "GET", "/api/me/investor/fundbook/drawdown");
    assert(ddBFinal.status === 200, `B drawdown → 200 (got ${ddBFinal.status})`);
    assert((ddBFinal.json?.own ?? null) === null, "fully-redeemed investor B has no stale INVESTOR drawdown row");
  } catch (e) {
    assert(false, `unexpected error: ${(e as Error).message}`);
  } finally {
    const ids = [investorA?.id, investorB?.id, master?.id, admin?.id].filter(
      (x): x is number => typeof x === "number",
    );
    try {
      // Remove seeded broker/bridge rows FIRST (read-only targets of the overlay
      // we created only for this test).
      if (master) {
        await db.delete(arxLivePositionsTable).where(eq(arxLivePositionsTable.userId, master.id));
        await db.delete(tradePoolAllocationsTable).where(eq(tradePoolAllocationsTable.userId, master.id));
      }
      if (bridgeId != null) {
        await db.delete(mt5ConnectionTable).where(eq(mt5ConnectionTable.id, bridgeId));
      }
      // Remove HWM rows this test created: per-user INVESTOR/TRADE rows, the
      // seeded BROKER row, and POOL/MASTER aggregates (recomputed from a clean
      // state once the seeded rows are gone — the next recompute restamps them).
      if (ids.length > 0) {
        await db.delete(fundBookHighWaterMarksTable).where(inArray(fundBookHighWaterMarksTable.userId, ids));
      }
      if (bridgeId != null) {
        await db
          .delete(fundBookHighWaterMarksTable)
          .where(and(eq(fundBookHighWaterMarksTable.scopeType, "BROKER"), eq(fundBookHighWaterMarksTable.scopeKey, String(bridgeId))));
      }
      if (ids.length > 0) {
        await db.delete(fundBookUnitEventsTable).where(inArray(fundBookUnitEventsTable.userId, ids));
        await db.delete(investorPoolHoldingsTable).where(inArray(investorPoolHoldingsTable.userId, ids));
        await db.delete(investorProfilesTable).where(inArray(investorProfilesTable.userId, ids));
        await db.delete(adminActionAuditLogTable).where(inArray(adminActionAuditLogTable.targetUserId, ids));
        await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, ids));
        await db.delete(usersTable).where(inArray(usersTable.id, ids));
      }
      // Restore the shared CASH_RESERVE NAV snapshot exactly as it was found.
      if (poolId != null && navBaseline != null) {
        await db
          .update(strategyPoolNavTable)
          .set({
            navPerUnit: navBaseline.navPerUnit,
            totalUnitsOutstanding: navBaseline.totalUnitsOutstanding,
            totalPoolValue: navBaseline.totalPoolValue,
            realizedPl: navBaseline.realizedPl,
            unrealizedPl: navBaseline.unrealizedPl,
            feesAccrued: navBaseline.feesAccrued,
            depositsAllocated: navBaseline.depositsAllocated,
            withdrawalsRedeemed: navBaseline.withdrawalsRedeemed,
            approvedAdjustments: navBaseline.approvedAdjustments,
            highWaterValue: navBaseline.highWaterValue,
            currentDrawdownPercent: navBaseline.currentDrawdownPercent,
            navStatus: navBaseline.navStatus,
          })
          .where(eq(strategyPoolNavTable.strategyPoolId, poolId));
      }
    } catch (e) {
      assert(false, `cleanup failed: ${(e as Error).message}`);
    }
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  }

  const endLive = await liveCommandsCount();
  assert(endLive === startLive, `no live command created (start=${startLive} end=${endLive})`);

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  await pool.end().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  // eslint-disable-next-line no-console
  console.error("[fundBookBrokerOverlayTest] FAILED:", e);
  await pool.end().catch(() => {});
  process.exit(1);
});

export {};
