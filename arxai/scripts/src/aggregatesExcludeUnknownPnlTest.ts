// Test: performance aggregates MUST skip untrusted (pnlStatus="UNKNOWN") rows.
//
// Pins the contract that `/performance/summary` and
// `/performance/strategy-breakdown` never let a closed trade whose realised
// P/L could not be trusted leak into any numeric field (totalPnl, winRate,
// profit factor, best/worst, strategy win/loss, etc.). A future refactor that
// silently re-admitted UNKNOWN rows would re-introduce fabricated totals for
// users — this test fails loudly if that happens.
//
// It also pins that the `/trades` projection exposes `pnlStatus` +
// `dataQualityFlag` on every row so the UI can render "P/L unavailable".
//
// HOW IT PROVES EXCLUSION-BY-pnlStatus (not merely null-pnl):
//   The seeded UNKNOWN rows carry a large NON-NULL pnl (9999) and status
//   CLOSED_WIN. If any aggregate filtered on `pnl == null` instead of
//   `pnlStatus == "UNKNOWN"`, totalPnl / winRate / wins would blow up and the
//   assertions would fail. The routes filter on pnlStatus, so they stay clean.
//
// SAFETY / ISOLATION:
//   - Seeds a single isolated system user (isSystemUser=true) with a fixed
//     email and operates ONLY on that user's rows.
//   - Idempotent: deletes any leftover rows for the fixed email at start and
//     cleans up (trades, session, user) at the end, even on failure.
//   - Read-only against the HTTP API (GET only). Never places a trade, never
//     inserts arx_live_commands, never reaches the EA or a broker.
//   - CI-safe / self-contained: spins up the REAL Express app in-process on an
//     ephemeral port (no externally-running server required), exercising the
//     genuine middleware chain (cookie-parser, attachAuthUser, requireUser,
//     error handler). Set ARX_QA_BASE_URL to probe an already-running server
//     instead. Only DATABASE_URL is required.
//
// Run: pnpm --filter @workspace/scripts run test:aggregates-exclude-unknown

import { randomBytes, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  tradesTable,
  authUserSessionsTable,
} from "@workspace/db";
import {
  getSharedBaseUrl,
  closeSharedServer,
  isEntrypoint,
  type CiTestResultLike,
} from "./ci/inProcessAppHarness.js";

const TEST_EMAIL = "qa+aggregates-exclude-unknown@arx.test";
const STRATEGY_A = "Trend Continuation";
const STRATEGY_B = "Break of Structure";

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

function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

async function cleanupByEmail(): Promise<void> {
  const rows = await db.select().from(usersTable).where(eq(usersTable.email, TEST_EMAIL));
  for (const u of rows) {
    await db.delete(tradesTable).where(eq(tradesTable.userId, u.id));
    await db.delete(authUserSessionsTable).where(eq(authUserSessionsTable.userId, u.id));
    await db.delete(usersTable).where(eq(usersTable.id, u.id));
  }
}

export async function run(): Promise<CiTestResultLike> {
  passes = 0;
  failures = 0;
  // eslint-disable-next-line no-console
  console.log("aggregatesExcludeUnknownPnlTest");
  // eslint-disable-next-line no-console
  console.log("===============================\n");

  // Fresh slate for idempotency.
  await cleanupByEmail();

  // ── Resolve a base URL from the shared in-process harness: an ephemeral
  //    server booted once (CI-safe), or ARX_QA_BASE_URL when probing an
  //    already-running server. ─────────────────────────────────────────────
  const baseUrl = await getSharedBaseUrl();

  // ── Seed isolated user + session ───────────────────────────────────────
  const insertedUsers = await db.insert(usersTable).values({
    email: TEST_EMAIL,
    name: "QA Aggregates Exclude Unknown",
    role: "USER",
    isSystemUser: true,
  }).returning();
  const user = insertedUsers[0]!;

  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  await db.insert(authUserSessionsTable).values({
    userId: user.id,
    tokenHash,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  const cookie = `arx_user_session=${rawToken}`;

  // ── Seed a mix of COMPUTED, UNKNOWN, and OPEN trades ───────────────────
  // COMPUTED closed (these are the ONLY rows that should count):
  //   A win  +100, A win  +50, A loss -40, B win +30
  // UNKNOWN closed (must be excluded everywhere): non-null pnl 9999 +
  //   status CLOSED_WIN to prove the filter is on pnlStatus, not pnl==null.
  //   one on strategy A, one on strategy B.
  // OPEN (counts only toward openTrades).
  const base = {
    userId: user.id,
    direction: "BUY" as const,
    lot: 0.01,
    entryPrice: 1.05,
    stopLoss: 1.04,
    takeProfit: 1.07,
    confidence: 80,
    mode: "DEMO" as const,
  };
  const now = new Date();
  await db.insert(tradesTable).values([
    { ...base, symbol: "EURUSD", strategy: STRATEGY_A, status: "CLOSED_WIN", pnl: 100, pnlStatus: "COMPUTED", closedAt: now },
    { ...base, symbol: "EURUSD", strategy: STRATEGY_A, status: "CLOSED_WIN", pnl: 50, pnlStatus: "COMPUTED", closedAt: now },
    { ...base, symbol: "EURUSD", strategy: STRATEGY_A, status: "CLOSED_LOSS", pnl: -40, pnlStatus: "COMPUTED", closedAt: now },
    { ...base, symbol: "GBPUSD", strategy: STRATEGY_B, status: "CLOSED_WIN", pnl: 30, pnlStatus: "COMPUTED", closedAt: now },
    // UNKNOWN — large non-null pnl + CLOSED_WIN: a landmine for any aggregate
    // that forgets to skip pnlStatus="UNKNOWN".
    { ...base, symbol: "EURUSD", strategy: STRATEGY_A, status: "CLOSED_WIN", pnl: 9999, pnlStatus: "UNKNOWN", dataQualityFlag: "MISSING_CLOSE_FILL_PRICE", closedAt: now },
    { ...base, symbol: "GBPUSD", strategy: STRATEGY_B, status: "CLOSED_WIN", pnl: 9999, pnlStatus: "UNKNOWN", dataQualityFlag: "MISSING_CLOSE_FILL_PRICE", closedAt: now },
    // OPEN — counts only toward openTrades.
    { ...base, symbol: "USDJPY", strategy: STRATEGY_A, status: "OPEN", pnl: null, pnlStatus: "PENDING" },
  ]);

  // Expected values derived from COMPUTED rows ONLY:
  //   wins 3 (100,50,30), loss 1 (-40); total = 140; winRate = 75%
  const EXPECT = {
    totalPnl: 140,
    winRate: 75,
    totalTrades: 4,
    winningTrades: 3,
    losingTrades: 1,
    openTrades: 1,
    bestTradePnl: 100,
    worstTradePnl: -40,
    grossProfit: 180,
    grossLoss: 40,
    profitFactor: 180 / 40, // 4.5
    excludedUnknownCount: 2,
  };

  // ── /performance/summary ───────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log("/performance/summary — UNKNOWN rows excluded from every field");
  const summaryRes = await fetch(`${baseUrl}/api/performance/summary`, {
    headers: { cookie },
  });
  assert(summaryRes.status === 200, `summary HTTP 200 (got ${summaryRes.status})`);
  const summary = await summaryRes.json() as Record<string, number>;

  assert(near(summary["totalPnl"]!, EXPECT.totalPnl), `totalPnl = ${EXPECT.totalPnl} (got ${summary["totalPnl"]})`);
  assert(near(summary["winRate"]!, EXPECT.winRate), `winRate = ${EXPECT.winRate} (got ${summary["winRate"]})`);
  assert(summary["totalTrades"] === EXPECT.totalTrades, `totalTrades = ${EXPECT.totalTrades} (got ${summary["totalTrades"]})`);
  assert(summary["winningTrades"] === EXPECT.winningTrades, `winningTrades = ${EXPECT.winningTrades} (got ${summary["winningTrades"]})`);
  assert(summary["losingTrades"] === EXPECT.losingTrades, `losingTrades = ${EXPECT.losingTrades} (got ${summary["losingTrades"]})`);
  assert(summary["openTrades"] === EXPECT.openTrades, `openTrades = ${EXPECT.openTrades} (got ${summary["openTrades"]})`);
  assert(near(summary["bestTradePnl"]!, EXPECT.bestTradePnl), `bestTradePnl = ${EXPECT.bestTradePnl} (got ${summary["bestTradePnl"]})`);
  assert(near(summary["worstTradePnl"]!, EXPECT.worstTradePnl), `worstTradePnl = ${EXPECT.worstTradePnl} (got ${summary["worstTradePnl"]})`);
  assert(near(summary["profitFactor"]!, EXPECT.profitFactor), `profitFactor = ${EXPECT.profitFactor} (got ${summary["profitFactor"]})`);
  assert(summary["excludedUnknownCount"] === EXPECT.excludedUnknownCount, `excludedUnknownCount = ${EXPECT.excludedUnknownCount} (got ${summary["excludedUnknownCount"]})`);
  // Direct landmine check: the 9999 from UNKNOWN rows must never leak into
  // P/L-derived fields. (accountBalance = 10000 + totalPnl is legitimately
  // > 9999, so it is excluded from this guard.)
  const landmineFields = ["totalPnl", "todayPnl", "bestTradePnl", "worstTradePnl", "profitFactor"] as const;
  assert(
    landmineFields.every((k) => Math.abs(summary[k] ?? 0) < 9999),
    "no P/L field carries the 9999 landmine value from the UNKNOWN rows",
  );

  // ── /performance/strategy-breakdown ────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log("\n/performance/strategy-breakdown — UNKNOWN rows excluded per strategy");
  const breakdownRes = await fetch(`${baseUrl}/api/performance/strategy-breakdown`, {
    headers: { cookie },
  });
  assert(breakdownRes.status === 200, `strategy-breakdown HTTP 200 (got ${breakdownRes.status})`);
  const breakdown = await breakdownRes.json() as Array<{
    strategy: string; totalTrades: number; wins: number; losses: number; winRate: number; totalPnl: number;
  }>;
  const byStrategy = new Map(breakdown.map((b) => [b.strategy, b]));

  const a = byStrategy.get(STRATEGY_A);
  assert(!!a, `${STRATEGY_A} present in breakdown`);
  if (a) {
    // A COMPUTED: 2 wins (100,50), 1 loss (-40) → pnl 110. UNKNOWN A excluded.
    assert(a.wins === 2, `${STRATEGY_A} wins = 2 (got ${a.wins})`);
    assert(a.losses === 1, `${STRATEGY_A} losses = 1 (got ${a.losses})`);
    assert(a.totalTrades === 3, `${STRATEGY_A} totalTrades = 3 (got ${a.totalTrades})`);
    assert(near(a.totalPnl, 110), `${STRATEGY_A} totalPnl = 110 (got ${a.totalPnl})`);
  }

  const b = byStrategy.get(STRATEGY_B);
  assert(!!b, `${STRATEGY_B} present in breakdown`);
  if (b) {
    // B COMPUTED: 1 win (30). UNKNOWN B excluded.
    assert(b.wins === 1, `${STRATEGY_B} wins = 1 (got ${b.wins})`);
    assert(b.losses === 0, `${STRATEGY_B} losses = 0 (got ${b.losses})`);
    assert(b.totalTrades === 1, `${STRATEGY_B} totalTrades = 1 (got ${b.totalTrades})`);
    assert(near(b.totalPnl, 30), `${STRATEGY_B} totalPnl = 30 (got ${b.totalPnl})`);
  }
  assert(
    breakdown.every((row) => Math.abs(row.totalPnl) < 9999),
    "no strategy carries the 9999 landmine value from the UNKNOWN rows",
  );

  // ── /trades projection includes pnlStatus + dataQualityFlag ────────────
  // eslint-disable-next-line no-console
  console.log("\n/trades — projection exposes pnlStatus + dataQualityFlag per row");
  const tradesRes = await fetch(`${baseUrl}/api/trades?limit=50`, { headers: { cookie } });
  assert(tradesRes.status === 200, `trades HTTP 200 (got ${tradesRes.status})`);
  const tradeRows = await tradesRes.json() as Array<Record<string, unknown>>;
  assert(tradeRows.length === 7, `returned all 7 seeded rows (got ${tradeRows.length})`);
  assert(
    tradeRows.every((r) => "pnlStatus" in r),
    "every /trades row exposes a pnlStatus field",
  );
  assert(
    tradeRows.every((r) => "dataQualityFlag" in r),
    "every /trades row exposes a dataQualityFlag field",
  );
  const unknownRows = tradeRows.filter((r) => r["pnlStatus"] === "UNKNOWN");
  assert(unknownRows.length === 2, `2 rows surface pnlStatus="UNKNOWN" (got ${unknownRows.length})`);
  assert(
    unknownRows.every((r) => r["dataQualityFlag"] === "MISSING_CLOSE_FILL_PRICE"),
    "UNKNOWN rows carry dataQualityFlag=MISSING_CLOSE_FILL_PRICE",
  );

  // ── Cleanup ────────────────────────────────────────────────────────────
  await cleanupByEmail();

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "aggregatesExcludeUnknownPnlTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    async (r) => {
      await closeSharedServer().catch(() => {});
      process.exit(r.failures > 0 ? 1 : 0);
    },
    async (err) => {
      // Best-effort cleanup so a mid-run failure does not poison the next run.
      await cleanupByEmail().catch(() => {});
      await closeSharedServer().catch(() => {});
      // eslint-disable-next-line no-console
      console.error("[aggregatesExcludeUnknownPnlTest] FAILED:", err);
      process.exit(1);
    },
  );
}
