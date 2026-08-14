// Test: POST /api/watchlists/:id/items end-to-end against the booted app
// (Task #422).
//
// Task #418 added a server-side gate so a watchlist item must resolve into the
// approved Top 250 (otherwise it returns 400 SYMBOL_NOT_IN_APPROVED_LIST). This
// closed a scan escape hatch: enrichItems() runs getMarketData + runStrategyScan
// on whatever symbol a row holds, so an arbitrary "custom" symbol would be
// scanned outside the approved universe.
//
// The existing coverage (scripts/src/marketPickerDriftLockTest.ts) is a
// source-scan of the route + a resolver unit check. Neither proves the RUNNING
// endpoint actually rejects an off-universe symbol and accepts an approved alias
// while storing the canonical standardSymbol. This test closes that gap.
//
// What this proves against the REAL HTTP route (booted Express app, real session):
//   1. Off-universe symbol ("FAKECOIN") → 400 with error
//      SYMBOL_NOT_IN_APPROVED_LIST, and NO watchlist_items row is created
//      (the scan escape hatch stays closed — nothing is stored or scanned).
//   2. Approved alias "gold" → 200, and the STORED symbol is the canonical
//      standardSymbol "XAUUSD" (not the typed alias).
//   3. Approved alias "v75" → 200, and the STORED symbol is the canonical
//      standardSymbol "Volatility 75 Index".
//   4. Anonymous POST → 401 (the route is per-user gated).
//
// SAFETY / ISOLATION
//   - Seeds a single isolated system user (isSystemUser=true, fixed email) and
//     operates ONLY on that user's rows. Idempotent: cleans up the watchlist,
//     items, session, and user at start and end, even on failure.
//   - Read-only w.r.t. trading: only the watchlist CRUD endpoints are called.
//     Never places a trade, never reaches the EA or a broker.
//   - CI-safe / self-contained: spins up the REAL Express app in-process on an
//     ephemeral port. Set ARX_QA_BASE_URL to probe an already-running server
//     instead. Only DATABASE_URL is required.
//
// Run: pnpm --filter @workspace/scripts run test:watchlist-universe-gate

import { randomBytes, createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  authUserSessionsTable,
  watchlistsTable,
  watchlistItemsTable,
} from "@workspace/db";
import {
  getSharedBaseUrl,
  closeSharedServer,
  isEntrypoint,
  type CiTestResultLike,
} from "./ci/inProcessAppHarness.js";

const TEST_EMAIL = "qa+watchlist-universe-gate@arx.test";

// An off-universe symbol that resolveUserMarketInput rejects (not_in_universe).
const OFF_UNIVERSE_SYMBOL = "FAKECOIN";
// Approved aliases whose canonical standardSymbol differs from the typed input,
// proving the route stores the canonical symbol, not the alias.
// Task #570 retarget: the watchlist add gate now resolves via the ARX Focus
// registry (resolveArxMarket) and stores its canonicalSymbol — the single source
// of truth. For V75 that canonical is "V75" (display name "Volatility 75 Index"
// is now an mt5Alias). This test was previously asserting the legacy
// resolveUserMarketInput canonical "Volatility 75 Index"; it is retargeted to the
// current contract, not loosened.
const APPROVED_ALIASES: Array<{ typed: string; canonical: string }> = [
  { typed: "gold", canonical: "XAUUSD" },
  { typed: "v75", canonical: "V75" },
];

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

async function cleanupByEmail(): Promise<void> {
  const rows = await db.select().from(usersTable).where(eq(usersTable.email, TEST_EMAIL));
  for (const u of rows) {
    const lists = await db.select().from(watchlistsTable).where(eq(watchlistsTable.userId, u.id));
    const listIds = lists.map((l) => l.id);
    if (listIds.length) {
      await db.delete(watchlistItemsTable).where(inArray(watchlistItemsTable.watchlistId, listIds));
    }
    await db.delete(watchlistsTable).where(eq(watchlistsTable.userId, u.id));
    await db.delete(authUserSessionsTable).where(eq(authUserSessionsTable.userId, u.id));
    await db.delete(usersTable).where(eq(usersTable.id, u.id));
  }
}

export async function run(): Promise<CiTestResultLike> {
  passes = 0;
  failures = 0;
  // eslint-disable-next-line no-console
  console.log("watchlistUniverseGateRouteTest");
  // eslint-disable-next-line no-console
  console.log("==============================\n");

  await cleanupByEmail();

  const baseUrl = await getSharedBaseUrl();

  // ── Seed isolated user + session ─────────────────────────────────────────
  const insertedUsers = await db.insert(usersTable).values({
    email: TEST_EMAIL,
    name: "QA Watchlist Universe Gate",
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

  const postItem = async (listId: number, body: unknown, withAuth = true) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (withAuth) headers["cookie"] = cookie;
    const res = await fetch(`${baseUrl}/api/watchlists/${listId}/items`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "manual",
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json } as { status: number; json: any };
  };

  try {
    // ── Create a watchlist to add items into ────────────────────────────────
    const createRes = await fetch(`${baseUrl}/api/watchlists`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "QA Universe Gate", category: "Custom" }),
    });
    const createJson = (await createRes.json().catch(() => null)) as any;
    assert(createRes.status === 200, `create watchlist HTTP 200 (got ${createRes.status})`);
    const listId = createJson?.id as number;
    assert(typeof listId === "number", `created watchlist id present (got ${String(listId)})`);

    // ── 0. AUTH — the route is per-user gated (anon → 401). ─────────────────
    {
      const anon = await postItem(listId, { symbol: "EURUSD", marketType: "forex" }, false);
      assert(anon.status === 401, `anon POST item → 401 (got ${anon.status})`);
    }

    // ── 1. Off-universe symbol → 400 SYMBOL_NOT_IN_APPROVED_LIST, no row ─────
    // eslint-disable-next-line no-console
    console.log(`\nPOST item "${OFF_UNIVERSE_SYMBOL}" — off-universe → rejected, nothing stored`);
    const off = await postItem(listId, { symbol: OFF_UNIVERSE_SYMBOL, marketType: "crypto" });
    assert(off.status === 400, `off-universe HTTP 400 (got ${off.status})`);
    assert(
      off.json?.error === "SYMBOL_NOT_IN_APPROVED_LIST",
      `off-universe error === "SYMBOL_NOT_IN_APPROVED_LIST" (got ${String(off.json?.error)})`,
    );
    // No row may be scanned/stored for the rejected symbol.
    const afterReject = await db.select().from(watchlistItemsTable)
      .where(eq(watchlistItemsTable.watchlistId, listId));
    assert(afterReject.length === 0, `off-universe: no watchlist_items row stored (got ${afterReject.length})`);

    // ── 2/3. Approved aliases → 200, stored as canonical standardSymbol ─────
    for (const { typed, canonical } of APPROVED_ALIASES) {
      // eslint-disable-next-line no-console
      console.log(`\nPOST item "${typed}" — approved alias → stored as canonical "${canonical}"`);
      const ok = await postItem(listId, { symbol: typed, marketType: "forex" });
      assert(ok.status === 200, `"${typed}" HTTP 200 (got ${ok.status})`);
      assert(
        ok.json?.symbol === canonical,
        `"${typed}" response symbol === canonical "${canonical}" (got ${String(ok.json?.symbol)})`,
      );
      // The persisted row carries the canonical symbol, not the typed alias.
      const storedId = ok.json?.id as number;
      const storedRows = storedId != null
        ? await db.select().from(watchlistItemsTable).where(eq(watchlistItemsTable.id, storedId))
        : [];
      assert(
        storedRows[0]?.symbol === canonical,
        `"${typed}" stored row symbol === canonical "${canonical}" (got ${String(storedRows[0]?.symbol)})`,
      );
    }
  } finally {
    await cleanupByEmail();
  }

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "watchlistUniverseGateRouteTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    async (r) => {
      await closeSharedServer().catch(() => {});
      process.exit(r.failures > 0 ? 1 : 0);
    },
    async (err) => {
      await cleanupByEmail().catch(() => {});
      await closeSharedServer().catch(() => {});
      // eslint-disable-next-line no-console
      console.error("[watchlistUniverseGateRouteTest] FAILED:", err);
      process.exit(1);
    },
  );
}
