// brokerCandleIngestTest — Phase A verification of the broker-native candle
// store, the closed-bar finalization rule, the backfill state machine, and the
// EA-facing batch ingest endpoint:
//   POST /api/mt5/candles/ingest   (artifacts/api-server/src/routes/mt5.ts)
//   service: artifacts/api-server/src/lib/data/brokerCandleStore.ts
//   schema:  lib/db/src/schema/brokerCandles.ts
//            lib/db/src/schema/brokerCandleBackfillStatus.ts
//
// WHAT IT PROVES
//   Pure unit (no HTTP):
//     - normalizeBrokerTimeframe maps aliases to the full 21 MT5 tfs; rejects M7/bare-12
//     - computeBackfillStatus covers every branch
//       (ERROR / NOT_STARTED / COMPLETE / BROKER_LIMITED / BUILDING / PARTIAL)
//   Endpoint (in-process app harness):
//     Auth (bridgeAuthPerUserOnly):
//       - missing token -> 401 ; garbage token -> 401 ; valid token -> 200
//     Payload validation (zod): empty symbol / empty timeframe -> 400
//     Pinned enum: a truly-unknown timeframe (M7) -> note unsupported_timeframe,
//       acceptedBars 0, rejectedBars all; the full 21 MT5 set (incl
//       M2/M30/H2/H12/W1/MN1) is accepted and stored
//     Bar validation: valid closed bars accepted; impossible OHLC rejected
//     De-dupe: same openTime twice in one batch -> 1 accepted
//     Closed-bar finalization (single openTime sequence):
//       forming -> forming(update) -> closed(finalize) -> closed-same(idempotent)
//       -> closed-different(REJECT) -> forming(REJECT, regression)
//     Stale transport: far-past sentAt -> note stale_push_timestamp, stored 0
//     Invalid transport: unparsable sentAt -> note invalid_push_timestamp, 0
//     Response contract: latestStoredBySymbolTimeframe + nextBackfillHints present
//     Durable store: broker_candles rows + a backfill_status row really persist
//
// SHARED-DB SAFETY
//   broker_candles / broker_candle_backfill_status are NEW market-data telemetry
//   tables (not safety evidence). We seed one isolated isSystemUser + one
//   mt5_connection (hashed token) and clean EVERYTHING in a `finally`, scoped by
//   the seeded bridge/user and a unique synthetic symbol. Never places a trade,
//   never inserts an arx_live_command, never reaches a real EA.
//
// Run: pnpm --filter @workspace/scripts run test:broker-candle-ingest

import { randomBytes, createHash } from "node:crypto";
import { eq, inArray, like, and } from "drizzle-orm";
import {
  db,
  usersTable,
  authUserSessionsTable,
  mt5ConnectionTable,
  brokerCandlesTable,
  brokerCandleBackfillStatusTable,
  marketCandlesTable,
} from "@workspace/db";
import {
  normalizeBrokerTimeframe,
  computeBackfillStatus,
  CANDLE_INGEST_BODY_LIMIT_BYTES,
  MAX_BARS_PER_INGEST_BATCH,
} from "../../artifacts/api-server/src/lib/data/brokerCandleStore.js";
import { routeCandles } from "../../artifacts/api-server/src/lib/data/marketDataRouter.js";
import { __resetMt5ProviderStore } from "../../artifacts/api-server/src/lib/data/providers/mt5Provider.js";
import { getSharedBaseUrl, isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

const EMAIL_PREFIX = "qa+broker-candle-ingest";
const BRIDGE_EMAIL = `${EMAIL_PREFIX}-bridge@arx.test`;
const SYM = `QBC${randomBytes(2).toString("hex").toUpperCase()}`;
// A second synthetic symbol carrying FRESH durable history, to prove the router
// prefers broker-native bars over fallback providers when fresh + sufficient.
const SYM_FRESH = `QBF${randomBytes(2).toString("hex").toUpperCase()}`;
// A third synthetic symbol carrying one closed bar per NEW (Task #484) timeframe,
// proving the extended 21-value enum ingests + persists end-to-end.
const SYM_TFS = `QBT${randomBytes(2).toString("hex").toUpperCase()}`;
// A fourth synthetic symbol carrying a worst-case max-size (5000-bar) batch,
// proving the route body limit (Task #500) accepts a full legitimate batch
// instead of bouncing it at the parser with 413.
const SYM_BIG = `QBG${randomBytes(2).toString("hex").toUpperCase()}`;

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

async function seededUserIds(): Promise<number[]> {
  const users = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(like(usersTable.email, `${EMAIL_PREFIX}%`));
  return users.map((u) => u.id);
}

async function cleanup(): Promise<void> {
  const ids = await seededUserIds();
  if (ids.length > 0) {
    await db.delete(brokerCandlesTable).where(inArray(brokerCandlesTable.userId, ids));
    await db
      .delete(brokerCandleBackfillStatusTable)
      .where(inArray(brokerCandleBackfillStatusTable.userId, ids));
    await db.delete(mt5ConnectionTable).where(inArray(mt5ConnectionTable.userId, ids));
    await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, ids));
    await db.delete(usersTable).where(inArray(usersTable.id, ids));
  }
  // The synthetic symbols are unique to this run; clear their mirrored cache rows.
  await db.delete(marketCandlesTable).where(inArray(marketCandlesTable.symbol, [SYM, SYM_FRESH, SYM_TFS, SYM_BIG]));
}

type IngestResult = {
  ok?: boolean;
  acceptedBars?: number;
  rejectedBars?: number;
  note?: string;
  latestStoredBySymbolTimeframe?: Array<{
    symbol: string;
    timeframe: string;
    latestOpenTimeUtc: string | null;
    barsStored: number;
  }>;
  nextBackfillHints?: Array<{ status: string; suggestedEndTimeUtc: string | null; reason: string }>;
  error?: string;
};

async function ingest(
  base: string,
  token: string | null,
  body: unknown,
): Promise<{ status: number; body: IngestResult }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["X-MT5-Bridge-Token"] = token;
  const r = await fetch(`${base}/api/mt5/candles/ingest`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  let parsed: IngestResult = {};
  try {
    parsed = (await r.json()) as IngestResult;
  } catch {
    parsed = {};
  }
  return { status: r.status, body: parsed };
}

function bar(
  openTime: string,
  o: number,
  h: number,
  l: number,
  c: number,
  isClosed?: boolean,
) {
  return { openTime, open: o, high: h, low: l, close: c, tickVolume: 100, ...(isClosed != null ? { isClosed } : {}) };
}

function runUnit(): void {
  // ── normalizeBrokerTimeframe ────────────────────────────────────────────────
  assert(normalizeBrokerTimeframe("M5") === "M5", "normalize M5 -> M5");
  assert(normalizeBrokerTimeframe("5m") === "M5", "normalize 5m -> M5");
  assert(normalizeBrokerTimeframe("15") === "M15", "normalize 15 -> M15");
  assert(normalizeBrokerTimeframe("1h") === "H1", "normalize 1h -> H1");
  assert(normalizeBrokerTimeframe("240") === "H4", "normalize 240 -> H4");
  assert(normalizeBrokerTimeframe("daily") === "D1", "normalize daily -> D1");
  // Task #484 — the full 21 MT5 set is now pinned, so the previously-"unsupported"
  // mid buckets normalize to their canonical id instead of null.
  assert(normalizeBrokerTimeframe("M30") === "M30", "normalize M30 -> M30 (now pinned)");
  assert(normalizeBrokerTimeframe("M2") === "M2", "normalize M2 -> M2 (now pinned)");
  assert(normalizeBrokerTimeframe("30m") === "M30", "normalize 30m -> M30");
  assert(normalizeBrokerTimeframe("120") === "H2", "normalize 120 -> H2");
  assert(normalizeBrokerTimeframe("12h") === "H12", "normalize 12h -> H12");
  assert(normalizeBrokerTimeframe("1w") === "W1", "normalize 1w -> W1");
  assert(normalizeBrokerTimeframe("weekly") === "W1", "normalize weekly -> W1");
  // "1m" (one minute) vs "1M" (one month) stays a case-sensitive split.
  assert(normalizeBrokerTimeframe("1m") === "M1", "normalize 1m -> M1 (minute)");
  assert(normalizeBrokerTimeframe("1M") === "MN1", "normalize 1M -> MN1 (month)");
  assert(normalizeBrokerTimeframe("1mo") === "MN1", "normalize 1mo -> MN1");
  assert(normalizeBrokerTimeframe("monthly") === "MN1", "normalize monthly -> MN1");
  // A truly-unknown timeframe and an ambiguous bare number are still rejected.
  assert(normalizeBrokerTimeframe("M7") === null, "normalize M7 -> null (not a real MT5 tf)");
  assert(normalizeBrokerTimeframe("12") === null, "normalize bare 12 -> null (ambiguous)");
  assert(normalizeBrokerTimeframe("") === null, "normalize empty -> null");

  // ── computeBackfillStatus — every branch ────────────────────────────────────
  const now = Date.UTC(2026, 5, 10, 12, 0, 0);
  const day = 24 * 60 * 60_000;
  assert(
    computeBackfillStatus({ barsStored: 5, oldestStoredAt: null, newestStoredAt: null, targetDays: 365, lastIngestAt: new Date(now), hadError: true, now }).status === "ERROR",
    "backfill ERROR when hadError",
  );
  assert(
    computeBackfillStatus({ barsStored: 0, oldestStoredAt: null, newestStoredAt: null, targetDays: 365, lastIngestAt: null, now }).status === "NOT_STARTED",
    "backfill NOT_STARTED when no bars",
  );
  assert(
    computeBackfillStatus({ barsStored: 100, oldestStoredAt: new Date(now - 400 * day), newestStoredAt: new Date(now), targetDays: 365, lastIngestAt: new Date(now), now }).status === "COMPLETE",
    "backfill COMPLETE when coverage >= target",
  );
  assert(
    computeBackfillStatus({ barsStored: 100, oldestStoredAt: new Date(now - 10 * day), newestStoredAt: new Date(now), targetDays: 365, lastIngestAt: new Date(now), brokerLimited: true, now }).status === "BROKER_LIMITED",
    "backfill BROKER_LIMITED when broker has no older bars",
  );
  assert(
    computeBackfillStatus({ barsStored: 100, oldestStoredAt: new Date(now - 10 * day), newestStoredAt: new Date(now), targetDays: 365, lastIngestAt: new Date(now), now }).status === "BUILDING",
    "backfill BUILDING when recent ingest + target unmet",
  );
  assert(
    computeBackfillStatus({ barsStored: 100, oldestStoredAt: new Date(now - 10 * day), newestStoredAt: new Date(now), targetDays: 365, lastIngestAt: new Date(now - 60 * 60_000), now }).status === "PARTIAL",
    "backfill PARTIAL when stale ingest + target unmet",
  );
}

export async function run(): Promise<CiTestResultLike> {
  passes = 0;
  failures = 0;
  // eslint-disable-next-line no-console
  console.log("brokerCandleIngestTest");
  // eslint-disable-next-line no-console
  console.log("======================\n");

  runUnit();

  await cleanup();
  const base = await getSharedBaseUrl();

  try {
    const [bridgeUser] = await db
      .insert(usersTable)
      .values({ email: BRIDGE_EMAIL, name: "QA Broker Candle Bridge", role: "USER", isSystemUser: true })
      .returning();
    if (!bridgeUser) throw new Error("user creation failed");

    const rawToken = randomBytes(24).toString("base64url");
    const [conn] = await db
      .insert(mt5ConnectionTable)
      .values({
        userId: bridgeUser.id,
        connectionName: "QA Broker Candle Bridge",
        status: "connected",
        apiKeyHash: sha256(rawToken),
        tokenLast4: rawToken.slice(-4),
        tokenCreatedAt: new Date(),
        accountNumber: "9999001",
      })
      .returning();
    if (!conn) throw new Error("connection creation failed");

    // Fixed, well-past bar instants so derived finalization is unambiguous.
    const T0 = "2026-06-07T08:00:00Z";
    const T1 = "2026-06-07T08:05:00Z";
    const T2 = "2026-06-07T08:10:00Z";

    // ── AUTH ──────────────────────────────────────────────────────────────────
    const noTok = await ingest(base, null, { symbol: SYM, timeframe: "M5", bars: [bar(T0, 1.1, 1.12, 1.09, 1.11, true)] });
    assert(noTok.status === 401, `missing bridge token -> 401 (got ${noTok.status})`);
    const badTok = await ingest(base, "not-a-real-token", { symbol: SYM, timeframe: "M5", bars: [bar(T0, 1.1, 1.12, 1.09, 1.11, true)] });
    assert(badTok.status === 401, `garbage bridge token -> 401 (got ${badTok.status})`);

    // ── PAYLOAD VALIDATION ──────────────────────────────────────────────────────
    const emptySym = await ingest(base, rawToken, { symbol: "", timeframe: "M5", bars: [bar(T0, 1.1, 1.12, 1.09, 1.11, true)] });
    assert(emptySym.status === 400, `empty symbol -> 400 (got ${emptySym.status})`);
    const emptyTf = await ingest(base, rawToken, { symbol: SYM, timeframe: "", bars: [bar(T0, 1.1, 1.12, 1.09, 1.11, true)] });
    assert(emptyTf.status === 400, `empty timeframe -> 400 (got ${emptyTf.status})`);

    // ── PINNED ENUM: a truly-unknown timeframe is still rejected at ingest ───────
    // M7 is not a real MT5 timeframe (and not an alias), so it must be refused even
    // though the accepted set grew to the full 21 in Task #484.
    const m7 = await ingest(base, rawToken, { symbol: SYM, timeframe: "M7", bars: [bar(T0, 1.1, 1.12, 1.09, 1.11, true)] });
    assert(m7.status === 200, `M7 push -> 200 telemetry (got ${m7.status})`);
    assert(m7.body.note === "unsupported_timeframe", `M7 note=unsupported_timeframe (got ${m7.body.note})`);
    assert(m7.body.acceptedBars === 0 && m7.body.rejectedBars === 1, `M7 accepted 0 / rejected 1 (got ${m7.body.acceptedBars}/${m7.body.rejectedBars})`);

    // ── FULL 21 MT5 ENUM ACCEPTANCE (Task #484) ─────────────────────────────────
    // The enum extension must flow end-to-end: previously-"unsupported" mid buckets
    // (and the W1/MN1 coarse bars) now ingest + persist. One closed bar each, on a
    // dedicated symbol so it never perturbs the SYM mirror/count assertions below.
    const newTfs: Array<[string, string]> = [
      ["M2", "2026-06-07T08:00:00Z"],
      ["M30", "2026-06-07T08:00:00Z"],
      ["H2", "2026-06-07T08:00:00Z"],
      ["H12", "2026-06-07T00:00:00Z"],
      ["W1", "2026-06-01T00:00:00Z"],
      ["MN1", "2026-06-01T00:00:00Z"],
    ];
    for (const [tf, openIso] of newTfs) {
      const r = await ingest(base, rawToken, {
        symbol: SYM_TFS, timeframe: tf, brokerSymbol: SYM_TFS, eaVersion: "1.52",
        bars: [bar(openIso, 1.10, 1.12, 1.09, 1.11, true)],
      });
      assert(
        r.status === 200 && (r.body.acceptedBars ?? 0) === 1 && r.body.note !== "unsupported_timeframe",
        `${tf} closed bar accepted + stored (status=${r.status}, accepted=${r.body.acceptedBars}, note=${r.body.note ?? "none"})`,
      );
    }
    const tfRows = await db
      .select({ tf: brokerCandlesTable.timeframe })
      .from(brokerCandlesTable)
      .where(and(eq(brokerCandlesTable.bridgeConnectionId, conn.id), eq(brokerCandlesTable.brokerSymbol, SYM_TFS)));
    const storedTfs = new Set(tfRows.map((row) => row.tf));
    for (const [tf] of newTfs) {
      assert(storedTfs.has(tf), `broker_candles holds a ${tf} row for the extended-enum series`);
    }

    // ── MAX-SIZE BATCH (Task #500) — 5000 bars must NOT 413 at the parser ───────
    // The route body limit must comfortably fit the worst legitimate batch:
    // MAX_BARS_PER_INGEST_BATCH bars at the FULL barSchema shape (every optional
    // field present, maximizing serialized size). Build a real such batch, assert
    // the configured limit stays >= its measured byte size (so the limit can
    // never silently regress below the legitimate maximum), then POST it and
    // assert it is ACCEPTED (200, not 413) and every bar stores.
    function maxBar(openMs: number) {
      const openIso = new Date(openMs).toISOString();
      const closeIso = new Date(openMs + 5 * 60_000).toISOString();
      return {
        openTime: openIso,
        time: openIso,
        closeTime: closeIso,
        open: 1.123456,
        high: 1.125678,
        low: 1.120012,
        close: 1.124567,
        tickVolume: 1234567,
        realVolume: 1234567,
        volume: 1234567,
        spread: 123,
        isClosed: true,
        isFinal: true,
      };
    }
    const bigBaseMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const bigBars = [];
    for (let i = 0; i < MAX_BARS_PER_INGEST_BATCH; i++) {
      bigBars.push(maxBar(bigBaseMs + i * 5 * 60_000));
    }
    const bigBody = { symbol: SYM_BIG, timeframe: "M5", brokerSymbol: SYM_BIG, eaVersion: "1.52", bars: bigBars };
    const measuredBytes = Buffer.byteLength(JSON.stringify(bigBody), "utf8");
    assert(
      CANDLE_INGEST_BODY_LIMIT_BYTES >= measuredBytes,
      `configured ingest body limit (${CANDLE_INGEST_BODY_LIMIT_BYTES}) >= measured ${MAX_BARS_PER_INGEST_BATCH}-bar batch (${measuredBytes})`,
    );
    // The batch is also intentionally larger than the conservative ~100kb global
    // express.json() default — so without the dedicated route limit this POST
    // would 413 at the parser. Proves the fix is load-bearing.
    assert(measuredBytes > 100 * 1024, `max batch (${measuredBytes}B) exceeds the 100kb global default it used to be bounced by`);
    const big = await ingest(base, rawToken, bigBody);
    assert(big.status === 200, `5000-bar batch accepted, NOT 413 (got ${big.status})`);
    assert((big.body.acceptedBars ?? 0) === MAX_BARS_PER_INGEST_BATCH, `all ${MAX_BARS_PER_INGEST_BATCH} bars accepted (got ${big.body.acceptedBars})`);

    // ── BAR VALIDATION + DE-DUPE (one batch) ────────────────────────────────────
    const mixed = await ingest(base, rawToken, {
      symbol: SYM, timeframe: "M5", brokerSymbol: SYM, eaVersion: "1.50",
      bars: [
        bar(T0, 1.10, 1.12, 1.09, 1.11, true), // valid closed
        bar(T1, 1.11, 1.13, 1.10, 1.12, true), // valid closed
        bar(T1, 1.11, 1.13, 1.10, 1.12, true), // DUP openTime -> de-dupe
        bar(T2, 1.12, 1.05, 1.20, 1.13, true), // INVALID high<low
      ],
    });
    assert(mixed.status === 200, `mixed push -> 200 (got ${mixed.status})`);
    assert(mixed.body.acceptedBars === 2, `2 valid distinct bars accepted (got ${mixed.body.acceptedBars})`);
    assert((mixed.body.rejectedBars ?? 0) >= 1, `impossible OHLC rejected (got ${mixed.body.rejectedBars})`);
    assert(
      !!mixed.body.latestStoredBySymbolTimeframe?.[0] && mixed.body.latestStoredBySymbolTimeframe[0].barsStored === 2,
      `latestStoredBySymbolTimeframe reports 2 stored (got ${mixed.body.latestStoredBySymbolTimeframe?.[0]?.barsStored})`,
    );
    assert(
      !!mixed.body.nextBackfillHints?.[0] && typeof mixed.body.nextBackfillHints[0].status === "string",
      "nextBackfillHints present with a status",
    );

    // ── CLOSED-BAR FINALIZATION (single openTime TF sequence) ───────────────────
    const TF = "2026-06-07T07:00:00Z";
    const f1 = await ingest(base, rawToken, { symbol: SYM, timeframe: "M5", bars: [bar(TF, 2.00, 2.05, 1.99, 2.01, false)] });
    assert(f1.body.acceptedBars === 1, `forming bar accepted (got ${f1.body.acceptedBars})`);
    const f2 = await ingest(base, rawToken, { symbol: SYM, timeframe: "M5", bars: [bar(TF, 2.00, 2.06, 1.99, 2.03, false)] });
    assert(f2.body.acceptedBars === 1, `forming update accepted in place (got ${f2.body.acceptedBars})`);
    const f3 = await ingest(base, rawToken, { symbol: SYM, timeframe: "M5", bars: [bar(TF, 2.00, 2.07, 1.98, 2.04, true)] });
    assert(f3.body.acceptedBars === 1, `forming -> closed finalize accepted (got ${f3.body.acceptedBars})`);
    const f4 = await ingest(base, rawToken, { symbol: SYM, timeframe: "M5", bars: [bar(TF, 2.00, 2.07, 1.98, 2.04, true)] });
    assert(f4.body.acceptedBars === 1 && (f4.body.rejectedBars ?? 0) === 0, `identical closed bar idempotently accepted (got ${f4.body.acceptedBars}/${f4.body.rejectedBars})`);
    const f5 = await ingest(base, rawToken, { symbol: SYM, timeframe: "M5", bars: [bar(TF, 2.00, 2.10, 1.95, 2.08, true)] });
    assert(f5.body.acceptedBars === 0 && f5.body.rejectedBars === 1, `conflicting closed bar REJECTED (got ${f5.body.acceptedBars}/${f5.body.rejectedBars})`);
    const f6 = await ingest(base, rawToken, { symbol: SYM, timeframe: "M5", bars: [bar(TF, 2.00, 2.06, 1.99, 2.03, false)] });
    assert(f6.body.acceptedBars === 0 && f6.body.rejectedBars === 1, `forming-after-closed REJECTED as regression (got ${f6.body.acceptedBars}/${f6.body.rejectedBars})`);

    // ── STALE / INVALID TRANSPORT GUARD ─────────────────────────────────────────
    const stale = await ingest(base, rawToken, {
      symbol: SYM, timeframe: "M5",
      sentAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      bars: [bar("2026-06-07T09:00:00Z", 1.40, 1.42, 1.39, 1.41, true)],
    });
    assert(stale.status === 200 && stale.body.note === "stale_push_timestamp" && stale.body.acceptedBars === 0, `stale sentAt refused (note=${stale.body.note}, accepted=${stale.body.acceptedBars})`);
    const invalid = await ingest(base, rawToken, {
      symbol: SYM, timeframe: "M5",
      sentAt: "not-a-timestamp",
      bars: [bar("2026-06-07T09:05:00Z", 1.41, 1.43, 1.40, 1.42, true)],
    });
    assert(invalid.status === 200 && invalid.body.note === "invalid_push_timestamp" && invalid.body.acceptedBars === 0, `invalid sentAt fails closed (note=${invalid.body.note}, accepted=${invalid.body.acceptedBars})`);

    // ── DURABLE STORE: rows + backfill status really persist ─────────────────────
    const stored = await db
      .select({ id: brokerCandlesTable.id })
      .from(brokerCandlesTable)
      .where(
        and(
          eq(brokerCandlesTable.bridgeConnectionId, conn.id),
          eq(brokerCandlesTable.brokerSymbol, SYM),
          eq(brokerCandlesTable.timeframe, "M5"),
        ),
      );
    // T0, T1 (closed) + TF (finalized) = 3 durable rows.
    assert(stored.length === 3, `broker_candles persisted 3 rows for the series (got ${stored.length})`);

    const bf = await db
      .select({ status: brokerCandleBackfillStatusTable.status, barsStored: brokerCandleBackfillStatusTable.barsStored })
      .from(brokerCandleBackfillStatusTable)
      .where(
        and(
          eq(brokerCandleBackfillStatusTable.bridgeConnectionId, conn.id),
          eq(brokerCandleBackfillStatusTable.brokerSymbol, SYM),
          eq(brokerCandleBackfillStatusTable.timeframe, "M5"),
        ),
      );
    assert(bf.length === 1, `one backfill_status row for the series (got ${bf.length})`);
    assert(!!bf[0] && bf[0].barsStored === 3, `backfill_status barsStored=3 (got ${bf[0]?.barsStored})`);

    // Mirror: accepted closed bars reached the read-path cache (mt5_broker slot).
    const mirrored = await db
      .select({ id: marketCandlesTable.id })
      .from(marketCandlesTable)
      .where(and(eq(marketCandlesTable.symbol, SYM), eq(marketCandlesTable.source, "mt5_broker")));
    assert(mirrored.length === 3, `accepted closed bars mirrored to market_candles mt5_broker slot (got ${mirrored.length})`);

    // ── DURABLE-READ PREFERENCE (Task #470) ─────────────────────────────────────
    // The router must prefer fresh + sufficient durable broker history over the
    // fallback providers, and fall through HONESTLY when the durable series is
    // stale. The in-memory provider is empty here (the batch ingest never feeds
    // it), but reset it explicitly so the durable path is unambiguous.
    __resetMt5ProviderStore();

    // FRESH case: ingest >= 30 fresh closed M5 bars ending at the most recent
    // completed 5-min boundary, then route through the chart read path.
    const FIVE_MIN = 5 * 60_000;
    const newestBucket = Math.floor(Date.now() / FIVE_MIN) * FIVE_MIN - FIVE_MIN;
    const FRESH_COUNT = 35;
    const freshBars = [];
    for (let i = FRESH_COUNT - 1; i >= 0; i--) {
      const openMs = newestBucket - i * FIVE_MIN;
      const iso = new Date(openMs).toISOString();
      freshBars.push(bar(iso, 1.10, 1.12, 1.09, 1.11, true));
    }
    const freshIngest = await ingest(base, rawToken, {
      symbol: SYM_FRESH, timeframe: "M5", brokerSymbol: SYM_FRESH, eaVersion: "1.50", bars: freshBars,
    });
    assert(freshIngest.status === 200 && (freshIngest.body.acceptedBars ?? 0) === FRESH_COUNT,
      `fresh series ingested ${FRESH_COUNT} bars (got ${freshIngest.body.acceptedBars})`);

    __resetMt5ProviderStore();
    const freshRoute = await routeCandles(SYM_FRESH, "M5", 100);
    assert(freshRoute.primaryProvider === "mt5_broker",
      `router prefers durable broker history when fresh+sufficient (got ${freshRoute.primaryProvider})`);
    assert(freshRoute.ok && freshRoute.candles.length >= 30,
      `durable broker serve returns the stored bars (ok=${freshRoute.ok}, n=${freshRoute.candles.length})`);

    // STALE case: SYM only has 2026-06-07 M5 bars (days old). The durable read
    // must REJECT them as stale and the mt5_broker attempt must say so, so the
    // router falls through instead of serving a stale broker series as live.
    __resetMt5ProviderStore();
    const staleRoute = await routeCandles(SYM, "M5", 100);
    const staleMt5Attempt = staleRoute.attempts.find((a) => a.provider === "mt5_broker");
    assert(staleRoute.primaryProvider !== "mt5_broker",
      `router does NOT prefer a stale durable broker series (primary=${staleRoute.primaryProvider})`);
    assert(!!staleMt5Attempt && staleMt5Attempt.reason === "MT5_BROKER_HISTORY_STALE",
      `stale durable series surfaces MT5_BROKER_HISTORY_STALE (got ${staleMt5Attempt?.reason})`);
  } finally {
    await cleanup();
  }

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "brokerCandleIngestTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    async (err) => {
      await cleanup().catch(() => {});
      // eslint-disable-next-line no-console
      console.error("[brokerCandleIngestTest] FAILED:", err);
      process.exit(1);
    },
  );
}
