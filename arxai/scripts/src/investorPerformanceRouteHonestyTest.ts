// Test: the investor Performance route serves ONLY honest, ledger-derived
// numbers (Task #92).
//
// Task #77 locked the investor equity curve at the pure-logic level
// (scripts/src/ci/check-investor-equity-series.ts proves computeEquitySeries /
// computeMetrics never fabricate, project, or interpolate). That guard does NOT
// exercise the HTTP route that actually serves those numbers to the investor
// Performance tab. This test closes that gap: it spins up the REAL Express app
// in-process, seeds an isolated investor with a KNOWN ledger, hits
// GET /api/me/investor/performance, and asserts the response is byte-for-byte
// what computeEquitySeries / computeMetrics produce from the same ledger.
//
// A regression where the helper stays correct but the endpoint reshapes, drops,
// adds, or fabricates a field on the way out would fail this test loudly.
//
// IT PROVES:
//   1. series === computeEquitySeries(ledger): same length (no extra/projected
//      points), and every point's {at,label,value} matches exactly.
//   2. The headline metrics (hasPerformanceData, realizedPnl, unrealizedPnl,
//      monthlyReturnPct, allTimeReturnPct, baseCurrency) === computeMetrics(...)
//      — no fabricated returns, no rounding drift, baseCurrency echoes the
//      stored profile rather than a hard-coded default.
//   3. An empty-ledger investor gets an honest empty series + hasPerformanceData
//      = false THROUGH the route (the honest empty state is not lost in the
//      endpoint).
//
// SAFETY / ISOLATION:
//   - Seeds two isolated system users (isSystemUser=true) with fixed emails and
//     operates ONLY on their rows.
//   - Idempotent: deletes any leftover rows for the fixed emails at start and
//     cleans up (ledger, profile, session, user) at the end, even on failure.
//   - Read-only against the HTTP API (GET only). Never places a trade, never
//     touches any execution / live / bridge surface.
//   - CI-safe / self-contained: spins up the REAL Express app in-process on an
//     ephemeral port (no externally-running server required). Set ARX_QA_BASE_URL
//     to probe an already-running server instead. Only DATABASE_URL is required.
//
// Run: pnpm --filter @workspace/scripts run test:investor-performance-route

import { randomBytes, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  authUserSessionsTable,
  investorProfilesTable,
  investorLedgerEntriesTable,
  type InvestorLedgerEntry,
} from "@workspace/db";
import {
  computeMetrics,
  computeEquitySeries,
} from "../../artifacts/api-server/src/lib/investor/investorService.js";
import {
  getSharedBaseUrl,
  closeSharedServer,
  isEntrypoint,
  type CiTestResultLike,
} from "./ci/inProcessAppHarness.js";

const SEEDED_EMAIL = "qa+investor-performance-route-seeded@arx.test";
const EMPTY_EMAIL = "qa+investor-performance-route-empty@arx.test";
const SEEDED_CURRENCY = "EUR"; // deliberately not the "USD" route default

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

async function cleanupByEmail(email: string): Promise<void> {
  const rows = await db.select().from(usersTable).where(eq(usersTable.email, email));
  for (const u of rows) {
    await db.delete(investorLedgerEntriesTable).where(eq(investorLedgerEntriesTable.userId, u.id));
    await db.delete(investorProfilesTable).where(eq(investorProfilesTable.userId, u.id));
    await db.delete(authUserSessionsTable).where(eq(authUserSessionsTable.userId, u.id));
    await db.delete(usersTable).where(eq(usersTable.id, u.id));
  }
}

async function cleanupAll(): Promise<void> {
  await cleanupByEmail(SEEDED_EMAIL);
  await cleanupByEmail(EMPTY_EMAIL);
}

// Seed an isolated system user + an active session, returning the user id and a
// ready-to-send cookie header value.
async function seedUserWithSession(
  email: string,
  name: string,
): Promise<{ userId: number; cookie: string }> {
  // INVESTOR role: the investor portal is gated to investor accounts
  // (denyTraderInvestorArea refuses plain USER traders), so a trader cookie
  // would 403 before the route ever runs.
  const insertedUsers = await db
    .insert(usersTable)
    .values({ email, name, role: "INVESTOR", isSystemUser: true })
    .returning();
  const user = insertedUsers[0]!;

  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  await db.insert(authUserSessionsTable).values({
    userId: user.id,
    tokenHash,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return { userId: user.id, cookie: `arx_user_session=${rawToken}` };
}

export async function run(): Promise<CiTestResultLike> {
  passes = 0;
  failures = 0;
  // eslint-disable-next-line no-console
  console.log("investorPerformanceRouteHonestyTest");
  // eslint-disable-next-line no-console
  console.log("==================================\n");

  // Fresh slate for idempotency.
  await cleanupAll();

  // ── Resolve a base URL from the shared in-process harness: an ephemeral
  //    server booted once (CI-safe), or ARX_QA_BASE_URL when probing an
  //    already-running server. ─────────────────────────────────────────────
  const baseUrl = await getSharedBaseUrl();

  // ── Seeded investor: known multi-day ledger including PERFORMANCE rows ───
  const { userId: seededId, cookie: seededCookie } = await seedUserWithSession(
    SEEDED_EMAIL,
    "QA Investor Performance Route (seeded)",
  );
  // A profile with a non-default base currency proves the route echoes the
  // stored currency rather than a hard-coded "USD".
  await db.insert(investorProfilesTable).values({
    userId: seededId,
    baseCurrency: SEEDED_CURRENCY,
    status: "active",
  });

  // Build a ledger at fixed absolute instants so day-bucketing and ordering are
  // deterministic. Includes DEPOSIT/WITHDRAWAL/ADJUSTMENT (contributions) plus
  // PERFORMANCE rows (recorded returns) so hasPerformanceData=true and the
  // headline return fields are exercised. Two rows land on the SAME day to
  // prove the route does not re-shape the helper's same-day collapse.
  const ledgerSeed: Array<{ entryType: string; signedAmount: number; at: string }> = [
    { entryType: "DEPOSIT", signedAmount: 10_000, at: "2026-01-05T09:00:00.000Z" },
    { entryType: "PERFORMANCE", signedAmount: 500, at: "2026-01-31T16:00:00.000Z" },
    { entryType: "ADJUSTMENT", signedAmount: 250, at: "2026-02-10T09:00:00.000Z" },
    { entryType: "WITHDRAWAL", signedAmount: -2_000, at: "2026-02-10T18:00:00.000Z" },
    { entryType: "PERFORMANCE", signedAmount: -300, at: "2026-02-28T16:00:00.000Z" },
  ];
  await db.insert(investorLedgerEntriesTable).values(
    ledgerSeed.map((e) => ({
      userId: seededId,
      entryType: e.entryType,
      signedAmount: e.signedAmount,
      currency: SEEDED_CURRENCY,
      reason: "qa seed",
      createdByAdminId: seededId,
      createdAt: new Date(e.at),
    })),
  );

  // Reconstruct the SAME ledger shape getLedger() returns (descending by
  // createdAt) and feed the real helpers — this is the source of truth the
  // route must match exactly.
  const ledgerForHelpers: InvestorLedgerEntry[] = [...ledgerSeed]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .map(
      (e) =>
        ({
          entryType: e.entryType,
          signedAmount: e.signedAmount,
          createdAt: new Date(e.at),
        }) as unknown as InvestorLedgerEntry,
    );
  const expectedSeries = computeEquitySeries(ledgerForHelpers);
  const expectedMetrics = computeMetrics(ledgerForHelpers);

  // Sanity: the fixture must actually exercise the interesting paths, otherwise
  // the route assertions below would pass vacuously.
  assert(expectedMetrics.hasPerformanceData === true, "fixture has recorded performance data");
  assert(expectedSeries.length === 4, `fixture collapses to 4 daily points (got ${expectedSeries.length})`);
  assert(
    expectedMetrics.allTimeReturnPct !== null && expectedMetrics.monthlyReturnPct !== null,
    "fixture produces non-null headline return figures",
  );

  // ── GET /me/investor/performance (seeded) ──────────────────────────────
  // eslint-disable-next-line no-console
  console.log("\n/me/investor/performance — response matches the helpers exactly");
  const perfRes = await fetch(`${baseUrl}/api/me/investor/performance`, {
    headers: { cookie: seededCookie },
  });
  assert(perfRes.status === 200, `performance HTTP 200 (got ${perfRes.status})`);
  const perf = (await perfRes.json()) as {
    ok: boolean;
    hasPerformanceData: boolean;
    baseCurrency: string;
    realizedPnl: number;
    unrealizedPnl: number;
    monthlyReturnPct: number | null;
    allTimeReturnPct: number | null;
    series: Array<{ at: string; label: string; value: number }>;
  };

  assert(perf.ok === true, "response ok=true");
  assert(perf.baseCurrency === SEEDED_CURRENCY, `baseCurrency echoes stored profile "${SEEDED_CURRENCY}" (got ${perf.baseCurrency})`);
  assert(perf.hasPerformanceData === expectedMetrics.hasPerformanceData, `hasPerformanceData matches helper (${expectedMetrics.hasPerformanceData})`);
  assert(perf.realizedPnl === expectedMetrics.realizedPnl, `realizedPnl matches helper (${expectedMetrics.realizedPnl}, got ${perf.realizedPnl})`);
  assert(perf.unrealizedPnl === expectedMetrics.unrealizedPnl, `unrealizedPnl matches helper (${expectedMetrics.unrealizedPnl}, got ${perf.unrealizedPnl})`);
  assert(perf.monthlyReturnPct === expectedMetrics.monthlyReturnPct, `monthlyReturnPct matches helper (${expectedMetrics.monthlyReturnPct}, got ${perf.monthlyReturnPct})`);
  assert(perf.allTimeReturnPct === expectedMetrics.allTimeReturnPct, `allTimeReturnPct matches helper (${expectedMetrics.allTimeReturnPct}, got ${perf.allTimeReturnPct})`);

  // Series: identical length (no extra / projected / interpolated points)...
  assert(
    perf.series.length === expectedSeries.length,
    `series length matches helper exactly — no extra projected points (${expectedSeries.length}, got ${perf.series.length})`,
  );
  // ...and every point identical field-for-field (no fabricated values, no
  // reshaping, no rounding drift).
  let allPointsMatch = perf.series.length === expectedSeries.length;
  for (let i = 0; i < expectedSeries.length && i < perf.series.length; i++) {
    const got = perf.series[i]!;
    const want = expectedSeries[i]!;
    const ok = got.at === want.at && got.label === want.label && got.value === want.value;
    if (!ok) {
      allPointsMatch = false;
      // eslint-disable-next-line no-console
      console.error(
        `    point ${i} mismatch: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`,
      );
    }
  }
  assert(allPointsMatch, "every series point matches the helper field-for-field (at/label/value)");

  // The recorded performance total must move realizedPnl by exactly the summed
  // PERFORMANCE rows (+500 - 300 = +200) — not a fabricated or projected figure.
  assert(perf.realizedPnl === 200, `realizedPnl is the exact summed PERFORMANCE total (200, got ${perf.realizedPnl})`);

  // ── Empty-ledger investor: honest empty series + hasPerformanceData=false ─
  // eslint-disable-next-line no-console
  console.log("\n/me/investor/performance — empty ledger stays honest through the route");
  const { cookie: emptyCookie } = await seedUserWithSession(
    EMPTY_EMAIL,
    "QA Investor Performance Route (empty)",
  );
  const emptyRes = await fetch(`${baseUrl}/api/me/investor/performance`, {
    headers: { cookie: emptyCookie },
  });
  assert(emptyRes.status === 200, `empty performance HTTP 200 (got ${emptyRes.status})`);
  const empty = (await emptyRes.json()) as {
    ok: boolean;
    hasPerformanceData: boolean;
    realizedPnl: number;
    unrealizedPnl: number;
    monthlyReturnPct: number | null;
    allTimeReturnPct: number | null;
    series: unknown[];
  };
  assert(Array.isArray(empty.series) && empty.series.length === 0, `empty ledger → empty series (got ${empty.series.length} point(s))`);
  assert(empty.hasPerformanceData === false, "empty ledger → hasPerformanceData=false through the route");
  assert(empty.realizedPnl === 0, `empty ledger → realizedPnl=0 (got ${empty.realizedPnl})`);
  assert(empty.monthlyReturnPct === null, "empty ledger → monthlyReturnPct=null (no fabricated return)");
  assert(empty.allTimeReturnPct === null, "empty ledger → allTimeReturnPct=null (no fabricated return)");

  // ── Cleanup ────────────────────────────────────────────────────────────
  await cleanupAll();

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "investorPerformanceRouteHonestyTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    async (r) => {
      await closeSharedServer().catch(() => {});
      process.exit(r.failures > 0 ? 1 : 0);
    },
    async (err) => {
      // Best-effort cleanup so a mid-run failure does not poison the next run.
      await cleanupAll().catch(() => {});
      await closeSharedServer().catch(() => {});
      // eslint-disable-next-line no-console
      console.error("[investorPerformanceRouteHonestyTest] FAILED:", err);
      process.exit(1);
    },
  );
}
