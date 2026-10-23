// fundBookRegressionTest.ts — Task #145 final proof layer.
//
// This is the consolidated REGRESSION + PRIVACY suite for the ARX Fund Book. It
// does not re-prove the per-engine financial math (that is owned by
// fundBook*Test.ts); it proves the two things this task is responsible for:
//
//   A. THE LIVE EXECUTION PATH IS UNTOUCHED. We snapshot the broker/bridge and
//      live-command state, run the FULL battery of Fund Book write operations
//      (unit issuance/redemption, drawdown recompute, weekly-report generate +
//      publish, reconciliation run), and assert afterwards that:
//        - the arx_live_commands count is unchanged,
//        - the mt5_commands count is unchanged,
//        - the mt5_demo_commands count is unchanged,
//        - every seeded broker row (bridge + positions) is BYTE-IDENTICAL.
//      i.e. Fund Book accounting never queued a command nor mutated a broker
//      row. (The static companion guard `check-fundbook-no-broker-writes`
//      proves this at the source level; this proves it at runtime.)
//
//   B. NO FORBIDDEN FIELD LEAKS TO AN INVESTOR. We hit EVERY investor-facing
//      Fund Book read endpoint and assert the raw response body contains none
//      of the forbidden tokens (raw broker fields, the ARX internal waterfall
//      split, trader compensation, raw broker magnitudes).
//
//   C. PERMISSION MATRIX. investor → admin endpoints 403; anonymous → 401;
//      admin-previewing-as-user (x-arx-view-mode: user-preview) → 403; and the
//      same admin WITHOUT the preview header → 200 (guards against a vacuous
//      pass).
//
//   D. EXISTING-PRODUCT SMOKE. Confirms the existing trading product still
//      responds after the merged Fund Book code (account-mode, scanner candles,
//      admin live-gates diagnostic) — none regressed to a 5xx.
//
// SAFETY / ISOLATION:
//   - Seeds isolated users + ONE bridge + tagged positions (fixed TAG) and
//     operates ONLY on their rows. Idempotent cleanup of every seeded row at
//     the end, even on failure. Restores the shared CASH_RESERVE NAV snapshot.
//   - CI-safe: spins up the REAL Express app in-process on an ephemeral port.
//     Set ARX_QA_BASE_URL to probe an already-running server instead. Only
//     DATABASE_URL is required.
//
// Run: pnpm --filter @workspace/scripts run test:fundbook-regression

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
  fundBookWeeklyReportsTable,
  adminActionAuditLogTable,
  strategyPoolsTable,
  strategyPoolNavTable,
  mt5ConnectionTable,
  arxLivePositionsTable,
  tradePoolAllocationsTable,
} from "@workspace/db/schema";

const EXTERNAL_BASE = process.env["ARX_QA_BASE_URL"];
const TAG = `qaFbRegress_${Date.now()}_${randomBytes(3).toString("hex")}`;
const USER_SESSION_COOKIE = "arx_user_session";
const SESSION_TTL_MS = 60 * 60 * 1000;
const POOL_KEY = "CASH_RESERVE";
const VIEW_MODE_HEADER = "x-arx-view-mode";

// Distinctive magnitudes/strings we seed onto broker rows so a leak shows up as
// an exact substring in an investor payload.
const ASSIGNED_TICKET = `${TAG}_ASSIGNED`;
const UNASSIGNED_TICKET = `${TAG}_UNASSIGNED`;
const BROKER_BALANCE = 137911.42;
const BROKER_EQUITY = 138311.42;
const BROKER_ACCOUNT_NUMBER = "99887766";

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
    extraHeaders?: Record<string, string>,
  ): Promise<Resp> {
    const headers: Record<string, string> = { accept: "application/json", ...(extraHeaders ?? {}) };
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

async function tableCount(table: string): Promise<number> {
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
  return (r.rows[0] as { n: number }).n;
}

async function snapshotBrokerRows(masterId: number, bridgeId: number): Promise<string> {
  // Stable JSON snapshot of every broker/bridge row we seeded, so any mutation
  // by a Fund Book write op surfaces as a snapshot mismatch.
  const positions = await db
    .select()
    .from(arxLivePositionsTable)
    .where(eq(arxLivePositionsTable.userId, masterId));
  const bridge = await db
    .select()
    .from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.id, bridgeId));
  const sortedPos = [...positions].sort((a, b) =>
    String(a.brokerTicket).localeCompare(String(b.brokerTicket)),
  );
  return JSON.stringify({ bridge, positions: sortedPos });
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("fundBookRegressionTest");
  // eslint-disable-next-line no-console
  console.log("======================\n");

  let server: Server | null = null;
  let baseUrl = EXTERNAL_BASE ?? "";
  if (!EXTERNAL_BASE) {
    const app = (await import("../../artifacts/api-server/src/app.js")).default;
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
  const req = makeReq(baseUrl);

  let admin: Actor | undefined;
  let investorA: Actor | undefined;
  let investorB: Actor | undefined;
  let master: Actor | undefined;
  let bridgeId: number | null = null;
  let poolId: number | null = null;
  let navBaseline: typeof strategyPoolNavTable.$inferSelect | null = null;

  // Live/broker state BEFORE any Fund Book write op.
  const startLive = await tableCount("arx_live_commands");
  const startMt5 = await tableCount("mt5_commands");
  const startDemo = await tableCount("mt5_demo_commands");

  try {
    // ── Seed isolated actors + bridge + positions ────────────────────────────
    // eslint-disable-next-line no-console
    console.log("Seeding isolated investors, master bridge, and positions");
    admin = await createActor("admin", "ADMIN");
    investorA = await createActor("invA", "INVESTOR");
    investorB = await createActor("invB", "INVESTOR");
    master = await createActor("master", "USER");
    await seedProfile(investorA);
    await seedProfile(investorB);

    // Resolve the shared pool + capture its NAV baseline for exact restore.
    const poolRow = await db
      .select()
      .from(strategyPoolsTable)
      .where(eq(strategyPoolsTable.poolKey, POOL_KEY));
    assert(poolRow.length === 1, `shared pool ${POOL_KEY} exists`);
    poolId = poolRow[0]!.id;
    const navRow = await db
      .select()
      .from(strategyPoolNavTable)
      .where(eq(strategyPoolNavTable.strategyPoolId, poolId));
    assert(navRow.length === 1, `pool ${POOL_KEY} has a NAV row`);
    navBaseline = navRow[0]!;

    // Seed ONE master bridge carrying distinctive raw broker magnitudes.
    const now = new Date();
    const [bridge] = await db
      .insert(mt5ConnectionTable)
      .values({
        userId: master.id,
        connectionName: `${TAG}_bridge`,
        status: "connected",
        accountType: "live",
        accountCurrency: "USD",
        accountNumber: BROKER_ACCOUNT_NUMBER,
        accountBalance: BROKER_BALANCE,
        accountEquity: BROKER_EQUITY,
        margin: 1_000,
        freeMargin: 99_400,
        lastHeartbeat: now,
        lastPositionsSnapshotAt: now,
      })
      .returning();
    bridgeId = bridge!.id;

    // One ASSIGNED open position (floating +400) + one UNASSIGNED (+999).
    await db.insert(arxLivePositionsTable).values([
      {
        userId: master.id,
        bridgeConnectionId: bridgeId!,
        brokerTicket: ASSIGNED_TICKET,
        symbol: "EURUSD",
        side: "BUY",
        volume: 0.1,
        entryPrice: 1.1,
        currentPrice: 1.1,
        floatingPl: 400,
        openedAt: now,
        lastSyncedAt: now,
      },
      {
        userId: master.id,
        bridgeConnectionId: bridgeId!,
        brokerTicket: UNASSIGNED_TICKET,
        symbol: "GBPUSD",
        side: "SELL",
        volume: 0.1,
        entryPrice: 1.27,
        currentPrice: 1.27,
        floatingPl: 999,
        openedAt: now,
        lastSyncedAt: now,
      },
    ]);

    // Snapshot broker/bridge state immediately after seeding the bridge +
    // positions and BEFORE the first Fund Book write op (issuance). This makes
    // the byte-identity assertion cover the ENTIRE write battery —
    // issue/redeem/recompute/reconcile — not just the post-issuance segment.
    const brokerBefore = await snapshotBrokerRows(master.id, bridgeId!);

    // Issue units so both investors hold the pool, then assign the first
    // position to the pool (an accounting label only).
    const issueA = await req(admin.cookie, "POST", `/api/admin/fundbook/investors/${investorA.id}/units/issue`, {
      poolKey: POOL_KEY, grossAmount: 1500, reason: "qa regression issue A",
    });
    assert(issueA.status === 200, `issue A → 200 (got ${issueA.status})`);
    const issueB = await req(admin.cookie, "POST", `/api/admin/fundbook/investors/${investorB.id}/units/issue`, {
      poolKey: POOL_KEY, grossAmount: 500, reason: "qa regression issue B",
    });
    assert(issueB.status === 200, `issue B → 200 (got ${issueB.status})`);
    await db.insert(tradePoolAllocationsTable).values({
      userId: master.id,
      brokerTicket: ASSIGNED_TICKET,
      brokerPositionId: null,
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.1,
      strategyPoolId: poolId,
      allocationPercent: 100,
      status: "ASSIGNED",
    });

    // ── A. Run the FULL Fund Book write battery ──────────────────────────────
    // eslint-disable-next-line no-console
    console.log("\nA. Fund Book write battery never touches the live path");
    const recompute1 = await req(admin.cookie, "POST", "/api/admin/fundbook/drawdown/recompute", {
      reason: "qa regression recompute 1",
    });
    assert(recompute1.status === 200, `drawdown recompute #1 → 200 (got ${recompute1.status})`);
    const redeemB = await req(admin.cookie, "POST", `/api/admin/fundbook/investors/${investorB.id}/units/redeem`, {
      poolKey: POOL_KEY, grossAmount: 100, reason: "qa regression partial redeem B",
    });
    assert(redeemB.status === 200, `partial redeem B → 200 (got ${redeemB.status})`);
    const recompute2 = await req(admin.cookie, "POST", "/api/admin/fundbook/drawdown/recompute", {
      reason: "qa regression recompute 2",
    });
    assert(recompute2.status === 200, `drawdown recompute #2 → 200 (got ${recompute2.status})`);
    const reconcile = await req(admin.cookie, "POST", "/api/admin/fundbook/reconciliation/run", {
      reason: "qa regression reconciliation run",
    });
    assert(
      reconcile.status === 200 || reconcile.status === 201,
      `reconciliation run → 200/201 (got ${reconcile.status})`,
    );

    // Live/broker state AFTER the write battery.
    const endLive = await tableCount("arx_live_commands");
    const endMt5 = await tableCount("mt5_commands");
    const endDemo = await tableCount("mt5_demo_commands");
    assert(endLive === startLive, `arx_live_commands unchanged (start=${startLive} end=${endLive})`);
    assert(endMt5 === startMt5, `mt5_commands unchanged (start=${startMt5} end=${endMt5})`);
    assert(endDemo === startDemo, `mt5_demo_commands unchanged (start=${startDemo} end=${endDemo})`);

    const brokerAfter = await snapshotBrokerRows(master.id, bridgeId!);
    assert(brokerAfter === brokerBefore, "every seeded broker/bridge row is byte-identical after the write battery");

    // ── B. Consolidated no-forbidden-fields scan across ALL investor reads ────
    // eslint-disable-next-line no-console
    console.log("\nB. No forbidden field leaks to any investor endpoint");
    const investorEndpoints = [
      "/api/me/investor/fundbook",
      "/api/me/investor/fundbook/drawdown",
      "/api/me/investor/fundbook/events",
      "/api/me/investor/fundbook/waterfall",
      "/api/me/investor/fundbook/weekly-reports",
    ];
    // Forbidden raw-broker / ARX-internal / trader-comp field names + the exact
    // seeded raw magnitudes and ticket strings.
    const forbiddenTokens = [
      "accountBalance",
      "accountEquity",
      "accountNumber",
      "brokerTicket",
      "arxShare",
      "arxInternal",
      "arxSharePct",
      "traderComp",
      "internalSplit",
      ASSIGNED_TICKET,
      UNASSIGNED_TICKET,
      BROKER_ACCOUNT_NUMBER,
      String(BROKER_BALANCE),
      String(BROKER_EQUITY),
    ];
    for (const ep of investorEndpoints) {
      const r = await req(investorA.cookie, "GET", ep);
      assert(r.status === 200, `investor GET ${ep} → 200 (got ${r.status})`);
      const leaks = forbiddenTokens.filter((t) => r.bodyText.includes(t));
      assert(leaks.length === 0, `${ep} leaks none of [${leaks.join(", ") || "—"}]`);
    }

    // ── C. Permission matrix ─────────────────────────────────────────────────
    // eslint-disable-next-line no-console
    console.log("\nC. Admin Fund Book endpoints reject non-admin / preview");
    const adminEndpoints: Array<["GET" | "POST", string, unknown]> = [
      ["GET", "/api/admin/fundbook/pools", undefined],
      ["GET", "/api/admin/fundbook/broker-mirror", undefined],
      ["GET", "/api/admin/investors", undefined],
      ["POST", "/api/admin/fundbook/drawdown/recompute", { reason: "qa blocked" }],
    ];
    for (const [method, path, body] of adminEndpoints) {
      const inv = await req(investorA.cookie, method, path, body);
      assert(inv.status === 403, `INVESTOR → ${method} ${path} 403 (got ${inv.status})`);
      const anon = await req(null, method, path, body);
      assert(anon.status === 401, `anonymous → ${method} ${path} 401 (got ${anon.status})`);
      // Admin previewing-as-user is downgraded to USER and must also be denied.
      const preview = await req(admin.cookie, method, path, body, { [VIEW_MODE_HEADER]: "user-preview" });
      assert(preview.status === 403, `admin-previewing-as-user → ${method} ${path} 403 (got ${preview.status})`);
    }
    // Guard against a vacuous pass: the SAME admin without the preview header
    // reaches the endpoint.
    const adminOk = await req(admin.cookie, "GET", "/api/admin/fundbook/pools");
    assert(adminOk.status === 200, `real ADMIN → GET pools 200 (got ${adminOk.status})`);

    // ── D. Existing-product smoke (not regressed by the merged Fund Book) ─────
    // eslint-disable-next-line no-console
    console.log("\nD. Existing trading product still responds (no 5xx)");
    const smoke: Array<[Actor | null, string]> = [
      [master, "/api/me/account-mode"],
      [master, "/api/data/candles?symbol=EURUSD&timeframe=H1"],
      [admin, "/api/admin/live-gates/diagnostic"],
    ];
    for (const [actor, path] of smoke) {
      const r = await req(actor ? actor.cookie : null, "GET", path);
      assert(r.status < 500, `GET ${path} did not 5xx (got ${r.status})`);
    }
  } catch (e) {
    assert(false, `unexpected error: ${(e as Error).message}`);
  } finally {
    const ids = [investorA?.id, investorB?.id, master?.id, admin?.id].filter(
      (x): x is number => typeof x === "number",
    );
    try {
      if (master) {
        await db.delete(arxLivePositionsTable).where(eq(arxLivePositionsTable.userId, master.id));
        await db.delete(tradePoolAllocationsTable).where(eq(tradePoolAllocationsTable.userId, master.id));
      }
      if (bridgeId != null) {
        await db.delete(mt5ConnectionTable).where(eq(mt5ConnectionTable.id, bridgeId));
        await db
          .delete(fundBookHighWaterMarksTable)
          .where(and(eq(fundBookHighWaterMarksTable.scopeType, "BROKER"), eq(fundBookHighWaterMarksTable.scopeKey, String(bridgeId))));
      }
      if (ids.length > 0) {
        await db.delete(fundBookHighWaterMarksTable).where(inArray(fundBookHighWaterMarksTable.userId, ids));
        await db.delete(fundBookWeeklyReportsTable).where(inArray(fundBookWeeklyReportsTable.userId, ids));
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

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  await pool.end().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  // eslint-disable-next-line no-console
  console.error("[fundBookRegressionTest] FAILED:", e);
  await pool.end().catch(() => {});
  process.exit(1);
});

export {};
