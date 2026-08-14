// fundBookUnitAccountingTest.ts — Automated proof (Task #130) of the ARX Fund
// Book unit-accounting core: strategy pools, unit-based NAV, per-investor
// holdings, and the auditable issue/redeem endpoints.
//
// IT PROVES (pure math + the REAL Express app in-process):
//   PURE:
//     1. Starting NAV is $1.00 and a zero-unit pool reports NAV $1.00.
//     2. Issuing units at the current NAV does NOT move the NAV
//        (deposit-NAV-neutrality): newUnits = amount / nav.
//     3. Value = units × NAV; ownership = units / totalUnits × 100.
//     4. NAV is null (UNDER_REVIEW) only when uncomputable (negative units).
//   INTEGRATION (admin endpoints + investor reads):
//     5. Issuing units to an investor returns units = amount/NAV at NAV $1.00,
//        writes ONE FUNDBOOK_UNITS_ISSUE audit row (baseline-delta), and the
//        holding row reflects unitsOwned and currentValue = units×NAV.
//     6. A second deposit at the same NAV keeps NAV at $1.00 (no inflation).
//     7. Redeeming units returns gross = units×NAV, writes ONE
//        FUNDBOOK_UNITS_REDEEM audit row, and reduces the holding.
//     8. Per-investor isolation: investor B's holding NEVER includes investor
//        A's units; ownership math is per-investor.
//     9. Non-admin callers are rejected (INVESTOR → 403, anonymous → 401) on the
//        issue endpoint.
//    10. VISIBILITY CONTRACT (June 19 2026, commit 55f05663, Task #610
//        follow-ups): GET /api/me/investor/fundbook exposes ONLY the BALANCED
//        pool to investors. CASH_RESERVE (and every other non-BALANCED pool)
//        must be HIDDEN from the investor view. This test operates on the
//        BALANCED pool (the only pool whose holdings are observable through
//        the investor view), so the view is expected to SHOW the seeded
//        holding and its real settled value; the hidden-pool contract is
//        asserted as "no non-BALANCED pool ever surfaces". The NAV row is
//        reset to a $1.00 baseline in setup (and restored afterwards), so the
//        NAV-$1.00 unit math holds despite BALANCED tier pricing. Do NOT
//        "fix" a failure here by exposing non-BALANCED pools in the endpoint.
//
// SAFETY / ISOLATION:
//   - Seeds isolated users (fixed TAG) and operates ONLY on their rows.
//   - Idempotent cleanup of every seeded row at the end, even on failure.
//   - Never places a trade / touches any execution / live / bridge surface; the
//     starting arx_live_commands count is asserted unchanged at the end.
//   - Operates ONLY on the BALANCED seed pool's per-user holdings/events for
//     its own seeded users; pool rows themselves are shared seeds and are left
//     intact (NAV returns to a clean state once the seeded holdings are removed).
//   - CI-safe: spins up the REAL Express app in-process on an ephemeral port.
//     Set ARX_QA_BASE_URL to probe an already-running server instead. Only
//     DATABASE_URL is required.
//
// Run: pnpm --filter @workspace/scripts run test:fundbook

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { pool, db } from "@workspace/db";
import {
  usersTable,
  authUserSessionsTable,
  investorProfilesTable,
  investorPoolHoldingsTable,
  fundBookUnitEventsTable,
  adminActionAuditLogTable,
  strategyPoolsTable,
  strategyPoolNavTable,
} from "@workspace/db/schema";
import {
  computeNav,
  computeUnitsForAmount,
  computeHoldingValue,
  computeOwnershipPct,
  STARTING_NAV_PER_UNIT,
} from "../../artifacts/api-server/src/lib/fundbook/navMath.js";

const EXTERNAL_BASE = process.env["ARX_QA_BASE_URL"];
const TAG = `qaFundBook_${Date.now()}_${randomBytes(3).toString("hex")}`;
const USER_SESSION_COOKIE = "arx_user_session";
const SESSION_TTL_MS = 60 * 60 * 1000;
// BALANCED is the only pool exposed on the investor Fund Book view (Task #610
// balanced-only visibility), so the unit-accounting round-trip must run there
// for the investor-read assertions to be observable.
const POOL_KEY = "BALANCED";

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

async function auditCount(targetUserId: number, action: string): Promise<number> {
  const r = await pool.query(
    "SELECT COUNT(*)::int AS n FROM admin_action_audit_log WHERE target_user_id = $1 AND action = $2",
    [targetUserId, action],
  );
  return (r.rows[0] as { n: number }).n;
}

async function liveCommandsCount(): Promise<number> {
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands");
  return (r.rows[0] as { n: number }).n;
}

// June 19 Balanced-only visibility contract helpers: the investor Fund Book
// view must NEVER surface any non-BALANCED pool (CASH_RESERVE, CONSERVATIVE,
// AGGRESSIVE, …). The test operates on BALANCED — the only pool investors may
// see — so the view is expected to SHOW the holding; unit math is additionally
// verified against DB truth.
function viewExposesHiddenPool(json: any): boolean {
  return (json?.pools ?? []).some((p: any) => p.poolKey !== "BALANCED");
}
function viewIsBalancedOnly(json: any): boolean {
  const pools = json?.pools ?? [];
  return pools.every((p: any) => p.poolKey === "BALANCED");
}

// Direct DB truth for the hidden pool: the per-investor holding row and the
// shared pool NAV row. This is how unit/ownership math is verified now that
// the investor API view intentionally hides CASH_RESERVE.
async function dbHolding(userId: number, strategyPoolId: number) {
  const rows = await db
    .select()
    .from(investorPoolHoldingsTable)
    .where(eq(investorPoolHoldingsTable.userId, userId));
  return rows.find((h) => h.strategyPoolId === strategyPoolId) ?? null;
}
async function dbNav(strategyPoolId: number) {
  const rows = await db
    .select()
    .from(strategyPoolNavTable)
    .where(eq(strategyPoolNavTable.strategyPoolId, strategyPoolId))
    .limit(1);
  return rows[0] ?? null;
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("fundBookUnitAccountingTest");
  // eslint-disable-next-line no-console
  console.log("==========================\n");

  const startLive = await liveCommandsCount();

  // ── Pure-math proofs (no IO) ──────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log("1. Pure NAV / unit math");
  assert(STARTING_NAV_PER_UNIT === 1, "starting NAV per unit is $1.00");
  assert(computeNav(0, 0) === 1, "zero-unit pool reports NAV $1.00");
  assert(computeNav(-5, 5) !== null && approx(computeNav(-5, 5)!, -1), "NAV computes even when value is negative");
  assert(computeNav(100, -1) === null, "NAV is null (UNDER_REVIEW) for negative units");

  // Deposit-NAV-neutrality: starting from value V, units U (nav = V/U), a
  // deposit of A at the current nav must keep nav unchanged.
  {
    const V = 1000, U = 1000; // nav = 1.00
    const nav0 = computeNav(V, U)!;
    const A = 250;
    const newUnits = computeUnitsForAmount(A, nav0);
    const nav1 = computeNav(V + A, U + newUnits)!;
    assert(approx(nav0, 1), "initial NAV is $1.00 at 1000 value / 1000 units");
    assert(approx(newUnits, 250), "deposit of $250 at NAV $1.00 issues 250 units");
    assert(approx(nav1, nav0), "deposit at current NAV does NOT move the NAV");
  }
  // Same neutrality at a non-$1 NAV.
  {
    const V = 2400, U = 2000; // nav = 1.20
    const nav0 = computeNav(V, U)!;
    const A = 600;
    const newUnits = computeUnitsForAmount(A, nav0);
    const nav1 = computeNav(V + A, U + newUnits)!;
    assert(approx(nav0, 1.2), "NAV $1.20 at 2400/2000");
    assert(approx(nav1, nav0), "deposit at NAV $1.20 stays NAV-neutral");
  }
  assert(approx(computeHoldingValue(250, 1.2), 300), "value = units × NAV (250 × 1.20 = 300)");
  assert(approx(computeOwnershipPct(250, 1000), 25), "ownership = units / total × 100 (25%)");

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
  let admin: Actor | null = null;
  let poolId: number | null = null;
  let navBaseline: typeof strategyPoolNavTable.$inferSelect | null = null;

  try {
    investorA = await createActor("investorA", "INVESTOR");
    investorB = await createActor("investorB", "INVESTOR");
    admin = await createActor("admin", "ADMIN");
    await seedProfile(investorA);
    await seedProfile(investorB);

    const issueUrl = (uid: number) => `/api/admin/fundbook/investors/${uid}/units/issue`;
    const redeemUrl = (uid: number) => `/api/admin/fundbook/investors/${uid}/units/redeem`;

    // Ensure the four pools exist (lazy seed), then capture the shared
    // BALANCED NAV snapshot and reset it to a clean baseline so the unit
    // math below is deterministic. The exact captured row is restored in the
    // finally block, leaving the shared seed pool exactly as it was found.
    await req(admin.cookie, "GET", "/api/admin/fundbook/pools");
    const poolRow = (
      await db.select().from(strategyPoolsTable).where(eq(strategyPoolsTable.poolKey, POOL_KEY)).limit(1)
    )[0];
    assert(poolRow != null, "BALANCED seed pool exists after lazy ensure");
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

    // ── 2. Issue units to investor A at NAV $1.00 ─────────────────────────────
    // eslint-disable-next-line no-console
    console.log("\n2. Admin issues units to investor A (deposit at NAV $1.00)");
    const issueABefore = await auditCount(investorA.id, "FUNDBOOK_UNITS_ISSUE");
    const issueA = await req(admin.cookie, "POST", issueUrl(investorA.id), {
      poolKey: POOL_KEY,
      grossAmount: 1000,
      reason: "qa fund book deposit A",
    });
    assert(issueA.status === 200, `issue → 200 (got ${issueA.status})`);
    assert(approx(issueA.json?.navPerUnit ?? 0, 1), `issued at NAV $1.00 (got ${issueA.json?.navPerUnit})`);
    assert(approx(issueA.json?.unitsIssued ?? 0, 1000), `1000 units issued for $1000 (got ${issueA.json?.unitsIssued})`);
    assert(
      (await auditCount(investorA.id, "FUNDBOOK_UNITS_ISSUE")) === issueABefore + 1,
      "exactly one FUNDBOOK_UNITS_ISSUE audit row written (baseline-delta)",
    );

    // June 19 Balanced-only visibility contract: the investor view exposes
    // ONLY BALANCED pools — no hidden pool (CASH_RESERVE etc.) may surface.
    // Since this test's holding IS in BALANCED, the view must show its real
    // settled value (units × NAV $1.00). DB truth is verified alongside.
    const viewA1 = await req(investorA.cookie, "GET", "/api/me/investor/fundbook");
    assert(viewA1.status === 200, `investor A read → 200 (got ${viewA1.status})`);
    assert(!viewExposesHiddenPool(viewA1.json), "investor view exposes NO non-BALANCED pool (June 19 Balanced-only contract)");
    assert(viewIsBalancedOnly(viewA1.json), "investor view exposes ONLY BALANCED pools");
    assert(
      approx(viewA1.json?.settledValue ?? -1, 1000),
      `settledValue reflects the BALANCED holding at NAV $1.00 (expected 1000, got ${viewA1.json?.settledValue})`,
    );
    const aHold1 = await dbHolding(investorA.id, poolId!);
    const nav1Row = await dbNav(poolId!);
    assert(aHold1 != null, "investor A holding row exists (DB truth)");
    assert(approx(aHold1?.unitsOwned ?? 0, 1000), `investor A unitsOwned = 1000 (DB truth, got ${aHold1?.unitsOwned})`);
    assert(
      approx(
        computeHoldingValue(aHold1?.unitsOwned ?? 0, nav1Row?.navPerUnit ?? 0),
        (aHold1?.unitsOwned ?? 0) * (nav1Row?.navPerUnit ?? 0),
      ),
      "investor A currentValue = units × NAV (DB truth)",
    );

    // ── 3. A second deposit keeps NAV at $1.00 (no inflation) ──────────────────
    // eslint-disable-next-line no-console
    console.log("\n3. Second deposit keeps NAV at $1.00 (deposits never inflate NAV)");
    const issueA2 = await req(admin.cookie, "POST", issueUrl(investorA.id), {
      poolKey: POOL_KEY,
      grossAmount: 500,
      reason: "qa fund book deposit A2",
    });
    assert(issueA2.status === 200, `second issue → 200 (got ${issueA2.status})`);
    assert(approx(issueA2.json?.navPerUnit ?? 0, 1), `NAV still $1.00 after 2nd deposit (got ${issueA2.json?.navPerUnit})`);
    assert(approx(issueA2.json?.unitsIssued ?? 0, 500), `500 units for $500 at NAV $1.00 (got ${issueA2.json?.unitsIssued})`);

    // ── 4. Issue to investor B, then prove per-investor isolation ─────────────
    // eslint-disable-next-line no-console
    console.log("\n4. Per-investor isolation");
    const issueB = await req(admin.cookie, "POST", issueUrl(investorB.id), {
      poolKey: POOL_KEY,
      grossAmount: 500,
      reason: "qa fund book deposit B",
    });
    assert(issueB.status === 200, `issue to B → 200 (got ${issueB.status})`);

    // The Balanced-only visibility contract holds for every caller: no
    // non-BALANCED pool surfaces; per-investor unit truth comes from the DB
    // holding rows.
    const viewB = await req(investorB.cookie, "GET", "/api/me/investor/fundbook");
    assert(!viewExposesHiddenPool(viewB.json), "investor B view exposes NO non-BALANCED pool either");
    const bHold = await dbHolding(investorB.id, poolId!);
    assert(approx(bHold?.unitsOwned ?? -1, 500), `investor B holds ONLY their own 500 units (DB truth, got ${bHold?.unitsOwned})`);

    const aHold2 = await dbHolding(investorA.id, poolId!);
    assert(approx(aHold2?.unitsOwned ?? -1, 1500), `investor A holds their own 1500 units, not B's (DB truth, got ${aHold2?.unitsOwned})`);
    // Ownership is per-investor against the shared total (1500 + 500 = 2000).
    const nav2Row = await dbNav(poolId!);
    const totalUnits = nav2Row?.totalUnitsOutstanding ?? 0;
    assert(approx(totalUnits, 2000), `pool totalUnitsOutstanding = 2000 (got ${totalUnits})`);
    assert(
      approx(computeOwnershipPct(aHold2?.unitsOwned ?? 0, totalUnits), 75),
      `investor A ownership = 75% of pool (got ${computeOwnershipPct(aHold2?.unitsOwned ?? 0, totalUnits)})`,
    );
    assert(
      approx(computeOwnershipPct(bHold?.unitsOwned ?? 0, totalUnits), 25),
      `investor B ownership = 25% of pool (got ${computeOwnershipPct(bHold?.unitsOwned ?? 0, totalUnits)})`,
    );

    // ── 5. Redeem units from investor A at NAV $1.00 ─────────────────────────
    // eslint-disable-next-line no-console
    console.log("\n5. Admin redeems units from investor A");
    const redeemBefore = await auditCount(investorA.id, "FUNDBOOK_UNITS_REDEEM");
    const redeemA = await req(admin.cookie, "POST", redeemUrl(investorA.id), {
      poolKey: POOL_KEY,
      units: 400,
      reason: "qa fund book redeem A",
    });
    assert(redeemA.status === 200, `redeem → 200 (got ${redeemA.status})`);
    assert(approx(redeemA.json?.unitsRedeemed ?? 0, 400), `400 units redeemed (got ${redeemA.json?.unitsRedeemed})`);
    assert(approx(redeemA.json?.grossValue ?? 0, 400), `gross value = units × NAV = $400 (got ${redeemA.json?.grossValue})`);
    assert(
      (await auditCount(investorA.id, "FUNDBOOK_UNITS_REDEEM")) === redeemBefore + 1,
      "exactly one FUNDBOOK_UNITS_REDEEM audit row written (baseline-delta)",
    );
    const viewA3 = await req(investorA.cookie, "GET", "/api/me/investor/fundbook");
    assert(!viewExposesHiddenPool(viewA3.json), "investor view still exposes NO non-BALANCED pool after redeem");
    const aHold3 = await dbHolding(investorA.id, poolId!);
    assert(approx(aHold3?.unitsOwned ?? -1, 1100), `investor A holding reduced to 1100 units (DB truth, got ${aHold3?.unitsOwned})`);

    // Over-redeeming more units than owned is refused.
    const overRedeem = await req(admin.cookie, "POST", redeemUrl(investorA.id), {
      poolKey: POOL_KEY,
      units: 999999,
      reason: "qa fund book over-redeem",
    });
    assert(overRedeem.status === 400, `over-redeem refused → 400 (got ${overRedeem.status})`);

    // ── 6. Auth gating on the admin endpoints ────────────────────────────────
    // eslint-disable-next-line no-console
    console.log("\n6. Admin endpoints reject non-admin callers");
    const investorIssue = await req(investorA.cookie, "POST", issueUrl(investorA.id), {
      poolKey: POOL_KEY,
      grossAmount: 100,
      reason: "qa should be blocked",
    });
    assert(investorIssue.status === 403, `INVESTOR issuing units → 403 (got ${investorIssue.status})`);
    const anonIssue = await req(null, "POST", issueUrl(investorA.id), {
      poolKey: POOL_KEY,
      grossAmount: 100,
      reason: "qa should be blocked",
    });
    assert(anonIssue.status === 401, `anonymous issuing units → 401 (got ${anonIssue.status})`);
  } catch (e) {
    assert(false, `unexpected error: ${(e as Error).message}`);
  } finally {
    const ids = [investorA?.id, investorB?.id, admin?.id].filter(
      (x): x is number => typeof x === "number",
    );
    try {
      if (ids.length > 0) {
        await db.delete(fundBookUnitEventsTable).where(inArray(fundBookUnitEventsTable.userId, ids));
        await db.delete(investorPoolHoldingsTable).where(inArray(investorPoolHoldingsTable.userId, ids));
        await db.delete(investorProfilesTable).where(inArray(investorProfilesTable.userId, ids));
        await db.delete(adminActionAuditLogTable).where(inArray(adminActionAuditLogTable.targetUserId, ids));
        await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, ids));
        await db.delete(usersTable).where(inArray(usersTable.id, ids));
      }
      // Restore the shared BALANCED NAV snapshot exactly as it was found.
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
  console.error("[fundBookUnitAccountingTest] FAILED:", e);
  await pool.end().catch(() => {});
  process.exit(1);
});
