// brokerCandleCoverageRouteTest — Task #476 (shape + admin-gate),
//   extended by Task #481 (per-user attribution / no cross-leak).
//
// WHY
//   The admin "Broker price-history coverage" panel reads
//     GET /api/admin/market-data/broker-candles
//       (artifacts/api-server/src/routes/adminMarketDataDiagnostics.ts)
//   which projects getBrokerCandleCoverage()
//       (artifacts/api-server/src/lib/data/brokerCandleStore.ts).
//   Nothing previously locked the response shape (statusCounts, totals, per-
//   series rows + mirrored cache bars) or proved the endpoint is admin-gated.
//   A silent regression here would corrupt the operator's only view of how deep
//   the broker's stored history actually is.
//
//   getBrokerCandleCoverage() is an operator-wide aggregate: it INTENTIONALLY
//   returns rows across every bridge/user (the admin sees the whole fleet). But
//   each row carries the owning userId + bridgeConnectionId, and a regression
//   that accidentally scoped or cross-joined on the wrong key could attribute
//   one operator's stored series to another, or leak it through the ?symbol=
//   filter. Task #481 adds a focused per-user isolation assertion to catch that.
//
// WHAT IT PROVES
//   Auth (requireAdmin, EFFECTIVE role, case-insensitive):
//     - anonymous            -> 401
//     - normal USER session  -> 403
//     - ADMIN session        -> 200
//     - OWNER session        -> 200
//   Per-series shape, exact via the ?symbol= filter (deterministic on a shared
//   DB because each synthetic symbol is unique to this run):
//     - SYM_A (COMPLETE, M5): one row whose
//         symbol/timeframe/status/barsStored/oldestStoredAt/newestStoredAt
//       match the seeded backfill_status row, and whose mirroredCacheBars equals
//       the bars seeded into the router-read mt5_broker mirror slot.
//     - SYM_B (BUILDING, H1): one row with mirroredCacheBars 0 (nothing mirrored).
//     - statusCounts/totalSeries/totalBarsStored/totalMirroredCacheBars match
//       the single filtered series exactly.
//   ?symbol= filter narrows:
//     - the unfiltered response contains BOTH seeded symbols;
//     - filtering by SYM_A returns ONLY SYM_A (one row, no SYM_B).
//   Per-user isolation (Task #481) — TWO distinct bridge users:
//     - bridge user #1 owns SYM_A + SYM_B; bridge user #2 owns SYM_C.
//     - each coverage row is attributed to its OWN userId + bridgeConnectionId
//       (no cross-attribution between the two bridges);
//     - filtering by SYM_C returns ONLY bridge user #2's row, never bridge
//       user #1's userId/bridge, and vice-versa.
//
// SHARED-DB SAFETY
//   broker_candles / broker_candle_backfill_status / market_candles are
//   market-data telemetry tables (NOT safety evidence). We seed two isolated
//   isSystemUser bridges (each with its own mt5 connection) + one admin + one
//   normal user (each with a session), plus rows under three unique synthetic
//   symbols, and clean EVERYTHING in a `finally`, scoped by the seeded users +
//   synthetic symbols. Never places a trade, never inserts an arx_live_command,
//   never reaches a real EA. Because other rows may already exist in the shared
//   backfill_status table, every exact count assertion is made against the
//   ?symbol=-filtered response, never the global unfiltered totals.
//
// Run: pnpm --filter @workspace/scripts run test:broker-candle-coverage-route

import { randomBytes, createHash } from "node:crypto";
import { inArray, like } from "drizzle-orm";
import {
  db,
  usersTable,
  authUserSessionsTable,
  mt5ConnectionTable,
  brokerCandlesTable,
  brokerCandleBackfillStatusTable,
  marketCandlesTable,
} from "@workspace/db";
import { upsertCandles } from "../../artifacts/api-server/src/lib/data/candleCache.js";
import { getSharedBaseUrl, isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

const EMAIL_PREFIX = "qa+broker-candle-coverage";
const SESSION_TTL_MS = 15 * 60 * 1000;
const SESSION_COOKIE = "arx_user_session";

// Unique synthetic symbols so the ?symbol= filtered assertions are deterministic
// on a shared DB (no collision with real or other-run rows).
const SYM_A = `QCA${randomBytes(2).toString("hex").toUpperCase()}`;
const SYM_B = `QCB${randomBytes(2).toString("hex").toUpperCase()}`;
// SYM_C belongs to a SECOND bridge user — used to prove per-user attribution
// and that the ?symbol= filter never crosses bridge ownership (Task #481).
const SYM_C = `QCC${randomBytes(2).toString("hex").toUpperCase()}`;

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

function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function mintSession(userId: number): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await db.insert(authUserSessionsTable).values({
    userId,
    tokenHash: sha256(raw),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    ipAddress: "127.0.0.1",
    userAgent: "qa-broker-candle-coverage",
  });
  return raw;
}

async function cleanup(): Promise<void> {
  const users = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(like(usersTable.email, `${EMAIL_PREFIX}%`));
  const ids = users.map((u) => u.id);
  if (ids.length > 0) {
    await db.delete(brokerCandlesTable).where(inArray(brokerCandlesTable.userId, ids));
    await db
      .delete(brokerCandleBackfillStatusTable)
      .where(inArray(brokerCandleBackfillStatusTable.userId, ids));
    await db.delete(mt5ConnectionTable).where(inArray(mt5ConnectionTable.userId, ids));
    await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, ids));
    await db.delete(usersTable).where(inArray(usersTable.id, ids));
  }
  // The synthetic symbols are unique to this run; clear their mirror rows.
  await db
    .delete(marketCandlesTable)
    .where(inArray(marketCandlesTable.symbol, [SYM_A, SYM_B, SYM_C]));
}

interface CoverageRow {
  userId: number;
  bridgeConnectionId: number;
  symbol: string;
  timeframe: string;
  status: string;
  barsStored: number;
  oldestStoredAt: string | null;
  newestStoredAt: string | null;
  mirroredCacheBars: number;
}
interface CoverageBody {
  ok?: boolean;
  coverage?: {
    rows: CoverageRow[];
    statusCounts: Record<string, number>;
    totalSeries: number;
    totalBarsStored: number;
    totalMirroredCacheBars: number;
  };
  error?: string;
}

async function getCoverage(
  base: string,
  cookie: string | null,
  symbol?: string,
): Promise<{ status: number; body: CoverageBody }> {
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = `${SESSION_COOKIE}=${cookie}`;
  const qs = symbol ? `?symbol=${encodeURIComponent(symbol)}` : "";
  const r = await fetch(`${base}/api/admin/market-data/broker-candles${qs}`, { headers });
  let body: CoverageBody = {};
  try {
    body = (await r.json()) as CoverageBody;
  } catch {
    body = {};
  }
  return { status: r.status, body };
}

export async function run(): Promise<CiTestResultLike> {
  passes = 0;
  failures = 0;
  // eslint-disable-next-line no-console
  console.log("brokerCandleCoverageRouteTest");
  // eslint-disable-next-line no-console
  console.log("=============================\n");

  await cleanup();
  const base = await getSharedBaseUrl();

  // Seed instants (UTC). SYM_A spans ~365d (COMPLETE), SYM_B ~1d (BUILDING).
  const A_OLDEST = new Date("2025-06-08T00:00:00Z");
  const A_NEWEST = new Date("2026-06-08T00:00:00Z");
  const B_OLDEST = new Date("2026-06-09T00:00:00Z");
  const B_NEWEST = new Date("2026-06-10T00:00:00Z");
  const A_BARS_STORED = 50;
  const B_BARS_STORED = 12;
  const A_MIRROR_BARS = 3;
  // SYM_C (second bridge user) — distinct extent so a cross-attribution would
  // also surface as a value mismatch, not just a wrong owner id.
  const C_OLDEST = new Date("2025-12-08T00:00:00Z");
  const C_NEWEST = new Date("2026-06-08T00:00:00Z");
  const C_BARS_STORED = 27;

  try {
    // ── Seed users + sessions ────────────────────────────────────────────────
    const [bridgeUser] = await db
      .insert(usersTable)
      .values({ email: `${EMAIL_PREFIX}-bridge@arx.test`, name: "QA Coverage Bridge", role: "USER", isSystemUser: true })
      .returning();
    const [bridgeUser2] = await db
      .insert(usersTable)
      .values({ email: `${EMAIL_PREFIX}-bridge2@arx.test`, name: "QA Coverage Bridge 2", role: "USER", isSystemUser: true })
      .returning();
    const [adminUser] = await db
      .insert(usersTable)
      .values({ email: `${EMAIL_PREFIX}-admin@arx.test`, name: "QA Coverage Admin", role: "ADMIN", isSystemUser: true })
      .returning();
    const [ownerUser] = await db
      .insert(usersTable)
      .values({ email: `${EMAIL_PREFIX}-owner@arx.test`, name: "QA Coverage Owner", role: "OWNER", isSystemUser: true })
      .returning();
    const [normalUser] = await db
      .insert(usersTable)
      .values({ email: `${EMAIL_PREFIX}-user@arx.test`, name: "QA Coverage User", role: "USER", isSystemUser: true })
      .returning();
    if (!bridgeUser || !bridgeUser2 || !adminUser || !ownerUser || !normalUser) throw new Error("user creation failed");

    const adminCookie = await mintSession(adminUser.id);
    const ownerCookie = await mintSession(ownerUser.id);
    const userCookie = await mintSession(normalUser.id);

    const rawToken = randomBytes(24).toString("base64url");
    const [conn] = await db
      .insert(mt5ConnectionTable)
      .values({
        userId: bridgeUser.id,
        connectionName: "QA Coverage Bridge",
        status: "connected",
        apiKeyHash: sha256(rawToken),
        tokenLast4: rawToken.slice(-4),
        tokenCreatedAt: new Date(),
        accountNumber: "9991001",
      })
      .returning();
    if (!conn) throw new Error("connection creation failed");

    // Second, independent bridge (different user) — owns SYM_C only.
    const rawToken2 = randomBytes(24).toString("base64url");
    const [conn2] = await db
      .insert(mt5ConnectionTable)
      .values({
        userId: bridgeUser2.id,
        connectionName: "QA Coverage Bridge 2",
        status: "connected",
        apiKeyHash: sha256(rawToken2),
        tokenLast4: rawToken2.slice(-4),
        tokenCreatedAt: new Date(),
        accountNumber: "9992002",
      })
      .returning();
    if (!conn2) throw new Error("connection #2 creation failed");

    // ── Seed broker_candles (a few rows, for fidelity / provenance) ───────────
    await db.insert(brokerCandlesTable).values([
      {
        userId: bridgeUser.id, bridgeConnectionId: conn.id, accountNumber: "9991001",
        brokerSymbol: SYM_A, symbol: SYM_A, timeframe: "M5",
        openTimeUtc: A_OLDEST, closeTimeUtc: new Date(A_OLDEST.getTime() + 5 * 60_000),
        open: 1.10, high: 1.12, low: 1.09, close: 1.11, isClosedBar: true, source: "mt5_ea",
        qualityStatus: "accepted", qualityReason: "new_closed",
      },
      {
        userId: bridgeUser.id, bridgeConnectionId: conn.id, accountNumber: "9991001",
        brokerSymbol: SYM_A, symbol: SYM_A, timeframe: "M5",
        openTimeUtc: A_NEWEST, closeTimeUtc: new Date(A_NEWEST.getTime() + 5 * 60_000),
        open: 1.11, high: 1.13, low: 1.10, close: 1.12, isClosedBar: true, source: "mt5_ea",
        qualityStatus: "accepted", qualityReason: "new_closed",
      },
    ]);

    // ── Seed broker_candle_backfill_status (the rows the endpoint projects) ───
    await db.insert(brokerCandleBackfillStatusTable).values([
      {
        userId: bridgeUser.id, bridgeConnectionId: conn.id,
        brokerSymbol: SYM_A, symbol: SYM_A, timeframe: "M5",
        status: "COMPLETE", statusReason: "depth_target_met",
        oldestStoredAt: A_OLDEST, newestStoredAt: A_NEWEST,
        barsStored: A_BARS_STORED, targetDays: 365, coverageDays: 365,
        lastIngestAt: A_NEWEST,
      },
      {
        userId: bridgeUser.id, bridgeConnectionId: conn.id,
        brokerSymbol: SYM_B, symbol: SYM_B, timeframe: "H1",
        status: "BUILDING", statusReason: "actively_streaming",
        oldestStoredAt: B_OLDEST, newestStoredAt: B_NEWEST,
        barsStored: B_BARS_STORED, targetDays: 365, coverageDays: 1,
        lastIngestAt: B_NEWEST,
      },
    ]);

    // ── Seed SYM_C under the SECOND bridge user (isolation fixture) ───────────
    await db.insert(brokerCandlesTable).values([
      {
        userId: bridgeUser2.id, bridgeConnectionId: conn2.id, accountNumber: "9992002",
        brokerSymbol: SYM_C, symbol: SYM_C, timeframe: "M15",
        openTimeUtc: C_OLDEST, closeTimeUtc: new Date(C_OLDEST.getTime() + 15 * 60_000),
        open: 2.20, high: 2.25, low: 2.18, close: 2.22, isClosedBar: true, source: "mt5_ea",
        qualityStatus: "accepted", qualityReason: "new_closed",
      },
    ]);
    await db.insert(brokerCandleBackfillStatusTable).values([
      {
        userId: bridgeUser2.id, bridgeConnectionId: conn2.id,
        brokerSymbol: SYM_C, symbol: SYM_C, timeframe: "M15",
        status: "COMPLETE", statusReason: "depth_target_met",
        oldestStoredAt: C_OLDEST, newestStoredAt: C_NEWEST,
        barsStored: C_BARS_STORED, targetDays: 365, coverageDays: 365,
        lastIngestAt: C_NEWEST,
      },
    ]);

    // ── Seed the mt5_broker mirror cache for SYM_A only (drives mirroredCacheBars)
    const mirrorBars = [];
    for (let i = 0; i < A_MIRROR_BARS; i++) {
      const t = new Date(A_NEWEST.getTime() - i * 5 * 60_000).toISOString();
      mirrorBars.push({ time: t, open: 1.11, high: 1.13, low: 1.10, close: 1.12, volume: 100 });
    }
    const wrote = await upsertCandles(SYM_A, "M5", "mt5_broker", mirrorBars);
    assert(wrote.written === A_MIRROR_BARS, `seeded ${A_MIRROR_BARS} mt5_broker mirror bars for SYM_A (wrote ${wrote.written})`);

    // ── AUTH GATE ─────────────────────────────────────────────────────────────
    const anon = await getCoverage(base, null);
    assert(anon.status === 401, `anonymous -> 401 (got ${anon.status})`);
    const asUser = await getCoverage(base, userCookie);
    assert(asUser.status === 403, `normal USER -> 403 (got ${asUser.status})`);
    const asAdmin = await getCoverage(base, adminCookie);
    assert(asAdmin.status === 200, `ADMIN -> 200 (got ${asAdmin.status})`);
    const asOwner = await getCoverage(base, ownerCookie);
    assert(asOwner.status === 200, `OWNER -> 200 (got ${asOwner.status})`);

    // ── PER-SERIES SHAPE — SYM_A (exact via ?symbol= filter) ──────────────────
    const a = await getCoverage(base, adminCookie, SYM_A);
    assert(a.status === 200 && a.body.ok === true, `SYM_A filtered -> 200 ok (status ${a.status})`);
    const aCov = a.body.coverage;
    assert(!!aCov, "SYM_A response carries a coverage object");
    assert(!!aCov && aCov.totalSeries === 1, `SYM_A filter returns exactly 1 series (got ${aCov?.totalSeries})`);
    assert(!!aCov && aCov.rows.length === 1, `SYM_A filter returns exactly 1 row (got ${aCov?.rows.length})`);
    const aRow = aCov?.rows[0];
    assert(!!aRow && aRow.symbol === SYM_A, `SYM_A row.symbol matches (got ${aRow?.symbol})`);
    assert(!!aRow && aRow.timeframe === "M5", `SYM_A row.timeframe = M5 (got ${aRow?.timeframe})`);
    assert(!!aRow && aRow.status === "COMPLETE", `SYM_A row.status = COMPLETE (got ${aRow?.status})`);
    assert(!!aRow && aRow.barsStored === A_BARS_STORED, `SYM_A row.barsStored = ${A_BARS_STORED} (got ${aRow?.barsStored})`);
    assert(!!aRow && aRow.oldestStoredAt === A_OLDEST.toISOString(), `SYM_A row.oldestStoredAt matches (got ${aRow?.oldestStoredAt})`);
    assert(!!aRow && aRow.newestStoredAt === A_NEWEST.toISOString(), `SYM_A row.newestStoredAt matches (got ${aRow?.newestStoredAt})`);
    assert(!!aRow && aRow.mirroredCacheBars === A_MIRROR_BARS, `SYM_A row.mirroredCacheBars = ${A_MIRROR_BARS} (got ${aRow?.mirroredCacheBars})`);
    // Attribution: SYM_A is owned by bridge user #1.
    assert(!!aRow && aRow.userId === bridgeUser.id, `SYM_A row.userId = bridge user #1 (got ${aRow?.userId})`);
    assert(!!aRow && aRow.bridgeConnectionId === conn.id, `SYM_A row.bridgeConnectionId = bridge #1 conn (got ${aRow?.bridgeConnectionId})`);

    // statusCounts / totals are exact for a single-series filter.
    assert(!!aCov && aCov.statusCounts["COMPLETE"] === 1, `SYM_A statusCounts.COMPLETE = 1 (got ${aCov?.statusCounts["COMPLETE"]})`);
    assert(
      !!aCov && (["NOT_STARTED", "BUILDING", "PARTIAL", "BROKER_LIMITED", "ERROR"] as const).every((s) => aCov.statusCounts[s] === 0),
      "SYM_A statusCounts: every non-COMPLETE status is 0",
    );
    assert(!!aCov && aCov.totalBarsStored === A_BARS_STORED, `SYM_A totalBarsStored = ${A_BARS_STORED} (got ${aCov?.totalBarsStored})`);
    assert(!!aCov && aCov.totalMirroredCacheBars === A_MIRROR_BARS, `SYM_A totalMirroredCacheBars = ${A_MIRROR_BARS} (got ${aCov?.totalMirroredCacheBars})`);

    // ── PER-SERIES SHAPE — SYM_B (BUILDING, no mirror) ────────────────────────
    const b = await getCoverage(base, adminCookie, SYM_B);
    const bCov = b.body.coverage;
    assert(!!bCov && bCov.totalSeries === 1, `SYM_B filter returns exactly 1 series (got ${bCov?.totalSeries})`);
    const bRow = bCov?.rows[0];
    assert(!!bRow && bRow.symbol === SYM_B && bRow.timeframe === "H1", `SYM_B row symbol+timeframe match (got ${bRow?.symbol}/${bRow?.timeframe})`);
    assert(!!bRow && bRow.status === "BUILDING", `SYM_B row.status = BUILDING (got ${bRow?.status})`);
    assert(!!bRow && bRow.barsStored === B_BARS_STORED, `SYM_B row.barsStored = ${B_BARS_STORED} (got ${bRow?.barsStored})`);
    assert(!!bRow && bRow.mirroredCacheBars === 0, `SYM_B row.mirroredCacheBars = 0 (nothing mirrored) (got ${bRow?.mirroredCacheBars})`);
    assert(!!bCov && bCov.statusCounts["BUILDING"] === 1, `SYM_B statusCounts.BUILDING = 1 (got ${bCov?.statusCounts["BUILDING"]})`);

    // ── PER-USER ISOLATION — SYM_C (second bridge user) (Task #481) ───────────
    // SYM_C is owned by bridge user #2. The filtered response must attribute it
    // to user #2's id + connection, NEVER user #1's, and must not leak any of
    // user #1's symbols.
    const c = await getCoverage(base, adminCookie, SYM_C);
    assert(c.status === 200 && c.body.ok === true, `SYM_C filtered -> 200 ok (status ${c.status})`);
    const cCov = c.body.coverage;
    assert(!!cCov && cCov.totalSeries === 1, `SYM_C filter returns exactly 1 series (got ${cCov?.totalSeries})`);
    const cRow = cCov?.rows[0];
    assert(!!cRow && cRow.symbol === SYM_C && cRow.timeframe === "M15", `SYM_C row symbol+timeframe match (got ${cRow?.symbol}/${cRow?.timeframe})`);
    assert(!!cRow && cRow.barsStored === C_BARS_STORED, `SYM_C row.barsStored = ${C_BARS_STORED} (got ${cRow?.barsStored})`);
    // Correct owner attribution — and NOT bridge user #1's identity.
    assert(!!cRow && cRow.userId === bridgeUser2.id, `SYM_C row.userId = bridge user #2 (got ${cRow?.userId})`);
    assert(!!cRow && cRow.bridgeConnectionId === conn2.id, `SYM_C row.bridgeConnectionId = bridge #2 conn (got ${cRow?.bridgeConnectionId})`);
    assert(!!cRow && cRow.userId !== bridgeUser.id, "SYM_C row is NOT attributed to bridge user #1 (no cross-attribution)");
    assert(!!cRow && cRow.bridgeConnectionId !== conn.id, "SYM_C row is NOT attributed to bridge #1's connection");
    // The SYM_C filter must not leak any of bridge user #1's symbols.
    const cSymbols = new Set((cCov?.rows ?? []).map((r) => r.symbol));
    assert(cSymbols.size === 1 && cSymbols.has(SYM_C), "SYM_C filter returns ONLY SYM_C (no bridge #1 symbols)");
    assert(!cSymbols.has(SYM_A) && !cSymbols.has(SYM_B), "SYM_C filter never returns bridge user #1's SYM_A/SYM_B");

    // ── ?symbol= FILTER NARROWS ───────────────────────────────────────────────
    const all = await getCoverage(base, adminCookie);
    const allRows = all.body.coverage?.rows ?? [];
    const allSymbols = new Set(allRows.map((r) => r.symbol));
    assert(allSymbols.has(SYM_A) && allSymbols.has(SYM_B), "unfiltered coverage contains BOTH bridge #1 symbols");
    assert(allSymbols.has(SYM_C), "unfiltered coverage also contains bridge #2's symbol (operator-wide aggregate)");
    // The SYM_A filter must return ONLY SYM_A (no SYM_B leak) and fewer-or-equal rows.
    const aSymbols = new Set((aCov?.rows ?? []).map((r) => r.symbol));
    assert(aSymbols.size === 1 && aSymbols.has(SYM_A), "SYM_A filter returns ONLY SYM_A (no other symbols)");
    assert((aCov?.rows.length ?? 0) < allRows.length, `SYM_A filter narrows the row set (filtered ${aCov?.rows.length} < unfiltered ${allRows.length})`);

    // ── No cross-attribution in the FULL (unfiltered) aggregate ───────────────
    // Each seeded symbol, wherever it appears in the operator-wide list, must
    // carry its own owner — a wrong-key scope/join would surface here too.
    const ownerBySymbol = new Map<string, { userId: number; bridgeConnectionId: number }>();
    for (const r of allRows) {
      if (r.symbol === SYM_A || r.symbol === SYM_B || r.symbol === SYM_C) {
        ownerBySymbol.set(r.symbol, { userId: r.userId, bridgeConnectionId: r.bridgeConnectionId });
      }
    }
    assert(
      ownerBySymbol.get(SYM_A)?.userId === bridgeUser.id &&
        ownerBySymbol.get(SYM_A)?.bridgeConnectionId === conn.id,
      "unfiltered: SYM_A attributed to bridge user #1",
    );
    assert(
      ownerBySymbol.get(SYM_B)?.userId === bridgeUser.id &&
        ownerBySymbol.get(SYM_B)?.bridgeConnectionId === conn.id,
      "unfiltered: SYM_B attributed to bridge user #1",
    );
    assert(
      ownerBySymbol.get(SYM_C)?.userId === bridgeUser2.id &&
        ownerBySymbol.get(SYM_C)?.bridgeConnectionId === conn2.id,
      "unfiltered: SYM_C attributed to bridge user #2 (no cross-attribution)",
    );
  } finally {
    await cleanup();
  }

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "brokerCandleCoverageRouteTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    async (err) => {
      await cleanup().catch(() => {});
      // eslint-disable-next-line no-console
      console.error("[brokerCandleCoverageRouteTest] FAILED:", err);
      process.exit(1);
    },
  );
}
