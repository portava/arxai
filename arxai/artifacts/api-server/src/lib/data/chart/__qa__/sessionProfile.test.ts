// ═══════════════════════════════════════════════════════════════════════════
// sessionProfile.test.ts — DB-backed coverage for the ASYNC session-profile
// wrapper `getSessionProfile` (artifacts/api-server/src/lib/data/chart/
// sessionProfile.ts).
//
// WHY THIS EXISTS
//   The session-aware completeness fix has two halves:
//     1. buildWeeklyPresenceProfile — a PURE epoch-list → profile builder, fully
//        covered by the static fixtures F35–F41 in candleFixtures.test.ts.
//     2. getSessionProfile — the ASYNC wrapper that reads observed bar OPEN times
//        from the `broker_candles` table, uppercases the symbol key, parses the
//        stored timestamps to epoch-ms, applies the ≥3-week sufficiency
//        threshold, caches per (symbol|timeframe), and returns null (fail-honest)
//        when the read throws.
//   Only the pure half was tested. This suite seeds REAL broker_candles rows and
//   drives the DB-backed wrapper end to end — the part that actually decides
//   EURUSD's real trading week in production.
//
// WHAT IT PROVES
//   [S01] A weekday-only (5-of-7 weekly slots) forex history of ≥3 weeks yields a
//         profile that marks the weekday slots EXPECTED, excludes the two weekend
//         slots, and reports sufficientHistory=true.
//   [S02] The symbol key is normalized to UPPERCASE before the DB read: a query
//         using the lowercase symbol still resolves the uppercase-stored rows.
//   [S03] A thin history (<3 weeks) returns a real profile with
//         sufficientHistory=false (the caller must NOT assert market-closed slots).
//   [S04] A timeframe with no stored or derivable source returns null (honest —
//         never a fabricated profile).
//   [S05] A DB read failure returns null (fail-honest), never a fabricated profile.
//   [S06] An evenly-split M15 Friday history (4 full + 4 short of 8 weeks — the
//         tie a daylight-saving change makes at the lookback midpoint) flows
//         through the DERIVED M30 profile and DEMOTES the 0.5-tie boundary slots
//         while keeping the always-traded neighbour expected. The DB-backed twin
//         of pure-builder fixture [F48] — the strict-majority rule proven where
//         production actually reads it.
//
// WEEKLY-SLOT MODEL (matches sessionProfile.ts WEEK_MS math exactly)
//   The builder buckets each bar OPEN epoch into a fixed weekly slot
//   slot = floor(openMs / intervalMs) mod slotsPerWeek. For D1 (slotsPerWeek=7),
//   a bar at openMs = (w*7 + dow) * D1_MS lands in slot `dow` of week `w`. We seed
//   dow 0–4 ("trading days") and leave dow 5–6 empty ("weekend"), anchored to
//   recent epoch-weeks so every row falls inside the wrapper's 8-week lookback.
//
// SHARED-DB SAFETY
//   broker_candles is market-CALENDAR telemetry (not safety evidence). We seed one
//   isolated isSystemUser + one mt5_connection and clean EVERYTHING in a `finally`,
//   scoped by the seeded user/connection and unique synthetic symbols. Never
//   places a trade, never inserts an arx_live_command, never reaches a real EA.
//
// Run: pnpm --filter @workspace/api-server run test:session-profile

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
import {
  getSessionProfile,
  _resetSessionProfileCache,
  MIN_WEEKS_FOR_PROFILE,
} from "../sessionProfile.js";
import { timeframeMs } from "../timeframes.js";

const D1_MS = timeframeMs("D1");
const WEEK_MS = 7 * D1_MS;
const M15_MS = timeframeMs("M15");
const M30_MS = timeframeMs("M30");
const M15_PER_DAY = D1_MS / M15_MS; // 96
const M30_PER_DAY = D1_MS / M30_MS; // 48

// Unique synthetic symbols (uppercase, as the producer stores them).
const TAG = randomBytes(2).toString("hex").toUpperCase();
const SYM_SUFFICIENT = `QSPA${TAG}`;
const SYM_THIN = `QSPB${TAG}`;
const SYM_ERROR = `QSPC${TAG}`;
const SYM_TIE = `QSPD${TAG}`;
const ALL_SYMS = [SYM_SUFFICIENT, SYM_THIN, SYM_ERROR, SYM_TIE];

// Anchor to the current epoch-week so seeded bars sit inside the wrapper's
// 8-week lookback window. `now` is the start (Thursday 00:00 UTC) of the
// current epoch-week; seeded weeks are strictly in the past.
const BASE_WEEK = Math.floor(Math.floor(Date.now() / D1_MS) / 7);
const NOW = BASE_WEEK * WEEK_MS;

function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

let userId = 0;
let connId = 0;

/**
 * Seed weekday-only (dow 0–4) D1 bars for `weeks` recent epoch-weeks. Returns
 * the number of distinct weeks seeded (== observedWeeks the wrapper should see).
 */
async function seedWeekdayHistory(symbol: string, weeks: number): Promise<number> {
  const rows: (typeof brokerCandlesTable.$inferInsert)[] = [];
  for (let i = 1; i <= weeks; i++) {
    const w = BASE_WEEK - i; // strictly past, within 8-week lookback for weeks<=4
    for (let dow = 0; dow < 5; dow++) {
      const openMs = (w * 7 + dow) * D1_MS;
      rows.push({
        userId,
        bridgeConnectionId: connId,
        brokerSymbol: symbol,
        symbol, // stored UPPERCASE (producer convention)
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
  return weeks;
}

/**
 * Seed M15 bars for `weeks` recent epoch-weeks where the trading week straddles
 * a daylight-saving change: `fullFridayWeeks` Fridays trade the FULL day (M15
 * s=0..95 → every M30 slot 0..47), the remaining Fridays close one hour early
 * (drop the final hour, M15 s=92..95 → M30 slots 46,47 absent). Monday–Thursday
 * always trade the full day. Returns the number of distinct weeks seeded.
 *
 * With weeks=8 and fullFridayWeeks=4 the two DST boundary M30 slots (46,47)
 * trade in EXACTLY 4/8 = 0.5 of weeks — the perfect tie a DST change produces
 * when it lands on the midpoint of the 8-week lookback. The always-traded
 * neighbour slot 45 (M15 s=90,91) appears 8/8. This is the DB-backed twin of the
 * pure-builder fixture [F48] in candleFixtures.test.ts.
 */
async function seedM15DstSplitHistory(
  symbol: string,
  weeks: number,
  fullFridayWeeks: number,
): Promise<number> {
  const rows: (typeof brokerCandlesTable.$inferInsert)[] = [];
  for (let i = 1; i <= weeks; i++) {
    const w = BASE_WEEK - i; // strictly past; weeks<=8 sit inside the 8-week lookback
    for (let dow = 0; dow < 5; dow++) {
      const dayStart = (w * 7 + dow) * D1_MS;
      const isFriday = dow === 4;
      // The last `weeks - fullFridayWeeks` Fridays close early (summer season).
      const earlyClose = isFriday && i <= weeks - fullFridayWeeks;
      const lastM15 = earlyClose ? M15_PER_DAY - 4 : M15_PER_DAY; // drop the final hour
      for (let s = 0; s < lastM15; s++) {
        rows.push({
          userId,
          bridgeConnectionId: connId,
          brokerSymbol: symbol,
          symbol, // stored UPPERCASE (producer convention)
          timeframe: "M15", // M30 profile is DERIVED from M15 by the wrapper
          openTimeUtc: new Date(dayStart + s * M15_MS),
          open: 1.1,
          high: 1.101,
          low: 1.099,
          close: 1.1005,
          isClosedBar: true,
        });
      }
    }
  }
  await db.insert(brokerCandlesTable).values(rows);
  return weeks;
}

async function cleanup(): Promise<void> {
  await db.delete(brokerCandlesTable).where(inArray(brokerCandlesTable.symbol, ALL_SYMS));
  if (connId) await db.delete(mt5ConnectionTable).where(eq(mt5ConnectionTable.id, connId));
  if (userId) await db.delete(usersTable).where(eq(usersTable.id, userId));
}

test("sessionProfile (DB-backed getSessionProfile)", async (t) => {
  await cleanup();
  _resetSessionProfileCache();

  const [user] = await db
    .insert(usersTable)
    .values({
      email: `qa+session-profile-${TAG}@arx.test`,
      name: "QA Session Profile",
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
      connectionName: "QA Session Profile Bridge",
      status: "connected",
      apiKeyHash: sha256(rawToken),
      tokenLast4: rawToken.slice(-4),
      tokenCreatedAt: new Date(),
      accountNumber: "9999486",
    })
    .returning();
  assert.ok(conn, "seed connection");
  connId = conn.id;

  try {
    // ── [S01] ≥3 weeks of weekday-only history → weekday slots expected,
    //         weekend excluded, sufficientHistory=true ───────────────────────
    await t.test(
      "[S01] weekday-only history trusts weekday slots, excludes weekend, sufficientHistory=true",
      async () => {
        await seedWeekdayHistory(SYM_SUFFICIENT, 4);
        _resetSessionProfileCache();

        const profile = await getSessionProfile(SYM_SUFFICIENT, "D1", NOW);
        assert.ok(profile, "wrapper must return a profile for seeded history");
        assert.equal(profile.observedWeeks, 4, "four distinct epoch-weeks observed");
        assert.equal(profile.sufficientHistory, true, "4 weeks ≥ MIN_WEEKS_FOR_PROFILE");
        assert.ok(MIN_WEEKS_FOR_PROFILE <= 4, "sanity: threshold is 4 weeks or fewer");
        for (let dow = 0; dow < 5; dow++) {
          assert.ok(profile.expectedSlots.has(dow), `weekday slot ${dow} must be expected`);
        }
        assert.equal(profile.expectedSlots.has(5), false, "weekend slot 5 must NOT be expected");
        assert.equal(profile.expectedSlots.has(6), false, "weekend slot 6 must NOT be expected");
        assert.equal(profile.expectedSlots.size, 5, "exactly the five trading slots are expected");
      },
    );

    // ── [S02] symbol key is uppercased before the DB read ────────────────────
    await t.test("[S02] lowercase symbol resolves uppercase-stored rows (toUpperCase key)", async () => {
      _resetSessionProfileCache();
      const profile = await getSessionProfile(SYM_SUFFICIENT.toLowerCase(), "D1", NOW);
      assert.ok(profile, "lowercase query must still resolve the uppercase-stored series");
      assert.equal(profile.observedWeeks, 4, "same four weeks found via lowercase symbol");
      assert.equal(profile.sufficientHistory, true, "lowercase query is still sufficient");
    });

    // ── [S03] thin history (<3 weeks) → sufficientHistory=false ──────────────
    await t.test("[S03] insufficient history (<3 weeks) returns sufficientHistory=false", async () => {
      await seedWeekdayHistory(SYM_THIN, 2);
      _resetSessionProfileCache();

      const profile = await getSessionProfile(SYM_THIN, "D1", NOW);
      assert.ok(profile, "a thin history still returns a (real) profile, not null");
      assert.equal(profile.observedWeeks, 2, "two distinct epoch-weeks observed");
      assert.equal(
        profile.sufficientHistory,
        false,
        "2 weeks (< MIN_WEEKS_FOR_PROFILE) must not be trusted to assert market-closed slots",
      );
    });

    // ── [S04] no stored/derivable source timeframe → honest null ─────────────
    await t.test("[S04] non-derivable timeframe returns null (honest, no fabricated profile)", async () => {
      _resetSessionProfileCache();
      // M3 is a valid chart timeframe but is NOT physically stored in
      // broker_candles and has no finer-source mapping → fail honest.
      const profile = await getSessionProfile(SYM_SUFFICIENT, "M3", NOW);
      assert.equal(profile, null, "no stored/derivable source must return null, never a profile");
    });

    // ── [S05] DB read failure → fail-honest null ─────────────────────────────
    await t.test("[S05] a DB error returns null (fail-honest), not a fabricated profile", async () => {
      _resetSessionProfileCache();
      const originalSelect = db.select;
      // Force the broker_candles read to throw; the wrapper must swallow it and
      // return null rather than inventing a profile.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any).select = () => {
        throw new Error("forced session-profile DB failure");
      };
      try {
        const profile = await getSessionProfile(SYM_ERROR, "D1", NOW);
        assert.equal(profile, null, "a thrown DB read must yield null, never a fabricated profile");
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any).select = originalSelect;
      }
    });

    // ── [S06] DST tie at the lookback midpoint: an evenly-split M15 Friday
    //         history (4 full + 4 short of 8 weeks) → the DERIVED M30 profile
    //         DEMOTES the 0.5-tie boundary slots, keeps the always-traded
    //         neighbour expected. DB-backed twin of fixture [F48]. ────────────
    await t.test(
      "[S06] evenly-split DST history demotes the 0.5-tie M30 boundary slot, keeps the always-traded neighbour",
      async () => {
        const observed = await seedM15DstSplitHistory(SYM_TIE, 8, 4);
        assert.equal(observed, 8, "sanity: eight weeks seeded (DST splits them 4 full / 4 short)");
        _resetSessionProfileCache();

        // The wrapper derives the M30 profile from the stored M15 rows.
        const profile = await getSessionProfile(SYM_TIE, "M30", NOW);
        assert.ok(profile, "wrapper must derive an M30 profile from the stored M15 history");
        assert.equal(profile.intervalMs, M30_MS, "profile is bucketed at the M30 interval");
        assert.equal(profile.observedWeeks, 8, "eight distinct epoch-weeks observed");
        assert.equal(profile.sufficientHistory, true, "8 weeks ≥ MIN_WEEKS_FOR_PROFILE");

        const FRI = 4;
        const slot45 = FRI * M30_PER_DAY + 45; // 21:30–22:00 — traded every week (M15 s=90,91)
        const slot46 = FRI * M30_PER_DAY + 46; // 22:00–22:30 — DST boundary (M15 s=92,93)
        const slot47 = FRI * M30_PER_DAY + 47; // 22:30–23:00 — DST boundary (M15 s=94,95)

        assert.equal(
          profile.expectedSlots.has(slot45),
          true,
          "the always-traded (8/8) boundary neighbour slot 45 stays expected",
        );
        assert.equal(
          profile.expectedSlots.has(slot46),
          false,
          "a 4/8 = 0.5 tie slot 46 must be DEMOTED end-to-end under the strict-majority rule",
        );
        assert.equal(
          profile.expectedSlots.has(slot47),
          false,
          "a 4/8 = 0.5 tie slot 47 must be DEMOTED end-to-end under the strict-majority rule",
        );
      },
    );
  } finally {
    _resetSessionProfileCache();
    await cleanup();
  }
});
