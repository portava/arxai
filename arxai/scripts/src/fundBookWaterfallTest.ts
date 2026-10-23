// fundBookWaterfallTest.ts — Automated proof (Task #142, split updated Task #610)
// of the ARX Fund Book profit waterfall (45.5 ARX / 24.5 trader / 30 investor).
//
// IT PROVES (pure math + the REAL Express app in-process):
//   PURE (waterfallEngine.ts):
//     1. A loss (current < HWM) yields a $0 split and does NOT advance the HWM.
//     2. A run at/below the HWM yields a $0 split (no crystallization).
//     3. A positive run splits eligible profit EXACTLY 45.5% ARX company /
//        24.5% trader bucket / 30% investor (the three shares sum to
//        eligibleProfit) and advances the HWM to current.
//     4. The investor distributable is allocated strictly pro-rata by units; the
//        per-cent rounding remainder goes to the largest holder so the shares
//        sum to the distributable EXACTLY; zero-unit holders get $0.
//   INTEGRATION (admin endpoints + investor reads):
//     5. A positive run records eligible/ARX(60)/investor(40) on the admin run,
//        writes per-investor allocations pro-rata, AND a FUNDBOOK_WATERFALL_RUN
//        audit row (baseline-delta).
//     6. The /me investor read returns ONLY the caller's own distributable and
//        NEVER any ARX figure (deep scan of the payload for an "arx" key).
//     7. Per-investor isolation: investor B never sees investor A's allocation.
//     8. Idempotent: a second ACTIVE RUN for the same (pool, period) is refused.
//     9. Reversal offsets: reversing a run negates every allocation so each
//        investor's running distributable returns to $0, marks the original
//        REVERSED, writes a FUNDBOOK_WATERFALL_REVERSE audit row, and the
//        investor payload STILL carries no ARX.
//    10. A loss run records eligible $0 with no allocations and no ARX entry.
//    11. Auth gating: INVESTOR → 403, anonymous → 401 on both the run and the
//        admin list endpoint.
//
// SAFETY / ISOLATION:
//   - Seeds isolated users (fixed TAG) + TAG-scoped period keys, and operates
//     ONLY on their rows / those periods. Idempotent cleanup at the end even on
//     failure, with the shared CASH_RESERVE NAV snapshot restored exactly.
//   - RECORD-ONLY: asserts the arx_live_commands count is unchanged end-to-end.
//   - CI-safe: spins up the REAL Express app in-process on an ephemeral port.
//     Set ARX_QA_BASE_URL to probe an already-running server instead. Only
//     DATABASE_URL is required.
//
// Run: pnpm --filter @workspace/scripts run test:fundbook-waterfall

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
  adminActionAuditLogTable,
  strategyPoolsTable,
  strategyPoolNavTable,
  fundBookHighWaterMarksTable,
  fundBookWaterfallRunsTable,
  fundBookWaterfallAllocationsTable,
  fundBookArxInternalEntriesTable,
} from "@workspace/db/schema";
import {
  computeWaterfallSplit,
  allocateInvestorDistributable,
} from "../../artifacts/api-server/src/lib/fundbook/waterfallEngine.js";

const EXTERNAL_BASE = process.env["ARX_QA_BASE_URL"];
const TAG = `qaWaterfall_${Date.now()}_${randomBytes(3).toString("hex")}`;
const USER_SESSION_COOKIE = "arx_user_session";
const SESSION_TTL_MS = 60 * 60 * 1000;
const POOL_KEY = "CASH_RESERVE";
const PERIOD_PROFIT = `${TAG}-PROFIT`;
const PERIOD_LOSS = `${TAG}-LOSS`;

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

// Deep-scan any value for a key whose name mentions "arx" (case-insensitive) or
// for the exact admin-only field names. Returns the path of the first hit.
function findArxLeak(value: unknown, path = "$"): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findArxLeak(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/arx/i.test(k)) return `${path}.${k}`;
      if (k === "eligibleProfit" || k === "highWaterValueBefore" || k === "highWaterValueAfter") {
        return `${path}.${k}`;
      }
      const hit = findArxLeak(v, `${path}.${k}`);
      if (hit) return hit;
    }
  }
  return null;
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

async function seedHolding(actor: Actor, poolId: number, units: number): Promise<void> {
  await db.insert(investorPoolHoldingsTable).values({
    userId: actor.id,
    strategyPoolId: poolId,
    unitsOwned: units,
    status: "ACTIVE",
  });
}

// Whether the pool has a POOL overlay HWM row. The route resolves currentNetValue
// from the overlay's currentValue when present (it carries assigned floating P/L),
// else from strategy_pool_nav.totalPoolValue — so the test must drive whichever
// source actually wins. The contributed baseline ALWAYS comes from NAV
// (totalPoolValue − realized − unrealized), regardless of the overlay.
let overlayExists = false;

// Deterministically set the run inputs: the cutoff net value and the contributed
// baseline the first run is measured against. When an overlay row exists we drive
// currentNetValue through it and pin the NAV so baseline == `baseline`; otherwise
// NAV totalPoolValue serves as currentNetValue and realized P/L encodes profit.
async function setScenario(
  poolId: number,
  currentNetValue: number,
  baseline: number,
): Promise<void> {
  if (overlayExists) {
    await db
      .update(fundBookHighWaterMarksTable)
      .set({ currentValue: currentNetValue })
      .where(
        and(
          eq(fundBookHighWaterMarksTable.scopeType, "POOL"),
          eq(fundBookHighWaterMarksTable.scopeKey, String(poolId)),
        ),
      );
    await db
      .update(strategyPoolNavTable)
      .set({ totalPoolValue: baseline, realizedPl: 0, unrealizedPl: 0 })
      .where(eq(strategyPoolNavTable.strategyPoolId, poolId));
  } else {
    await db
      .update(strategyPoolNavTable)
      .set({ totalPoolValue: currentNetValue, realizedPl: currentNetValue - baseline, unrealizedPl: 0 })
      .where(eq(strategyPoolNavTable.strategyPoolId, poolId));
  }
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

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("fundBookWaterfallTest");
  // eslint-disable-next-line no-console
  console.log("=====================\n");

  const startLive = await liveCommandsCount();

  // ── Pure-engine proofs (no IO) ────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log("1. Pure waterfall split + allocation math");
  {
    const loss = computeWaterfallSplit({ currentNetValue: 9000, priorHighWaterMark: 10000 });
    assert(loss.eligibleProfit === 0, "loss → eligible $0");
    assert(
      loss.arxInternalShare === 0 && loss.traderShare === 0 && loss.investorDistributable === 0,
      "loss → no 45.5/24.5/30 split",
    );
    assert(loss.highWaterValueAfter === 10000, "loss → HWM unchanged (does not advance)");
    assert(loss.isPositiveRun === false, "loss → not a positive run");

    const flat = computeWaterfallSplit({ currentNetValue: 10000, priorHighWaterMark: 10000 });
    assert(flat.eligibleProfit === 0, "at HWM → eligible $0 (no crystallization)");
    assert(flat.highWaterValueAfter === 10000, "at HWM → HWM unchanged");

    const win = computeWaterfallSplit({ currentNetValue: 11000, priorHighWaterMark: 10000 });
    assert(win.eligibleProfit === 1000, "win → eligible = current − HWM = $1000");
    // Task #610 split: 45.5% ARX company / 24.5% trader bucket / 30% investor.
    assert(win.arxInternalShare === 455, "win → ARX 45.5% = $455");
    assert(win.traderShare === 245, "win → trader 24.5% = $245");
    assert(win.investorDistributable === 300, "win → investor 30% = $300");
    assert(
      approx(win.arxInternalShare + win.traderShare + win.investorDistributable, win.eligibleProfit),
      "win → 45.5/24.5/30 shares sum EXACTLY to eligible profit",
    );
    assert(win.highWaterValueAfter === 11000, "win → HWM advances to current value");

    // Pro-rata + penny remainder to the largest holder. $400 over 1500/500 units.
    const allocs = allocateInvestorDistributable(
      400,
      [{ userId: 1, units: 1500 }, { userId: 2, units: 500 }],
      2000,
    );
    const a1 = allocs.find((a) => a.userId === 1)!;
    const a2 = allocs.find((a) => a.userId === 2)!;
    assert(approx(a1.distributableShare, 300), "pro-rata: 75% holder gets $300");
    assert(approx(a2.distributableShare, 100), "pro-rata: 25% holder gets $100");
    assert(
      approx(a1.distributableShare + a2.distributableShare, 400),
      "pro-rata: shares sum EXACTLY to the distributable",
    );

    // Penny-remainder case: $100 across three equal holders = 33.33/33.33/33.34.
    const thirds = allocateInvestorDistributable(
      100,
      [{ userId: 1, units: 100 }, { userId: 2, units: 100 }, { userId: 3, units: 100 }],
      300,
    );
    const sumThirds = thirds.reduce((acc, a) => acc + a.distributableShare, 0);
    assert(approx(sumThirds, 100), "penny remainder: three equal holders still sum to $100");

    // Fractional 8dp units: ownership must be computed at full precision, NOT a
    // cents-rounded denominator. 123.45678901 + 76.54321099 = 200.0 exactly;
    // $100 distributable → ~$61.73 / ~$38.27, summing to $100 exactly.
    const fracHolders = [
      { userId: 1, units: 123.45678901 },
      { userId: 2, units: 76.54321099 },
    ];
    const fracTotal = fracHolders.reduce((acc, h) => acc + h.units, 0);
    const frac = allocateInvestorDistributable(100, fracHolders, fracTotal);
    const f1 = frac.find((a) => a.userId === 1)!;
    const f2 = frac.find((a) => a.userId === 2)!;
    assert(approx(f1.distributableShare, 61.73), `8dp pro-rata: holder 1 ≈ $61.73 (got ${f1.distributableShare})`);
    assert(approx(f2.distributableShare, 38.27), `8dp pro-rata: holder 2 ≈ $38.27 (got ${f2.distributableShare})`);
    assert(
      approx(f1.distributableShare + f2.distributableShare, 100),
      "8dp pro-rata: shares sum EXACTLY to the distributable",
    );
    // Ownership fraction is computed at full unit precision (the route now feeds
    // a round8 denominator, never round2): 123.45678901 / 200 = 0.6172839…
    assert(
      Math.abs(f1.ownershipFraction - 0.6172839450) < 1e-9,
      `8dp pro-rata: ownership fraction is full-precision (got ${f1.ownershipFraction})`,
    );

    // Zero-units holder gets nothing; no units → nothing allocated.
    const withZero = allocateInvestorDistributable(
      400,
      [{ userId: 1, units: 1000 }, { userId: 2, units: 0 }],
      1000,
    );
    assert(withZero.find((a) => a.userId === 2)!.distributableShare === 0, "zero-unit holder gets $0");
    const noUnits = allocateInvestorDistributable(400, [{ userId: 1, units: 0 }], 0);
    assert(noUnits[0]!.distributableShare === 0, "no units in pool → nothing allocated");
  }

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
  let overlayOrigValue: number | null = null;

  try {
    investorA = await createActor("investorA", "INVESTOR");
    investorB = await createActor("investorB", "INVESTOR");
    admin = await createActor("admin", "ADMIN");
    await seedProfile(investorA);
    await seedProfile(investorB);

    // Lazy-ensure pools, capture + reset the shared CASH_RESERVE NAV snapshot.
    await req(admin.cookie, "GET", "/api/admin/fundbook/pools");
    const poolRow = (
      await db.select().from(strategyPoolsTable).where(eq(strategyPoolsTable.poolKey, POOL_KEY)).limit(1)
    )[0];
    assert(poolRow != null, "CASH_RESERVE seed pool exists after lazy ensure");
    poolId = poolRow!.id;
    navBaseline = (
      await db.select().from(strategyPoolNavTable).where(eq(strategyPoolNavTable.strategyPoolId, poolId)).limit(1)
    )[0]!;
    // Detect a pre-existing POOL overlay HWM row so scenarios drive the source
    // the route actually reads; capture its value to restore it untouched.
    const [overlayRow] = await db
      .select()
      .from(fundBookHighWaterMarksTable)
      .where(
        and(
          eq(fundBookHighWaterMarksTable.scopeType, "POOL"),
          eq(fundBookHighWaterMarksTable.scopeKey, String(poolId)),
        ),
      )
      .limit(1);
    overlayExists = overlayRow != null;
    overlayOrigValue = overlayRow ? overlayRow.currentValue : null;

    // Two active holders: A=1500 units (75%), B=500 units (25%).
    await seedHolding(investorA, poolId, 1500);
    await seedHolding(investorB, poolId, 500);

    // ── 2. Positive run: $1000 eligible → 45.5/24.5/30, pro-rata 225/75 ───────
    // eslint-disable-next-line no-console
    console.log("\n2. Positive waterfall run (45.5/24.5/30 split + pro-rata allocation)");
    // current net value 11000 over a contributed baseline of 10000 → eligible 1000.
    await setScenario(poolId, 11000, 10000);
    const runBefore = await auditCount("FUNDBOOK_WATERFALL_RUN");
    const runResp = await req(admin.cookie, "POST", "/api/admin/fundbook/waterfall", {
      poolKey: POOL_KEY,
      periodKey: PERIOD_PROFIT,
      reason: "qa waterfall positive run",
    });
    assert(runResp.status === 200, `run → 200 (got ${runResp.status})`);
    const run = runResp.json?.run;
    assert(approx(run?.eligibleProfit ?? -1, 1000), `eligible = $1000 (got ${run?.eligibleProfit})`);
    assert(approx(run?.arxInternalShare ?? -1, 455), `ARX internal = $455 (got ${run?.arxInternalShare})`);
    assert(approx(run?.traderShare ?? -1, 245), `trader bucket = $245 (got ${run?.traderShare})`);
    assert(approx(run?.investorDistributable ?? -1, 300), `investor distributable = $300 (got ${run?.investorDistributable})`);
    assert(
      run?.arxSharePct === 45.5 && run?.traderSharePct === 24.5 && run?.investorSharePct === 30,
      "split percentages snapshotted 45.5 / 24.5 / 30",
    );
    assert(approx(run?.totalUnitsAtCutoff ?? 0, 2000), `total units at cutoff = 2000 (got ${run?.totalUnitsAtCutoff})`);
    assert(
      (await auditCount("FUNDBOOK_WATERFALL_RUN")) === runBefore + 1,
      "exactly one FUNDBOOK_WATERFALL_RUN audit row (baseline-delta)",
    );
    const runId = run?.id as number;

    // Admin detail: allocations pro-rata 300/100.
    const detail = await req(admin.cookie, "GET", `/api/admin/fundbook/waterfall/${runId}`);
    assert(detail.status === 200, `admin detail → 200 (got ${detail.status})`);
    const detAllocs: any[] = detail.json?.allocations ?? [];
    const detA = detAllocs.find((a) => a.userId === investorA!.id);
    const detB = detAllocs.find((a) => a.userId === investorB!.id);
    assert(approx(detA?.distributableShare ?? -1, 225), `admin: investor A allocation = $225 (got ${detA?.distributableShare})`);
    assert(approx(detB?.distributableShare ?? -1, 75), `admin: investor B allocation = $75 (got ${detB?.distributableShare})`);
    // The admin per-investor breakdown the UI renders must be ARX-free: ARX lives
    // ONLY on the run header, never per-investor. Guard against an ARX column
    // leaking into allocation rows.
    for (const a of detAllocs) {
      assert(findArxLeak(a) === null, `admin allocation row (user ${a.userId}) carries NO ARX figure`);
    }

    // ── 3. Investor /me read: own distributable only, NEVER any ARX ───────────
    // eslint-disable-next-line no-console
    console.log("\n3. Investor /me waterfall read (own distributable, NO ARX)");
    const meA = await req(investorA.cookie, "GET", "/api/me/investor/fundbook/waterfall");
    assert(meA.status === 200, `investor A /me → 200 (got ${meA.status})`);
    assert(approx(meA.json?.totalDistributable ?? -1, 225), `investor A total distributable = $225 (got ${meA.json?.totalDistributable})`);
    const meALeak = findArxLeak(meA.json);
    assert(meALeak === null, `investor A payload carries NO ARX figure (leak at ${meALeak ?? "none"})`);

    const meB = await req(investorB.cookie, "GET", "/api/me/investor/fundbook/waterfall");
    assert(approx(meB.json?.totalDistributable ?? -1, 75), `investor B total distributable = $75 (got ${meB.json?.totalDistributable})`);
    assert(findArxLeak(meB.json) === null, "investor B payload carries NO ARX figure");
    // Isolation: B's allocations never reference A's run share.
    const bShares = (meB.json?.allocations ?? []).map((a: any) => a.distributableShare);
    assert(!bShares.some((s: number) => approx(s, 225)), "investor B never sees investor A's $225 share");

    // ── 4. Idempotent: a second ACTIVE RUN for the same period is refused ──────
    // eslint-disable-next-line no-console
    console.log("\n4. Idempotency (same pool + period is a no-op)");
    const dupe = await req(admin.cookie, "POST", "/api/admin/fundbook/waterfall", {
      poolKey: POOL_KEY,
      periodKey: PERIOD_PROFIT,
      reason: "qa waterfall duplicate run",
    });
    assert(dupe.status === 409, `duplicate run → 409 (got ${dupe.status})`);
    assert(dupe.json?.error === "WATERFALL_PERIOD_ALREADY_RUN", `duplicate run error code (got ${dupe.json?.error})`);

    // ── 5. Reversal offsets every allocation back to $0 ───────────────────────
    // eslint-disable-next-line no-console
    console.log("\n5. Reversal offsets allocations to $0 (append-only)");
    const revBefore = await auditCount("FUNDBOOK_WATERFALL_REVERSE");
    const reverse = await req(admin.cookie, "POST", `/api/admin/fundbook/waterfall/${runId}/reverse`, {
      reason: "qa waterfall reversal",
    });
    assert(reverse.status === 200, `reverse → 200 (got ${reverse.status})`);
    assert(approx(reverse.json?.run?.investorDistributable ?? 1, -300), `reversal negates distributable to -$300 (got ${reverse.json?.run?.investorDistributable})`);
    assert(reverse.json?.run?.runType === "REVERSAL", "reversal row is runType REVERSAL");
    assert(
      (await auditCount("FUNDBOOK_WATERFALL_REVERSE")) === revBefore + 1,
      "exactly one FUNDBOOK_WATERFALL_REVERSE audit row (baseline-delta)",
    );
    // Reversing an already-REVERSED run is an idempotency conflict → 409 (not a
    // masked 500). Covers the conflict-classification path.
    const dupeReverse = await req(admin.cookie, "POST", `/api/admin/fundbook/waterfall/${runId}/reverse`, {
      reason: "qa duplicate reversal",
    });
    assert(dupeReverse.status === 409, `re-reversing a REVERSED run → 409 (got ${dupeReverse.status})`);
    // Original is now REVERSED.
    const afterList = await req(admin.cookie, "GET", `/api/admin/fundbook/waterfall?poolKey=${POOL_KEY}`);
    const origRow = (afterList.json?.runs ?? []).find((r: any) => r.id === runId);
    assert(origRow?.status === "REVERSED", `original run marked REVERSED (got ${origRow?.status})`);
    // Each investor's running distributable returns to $0; still no ARX.
    const meAAfter = await req(investorA.cookie, "GET", "/api/me/investor/fundbook/waterfall");
    assert(approx(meAAfter.json?.totalDistributable ?? -1, 0), `investor A net distributable back to $0 after reversal (got ${meAAfter.json?.totalDistributable})`);
    assert(findArxLeak(meAAfter.json) === null, "investor A payload STILL carries no ARX after reversal");
    const meBAfter = await req(investorB.cookie, "GET", "/api/me/investor/fundbook/waterfall");
    assert(approx(meBAfter.json?.totalDistributable ?? -1, 0), `investor B net distributable back to $0 after reversal (got ${meBAfter.json?.totalDistributable})`);
    assert(findArxLeak(meBAfter.json) === null, "investor B payload STILL carries no ARX after reversal");

    // ── 6. Loss run: $0 eligible, no allocations, no ARX entry ─────────────────
    // eslint-disable-next-line no-console
    console.log("\n6. Loss run records $0 with no allocations / no ARX entry");
    // After the reversal there is no ACTIVE RUN, so the prior HWM falls back to
    // the contributed baseline. Make a loss: current net value 9000 below a
    // baseline of 10000 → eligible 0.
    await setScenario(poolId, 9000, 10000);
    const arxRowsBefore = (
      await db
        .select()
        .from(fundBookArxInternalEntriesTable)
        .where(eq(fundBookArxInternalEntriesTable.strategyPoolId, poolId))
    ).length;
    const lossResp = await req(admin.cookie, "POST", "/api/admin/fundbook/waterfall", {
      poolKey: POOL_KEY,
      periodKey: PERIOD_LOSS,
      reason: "qa waterfall loss run",
    });
    assert(lossResp.status === 200, `loss run → 200 (got ${lossResp.status})`);
    assert(approx(lossResp.json?.run?.eligibleProfit ?? -1, 0), `loss run eligible = $0 (got ${lossResp.json?.run?.eligibleProfit})`);
    assert(approx(lossResp.json?.run?.arxInternalShare ?? -1, 0), "loss run ARX = $0");
    // Run header records the ACTUAL resolved cutoff net value (9000), NOT the
    // prior HWM — auditability must hold even when no profit is crystallized.
    assert(
      approx(lossResp.json?.run?.currentNetValue ?? -1, 9000),
      `loss run header currentNetValue = 9000 actual cutoff (got ${lossResp.json?.run?.currentNetValue})`,
    );
    const lossDetail = await req(admin.cookie, "GET", `/api/admin/fundbook/waterfall/${lossResp.json?.run?.id}`);
    assert((lossDetail.json?.allocations ?? []).length === 0, "loss run writes NO allocations");
    const arxRowsAfter = (
      await db
        .select()
        .from(fundBookArxInternalEntriesTable)
        .where(eq(fundBookArxInternalEntriesTable.strategyPoolId, poolId))
    ).length;
    assert(arxRowsAfter === arxRowsBefore, "loss run writes NO ARX internal entry");

    // ── 7. Auth gating ────────────────────────────────────────────────────────
    // eslint-disable-next-line no-console
    console.log("\n7. Auth gating on admin waterfall endpoints");
    const invRun = await req(investorA.cookie, "POST", "/api/admin/fundbook/waterfall", {
      poolKey: POOL_KEY,
      periodKey: `${TAG}-NOPE`,
      reason: "qa should be blocked",
    });
    assert(invRun.status === 403, `INVESTOR running waterfall → 403 (got ${invRun.status})`);
    const anonRun = await req(null, "POST", "/api/admin/fundbook/waterfall", {
      poolKey: POOL_KEY,
      periodKey: `${TAG}-NOPE`,
      reason: "qa should be blocked",
    });
    assert(anonRun.status === 401, `anonymous running waterfall → 401 (got ${anonRun.status})`);
    const invList = await req(investorA.cookie, "GET", "/api/admin/fundbook/waterfall");
    assert(invList.status === 403, `INVESTOR listing waterfall runs → 403 (got ${invList.status})`);
  } catch (e) {
    assert(false, `unexpected error: ${(e as Error).message}`);
  } finally {
    const ids = [investorA?.id, investorB?.id, admin?.id].filter(
      (x): x is number => typeof x === "number",
    );
    try {
      // Remove the TAG-scoped waterfall rows first (runs + allocations + ARX).
      if (poolId != null) {
        const periods = [PERIOD_PROFIT, PERIOD_LOSS];
        await db
          .delete(fundBookWaterfallAllocationsTable)
          .where(
            and(
              eq(fundBookWaterfallAllocationsTable.strategyPoolId, poolId),
              inArray(fundBookWaterfallAllocationsTable.periodKey, periods),
            ),
          );
        await db
          .delete(fundBookArxInternalEntriesTable)
          .where(
            and(
              eq(fundBookArxInternalEntriesTable.strategyPoolId, poolId),
              inArray(fundBookArxInternalEntriesTable.periodKey, periods),
            ),
          );
        await db
          .delete(fundBookWaterfallRunsTable)
          .where(
            and(
              eq(fundBookWaterfallRunsTable.strategyPoolId, poolId),
              inArray(fundBookWaterfallRunsTable.periodKey, periods),
            ),
          );
      }
      if (ids.length > 0) {
        await db.delete(investorPoolHoldingsTable).where(inArray(investorPoolHoldingsTable.userId, ids));
        await db.delete(investorProfilesTable).where(inArray(investorProfilesTable.userId, ids));
        await db.delete(adminActionAuditLogTable).where(inArray(adminActionAuditLogTable.adminId, ids));
        await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, ids));
        await db.delete(usersTable).where(inArray(usersTable.id, ids));
      }
      // Restore the shared CASH_RESERVE NAV snapshot exactly as it was found.
      if (poolId != null && navBaseline != null) {
        await db
          .update(strategyPoolNavTable)
          .set({
            totalPoolValue: navBaseline.totalPoolValue,
            realizedPl: navBaseline.realizedPl,
            unrealizedPl: navBaseline.unrealizedPl,
          })
          .where(eq(strategyPoolNavTable.strategyPoolId, poolId));
      }
      // Restore the overlay HWM currentValue exactly as it was found.
      if (poolId != null && overlayExists && overlayOrigValue != null) {
        await db
          .update(fundBookHighWaterMarksTable)
          .set({ currentValue: overlayOrigValue })
          .where(
            and(
              eq(fundBookHighWaterMarksTable.scopeType, "POOL"),
              eq(fundBookHighWaterMarksTable.scopeKey, String(poolId)),
            ),
          );
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
  console.error("[fundBookWaterfallTest] FAILED:", e);
  await pool.end().catch(() => {});
  process.exit(1);
});
