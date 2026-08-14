// mt5SyncCandlesEndpointTest — endpoint-level verification of the EA candle
// ingestion contract: POST /api/mt5/sync-candles (handler in
// artifacts/api-server/src/routes/mt5.ts) and the admin feed-status readout
// GET /api/admin/market-data/mt5-feed (adminMarketDataDiagnostics.ts).
//
// Task #316 ("get the app ready for real EA candle data — no fake candles")
// added strict OHLC validation, a feed-contribution status model
// (contributing / stale / non-contributing / unavailable) and an admin
// visibility endpoint. The original change only had provider-unit coverage;
// this test exercises the REAL HTTP route end-to-end through the in-process
// app harness so the wire contract is pinned.
//
// WHAT IT PROVES
//   Auth (bridgeAuthPerUserOnly):
//     - missing X-MT5-Bridge-Token            -> 401
//     - garbage token (no matching connection)-> 401
//     - valid per-user token                  -> 200
//   Payload validation (zod):
//     - empty symbol / empty timeframe        -> 400
//   Bar-level validation (isValidOhlc) — accepted vs rejected counts:
//     - well-formed bars stored
//     - impossible OHLC (high<low, body break) rejected, not stored
//     - non-finite (NaN/Infinity arrive as zod failure or finite check) handled
//     - negative & zero prices rejected (initialised-to-zero EA buffer guard)
//   Normalization:
//     - ISO-string and numeric-epoch-ms timestamps both normalize to ISO
//     - de-dupe by timestamp (last write wins) — same ts twice => 1 stored
//   Series keying:
//     - the SAME symbol under two timeframes (M5 vs H1) is isolated; an M5
//       push is never served under H1 (verified via the admin feed readout)
//   No-valid-bars safety:
//     - an all-garbage push returns stored:0 and does NOT clear a prior good
//       series (the existing M5 series stays contributing)
//   Admin feed readout:
//     - normal USER -> 403, ADMIN -> 200
//     - feedActive reflects provider connectivity (true after a fresh push)
//     - a freshly pushed series reads "contributing"
//     - a single-series probe for a never-pushed symbol reads "non-contributing"
//       while the feed is connected
//
// SHARED-DB SAFETY
//   The candle store is in-process memory (not a DB table), so pushes here do
//   not touch persistent evidence. We seed only an isolated isSystemUser +
//   one mt5_connection (hashed token) + sessions, and clean everything in a
//   `finally`. Never places a trade, never inserts an arx_live_command, never
//   reaches a real EA. Uses a unique symbol prefix so it cannot collide with
//   any real pushed series.
//
// Run: pnpm --filter @workspace/scripts run test:mt5-sync-candles-endpoint

import { randomBytes, createHash } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { db, usersTable, authUserSessionsTable, mt5ConnectionTable } from "@workspace/db";
import { getSharedBaseUrl, isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

const EMAIL_PREFIX = "qa+mt5-sync-candles";
const BRIDGE_EMAIL = `${EMAIL_PREFIX}-bridge@arx.test`;
const ADMIN_EMAIL = `${EMAIL_PREFIX}-admin@arx.test`;
const USER_EMAIL = `${EMAIL_PREFIX}-user@arx.test`;
const SESSION_TTL_MS = 15 * 60 * 1000;
const SESSION_COOKIE = "arx_user_session";

// Unique synthetic symbol so this run can never collide with a real pushed
// series in the shared in-process store.
const SYM = `QAX${randomBytes(2).toString("hex").toUpperCase()}`;

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
    userAgent: "qa-mt5-sync-candles-endpoint",
  });
  return raw;
}

async function cleanup(): Promise<void> {
  const users = await db.select({ id: usersTable.id }).from(usersTable)
    .where(like(usersTable.email, `${EMAIL_PREFIX}%`));
  const ids = users.map((u) => u.id);
  if (ids.length > 0) {
    await db.delete(mt5ConnectionTable).where(inArray(mt5ConnectionTable.userId, ids));
    await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, ids));
    await db.delete(usersTable).where(inArray(usersTable.id, ids));
  }
}

type SyncResult = { received?: boolean; stored?: number; accepted?: number; rejected?: number; note?: string; error?: string };

async function syncCandles(
  base: string,
  token: string | null,
  body: unknown,
): Promise<{ status: number; body: SyncResult }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["X-MT5-Bridge-Token"] = token;
  const r = await fetch(`${base}/api/mt5/sync-candles`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  let parsed: SyncResult = {};
  try { parsed = (await r.json()) as SyncResult; } catch { parsed = {}; }
  return { status: r.status, body: parsed };
}

async function syncQuotes(
  base: string,
  token: string | null,
  body: unknown,
): Promise<{ status: number; body: SyncResult }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["X-MT5-Bridge-Token"] = token;
  const r = await fetch(`${base}/api/mt5/sync-quotes`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  let parsed: SyncResult = {};
  try { parsed = (await r.json()) as SyncResult; } catch { parsed = {}; }
  return { status: r.status, body: parsed };
}

type FeedSeries = { symbol: string; timeframe: string; status: string; barCount: number };
type FeedBody = {
  ok?: boolean;
  feedActive?: boolean;
  providerConnected?: boolean;
  summary?: { totalSeries: number; contributing: number; stale: number; nonContributing: number; unavailable: number };
  series?: FeedSeries[];
};

async function getFeed(
  base: string,
  cookie: string | null,
  symbol?: string,
  timeframe?: string,
): Promise<{ status: number; body: FeedBody }> {
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = `${SESSION_COOKIE}=${cookie}`;
  const qs = symbol && timeframe ? `?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}` : "";
  const r = await fetch(`${base}/api/admin/market-data/mt5-feed${qs}`, { headers });
  let body: FeedBody = {};
  try { body = (await r.json()) as FeedBody; } catch { body = {}; }
  return { status: r.status, body };
}

function bar(time: string | number, o: number, h: number, l: number, c: number, vol = 100) {
  return { time, open: o, high: h, low: l, close: c, tickVolume: vol };
}

export async function run(): Promise<CiTestResultLike> {
  passes = 0;
  failures = 0;
  // eslint-disable-next-line no-console
  console.log("mt5SyncCandlesEndpointTest");
  // eslint-disable-next-line no-console
  console.log("=========================\n");

  await cleanup();
  const base = await getSharedBaseUrl();

  try {
    // ── Seed: a bridge user with a hashed token + admin + normal user ───────
    const [bridgeUser] = await db.insert(usersTable).values({
      email: BRIDGE_EMAIL, name: "QA Candle Bridge", role: "USER", isSystemUser: true,
    }).returning();
    const [adminUser] = await db.insert(usersTable).values({
      email: ADMIN_EMAIL, name: "QA Candle Admin", role: "ADMIN", isSystemUser: true,
    }).returning();
    const [normalUser] = await db.insert(usersTable).values({
      email: USER_EMAIL, name: "QA Candle User", role: "USER", isSystemUser: true,
    }).returning();
    if (!bridgeUser || !adminUser || !normalUser) throw new Error("user creation failed");

    const rawToken = randomBytes(24).toString("base64url");
    await db.insert(mt5ConnectionTable).values({
      userId: bridgeUser.id,
      connectionName: "QA Candle Bridge",
      status: "connected",
      apiKeyHash: sha256(rawToken),
      tokenLast4: rawToken.slice(-4),
      tokenCreatedAt: new Date(),
    });

    const adminCookie = await mintSession(adminUser.id);
    const userCookie = await mintSession(normalUser.id);

    // ── AUTH ────────────────────────────────────────────────────────────────
    const noToken = await syncCandles(base, null, { symbol: SYM, timeframe: "M5", bars: [bar("2026-06-07T08:00:00Z", 1, 1.1, 0.9, 1.05)] });
    assert(noToken.status === 401, `missing bridge token -> 401 (got ${noToken.status})`);

    const badToken = await syncCandles(base, "not-a-real-token", { symbol: SYM, timeframe: "M5", bars: [bar("2026-06-07T08:00:00Z", 1, 1.1, 0.9, 1.05)] });
    assert(badToken.status === 401, `garbage bridge token -> 401 (got ${badToken.status})`);

    // ── PAYLOAD VALIDATION (zod) ──────────────────────────────────────────────
    const emptySym = await syncCandles(base, rawToken, { symbol: "", timeframe: "M5", bars: [bar("2026-06-07T08:00:00Z", 1, 1.1, 0.9, 1.05)] });
    assert(emptySym.status === 400, `empty symbol -> 400 (got ${emptySym.status})`);
    const emptyTf = await syncCandles(base, rawToken, { symbol: SYM, timeframe: "", bars: [bar("2026-06-07T08:00:00Z", 1, 1.1, 0.9, 1.05)] });
    assert(emptyTf.status === 400, `empty timeframe -> 400 (got ${emptyTf.status})`);

    // ── BAR VALIDATION: well-formed vs impossible OHLC ────────────────────────
    // 3 valid + 4 invalid (high<low, body-break high, negative price, zero price)
    const mixed = await syncCandles(base, rawToken, {
      symbol: SYM, timeframe: "M5", eaVersion: "1.50", priceBasis: "mid", lastBarIsFinal: true,
      bars: [
        bar("2026-06-07T08:00:00Z", 1.10, 1.12, 1.09, 1.11), // valid
        bar("2026-06-07T08:05:00Z", 1.11, 1.13, 1.10, 1.12), // valid
        bar("2026-06-07T08:10:00Z", 1.12, 1.14, 1.11, 1.13), // valid
        bar("2026-06-07T08:15:00Z", 1.12, 1.05, 1.20, 1.13), // INVALID high<low
        bar("2026-06-07T08:20:00Z", 1.12, 1.10, 1.09, 1.13), // INVALID high<close (body break)
        bar("2026-06-07T08:25:00Z", -1.0, 1.10, -1.2, 1.05), // INVALID negative price
        bar("2026-06-07T08:30:00Z", 0, 1.10, 0, 1.05),       // INVALID zero price
      ],
    });
    assert(mixed.status === 200, `valid push -> 200 (got ${mixed.status})`);
    assert(mixed.body.stored === 3, `3 valid bars stored (got ${mixed.body.stored})`);
    assert(mixed.body.rejected === 4, `4 impossible/negative/zero bars rejected (got ${mixed.body.rejected})`);

    // ── NORMALIZATION: numeric epoch-ms + ISO both accepted; de-dupe by ts ────
    const epochMs = Date.parse("2026-06-07T09:00:00Z");
    const dedupe = await syncCandles(base, rawToken, {
      symbol: SYM, timeframe: "M5",
      bars: [
        bar(epochMs, 1.20, 1.22, 1.19, 1.21),                 // numeric epoch ms
        bar("2026-06-07T09:00:00Z", 1.30, 1.33, 1.29, 1.31),  // SAME instant as ISO -> de-dupe
        bar("2026-06-07T09:05:00Z", 1.31, 1.34, 1.30, 1.32),  // distinct
      ],
    });
    assert(dedupe.status === 200, `dedupe push -> 200 (got ${dedupe.status})`);
    assert(
      dedupe.body.stored === 2,
      `numeric-ms and ISO of the same instant de-dupe to 1, plus 1 distinct = 2 stored (got ${dedupe.body.stored})`,
    );

    // ── SERIES KEYING: same symbol, different timeframe is isolated ───────────
    const h1 = await syncCandles(base, rawToken, {
      symbol: SYM, timeframe: "H1",
      bars: [bar("2026-06-07T08:00:00Z", 2.0, 2.1, 1.9, 2.05)],
    });
    assert(h1.status === 200 && h1.body.stored === 1, `H1 series for same symbol stored independently (got ${h1.body.stored})`);

    // ── ADMIN FEED READOUT ────────────────────────────────────────────────────
    const feedAsUser = await getFeed(base, userCookie);
    assert(feedAsUser.status === 403, `feed readout as normal USER -> 403 (got ${feedAsUser.status})`);

    const feed = await getFeed(base, adminCookie);
    assert(feed.status === 200 && feed.body.ok === true, `feed readout as ADMIN -> 200 (got ${feed.status})`);
    // We just pushed fresh candles, so the provider must report connected.
    assert(feed.body.feedActive === true, "feedActive=true after a fresh push (derives from provider connectivity)");
    assert(feed.body.providerConnected === true, "providerConnected=true exposed alongside feedActive");

    const m5 = (feed.body.series ?? []).find((s) => s.symbol === SYM && s.timeframe === "M5");
    const h1row = (feed.body.series ?? []).find((s) => s.symbol === SYM && s.timeframe === "H1");
    assert(!!m5 && m5.status === "contributing", `M5 series reads contributing (status=${m5?.status})`);
    // updateCandlesFromMT5 REPLACES the series each push (the EA sends a rolling
    // window), so the latest M5 push — the de-dupe push of 2 distinct bars —
    // defines the current series.
    assert(!!m5 && m5.barCount === 2, `M5 contributing barCount=2 (latest push replaces; got ${m5?.barCount})`);
    assert(!!h1row && h1row.status === "contributing" && h1row.barCount === 1, `H1 series isolated, barCount=1 (got ${h1row?.barCount})`);

    // Single-series probe for a never-pushed symbol while the feed is connected.
    const probe = await getFeed(base, adminCookie, `${SYM}NONE`, "M5");
    const probeRow = (probe.body.series ?? [])[0];
    assert(
      probe.status === 200 && !!probeRow && probeRow.status === "non-contributing",
      `never-pushed symbol probe reads non-contributing while feed connected (status=${probeRow?.status})`,
    );

    // ── NO-VALID-BARS SAFETY: must not clear the existing good M5 series ───────
    const garbage = await syncCandles(base, rawToken, {
      symbol: SYM, timeframe: "M5",
      bars: [
        bar("2026-06-07T10:00:00Z", -5, -1, -9, -3),     // negative
        bar("2026-06-07T10:05:00Z", 0, 0, 0, 0),         // zero
        bar("2026-06-07T10:10:00Z", 1.1, 1.0, 1.2, 1.1), // high<low
      ],
    });
    assert(garbage.status === 200, `all-garbage push -> 200 (got ${garbage.status})`);
    assert(garbage.body.stored === 0, `all-garbage push stored:0 (got ${garbage.body.stored})`);
    assert(garbage.body.rejected === 3, `all-garbage push rejected:3 (got ${garbage.body.rejected})`);
    assert(garbage.body.note === "no_valid_bars", `all-garbage push note=no_valid_bars (got ${garbage.body.note})`);

    const feedAfter = await getFeed(base, adminCookie);
    const m5After = (feedAfter.body.series ?? []).find((s) => s.symbol === SYM && s.timeframe === "M5");
    assert(
      !!m5After && m5After.status === "contributing" && m5After.barCount === 2,
      `prior good M5 series untouched after garbage push (status=${m5After?.status}, bars=${m5After?.barCount})`,
    );

    // ── STALE / INVALID PUSH-TIMESTAMP GUARD (candles) ────────────────────────
    // The guard keys off the transport `sentAt`, never per-bar age (backfill must
    // be allowed). A far-past sentAt = delayed/replayed payload -> refuse.
    const stalePush = await syncCandles(base, rawToken, {
      symbol: SYM, timeframe: "M5",
      sentAt: new Date(Date.now() - 30 * 60_000).toISOString(), // 30 min in the past
      bars: [bar("2026-06-07T11:00:00Z", 1.40, 1.42, 1.39, 1.41)],
    });
    assert(stalePush.status === 200, `stale-push -> 200 (got ${stalePush.status})`);
    assert(stalePush.body.note === "stale_push_timestamp", `stale-push note=stale_push_timestamp (got ${stalePush.body.note})`);
    assert(stalePush.body.stored === 0, `stale-push stores nothing (got ${stalePush.body.stored})`);

    // An UNPARSABLE sentAt must fail CLOSED with an explicit reject — never a 500
    // and never laundered into a receive-time stamp.
    const invalidPush = await syncCandles(base, rawToken, {
      symbol: SYM, timeframe: "M5",
      sentAt: "not-a-timestamp",
      bars: [bar("2026-06-07T11:05:00Z", 1.41, 1.43, 1.40, 1.42)],
    });
    assert(invalidPush.status === 200, `invalid-sentAt -> 200 not 500 (got ${invalidPush.status})`);
    assert(invalidPush.body.note === "invalid_push_timestamp", `invalid-sentAt note=invalid_push_timestamp (got ${invalidPush.body.note})`);
    assert(invalidPush.body.stored === 0, `invalid-sentAt stores nothing (got ${invalidPush.body.stored})`);

    // Prior good series still intact after both refused pushes.
    const feedAfterGuards = await getFeed(base, adminCookie);
    const m5Guarded = (feedAfterGuards.body.series ?? []).find((s) => s.symbol === SYM && s.timeframe === "M5");
    assert(
      !!m5Guarded && m5Guarded.status === "contributing" && m5Guarded.barCount === 2,
      `good M5 series survives stale+invalid pushes (status=${m5Guarded?.status}, bars=${m5Guarded?.barCount})`,
    );

    // ── QUOTE INGEST GUARDS (sync-quotes) ─────────────────────────────────────
    // Auth still required.
    const quoteNoToken = await syncQuotes(base, null, { symbol: SYM, bid: 1.10, ask: 1.11 });
    assert(quoteNoToken.status === 401, `quote missing token -> 401 (got ${quoteNoToken.status})`);

    // A well-formed fresh quote is accepted.
    const goodQuote = await syncQuotes(base, rawToken, {
      symbol: SYM, bid: 1.10, ask: 1.11, timestamp: new Date().toISOString(),
    });
    assert(goodQuote.status === 200, `fresh quote -> 200 (got ${goodQuote.status})`);
    assert(goodQuote.body.accepted === 1, `fresh quote accepted=1 (got ${goodQuote.body.accepted})`);

    // An UNPARSABLE quote timestamp must fail CLOSED (explicit reject, never 500).
    const invalidQuote = await syncQuotes(base, rawToken, {
      symbol: SYM, bid: 1.10, ask: 1.11, timestamp: "not-a-timestamp",
    });
    assert(invalidQuote.status === 200, `invalid quote ts -> 200 not 500 (got ${invalidQuote.status})`);
    assert(invalidQuote.body.note === "invalid_quote_timestamp", `invalid quote ts note=invalid_quote_timestamp (got ${invalidQuote.body.note})`);
    assert(invalidQuote.body.accepted === 0, `invalid quote ts accepted=0 (got ${invalidQuote.body.accepted})`);

    // A far-past quote timestamp is stale (a quote is point-in-time, unlike backfill).
    const staleQuote = await syncQuotes(base, rawToken, {
      symbol: SYM, bid: 1.10, ask: 1.11, timestamp: new Date(Date.now() - 30 * 60_000).toISOString(),
    });
    assert(staleQuote.status === 200, `stale quote -> 200 (got ${staleQuote.status})`);
    assert(staleQuote.body.note === "stale_quote_timestamp", `stale quote note=stale_quote_timestamp (got ${staleQuote.body.note})`);
    assert(staleQuote.body.accepted === 0, `stale quote accepted=0 (got ${staleQuote.body.accepted})`);
  } finally {
    await cleanup();
  }

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "mt5SyncCandlesEndpointTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    async (err) => {
      await cleanup().catch(() => {});
      // eslint-disable-next-line no-console
      console.error("[mt5SyncCandlesEndpointTest] FAILED:", err);
      process.exit(1);
    },
  );
}
