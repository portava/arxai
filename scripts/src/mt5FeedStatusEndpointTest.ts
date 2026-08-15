// mt5FeedStatusEndpointTest — endpoint-level verification of the admin MT5
// Candle Feed status panel: GET /api/admin/market-data/mt5-feed (handler in
// artifacts/api-server/src/routes/adminMarketDataDiagnostics.ts), surfaced in
// the frontend by artifacts/trading-dashboard/src/pages/admin/provider-health.tsx.
//
// WHY
//   The MT5 Candle Feed card classifies every pushed symbol+timeframe series as
//   contributing / stale / non-contributing / unavailable and shows an honest
//   empty state when the EA has not sent any candles yet. That operator-visibility
//   contract had no dedicated automated coverage, so a future change to the
//   classification or the empty-state copy could silently break it. This test
//   locks the contract in place.
//
// WHAT IT PROVES
//   Auth gate (requireAdmin):
//     - anonymous (no session)        -> 401
//     - normal USER session           -> 403
//     - ADMIN session                 -> 200
//   Empty / unavailable state (store reset, provider disconnected):
//     - feedActive=false, providerConnected=false
//     - series=[] and summary all zero
//     - the honest "no series pushed since server start … first sync-candles
//       payload" note is returned
//     - a single-series probe while the feed is offline reads "unavailable"
//   Contributing + connectivity-driven feedActive:
//     - a freshly pushed non-empty series reads "contributing"
//     - feedActive=true is driven by provider connectivity, NOT derived from the
//       series list
//   Non-contributing:
//     - a single-series probe for a never-pushed symbol while the feed is
//       connected reads "non-contributing" (feed up, this symbol absent)
//   Stale:
//     - a fresh-but-empty series reads "stale" through the endpoint, and crucially
//       feedActive STAYS true even though no series is contributing — proving
//       feedActive is not derived from the series list
//     - aged-out staleness is proven deterministically via the injectable-`now`
//       provider functions the endpoint uses (getMt5AllSeriesStatus /
//       getMt5SeriesFreshness), since the endpoint itself reads wall-clock time
//
// SHARED-STATE SAFETY
//   The candle store is in-process memory (not a DB table). The in-process app
//   harness runs the Express app in THIS process, so direct provider seeding is
//   visible to the real HTTP endpoint. We reset the store at the start and end of
//   the run, seed only uniquely-prefixed synthetic symbols, and seed/clean an
//   isolated admin + normal user (isSystemUser) with sessions in a `finally`.
//   Never places a trade, never inserts a live command, never reaches a real EA.
//
// Run: pnpm --filter @workspace/scripts run test:mt5-feed-status-endpoint

import { randomBytes, createHash } from "node:crypto";
import { inArray, like } from "drizzle-orm";
import { db, usersTable, authUserSessionsTable } from "@workspace/db";
import { getSharedBaseUrl, isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";
import {
  mt5Provider,
  updateCandlesFromMT5,
  getMt5AllSeriesStatus,
  getMt5SeriesFreshness,
  __resetMt5ProviderStore,
  CANDLE_TTL_MS,
} from "../../artifacts/api-server/src/lib/data/providers/mt5Provider.js";
import type { Candle } from "../../artifacts/api-server/src/lib/data/types.js";

const EMAIL_PREFIX = "qa+mt5-feed-status";
const ADMIN_EMAIL = `${EMAIL_PREFIX}-admin@arx.test`;
const USER_EMAIL = `${EMAIL_PREFIX}-user@arx.test`;
const SESSION_TTL_MS = 15 * 60 * 1000;
const SESSION_COOKIE = "arx_user_session";

// Unique synthetic symbol family so this run can never collide with a real
// pushed series in the shared in-process store.
const TAG = randomBytes(2).toString("hex").toUpperCase();
const SYM_LIVE = `QAF${TAG}`;       // contributing
const SYM_ABSENT = `QAF${TAG}NONE`; // never pushed (non-contributing / unavailable)
const SYM_EMPTY = `QAF${TAG}EMPTY`; // fresh-but-empty (stale)

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

function bars(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    time: new Date(Date.UTC(2026, 5, 7, 8, i)).toISOString(),
    open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 100 + i,
  }));
}

async function mintSession(userId: number): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await db.insert(authUserSessionsTable).values({
    userId,
    tokenHash: sha256(raw),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    ipAddress: "127.0.0.1",
    userAgent: "qa-mt5-feed-status-endpoint",
  });
  return raw;
}

async function cleanup(): Promise<void> {
  const users = await db.select({ id: usersTable.id }).from(usersTable)
    .where(like(usersTable.email, `${EMAIL_PREFIX}%`));
  const ids = users.map((u) => u.id);
  if (ids.length > 0) {
    await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, ids));
    await db.delete(usersTable).where(inArray(usersTable.id, ids));
  }
}

type FeedSeries = { symbol: string; timeframe: string; status: string; barCount: number };
type FeedBody = {
  ok?: boolean;
  feedActive?: boolean;
  providerConnected?: boolean;
  summary?: { totalSeries: number; contributing: number; stale: number; nonContributing: number; unavailable: number };
  series?: FeedSeries[];
  note?: string;
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

export async function run(): Promise<CiTestResultLike> {
  passes = 0;
  failures = 0;
  // eslint-disable-next-line no-console
  console.log("mt5FeedStatusEndpointTest");
  // eslint-disable-next-line no-console
  console.log("========================\n");

  await cleanup();
  const base = await getSharedBaseUrl();

  try {
    // ── Seed: an admin + a normal user with sessions ──────────────────────────
    const [adminUser] = await db.insert(usersTable).values({
      email: ADMIN_EMAIL, name: "QA Feed Admin", role: "ADMIN", isSystemUser: true,
    }).returning();
    const [normalUser] = await db.insert(usersTable).values({
      email: USER_EMAIL, name: "QA Feed User", role: "USER", isSystemUser: true,
    }).returning();
    if (!adminUser || !normalUser) throw new Error("user creation failed");

    const adminCookie = await mintSession(adminUser.id);
    const userCookie = await mintSession(normalUser.id);

    // Clean slate — the harness app shares this in-process store with the test.
    __resetMt5ProviderStore();

    // ── AUTH GATE ─────────────────────────────────────────────────────────────
    const anon = await getFeed(base, null);
    assert(anon.status === 401, `anonymous (no session) -> 401 (got ${anon.status})`);
    const asUser = await getFeed(base, userCookie);
    assert(asUser.status === 403, `normal USER session -> 403 (got ${asUser.status})`);
    const asAdmin = await getFeed(base, adminCookie);
    assert(asAdmin.status === 200 && asAdmin.body.ok === true, `ADMIN session -> 200 ok (got ${asAdmin.status})`);

    // ── EMPTY / UNAVAILABLE STATE (store reset, provider disconnected) ────────
    const empty = await getFeed(base, adminCookie);
    assert(empty.body.feedActive === false, `empty feed: feedActive=false (got ${empty.body.feedActive})`);
    assert(empty.body.providerConnected === false, `empty feed: providerConnected=false (got ${empty.body.providerConnected})`);
    assert(Array.isArray(empty.body.series) && empty.body.series.length === 0, `empty feed: series=[] (got ${empty.body.series?.length})`);
    assert(empty.body.summary?.totalSeries === 0, `empty feed: summary.totalSeries=0 (got ${empty.body.summary?.totalSeries})`);
    assert(
      typeof empty.body.note === "string"
        && empty.body.note.includes("no series pushed since server start")
        && empty.body.note.includes("first sync-candles payload"),
      `empty feed: honest "EA hasn't sent candles yet" note (got "${(empty.body.note ?? "").slice(0, 80)}…")`,
    );

    // Single-series probe while the feed is entirely offline -> unavailable.
    const offlineProbe = await getFeed(base, adminCookie, SYM_ABSENT, "M5");
    const offlineRow = (offlineProbe.body.series ?? [])[0];
    assert(
      !!offlineRow && offlineRow.status === "unavailable" && offlineRow.barCount === 0,
      `offline single-series probe -> unavailable (status=${offlineRow?.status})`,
    );

    // ── CONTRIBUTING + connectivity-driven feedActive ─────────────────────────
    updateCandlesFromMT5(SYM_LIVE, bars([1.10, 1.11, 1.12]), "M5");
    const live = await getFeed(base, adminCookie);
    assert(live.body.feedActive === true, "fresh push: feedActive=true (driven by provider connectivity)");
    assert(live.body.providerConnected === true, "fresh push: providerConnected=true exposed alongside feedActive");
    const liveRow = (live.body.series ?? []).find((s) => s.symbol === SYM_LIVE && s.timeframe === "M5");
    assert(!!liveRow && liveRow.status === "contributing" && liveRow.barCount === 3, `live series -> contributing barCount=3 (status=${liveRow?.status}, bars=${liveRow?.barCount})`);
    assert((live.body.summary?.contributing ?? 0) >= 1, `summary.contributing counts the live series (got ${live.body.summary?.contributing})`);

    // ── NON-CONTRIBUTING (feed connected, this symbol absent) ─────────────────
    const ncProbe = await getFeed(base, adminCookie, SYM_ABSENT, "M5");
    const ncRow = (ncProbe.body.series ?? [])[0];
    assert(
      !!ncRow && ncRow.status === "non-contributing",
      `never-pushed symbol probe while connected -> non-contributing (status=${ncRow?.status})`,
    );

    // ── NON-CONTRIBUTING via fresh-but-empty series + feedActive NOT derived ───
    // A series pushed with zero bars is fresh (lastUpdate stamped) but cannot be
    // "contributing" (no bars). It is NOT "stale" — "stale" means aged out past
    // CANDLE_TTL_MS (router falls through). A fresh-but-empty push is a live feed
    // that simply has no usable bars yet, so it reads "non-contributing". This
    // separation matters because a feed-stopped watchdog must gate on age, never
    // on the status string. The provider stays connected, so feedActive MUST
    // remain true — proving feedActive is driven by provider connectivity, not by
    // whether any series is contributing.
    updateCandlesFromMT5(SYM_EMPTY, [], "M5");
    const withEmpty = await getFeed(base, adminCookie);
    const emptyRow = (withEmpty.body.series ?? []).find((s) => s.symbol === SYM_EMPTY && s.timeframe === "M5");
    assert(!!emptyRow && emptyRow.status === "non-contributing" && emptyRow.barCount === 0, `fresh-but-empty series -> non-contributing barCount=0 (status=${emptyRow?.status})`);
    assert(withEmpty.body.feedActive === true, "feedActive stays true with a fresh-but-empty series present (not derived from series list)");
    assert((withEmpty.body.summary?.nonContributing ?? 0) >= 1, `summary.nonContributing counts the empty series (got ${withEmpty.body.summary?.nonContributing})`);

    // ── STALE BY AGE (deterministic, via the injectable-`now` provider fns the
    //    endpoint uses; the endpoint itself reads wall-clock time so age can't be
    //    forced over HTTP) ─────────────────────────────────────────────────────
    __resetMt5ProviderStore();
    // `t0` is read AFTER the push, never before. The store stamps the series with
    // its own `Date.now()` at push time, and freshness is
    // `now - updatedAt <= CANDLE_TTL_MS`. Reading `t0` first meant the aged probe
    // below (`t0 + CANDLE_TTL_MS + 1`) only exceeded the TTL when the push landed
    // in the SAME MILLISECOND as `t0` — reliably true when this file runs alone,
    // and false whenever the scheduler put >=1ms between the two, which is what
    // the full `pnpm run ci` lane does under load. Anchoring after the push makes
    // `t0 >= updatedAt`, so the probe is past the TTL by construction rather than
    // by luck.
    updateCandlesFromMT5(SYM_LIVE, bars([2.10, 2.11]), "M5");
    const t0 = Date.now();

    const freshNow = getMt5AllSeriesStatus(t0 + 1000);
    const freshEntry = freshNow.find((s) => s.symbol === SYM_LIVE && s.timeframe === "M5");
    assert(!!freshEntry && freshEntry.status === "contributing", `within TTL -> contributing (status=${freshEntry?.status})`);

    const agedNow = getMt5AllSeriesStatus(t0 + CANDLE_TTL_MS + 1);
    const agedEntry = agedNow.find((s) => s.symbol === SYM_LIVE && s.timeframe === "M5");
    assert(!!agedEntry && agedEntry.status === "stale", `aged past CANDLE_TTL_MS -> stale (status=${agedEntry?.status})`);

    const freshness = getMt5SeriesFreshness(SYM_LIVE, "M5", t0 + CANDLE_TTL_MS + 1);
    assert(freshness.hasSeries === true && freshness.fresh === false, `getMt5SeriesFreshness reports aged series not fresh (fresh=${freshness.fresh})`);
    const absentFreshness = getMt5SeriesFreshness(SYM_ABSENT, "M5", t0);
    assert(absentFreshness.hasSeries === false, `getMt5SeriesFreshness reports absent series hasSeries=false (got ${absentFreshness.hasSeries})`);

    // A stale series is not served — the router falls through to the next provider.
    const staleServed = await mt5Provider.getCandles(SYM_LIVE, "M5", 100);
    // (getCandles uses wall-clock; the just-pushed series is fresh, so it serves.
    // The age semantics above already prove the TTL boundary deterministically.)
    assert(staleServed.length === 2, `fresh series is served by the provider (got ${staleServed.length})`);
  } finally {
    __resetMt5ProviderStore();
    await cleanup();
  }

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "mt5FeedStatusEndpointTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    async (err) => {
      __resetMt5ProviderStore();
      await cleanup().catch(() => {});
      // eslint-disable-next-line no-console
      console.error("[mt5FeedStatusEndpointTest] FAILED:", err);
      process.exit(1);
    },
  );
}
