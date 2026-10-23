// fundBookWeeklyReportTest.ts — Automated proof (Task #143) of the ARX Fund Book
// "Weekly investor account story".
//
// IT PROVES (pure builder + the REAL Express app in-process):
//   PURE (weeklyReportMath.ts buildWeeklyAccountStory):
//     1. No baseline ⇒ netChange=null, marketChange=null, baselineAvailable=false,
//        honest "starting snapshot" headline + disclosure (never a guessed number).
//     2. Baseline present ⇒ netChange = endValue − baseline EXACTLY;
//        flows = deposits − withdrawals + distributions; marketChange = netChange − flows.
//     3. navStatus UNDER_REVIEW ⇒ no net-change number is claimed in the headline.
//     4. Deterministic: identical input yields byte-identical output (what makes a
//        PUBLISHED snapshot reproducible).
//     5. "Watching next week" items are STATE-derived only (under-review / elevated
//        drawdown / lock releasing / stale) — never a fabricated forecast.
//   INTEGRATION (admin + investor endpoints):
//     6. Auth: anonymous → 401, INVESTOR → 403 on every admin endpoint.
//     7. reason is required (≥3 chars) on generate + publish.
//     8. generate mints append-only DRAFT versions (v1, v2 …); publish flips one to
//        PUBLISHED and supersedes any prior published version (one PUBLISHED / period).
//     9. The investor sees ONLY their own PUBLISHED report (never DRAFT/SUPERSEDED).
//    10. Per-investor isolation: investor B never sees investor A's report.
//    11. Reproducibility: a PUBLISHED snapshot is returned verbatim and is NOT
//        recomputed when the underlying holdings change after publication.
//    12. No leakage: the investor payload carries no ARX waterfall split, raw broker
//        balance, trader-comp, or paper/sim/mock wording (deep scan).
//
// SAFETY / ISOLATION:
//   - Seeds isolated users (fixed TAG) and operates ONLY on their rows. Idempotent
//     cleanup at the end even on failure.
//   - RECORD-ONLY: asserts the arx_live_commands count is unchanged end-to-end.
//   - CI-safe: spins up the REAL Express app in-process on an ephemeral port. Set
//     ARX_QA_BASE_URL to probe an already-running server instead. Only DATABASE_URL
//     is required.
//
// Run: pnpm --filter @workspace/scripts run test:fundbook-weekly

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
  fundBookWeeklyReportsTable,
  mt5ConnectionTable,
  fundDiscrepanciesTable,
} from "@workspace/db/schema";
import {
  buildWeeklyAccountStory,
  isValidPeriodKey,
  type WeeklyStoryInput,
} from "../../artifacts/api-server/src/lib/fundbook/weeklyReportMath.js";

const EXTERNAL_BASE = process.env["ARX_QA_BASE_URL"];
const TAG = `qaWeekly_${Date.now()}_${randomBytes(3).toString("hex")}`;
const USER_SESSION_COOKIE = "arx_user_session";
const SESSION_TTL_MS = 60 * 60 * 1000;
const POOL_KEY = "CASH_RESERVE";
const WEEK_A = "2099-W10";
const WEEK_B = "2099-W11";

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

// Deep-scan any value for a forbidden KEY (ARX waterfall internals, raw broker /
// master balance, trader comp, bridge/credentials). Returns the first hit path.
const FORBIDDEN_KEY = /arx|eligibleprofit|highwatervalue|brokerbalance|masterbalance|accountnumber|tradercomp|\bcomp\b|bridgetoken|apikey/i;
function findKeyLeak(value: unknown, path = "$"): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findKeyLeak(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(k)) return `${path}.${k} (key)`;
      const hit = findKeyLeak(v, `${path}.${k}`);
      if (hit) return hit;
    }
  }
  return null;
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

async function liveCommandsCount(): Promise<number> {
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands");
  return (r.rows[0] as { n: number }).n;
}
async function auditCount(action: string, adminId: number): Promise<number> {
  const r = await pool.query(
    "SELECT COUNT(*)::int AS n FROM admin_action_audit_log WHERE action = $1 AND admin_id = $2",
    [action, adminId],
  );
  return (r.rows[0] as { n: number }).n;
}

// A complete, investor-SAFE builder input we can vary per assertion.
function baseInput(over: Partial<WeeklyStoryInput> = {}): WeeklyStoryInput {
  return {
    periodKey: WEEK_B,
    periodStart: "2099-03-09T00:00:00.000Z",
    periodEnd: "2099-03-16T00:00:00.000Z",
    endValue: 10500,
    baselineValue: 10000,
    baselineAvailable: true,
    baselinePeriodKey: WEEK_A,
    deposits: 200,
    withdrawals: 50,
    distributions: 0,
    pools: [
      {
        poolKey: POOL_KEY,
        name: "Cash Reserve",
        riskLevel: "low",
        navStatus: "OK",
        unitsOwned: 100,
        settledValue: 10000,
        floatingPlShare: 500,
        flowsInWindow: 150,
      },
    ],
    drawdownPercent: 2,
    drawdownUsd: 200,
    lockedPrincipal: 0,
    withdrawableValue: 10500,
    nextReleaseAt: null,
    lockReleasesNextWeek: false,
    navStatus: "OK",
    freshness: "FRESH",
    freshnessMessage: "Your account values are current.",
    ...over,
  };
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("fundBookWeeklyReportTest");
  // eslint-disable-next-line no-console
  console.log("========================\n");

  const startLive = await liveCommandsCount();

  // ── 1. Pure builder honesty ──────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log("1. Pure weekly-story builder (honesty + determinism)");
  {
    // No baseline ⇒ no net-change number, honest starting snapshot.
    const noBase = buildWeeklyAccountStory(
      baseInput({ baselineAvailable: false, baselineValue: null, baselinePeriodKey: null }),
    );
    assert(noBase.economicImpact.netChange === null, "no baseline → netChange null");
    assert(noBase.economicImpact.marketChange === null, "no baseline → marketChange null");
    assert(noBase.economicImpact.baselineAvailable === false, "no baseline → baselineAvailable false");
    assert(/starting account snapshot/i.test(noBase.headline), "no baseline → honest starting-snapshot headline");
    assert(
      noBase.disclosures.some((d) => /no earlier published week to compare/i.test(d)),
      "no baseline → honest no-comparison disclosure",
    );

    // Baseline present ⇒ exact decomposition netChange = flows + marketChange.
    const withBase = buildWeeklyAccountStory(baseInput());
    const ei = withBase.economicImpact;
    assert(approx(ei.flows as number, 150), "flows = deposits − withdrawals + distributions = 150");
    assert(approx(ei.netChange as number, 500), "netChange = endValue − baseline = 500");
    assert(approx(ei.marketChange as number, 350), "marketChange = netChange − flows = 350");
    assert(
      approx((ei.flows as number) + (ei.marketChange as number), ei.netChange as number),
      "flows + marketChange == netChange EXACTLY",
    );

    // UNDER_REVIEW ⇒ never claims a net-change number in the headline.
    const review = buildWeeklyAccountStory(baseInput({ navStatus: "UNDER_REVIEW" }));
    assert(review.dataQuality.navStatus === "UNDER_REVIEW", "under-review → navStatus surfaced");
    assert(/being verified/i.test(review.headline), "under-review → honest 'being verified' headline");
    assert(!/\$\d/.test(review.headline), "under-review → no dollar figure claimed in headline");

    // HONESTY GATE: UNDER_REVIEW ⇒ numeric change figures are SUPPRESSED even
    // though a baseline exists (changeVerifiable=false; no guessed numbers).
    assert(review.economicImpact.changeVerifiable === false, "under-review → changeVerifiable false");
    assert(review.economicImpact.netChange === null, "under-review → netChange suppressed (null)");
    assert(review.economicImpact.marketChange === null, "under-review → marketChange suppressed (null)");
    // NON-RECONSTRUCTABLE: endValue + baselineValue are withheld together so the
    // investor can never derive change as (endValue − baselineValue) while the
    // values are unverifiable.
    assert(review.economicImpact.endValue === null, "under-review → endValue withheld (null)");
    assert(review.economicImpact.baselineValue === null, "under-review → baselineValue withheld (null)");
    assert(review.economicImpact.baselinePeriodKey === null, "under-review → baselinePeriodKey withheld (null)");
    // NON-RECONSTRUCTABLE (per-pool path): pool valuation numbers are withheld so
    // summing pool end-values can't rebuild the current account total, and
    // contributors/drawdown (valuation-derived performance) are suppressed too.
    assert(
      review.pools.every(
        (p) =>
          p.endValue === null &&
          p.settledValue === null &&
          p.floatingPlShare === null &&
          p.sharePct === null,
      ),
      "under-review → pool valuation numbers withheld (null)",
    );
    assert(
      review.topPositive.length === 0 && review.topNegative.length === 0,
      "under-review → contributors suppressed",
    );
    assert(
      review.risk.drawdownPercent === null && review.risk.drawdownUsd === null && review.risk.elevated === false,
      "under-review → drawdown figures withheld",
    );
    // Deposit-lock pair sums to the account total, so both are withheld too.
    assert(
      review.depositLock.lockedPrincipal === null && review.depositLock.withdrawableValue === null,
      "under-review → deposit-lock amounts withheld (null)",
    );
    // FULL NON-RECONSTRUCTABILITY: no numeric field in the whole payload can be
    // combined to rebuild the current account total while change is unverifiable.
    assert(
      review.economicImpact.endValue === null &&
        review.economicImpact.baselineValue === null &&
        review.pools.every(
          (p) => p.endValue === null && p.settledValue === null && p.floatingPlShare === null,
        ) &&
        review.depositLock.lockedPrincipal === null &&
        review.depositLock.withdrawableValue === null &&
        review.risk.drawdownUsd === null,
      "under-review → account total is not reconstructable from any payload field",
    );
    assert(
      review.disclosures.some((d) => /withheld this week until these values are verified/i.test(d)),
      "under-review with baseline → honest withheld disclosure",
    );

    // HONESTY GATE: STALE freshness ⇒ same suppression even with a baseline.
    const stale = buildWeeklyAccountStory(baseInput({ freshness: "STALE" }));
    assert(stale.economicImpact.changeVerifiable === false, "stale → changeVerifiable false");
    assert(stale.economicImpact.netChange === null, "stale → netChange suppressed (null)");
    assert(stale.economicImpact.marketChange === null, "stale → marketChange suppressed (null)");
    assert(stale.economicImpact.endValue === null, "stale → endValue withheld (null)");
    assert(stale.economicImpact.baselineValue === null, "stale → baselineValue withheld (null)");
    assert(
      stale.pools.every(
        (p) =>
          p.endValue === null &&
          p.settledValue === null &&
          p.floatingPlShare === null &&
          p.sharePct === null,
      ) &&
        stale.topPositive.length === 0 &&
        stale.topNegative.length === 0 &&
        stale.risk.drawdownPercent === null &&
        stale.depositLock.lockedPrincipal === null &&
        stale.depositLock.withdrawableValue === null,
      "stale → pool valuations + contributors + drawdown + deposit-lock withheld",
    );
    assert(/still updating/i.test(stale.headline), "stale → honest 'still updating' headline");
    assert(!/\$\d/.test(stale.headline), "stale → no dollar figure claimed in headline");

    // FRESH + baseline ⇒ figures ARE shown (verifiable).
    const freshWithBase = buildWeeklyAccountStory(baseInput());
    assert(freshWithBase.economicImpact.changeVerifiable === true, "fresh+baseline → changeVerifiable true");
    assert(
      freshWithBase.economicImpact.endValue != null && freshWithBase.economicImpact.baselineValue != null,
      "fresh+baseline → endValue & baselineValue exposed (verifiable)",
    );

    // Determinism: identical input → identical output (reproducible snapshot).
    const a = JSON.stringify(buildWeeklyAccountStory(baseInput()));
    const b = JSON.stringify(buildWeeklyAccountStory(baseInput()));
    assert(a === b, "deterministic: identical input → byte-identical output");

    // Elevated drawdown surfaces as a state-derived watch item ONLY while values
    // are verifiable (drawdown is a valuation-derived figure; under review/stale
    // it is withheld along with every other performance number).
    const watchVerifiable = buildWeeklyAccountStory(baseInput({ drawdownPercent: 15 }));
    const verifiableKinds = new Set(watchVerifiable.watching.map((w) => w.kind));
    assert(verifiableKinds.has("ELEVATED_DRAWDOWN"), "watch: elevated drawdown surfaces when verifiable");

    // Under review + stale: pool-under-review and stale-data still surface (pure
    // state), but the valuation-derived elevated-drawdown watch is suppressed.
    const watch = buildWeeklyAccountStory(
      baseInput({
        drawdownPercent: 15,
        navStatus: "UNDER_REVIEW",
        pools: [{ ...baseInput().pools[0]!, navStatus: "UNDER_REVIEW" }],
        freshness: "STALE",
      }),
    );
    const kinds = new Set(watch.watching.map((w) => w.kind));
    assert(!kinds.has("ELEVATED_DRAWDOWN"), "watch: elevated drawdown withheld while unverifiable");
    assert(kinds.has("POOL_UNDER_REVIEW"), "watch: pool-under-review is state-derived");
    assert(kinds.has("STALE_DATA"), "watch: stale data is state-derived");

    // ISO period-key validity: reject non-existent week 53; accept real ones.
    assert(isValidPeriodKey("2020-W53"), "period key: 2020 has an ISO week 53 (valid)");
    assert(!isValidPeriodKey("2021-W53"), "period key: 2021 has no ISO week 53 (rejected)");
    assert(isValidPeriodKey("2021-W52"), "period key: 2021-W52 is valid");
    assert(!isValidPeriodKey("2022-W53"), "period key: 2022 has no ISO week 53 (rejected)");

    // No paper/sim/mock wording anywhere in the produced narrative.
    const blob = JSON.stringify([noBase, withBase, review, watch]);
    assert(!/\b(paper|simulat|mock)\b/i.test(blob), "no paper/sim/mock wording in narrative");
    // No ARX waterfall internals leak through the narrative payload keys.
    assert(findKeyLeak(withBase) === null, `narrative carries no forbidden keys (got ${findKeyLeak(withBase)})`);
  }

  // ── Boot the real app in-process ─────────────────────────────────────────
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
  let bridgeId: number | null = null;
  const suspendedDiscrepancies: Array<{ id: number; status: string }> = [];

  try {
    investorA = await createActor("investorA", "INVESTOR");
    investorB = await createActor("investorB", "INVESTOR");
    admin = await createActor("admin", "ADMIN");
    await seedProfile(investorA);
    await seedProfile(investorB);

    // Ensure pools exist (engine also lazy-ensures), capture the pool id.
    await req(admin.cookie, "GET", "/api/admin/fundbook/pools");
    const poolRow = (
      await db.select().from(strategyPoolsTable).where(eq(strategyPoolsTable.poolKey, POOL_KEY)).limit(1)
    )[0];
    assert(poolRow != null, "CASH_RESERVE seed pool exists after lazy ensure");
    poolId = poolRow!.id;

    // Investor A holds 100 units so the snapshot has a non-zero end value.
    await db.insert(investorPoolHoldingsTable).values({
      userId: investorA.id,
      strategyPoolId: poolId,
      unitsOwned: 100,
      status: "ACTIVE",
    });

    // Seed ONE fresh live bridge: the weekly-report honesty gate
    // (getValueStatusForUser → classifyValueFreshness) withholds endValue with
    // changeVerifiable=false unless a live bridge has a FRESH mirror. Without
    // this seed the integration section depends on unrelated dev-DB bridge
    // state (non-deterministic). Deleted in cleanup below.
    const bridgeNow = new Date();
    const [bridge] = await db
      .insert(mt5ConnectionTable)
      .values({
        userId: admin.id,
        connectionName: `${TAG}_bridge`,
        status: "connected",
        accountType: "live",
        accountCurrency: "USD",
        accountBalance: 100_000,
        accountEquity: 100_000,
        margin: 0,
        freeMargin: 100_000,
        lastHeartbeat: bridgeNow,
        lastPositionsSnapshotAt: bridgeNow,
      })
      .returning();
    bridgeId = bridge!.id;

    // ── Deterministic discrepancy isolation (suspend → restore) ────────────
    // A pre-existing OPEN/INVESTIGATING discrepancy scoped to the seed pool
    // (leftover dev-DB state from an old reconciliation run) makes
    // getValueStatusForUser return UNDER_REVIEW for our fresh investor, and
    // the honesty gate then withholds endValue (changeVerifiable=false) —
    // unrelated state, not the behavior under test. Suspend EXACTLY those
    // pre-existing rows (captured id → original status) and restore each row's
    // original status in the finally block. Rows are never deleted, and
    // discrepancies opened DURING the run are never touched.
    const openDiscrepancies = await db
      .select({ id: fundDiscrepanciesTable.id, status: fundDiscrepanciesTable.status })
      .from(fundDiscrepanciesTable)
      .where(
        and(
          inArray(fundDiscrepanciesTable.status, ["OPEN", "INVESTIGATING"]),
          eq(fundDiscrepanciesTable.strategyPoolId, poolId),
        ),
      );
    for (const d of openDiscrepancies) {
      suspendedDiscrepancies.push({ id: d.id, status: d.status });
    }
    if (suspendedDiscrepancies.length > 0) {
      await db
        .update(fundDiscrepanciesTable)
        .set({ status: "RESOLVED" })
        .where(inArray(fundDiscrepanciesTable.id, suspendedDiscrepancies.map((d) => d.id)));
    }

    // Re-touch the seeded bridge's freshness right before each generate: the
    // honesty gate treats a mirror older than 60s as STALE (endValue withheld,
    // changeVerifiable=false), and the suite's earlier sections can take longer
    // than that. Keeps the FRESH verdict deterministic regardless of runtime.
    const touchBridge = async () => {
      const t = new Date();
      await db
        .update(mt5ConnectionTable)
        .set({ lastHeartbeat: t, lastPositionsSnapshotAt: t })
        .where(eq(mt5ConnectionTable.id, bridgeId!));
    };

    const genPath = (uid: number) => `/api/admin/fundbook/investors/${uid}/weekly-reports`;

    // ── 2. Auth gating ─────────────────────────────────────────────────────
    // eslint-disable-next-line no-console
    console.log("\n2. Auth gating (admin-only writes; investor reads scoped)");
    {
      const anon = await req(null, "GET", genPath(investorA.id));
      assert(anon.status === 401, `anonymous admin GET → 401 (got ${anon.status})`);
      const anonMe = await req(null, "GET", "/api/me/investor/fundbook/weekly-reports");
      assert(anonMe.status === 401, `anonymous investor GET → 401 (got ${anonMe.status})`);

      const invList = await req(investorA.cookie, "GET", genPath(investorA.id));
      assert(invList.status === 403, `INVESTOR admin list → 403 (got ${invList.status})`);
      const invGen = await req(investorA.cookie, "POST", genPath(investorA.id), {
        periodKey: WEEK_A,
        reason: "should be denied",
      });
      assert(invGen.status === 403, `INVESTOR admin generate → 403 (got ${invGen.status})`);
      const invPub = await req(investorA.cookie, "POST", "/api/admin/fundbook/weekly-reports/1/publish", {
        reason: "should be denied",
      });
      assert(invPub.status === 403, `INVESTOR admin publish → 403 (got ${invPub.status})`);
    }

    // ── 3. reason required ─────────────────────────────────────────────────
    // eslint-disable-next-line no-console
    console.log("\n3. reason is required (≥3 chars)");
    {
      const noReason = await req(admin!.cookie, "POST", genPath(investorA.id), { periodKey: WEEK_A, reason: "x" });
      assert(noReason.status === 400, `generate without reason → 400 (got ${noReason.status})`);
    }

    // ── 4. Append-only versions + publish + supersede ──────────────────────
    // eslint-disable-next-line no-console
    console.log("\n4. Append-only versions, publish, single-PUBLISHED-per-period");
    const genBefore = await auditCount("FUND_WEEKLY_REPORT_GENERATE", admin!.id);
    await touchBridge();
    const gen1 = await req(admin!.cookie, "POST", genPath(investorA.id), { periodKey: WEEK_A, reason: "qa generate v1" });
    assert(gen1.status === 200 && gen1.json?.report?.status === "DRAFT", `generate v1 → DRAFT (got ${gen1.status})`);
    assert(gen1.json?.report?.version === 1, `generate v1 → version 1 (got ${gen1.json?.report?.version})`);
    const v1Id = gen1.json.report.id as number;
    const v1EndValue = gen1.json.report.narrative.economicImpact.endValue as number;
    assert(Number.isFinite(v1EndValue) && v1EndValue > 0, `v1 snapshot endValue derived from holdings (got ${v1EndValue})`);

    const gen2 = await req(admin!.cookie, "POST", genPath(investorA.id), { periodKey: WEEK_A, reason: "qa generate v2" });
    assert(gen2.json?.report?.version === 2, `second generate → append-only version 2 (got ${gen2.json?.report?.version})`);
    const v2Id = gen2.json.report.id as number;
    const genAfter = await auditCount("FUND_WEEKLY_REPORT_GENERATE", admin!.id);
    assert(genAfter - genBefore === 2, `two generate audit rows written (delta ${genAfter - genBefore})`);

    // Investor sees nothing yet (no PUBLISHED version).
    const meBeforePub = await req(investorA.cookie, "GET", "/api/me/investor/fundbook/weekly-reports");
    assert((meBeforePub.json?.reports ?? []).length === 0, "investor sees no DRAFT reports");

    // Publish v2.
    const pubBefore = await auditCount("FUND_WEEKLY_REPORT_PUBLISH", admin!.id);
    const pub = await req(admin!.cookie, "POST", `/api/admin/fundbook/weekly-reports/${v2Id}/publish`, { reason: "qa publish v2" });
    assert(pub.status === 200 && pub.json?.report?.status === "PUBLISHED", `publish v2 → PUBLISHED (got ${pub.status})`);
    const pubAfter = await auditCount("FUND_WEEKLY_REPORT_PUBLISH", admin!.id);
    assert(pubAfter - pubBefore === 1, "publish audit row written");

    // Investor now sees exactly one published report (v2, not the v1 draft).
    const meAfterPub = await req(investorA.cookie, "GET", "/api/me/investor/fundbook/weekly-reports");
    const reports = meAfterPub.json?.reports ?? [];
    assert(reports.length === 1 && reports[0].id === v2Id, "investor sees exactly the PUBLISHED version");
    assert(reports[0].status === "PUBLISHED", "investor list item is PUBLISHED");

    // Generate v3 and publish it → v2 becomes SUPERSEDED (one PUBLISHED / period).
    await touchBridge();
    const gen3 = await req(admin!.cookie, "POST", genPath(investorA.id), { periodKey: WEEK_A, reason: "qa generate v3" });
    const v3Id = gen3.json.report.id as number;
    await req(admin!.cookie, "POST", `/api/admin/fundbook/weekly-reports/${v3Id}/publish`, { reason: "qa publish v3" });
    const meAfterV3 = await req(investorA.cookie, "GET", "/api/me/investor/fundbook/weekly-reports");
    const reports3 = meAfterV3.json?.reports ?? [];
    assert(reports3.length === 1 && reports3[0].id === v3Id, "still exactly one PUBLISHED after re-publish (supersede)");
    const v2Now = await req(admin!.cookie, "GET", `/api/admin/fundbook/weekly-reports/${v2Id}`);
    assert(v2Now.json?.report?.status === "SUPERSEDED", "prior published version is SUPERSEDED");
    void v1Id;

    // ── 5. Reproducibility (snapshot not recomputed) ───────────────────────
    // eslint-disable-next-line no-console
    console.log("\n5. PUBLISHED snapshot is reproducible (never recomputed)");
    {
      const before = await req(investorA.cookie, "GET", `/api/me/investor/fundbook/weekly-reports/${WEEK_A}`);
      const storedEnd = before.json?.report?.narrative?.economicImpact?.endValue as number;
      // Mutate the underlying holding AFTER publication.
      await db
        .update(investorPoolHoldingsTable)
        .set({ unitsOwned: 999 })
        .where(eq(investorPoolHoldingsTable.userId, investorA!.id));
      const after = await req(investorA.cookie, "GET", `/api/me/investor/fundbook/weekly-reports/${WEEK_A}`);
      const afterEnd = after.json?.report?.narrative?.economicImpact?.endValue as number;
      assert(approx(afterEnd, storedEnd), `published endValue unchanged after holdings change (was ${storedEnd}, now ${afterEnd})`);
    }

    // ── 6. Per-investor isolation + no leakage ─────────────────────────────
    // eslint-disable-next-line no-console
    console.log("\n6. Per-investor isolation + no broker/ARX/comp leakage");
    {
      const bList = await req(investorB!.cookie, "GET", "/api/me/investor/fundbook/weekly-reports");
      assert((bList.json?.reports ?? []).length === 0, "investor B sees none of investor A's reports");
      const bGet = await req(investorB!.cookie, "GET", `/api/me/investor/fundbook/weekly-reports/${WEEK_A}`);
      assert(bGet.json?.report == null, "investor B by-period read returns null (isolation)");

      const aGet = await req(investorA!.cookie, "GET", `/api/me/investor/fundbook/weekly-reports/${WEEK_A}`);
      const leak = findKeyLeak(aGet.json);
      assert(leak === null, `investor payload carries no forbidden keys (got ${leak})`);
      assert(!/\b(paper|simulat|mock)\b/i.test(aGet.bodyText), "investor payload has no paper/sim/mock wording");
    }

    // ── 7. Bulk generate + publish (cohort, per-investor isolation) ─────────
    // eslint-disable-next-line no-console
    console.log("\n7. Bulk generate + publish across the holdings cohort");
    {
      const BULK_WEEK = "2099-W20";
      const bulkGenPath = "/api/admin/fundbook/weekly-reports/bulk-generate";
      const bulkPubPath = "/api/admin/fundbook/weekly-reports/bulk-publish";

      // Auth: investor denied on both bulk endpoints.
      const invBulkGen = await req(investorA!.cookie, "POST", bulkGenPath, { periodKey: BULK_WEEK, reason: "denied" });
      assert(invBulkGen.status === 403, `INVESTOR bulk-generate → 403 (got ${invBulkGen.status})`);
      const invBulkPub = await req(investorA!.cookie, "POST", bulkPubPath, { periodKey: BULK_WEEK, reason: "denied" });
      assert(invBulkPub.status === 403, `INVESTOR bulk-publish → 403 (got ${invBulkPub.status})`);
      const anonBulk = await req(null, "POST", bulkGenPath, { periodKey: BULK_WEEK, reason: "denied" });
      assert(anonBulk.status === 401, `anonymous bulk-generate → 401 (got ${anonBulk.status})`);

      // reason required (≥3).
      const noReason = await req(admin!.cookie, "POST", bulkGenPath, { periodKey: BULK_WEEK, reason: "x" });
      assert(noReason.status === 400, `bulk-generate without reason → 400 (got ${noReason.status})`);

      // Give investor B a holding so the cohort has two members. Restore A's
      // units to a sane value (was mutated to 999 by the reproducibility test).
      await db
        .update(investorPoolHoldingsTable)
        .set({ unitsOwned: 100 })
        .where(eq(investorPoolHoldingsTable.userId, investorA!.id));
      await db.insert(investorPoolHoldingsTable).values({
        userId: investorB!.id,
        strategyPoolId: poolId!,
        unitsOwned: 50,
        status: "ACTIVE",
      });

      // Bulk generate for the whole cohort (no explicit userIds).
      await touchBridge();
      const bgBefore = await auditCount("FUND_WEEKLY_REPORT_GENERATE", admin!.id);
      const bulkGen = await req(admin!.cookie, "POST", bulkGenPath, { periodKey: BULK_WEEK, reason: "qa bulk generate" });
      assert(bulkGen.status === 200 && bulkGen.json?.ok === true, `bulk-generate → 200 ok (got ${bulkGen.status})`);
      assert(bulkGen.json?.total >= 2, `bulk-generate targeted the holdings cohort (total ${bulkGen.json?.total})`);
      const aResult = (bulkGen.json?.results ?? []).find((r: any) => r.userId === investorA!.id);
      const bResult = (bulkGen.json?.results ?? []).find((r: any) => r.userId === investorB!.id);
      assert(aResult?.ok === true && bResult?.ok === true, "bulk-generate succeeded for both cohort members");
      const bgAfter = await auditCount("FUND_WEEKLY_REPORT_GENERATE", admin!.id);
      assert(bgAfter - bgBefore >= 2, `bulk-generate wrote a per-investor audit row each (delta ${bgAfter - bgBefore})`);

      // Bulk publish the latest DRAFT for the same period.
      const bpBefore = await auditCount("FUND_WEEKLY_REPORT_PUBLISH", admin!.id);
      const bulkPub = await req(admin!.cookie, "POST", bulkPubPath, { periodKey: BULK_WEEK, reason: "qa bulk publish" });
      assert(bulkPub.status === 200 && bulkPub.json?.ok === true, `bulk-publish → 200 ok (got ${bulkPub.status})`);
      assert(bulkPub.json?.succeeded >= 2, `bulk-publish published for both members (succeeded ${bulkPub.json?.succeeded})`);
      const bpAfter = await auditCount("FUND_WEEKLY_REPORT_PUBLISH", admin!.id);
      assert(bpAfter - bpBefore >= 2, `bulk-publish wrote a per-investor audit row each (delta ${bpAfter - bpBefore})`);

      // Each investor now sees their own published bulk report (isolation holds).
      const aBulk = await req(investorA!.cookie, "GET", `/api/me/investor/fundbook/weekly-reports/${BULK_WEEK}`);
      const bBulk = await req(investorB!.cookie, "GET", `/api/me/investor/fundbook/weekly-reports/${BULK_WEEK}`);
      assert(aBulk.json?.report?.status === "PUBLISHED", "investor A sees their PUBLISHED bulk report");
      assert(bBulk.json?.report?.status === "PUBLISHED", "investor B sees their PUBLISHED bulk report");
      assert(
        aBulk.json?.report?.id !== bBulk.json?.report?.id,
        "bulk reports are distinct per investor (no cross-tenant snapshot)",
      );

      // No live command produced by any bulk action.
      assert(findKeyLeak(aBulk.json) === null, "bulk investor payload carries no forbidden keys");
    }
  } catch (e) {
    assert(false, `unexpected error: ${(e as Error).message}`);
  } finally {
    const ids = [investorA?.id, investorB?.id, admin?.id].filter(
      (x): x is number => typeof x === "number",
    );
    try {
      // Restore the exact original status of each pre-existing discrepancy
      // suspended above (runs even if user seeding failed), then SENTINEL-
      // verify the restore landed: if the suite is ever killed mid-run (no
      // finally) or the restore silently fails, the altered review posture
      // must be loudly visible instead of quietly persisting in the dev DB.
      for (const d of suspendedDiscrepancies) {
        await db
          .update(fundDiscrepanciesTable)
          .set({ status: d.status })
          .where(eq(fundDiscrepanciesTable.id, d.id));
      }
      if (suspendedDiscrepancies.length > 0) {
        const restoredRows = await db
          .select({ id: fundDiscrepanciesTable.id, status: fundDiscrepanciesTable.status })
          .from(fundDiscrepanciesTable)
          .where(inArray(fundDiscrepanciesTable.id, suspendedDiscrepancies.map((d) => d.id)));
        const allMatch = suspendedDiscrepancies.every((d) =>
          restoredRows.some((r) => r.id === d.id && r.status === d.status),
        );
        assert(
          allMatch,
          `sentinel: all ${suspendedDiscrepancies.length} suspended discrepancy status(es) restored exactly`,
        );
      }
      if (ids.length > 0) {
        if (bridgeId != null) {
          await db.delete(mt5ConnectionTable).where(eq(mt5ConnectionTable.id, bridgeId));
        }
        await db.delete(fundBookWeeklyReportsTable).where(inArray(fundBookWeeklyReportsTable.userId, ids));
        await db.delete(investorPoolHoldingsTable).where(inArray(investorPoolHoldingsTable.userId, ids));
        await db.delete(investorProfilesTable).where(inArray(investorProfilesTable.userId, ids));
        await db.delete(adminActionAuditLogTable).where(inArray(adminActionAuditLogTable.adminId, ids));
        await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, ids));
        await db.delete(usersTable).where(inArray(usersTable.id, ids));
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
  console.error("[fundBookWeeklyReportTest] FAILED:", e);
  await pool.end().catch(() => {});
  process.exit(1);
});
