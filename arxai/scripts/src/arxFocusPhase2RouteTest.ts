// Test: ARX Focus-Lock Phase 2 — endpoint backstops against the booted app
// (Task #570, spec step 10).
//
// Phase 1 locked the chart/scanner data path. Phase 2 extends the SAME
// Focus-Lock helpers (resolveArxMarket / isApprovedArxMarket /
// arxFocusBlockedEnvelope) to the remaining display surfaces that could still
// leak a non-approved market: backtesting, the dashboard timing-brain widgets,
// and the watchlist — plus their API endpoints — and confirms the full-provider
// admin diagnostics view stays admin-only.
//
// What this proves against the REAL HTTP routes (booted Express app, real
// session), all additive — no gate / floor / SL / trading-path is touched:
//
//   BACKTEST
//     1. POST /backtest-runs with an unapproved symbol → 200 blocked envelope
//        and NO backtest_runs row created (no candles generated / nothing run).
//     2. POST /backtest-runs with an approved symbol → 200 real run (isApproved
//        path), row present.
//     3. A pre-existing run on a now-unapproved symbol is HIDDEN from
//        GET /backtest-runs but still present in the DB (hidden, not deleted).
//     4. GET /backtest-runs/:id and /:id/trades for that hidden run return the
//        blocked envelope (never the run/trades data); the rows stay in the DB.
//
//   DASHBOARD (timing-brain)
//     5. GET /me/timing-brain/:symbol unapproved → 200 blocked envelope, no data.
//     6. GET /me/timing-brain/:symbol approved → NOT blocked (real read).
//
//   WATCHLIST
//     7. POST /watchlists/:id/items unapproved → 400 SYMBOL_NOT_IN_APPROVED_LIST,
//        no row stored.
//     8. A pre-existing unapproved saved item is HIDDEN from GET /watchlists but
//        still present in the DB (hidden, not deleted).
//
//   ADMIN
//     9. GET /admin/market-data/diagnostics as a normal USER → 403 (the
//        full-provider view is never visible to a normal user).
//
// SAFETY / ISOLATION
//   - Seeds a single isolated system user (isSystemUser=true, fixed email) and
//     operates ONLY on that user's rows + the backtest rows it inserts. Cleans
//     up at start and end, even on failure.
//   - Read-only w.r.t. trading: never places a trade, never reaches the EA or a
//     broker. Backtests are pure historical simulation.
//   - CI-safe / self-contained: spins up the REAL Express app in-process on an
//     ephemeral port. Set ARX_QA_BASE_URL to probe an already-running server.
//
// Run: pnpm --filter @workspace/scripts run test:arx-focus-phase2

import { randomBytes, createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  authUserSessionsTable,
  watchlistsTable,
  watchlistItemsTable,
  backtestRunsTable,
  backtestTradesTable,
} from "@workspace/db";
import { ARX_FOCUS_BLOCKED_REASON } from "@workspace/domain/market";
import {
  getSharedBaseUrl,
  closeSharedServer,
  isEntrypoint,
  type CiTestResultLike,
} from "./ci/inProcessAppHarness.js";

const TEST_EMAIL = "qa+arx-focus-phase2@arx.test";

// An off-universe symbol that resolveArxMarket rejects.
const OFF_UNIVERSE_SYMBOL = "FAKECOIN";
// An approved market (canonical) used to prove the pass-through path.
const APPROVED_SYMBOL = "EURUSD";

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

function isBlockedEnvelope(json: unknown, requestedSymbol: string): boolean {
  const e = json as Record<string, unknown> | null;
  return (
    !!e &&
    e["requestedSymbol"] === requestedSymbol &&
    e["isApprovedMarket"] === false &&
    e["blocked"] === true &&
    e["reason"] === ARX_FOCUS_BLOCKED_REASON
  );
}

// Asserts the extended approved envelope (Task #570) is present and well-formed.
// `expectCanonical` is the canonical symbol the approved market should resolve
// to (e.g. EURUSD). `dataSource` / `freshness` keys MUST exist (value may be
// null — freshness is descriptive). category / priorityTier must be present.
function isApprovedEnvelope(env: unknown, expectCanonical: string): boolean {
  const e = env as Record<string, unknown> | null;
  return (
    !!e &&
    e["isApprovedMarket"] === true &&
    e["blocked"] === false &&
    e["canonicalSymbol"] === expectCanonical &&
    typeof e["category"] === "string" &&
    (e["priorityTier"] === "tier_1" || e["priorityTier"] === "tier_2") &&
    "dataSource" in e &&
    "freshness" in e
  );
}

async function cleanup(): Promise<void> {
  const rows = await db.select().from(usersTable).where(eq(usersTable.email, TEST_EMAIL));
  for (const u of rows) {
    // Watchlists + items
    const lists = await db.select().from(watchlistsTable).where(eq(watchlistsTable.userId, u.id));
    const listIds = lists.map((l) => l.id);
    if (listIds.length) {
      await db.delete(watchlistItemsTable).where(inArray(watchlistItemsTable.watchlistId, listIds));
    }
    await db.delete(watchlistsTable).where(eq(watchlistsTable.userId, u.id));
    // Backtest runs (+ their trades) owned by this user
    const runs = await db.select().from(backtestRunsTable).where(eq(backtestRunsTable.userId, u.id));
    const runIds = runs.map((r) => r.id);
    if (runIds.length) {
      await db.delete(backtestTradesTable).where(inArray(backtestTradesTable.backtestRunId, runIds));
      await db.delete(backtestRunsTable).where(inArray(backtestRunsTable.id, runIds));
    }
    await db.delete(authUserSessionsTable).where(eq(authUserSessionsTable.userId, u.id));
    await db.delete(usersTable).where(eq(usersTable.id, u.id));
  }
}

export async function run(): Promise<CiTestResultLike> {
  passes = 0;
  failures = 0;
  // eslint-disable-next-line no-console
  console.log("arxFocusPhase2RouteTest");
  // eslint-disable-next-line no-console
  console.log("=======================\n");

  await cleanup();

  const baseUrl = await getSharedBaseUrl();

  // ── Seed isolated user + session ─────────────────────────────────────────
  const insertedUsers = await db.insert(usersTable).values({
    email: TEST_EMAIL,
    name: "QA ARX Focus Phase 2",
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

  const authedJson = async (path: string, init?: RequestInit) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      cookie,
      ...(init?.headers as Record<string, string> | undefined),
    };
    const res = await fetch(`${baseUrl}${path}`, { ...init, headers, redirect: "manual" });
    const json = await res.json().catch(() => null);
    return { status: res.status, json } as { status: number; json: any };
  };

  try {
    // ── BACKTEST ────────────────────────────────────────────────────────────
    // 1. Unapproved symbol → blocked envelope + NO row.
    // eslint-disable-next-line no-console
    console.log(`POST /backtest-runs "${OFF_UNIVERSE_SYMBOL}" — unapproved → blocked, nothing run`);
    const offRowsBefore = (await db.select().from(backtestRunsTable)
      .where(eq(backtestRunsTable.symbol, OFF_UNIVERSE_SYMBOL))).length;
    const btOff = await authedJson("/api/backtest-runs", {
      method: "POST",
      body: JSON.stringify({ strategyId: "trendContinuation", symbol: OFF_UNIVERSE_SYMBOL }),
    });
    assert(btOff.status === 200, `backtest unapproved HTTP 200 (got ${btOff.status})`);
    assert(
      isBlockedEnvelope(btOff.json, OFF_UNIVERSE_SYMBOL),
      `backtest unapproved → shared blocked envelope (got ${JSON.stringify(btOff.json)})`,
    );
    const offRowsAfter = (await db.select().from(backtestRunsTable)
      .where(eq(backtestRunsTable.symbol, OFF_UNIVERSE_SYMBOL))).length;
    assert(
      offRowsAfter === offRowsBefore,
      `backtest unapproved: no NEW backtest_runs row created (before=${offRowsBefore} after=${offRowsAfter})`,
    );

    // 2. Approved symbol → real run created.
    // eslint-disable-next-line no-console
    console.log(`\nPOST /backtest-runs "${APPROVED_SYMBOL}" — approved → real run`);
    const btOk = await authedJson("/api/backtest-runs", {
      method: "POST",
      body: JSON.stringify({ strategyId: "trendContinuation", symbol: APPROVED_SYMBOL, candleCount: 120 }),
    });
    assert(btOk.status === 200, `backtest approved HTTP 200 (got ${btOk.status})`);
    assert(btOk.json?.blocked !== true, `backtest approved NOT blocked`);
    assert(typeof btOk.json?.id === "number", `backtest approved returns a run id (got ${String(btOk.json?.id)})`);
    assert(
      isApprovedEnvelope(btOk.json?.arxFocus, APPROVED_SYMBOL),
      `POST /backtest-runs approved → extended approved envelope (got ${JSON.stringify(btOk.json?.arxFocus)})`,
    );

    // 3+4. Seed a run on a NOW-unapproved symbol directly in the DB, owned by the
    // test user, then prove it is hidden from the list AND blocked on detail —
    // while remaining in the DB (hidden, not deleted).
    const seededRun = (await db.insert(backtestRunsTable).values({
      userId: user.id,
      strategyId: "trendContinuation",
      symbol: OFF_UNIVERSE_SYMBOL,
      timeframe: "M1",
      startTime: new Date("2024-01-01T00:00:00Z"),
      endTime: new Date("2024-01-01T02:00:00Z"),
      status: "COMPLETED",
      totalTrades: 1,
    }).returning())[0]!;
    await db.insert(backtestTradesTable).values({
      backtestRunId: seededRun.id,
      symbol: OFF_UNIVERSE_SYMBOL,
      direction: "BUY",
      entryTime: new Date("2024-01-01T00:10:00Z"),
      exitTime: new Date("2024-01-01T00:20:00Z"),
      entryPrice: 100, exitPrice: 101, stopLoss: 99, takeProfit: 102,
      profitLoss: 1, rewardToRisk: 1, result: "WIN",
    });

    // eslint-disable-next-line no-console
    console.log(`\nGET /backtest-runs — hidden-not-deleted for unapproved saved run #${seededRun.id}`);
    const list = await authedJson("/api/backtest-runs?limit=200");
    assert(list.status === 200, `backtest list HTTP 200 (got ${list.status})`);
    const listed: any[] = Array.isArray(list.json?.runs) ? list.json.runs : [];
    assert(
      !listed.some((r) => r.id === seededRun.id),
      `unapproved saved run is HIDDEN from GET /backtest-runs`,
    );
    const stillInDb = await db.select().from(backtestRunsTable).where(eq(backtestRunsTable.id, seededRun.id));
    assert(stillInDb.length === 1, `hidden run still present in DB (not deleted)`);

    const detail = await authedJson(`/api/backtest-runs/${seededRun.id}`);
    assert(detail.status === 200, `backtest detail HTTP 200 (got ${detail.status})`);
    assert(
      isBlockedEnvelope(detail.json, OFF_UNIVERSE_SYMBOL),
      `GET /backtest-runs/:id unapproved → blocked envelope (got ${JSON.stringify(detail.json)})`,
    );
    const tradesDetail = await authedJson(`/api/backtest-runs/${seededRun.id}/trades`);
    assert(tradesDetail.status === 200, `backtest trades HTTP 200 (got ${tradesDetail.status})`);
    assert(
      isBlockedEnvelope(tradesDetail.json, OFF_UNIVERSE_SYMBOL),
      `GET /backtest-runs/:id/trades unapproved → blocked envelope (got ${JSON.stringify(tradesDetail.json)})`,
    );
    const tradesStillInDb = await db.select().from(backtestTradesTable)
      .where(eq(backtestTradesTable.backtestRunId, seededRun.id));
    assert(tradesStillInDb.length === 1, `hidden run's trades still present in DB (not deleted)`);

    // 2b. APPROVED branch on the read surfaces: the EURUSD run created above must
    // surface in GET /backtest-runs AND GET /backtest-runs/:id, each carrying the
    // extended approved envelope.
    const approvedRunId = btOk.json?.id as number;
    // eslint-disable-next-line no-console
    console.log(`\nGET /backtest-runs(/:id) approved run #${approvedRunId} → extended approved envelope`);
    const listedApproved = listed.find((r) => r.id === approvedRunId)
      ?? (await authedJson("/api/backtest-runs?limit=200")).json?.runs?.find((r: any) => r.id === approvedRunId);
    assert(
      isApprovedEnvelope(listedApproved?.arxFocus, APPROVED_SYMBOL),
      `GET /backtest-runs approved row → extended approved envelope (got ${JSON.stringify(listedApproved?.arxFocus)})`,
    );
    const approvedDetail = await authedJson(`/api/backtest-runs/${approvedRunId}`);
    assert(approvedDetail.status === 200, `backtest approved detail HTTP 200 (got ${approvedDetail.status})`);
    assert(
      isApprovedEnvelope(approvedDetail.json?.arxFocus, APPROVED_SYMBOL),
      `GET /backtest-runs/:id approved → extended approved envelope (got ${JSON.stringify(approvedDetail.json?.arxFocus)})`,
    );

    // ── DASHBOARD (timing-brain) ─────────────────────────────────────────────
    // eslint-disable-next-line no-console
    console.log(`\nGET /me/timing-brain/:symbol — Focus-Lock backstop`);
    const tbOff = await authedJson(`/api/me/timing-brain/${OFF_UNIVERSE_SYMBOL}`);
    assert(tbOff.status === 200, `timing-brain unapproved HTTP 200 (got ${tbOff.status})`);
    assert(
      isBlockedEnvelope(tbOff.json, OFF_UNIVERSE_SYMBOL),
      `timing-brain unapproved → blocked envelope, no data (got ${JSON.stringify(tbOff.json)})`,
    );
    const tbOk = await authedJson(`/api/me/timing-brain/${APPROVED_SYMBOL}`);
    assert(tbOk.status === 200, `timing-brain approved HTTP 200 (got ${tbOk.status})`);
    assert(tbOk.json?.blocked !== true, `timing-brain approved NOT blocked`);
    assert(
      isApprovedEnvelope(tbOk.json?.arxFocus, APPROVED_SYMBOL),
      `GET /me/timing-brain/:symbol approved → extended approved envelope (got ${JSON.stringify(tbOk.json?.arxFocus)})`,
    );

    // Multi-symbol: must return an EXPLICIT per-symbol entry for BOTH inputs (no
    // silent drop) — the unapproved one a blocked envelope, the approved one a
    // read carrying the approved envelope. Order is preserved.
    // eslint-disable-next-line no-console
    console.log(`\nGET /me/timing-brain?symbols=approved,unapproved — explicit per-symbol entries`);
    const tbMulti = await authedJson(
      `/api/me/timing-brain?symbols=${APPROVED_SYMBOL},${OFF_UNIVERSE_SYMBOL}`,
    );
    assert(tbMulti.status === 200, `timing-brain multi HTTP 200 (got ${tbMulti.status})`);
    const multiResults: any[] = Array.isArray(tbMulti.json?.results) ? tbMulti.json.results : [];
    assert(multiResults.length === 2, `timing-brain multi returns one entry per symbol (got ${multiResults.length})`);
    assert(
      multiResults.some((r) => isBlockedEnvelope(r, OFF_UNIVERSE_SYMBOL)),
      `timing-brain multi: unapproved symbol → explicit blocked entry (not dropped)`,
    );
    assert(
      multiResults.some((r) => r?.blocked !== true && isApprovedEnvelope(r?.arxFocus, APPROVED_SYMBOL)),
      `timing-brain multi: approved symbol → read with extended approved envelope`,
    );

    // ── WATCHLIST ─────────────────────────────────────────────────────────────
    // eslint-disable-next-line no-console
    console.log(`\nWatchlist add reject + hidden-not-deleted`);
    const createRes = await authedJson("/api/watchlists", {
      method: "POST",
      body: JSON.stringify({ name: "QA Phase2", category: "Custom" }),
    });
    const listId = createRes.json?.id as number;
    assert(typeof listId === "number", `created watchlist id present (got ${String(listId)})`);

    const addOff = await authedJson(`/api/watchlists/${listId}/items`, {
      method: "POST",
      body: JSON.stringify({ symbol: OFF_UNIVERSE_SYMBOL, marketType: "crypto" }),
    });
    assert(addOff.status === 400, `watchlist add unapproved → 400 (got ${addOff.status})`);
    assert(
      addOff.json?.error === "SYMBOL_NOT_IN_APPROVED_LIST",
      `watchlist add unapproved error code (got ${String(addOff.json?.error)})`,
    );
    const afterAdd = await db.select().from(watchlistItemsTable)
      .where(eq(watchlistItemsTable.watchlistId, listId));
    assert(afterAdd.length === 0, `watchlist add unapproved: no row stored (got ${afterAdd.length})`);

    // Approved branch: adding an approved symbol returns the enriched item with
    // the extended approved envelope.
    const addOk = await authedJson(`/api/watchlists/${listId}/items`, {
      method: "POST",
      body: JSON.stringify({ symbol: APPROVED_SYMBOL, marketType: "forex" }),
    });
    assert(addOk.status === 200, `watchlist add approved → 200 (got ${addOk.status})`);
    assert(
      isApprovedEnvelope(addOk.json?.arxFocus, APPROVED_SYMBOL),
      `watchlist add approved → extended approved envelope (got ${JSON.stringify(addOk.json?.arxFocus)})`,
    );

    // Seed an unapproved item directly, then confirm GET hides it but keeps it.
    const seededItem = (await db.insert(watchlistItemsTable).values({
      watchlistId: listId,
      symbol: OFF_UNIVERSE_SYMBOL,
      marketType: "crypto",
    }).returning())[0]!;
    const wl = await authedJson("/api/watchlists");
    assert(wl.status === 200, `watchlist GET HTTP 200 (got ${wl.status})`);
    const allItemsSurfaced: any[] = Array.isArray(wl.json)
      ? wl.json.flatMap((w: any) => (Array.isArray(w.items) ? w.items : []))
      : [];
    assert(
      !allItemsSurfaced.some((i) => i.symbol === OFF_UNIVERSE_SYMBOL),
      `unapproved saved watchlist item is HIDDEN from GET /watchlists`,
    );
    const itemStillInDb = await db.select().from(watchlistItemsTable)
      .where(eq(watchlistItemsTable.id, seededItem.id));
    assert(itemStillInDb.length === 1, `hidden watchlist item still present in DB (not deleted)`);

    // ── ADMIN ─────────────────────────────────────────────────────────────────
    // eslint-disable-next-line no-console
    console.log(`\nGET /admin/market-data/diagnostics as USER — full-provider view denied`);
    const adminAsUser = await authedJson("/api/admin/market-data/diagnostics");
    assert(
      adminAsUser.status === 403,
      `normal user → 403 on admin diagnostics (got ${adminAsUser.status})`,
    );
  } finally {
    await cleanup();
  }

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "arxFocusPhase2RouteTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    async (r) => {
      await closeSharedServer().catch(() => {});
      process.exit(r.failures > 0 ? 1 : 0);
    },
    async (err) => {
      await cleanup().catch(() => {});
      await closeSharedServer().catch(() => {});
      // eslint-disable-next-line no-console
      console.error("[arxFocusPhase2RouteTest] FAILED:", err);
      process.exit(1);
    },
  );
}
