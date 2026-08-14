// ═══════════════════════════════════════════════════════════════════════════
// sessionAwareChartFeed.test.ts — DB-backed coverage proving the chart's
// session-aware completeness check reads REAL trading hours END-TO-END through
// the production SEAM `getChartCandles` / `buildChartFeed`
// (artifacts/api-server/src/lib/data/chart/chartDataService.ts).
//
// WHY THIS EXISTS
//   The session-aware completeness logic is unit-covered in three places: the
//   pure presence-profile builder (candleFixtures.test.ts F35–F41), the pure
//   gap math (candleNormalization), and the async profile wrapper
//   (sessionProfile.test.ts). What was NOT covered: the FULL seam wiring them
//   together — buildChartFeed classifying the symbol, deciding whether to load
//   a profile at all (`!getSymbolProfile(...).session.alwaysOpen`), calling the
//   DB-backed `getSessionProfile`, threading it into `runCandleTruth`, and the
//   resulting `feedStatus.quality` / `aiUsable`. A regression anywhere in that
//   chain (e.g. the profile silently not loaded, the wrong `sessionExpected`
//   flag, or the 24/7 fast-path accidentally invoking the profile) would pass
//   every unit test yet ship a chart that mis-counts weekend gaps. This suite
//   drives the real seam against a real `broker_candles`-seeded calendar.
//
// WHAT IT PROVES
//   [C01] A SESSION instrument (forex/stocks/unknown — session.alwaysOpen=false)
//         with a ≥3-week weekday-only broker history reports a CLEAN, aiUsable
//         feed across a weekend gap: the two weekend slots are MARKET-CLOSED, so
//         missingCandleCount=0 even though the calendar skipped two days twice.
//         The session profile is provably applied (sessionProfileApplied=true).
//   [C02] The SAME instrument + SAME profile still flags a GENUINE mid-stream
//         weekday gap (two consecutive EXPECTED slots absent) — missing>0,
//         quality "partial", not aiUsable. Session-awareness excludes weekends,
//         it does NOT hide real data loss.
//   [C03] A 24/7 SYNTHETIC instrument (session.alwaysOpen=true) keeps the NAIVE
//         missing-bar count for the EXACT same gap shape — no profile is loaded
//         (sessionProfileApplied=false) and every skipped slot counts as missing.
//
// SEAM CONTROL
//   - Feed window: pushed into the in-memory `mt5Provider` via
//     `updateCandlesFromMT5` (the FIRST provider in every class chain). The
//     router's live in-memory slot wins, source resolves to "mt5_broker"
//     (timeBasis "open" → the candle `time` IS the bar OPEN, no shift).
//   - `buildChartFeed` reads wall-clock `Date.now()` directly (not injectable)
//     for the trailing-gap freshness check, the in-memory freshness/TTL gates,
//     AND the profile lookback window. We pin `Date.now` to a FIXED anchor for
//     each sub-test so the newest bar trails the current bucket by 0 intervals
//     (→ clean) and the seeded history sits inside the 8-week lookback.
//   - Anchor day is chosen so its epoch weekly-slot is an EXPECTED trading slot
//     (dow 2 in the dow0–4 = "weekday" convention shared with sessionProfile.ts).
//
// SHARED-DB SAFETY
//   broker_candles is market-CALENDAR telemetry (not safety evidence). We seed
//   one isolated isSystemUser + one mt5_connection and a UNIQUE synthetic-tagged
//   session symbol, and clean EVERYTHING in a `finally`. The 24/7 case writes NO
//   DB rows (its fast-path never reads broker_candles) — it only uses the
//   in-memory store, reset between sub-tests. Never places a trade, never inserts
//   an arx_live_command, never reaches a real EA.
//
// Run: pnpm --filter @workspace/api-server run test:session-aware-chart-feed

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  mt5ConnectionTable,
  brokerCandlesTable,
} from "@workspace/db";
import { getChartCandles } from "../chartDataService.js";
import { _resetSessionProfileCache } from "../sessionProfile.js";
import { updateCandlesFromMT5, __resetMt5ProviderStore } from "../../providers/mt5Provider.js";
import { timeframeMs } from "../timeframes.js";
import type { Candle } from "../../types.js";

const D1_MS = timeframeMs("D1");

// Unique, never-real session symbol (digits + length → classifies "unknown" →
// FOREX_SESSION default → session.alwaysOpen=false → session-aware path).
const TAG = randomBytes(2).toString("hex").toUpperCase();
const SESSION_SYM = `QSES9${TAG}`;
// A known 24/7 synthetic (V-pattern). No broker_candles is ever written for it.
const SYNTH_SYM = "V75";

// Anchor day: the most recent epoch-day whose weekly slot (== day mod 7) is 2,
// an EXPECTED trading slot in the dow0–4 weekday convention. Date.now() is
// pinned to noon of this day per sub-test → current D1 bucket = ANCHOR_DAY, so a
// newest bar opening at ANCHOR_DAY*D1_MS trails by 0 intervals (clean).
const TODAY_DAY = Math.floor(Date.now() / D1_MS);
const ANCHOR_DAY = TODAY_DAY - (((TODAY_DAY % 7) - 2 + 7) % 7);
const FIXED_NOW = ANCHOR_DAY * D1_MS + 12 * 3_600_000;

function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Build a D1 candle whose OPEN time is `day` epoch-days after the epoch. */
function barForDay(day: number, i: number): Candle {
  const base = 1.1 + i * 0.0001;
  return {
    time: new Date(day * D1_MS).toISOString(),
    open: base,
    high: base + 0.001,
    low: base - 0.001,
    close: base + 0.0005,
    volume: 1000 + i,
  };
}

function barsForDays(days: number[]): Candle[] {
  return days.map((d, i) => barForDay(d, i));
}

let userId = 0;
let connId = 0;

/**
 * Seed weekday-only (dow 0–4) D1 broker history for `weeks` recent epoch-weeks
 * anchored to ANCHOR_DAY's week, so the seam's `getSessionProfile` learns
 * expectedSlots={0,1,2,3,4}, weekend slots {5,6} market-closed, and
 * sufficientHistory=true. (ANCHOR_DAY mod 7 == 2 ⇒ (ANCHOR_DAY-2) mod 7 == 0.)
 */
async function seedWeekdayHistory(weeks: number): Promise<void> {
  const dow0OfAnchorWeek = ANCHOR_DAY - 2;
  const rows: (typeof brokerCandlesTable.$inferInsert)[] = [];
  for (let wk = 1; wk <= weeks; wk++) {
    const weekStartDay = dow0OfAnchorWeek - 7 * wk; // strictly past, dow0
    for (let dow = 0; dow < 5; dow++) {
      const openMs = (weekStartDay + dow) * D1_MS;
      rows.push({
        userId,
        bridgeConnectionId: connId,
        brokerSymbol: SESSION_SYM,
        symbol: SESSION_SYM, // stored UPPERCASE (producer convention)
        timeframe: "D1",
        openTimeUtc: new Date(openMs),
        open: 1.1,
        high: 1.101,
        low: 1.099,
        close: 1.1005,
        isClosedBar: true,
      });
    }
  }
  await db.insert(brokerCandlesTable).values(rows);
}

async function cleanup(): Promise<void> {
  await db.delete(brokerCandlesTable).where(eq(brokerCandlesTable.symbol, SESSION_SYM));
  if (connId) await db.delete(mt5ConnectionTable).where(eq(mt5ConnectionTable.id, connId));
  if (userId) await db.delete(usersTable).where(eq(usersTable.id, userId));
}

/** Run `fn` with Date.now() pinned to FIXED_NOW (restored in finally). */
async function withFixedNow<T>(fn: () => Promise<T>): Promise<T> {
  const orig = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    return await fn();
  } finally {
    Date.now = orig;
  }
}

// Day layout relative to ANCHOR_DAY (= D, weekly slot 2). Within-week steps are
// always 1 day; cross-week steps skip the two weekend slots (dow5, dow6).
const D = ANCHOR_DAY;
// Two full weekday weeks + the current week up to D (dow0,1,2), with the two
// weekends naturally skipped: D-12(dow4)→D-9(dow0) and D-5(dow4)→D-2(dow0).
const CLEAN_WEEKEND_DAYS = [
  D - 16, D - 15, D - 14, D - 13, D - 12, // week w-2, dow0–4
  D - 9, D - 8, D - 7, D - 6, D - 5,      // week w-1, dow0–4
  D - 2, D - 1, D,                        // current week, dow0–2 (tip = D)
];
// Same window but with week w-1's dow1 (D-8) and dow2 (D-7) removed: a genuine
// two-bar mid-stream gap between EXPECTED slots, ON TOP of the weekend skips.
const GENUINE_GAP_DAYS = CLEAN_WEEKEND_DAYS.filter((d) => d !== D - 8 && d !== D - 7);

test("session-aware chart feed (DB-backed seam: buildChartFeed/getChartCandles)", async (t) => {
  await cleanup();
  _resetSessionProfileCache();
  __resetMt5ProviderStore();

  const [user] = await db
    .insert(usersTable)
    .values({
      email: `qa+session-feed-${TAG}@arx.test`,
      name: "QA Session-Aware Feed",
      role: "USER",
      isSystemUser: true,
    })
    .returning();
  assert.ok(user, "seed user");
  userId = user.id;

  const rawToken = randomBytes(24).toString("base64url");
  const [conn] = await db
    .insert(mt5ConnectionTable)
    .values({
      userId,
      connectionName: "QA Session-Aware Feed Bridge",
      status: "connected",
      apiKeyHash: sha256(rawToken),
      tokenLast4: rawToken.slice(-4),
      tokenCreatedAt: new Date(),
      accountNumber: "9999487",
    })
    .returning();
  assert.ok(conn, "seed connection");
  connId = conn.id;

  try {
    // Seed the ≥3-week weekday-only broker calendar the seam will learn from.
    await seedWeekdayHistory(4);

    // ── [C01] session-aware CLEAN across a weekend gap ───────────────────────
    await t.test(
      "[C01] session instrument: weekend gap excluded → clean + aiUsable, profile applied",
      async () => {
        await withFixedNow(async () => {
          _resetSessionProfileCache();
          __resetMt5ProviderStore();
          updateCandlesFromMT5(SESSION_SYM, barsForDays(CLEAN_WEEKEND_DAYS), "D1");

          const res = await getChartCandles(SESSION_SYM, "D1", 200);

          assert.equal(res.source, "mt5_broker", "served by the in-memory broker slot");
          assert.equal(res.candleCount, CLEAN_WEEKEND_DAYS.length, "all seeded bars returned");
          assert.ok(res.truthResult, "truth engine ran");
          assert.equal(
            res.truthResult!.sessionAlwaysOpen,
            false,
            "session instrument (not 24/7) → session-aware path",
          );
          assert.equal(
            res.truthResult!.sessionProfileApplied,
            true,
            "the DB-backed weekly presence profile was loaded and applied through the seam",
          );
          assert.equal(
            res.feedStatus.missingCandleCount,
            0,
            "both weekend skips are market-closed slots, not missing bars",
          );
          assert.equal(res.feedStatus.completenessReason, null, "no isolated/genuine gap reason");
          assert.equal(res.feedStatus.quality, "clean", "complete session feed is clean");
          assert.equal(res.feedStatus.aiUsable, true, "clean ⇒ aiUsable");
          assert.equal(res.aiUsable, true, "top-level aiUsable mirrors feedStatus");
        });
      },
    );

    // ── [C02] genuine mid-stream weekday gap is STILL flagged ────────────────
    await t.test(
      "[C02] session instrument: genuine weekday gap → partial + not aiUsable",
      async () => {
        await withFixedNow(async () => {
          _resetSessionProfileCache();
          __resetMt5ProviderStore();
          updateCandlesFromMT5(SESSION_SYM, barsForDays(GENUINE_GAP_DAYS), "D1");

          const res = await getChartCandles(SESSION_SYM, "D1", 200);

          assert.equal(res.source, "mt5_broker", "served by the in-memory broker slot");
          assert.ok(res.truthResult, "truth engine ran");
          assert.equal(
            res.truthResult!.sessionProfileApplied,
            true,
            "profile still applied (same session instrument)",
          );
          // D-9(dow0)→D-6(dow3) skips D-8(dow1) and D-7(dow2): two consecutive
          // EXPECTED slots → a genuine run of 2 missing bars.
          assert.equal(
            res.feedStatus.missingCandleCount,
            2,
            "two consecutive absent EXPECTED slots count as a genuine gap",
          );
          assert.equal(res.feedStatus.quality, "partial", "genuine gap downgrades to partial");
          assert.equal(res.feedStatus.aiUsable, false, "partial ⇒ not aiUsable");
        });
      },
    );

    // ── [C03] 24/7 synthetic keeps the NAIVE count (no profile) ──────────────
    await t.test(
      "[C03] 24/7 synthetic: same gap shape keeps naive missing count, no profile",
      async () => {
        await withFixedNow(async () => {
          _resetSessionProfileCache();
          __resetMt5ProviderStore();
          // EXACT same calendar shape as the [C01] clean session feed.
          updateCandlesFromMT5(SYNTH_SYM, barsForDays(CLEAN_WEEKEND_DAYS), "D1");

          const res = await getChartCandles(SYNTH_SYM, "D1", 200);

          assert.equal(res.source, "mt5_broker", "served by the in-memory broker slot");
          assert.equal(res.candleCount, CLEAN_WEEKEND_DAYS.length, "all bars returned");
          assert.ok(res.truthResult, "truth engine ran");
          assert.equal(
            res.truthResult!.sessionAlwaysOpen,
            true,
            "synthetic is 24/7 → no market session",
          );
          assert.equal(
            res.truthResult!.sessionProfileApplied,
            false,
            "no presence profile is loaded for a 24/7 instrument (fast path)",
          );
          // Two weekend skips of 2 days each (steps=3 ⇒ +2 missing) = 4 naive.
          assert.equal(
            res.feedStatus.missingCandleCount,
            4,
            "every skipped slot counts as missing for a 24/7 instrument (naive)",
          );
          assert.equal(
            res.feedStatus.completenessReason,
            null,
            "naive path sets no session-completeness reason",
          );
          // Contrast guard: the SAME gap shape was 0 missing for the session
          // instrument in [C01] but is 4 here — proving the profile, not luck,
          // produced the session-aware result.
          assert.notEqual(
            res.feedStatus.missingCandleCount,
            0,
            "24/7 instrument must NOT excuse the weekend skips",
          );
        });
      },
    );
  } finally {
    _resetSessionProfileCache();
    __resetMt5ProviderStore();
    await cleanup();
  }
});
