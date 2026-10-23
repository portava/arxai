// ARX Native Chart — session-aware candle completeness profile.
//
// The candle truth/quality layer counts "expected bars" to decide whether a
// feed is complete. A naive 24/7 calendar over-counts missing bars for
// session-based instruments (forex/stocks/indices) because weekend and
// off-hours closures look like data gaps. This module learns, from the broker's
// OWN observed history, WHICH weekly time slots a symbol actually trades in, so
// the completeness calc can exclude market-closed slots and only flag genuine
// gaps.
//
// Design:
//   - A weekly "presence profile" buckets every observed bar OPEN time into a
//     fixed slot within the trading week (slotIndex = floor(ms/interval) mod
//     slotsPerWeek). A slot that traded in a STRICT MAJORITY of the observed
//     weeks (> EXPECTED_PRESENCE_RATIO) is "expected" (the market normally
//     trades then). All other slots — including a slot that traded in exactly
//     half the weeks (a tie) — are market-closed. The strict-majority test
//     deliberately demotes a 50%-tie: see EXPECTED_PRESENCE_RATIO below.
//   - The builder is PURE (epoch list in, profile out). The async wrapper reads
//     observed bar OPEN times from `broker_candles` — this is market-CALENDAR
//     telemetry (when does this instrument trade), NOT user data, so it reads
//     across all bridge owners. No OHLC prices, balances, tickets, or any
//     per-user trading state are read.
//
// SAFETY: read-only telemetry. Never an execution gate. Never fabricates a bar.

import { and, desc, eq, gte } from "drizzle-orm";
import { db, brokerCandlesTable } from "@workspace/db";
import { timeframeMs, type ChartTimeframe } from "./timeframes.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A weekly slot must have traded in MORE than this fraction of observed weeks
 * (a STRICT MAJORITY — note the `>` comparison below) to count as "expected".
 *
 * Decision (Task #491 — clock-change hour that traded exactly half the time):
 * the test is strict `>` rather than `>=`, so a slot that traded in EXACTLY
 * half the observed weeks (a 50% tie) is demoted to market-closed. This matters
 * at a daylight-saving transition that lands on the midpoint of the 8-week
 * lookback: a shifted boundary hour then trades in exactly half the weeks
 * (e.g. 4/8 = 0.5). Under a `>=` rule it would stay "expected", and on a
 * multi-slot timeframe (M30, where one hour spans two slots) its absence in the
 * new season would register as a 2-bar "genuine gap" — a transient false
 * partial until the transition ages out of the window. A tie is not "normally
 * trades": demoting it fails in the safe, honest direction (we do not assert
 * that a coin-flip slot's absence is a data gap), is timeframe-agnostic, and
 * leaves genuine majority-present gaps still flagged.
 */
const EXPECTED_PRESENCE_RATIO = 0.5;

/** Minimum distinct observed weeks before the profile is trusted enough to assert market-closed slots. */
export const MIN_WEEKS_FOR_PROFILE = 3;

/** How far back the profile reads observed bar times. */
const PROFILE_LOOKBACK_WEEKS = 8;

/** Hard cap on rows scanned per (symbol, timeframe) profile build. */
const PROFILE_MAX_ROWS = 60_000;

/** Cache TTL — the weekly trading calendar changes slowly; rebuild at most every 30 min. */
const PROFILE_CACHE_TTL_MS = 30 * 60_000;
const DAY_MS = 86_400_000;

/**
 * Chart timeframes used DIRECTLY as a presence-profile source — their own bar
 * OPEN times are read from `broker_candles` at their native interval.
 *
 * Sourcing under EA v1.54 (which default-streams nine timeframes —
 * M1,M5,M15,M30,H1,H4,H8,D1,W1 — all physically stored in `broker_candles`):
 *   - M1/M5/M15/H1/H4/D1 — profile read DIRECTLY from this timeframe (this set).
 *   - M30 — DERIVED from M15 (see PROFILE_SOURCE_TIMEFRAME). M30 rows now exist
 *     in `broker_candles`, but M15 is finer and present whenever M30 is, so we
 *     deliberately keep the one proven slot-coverage source instead of switching
 *     to the newer/sparser M30 rows.
 *   - H8/W1 — NO profile source (neither in this set nor derivable).
 *     `getSessionProfile` returns null and the caller fails honest: it WITHHOLDS
 *     missing-bar counts (never fabricates weekend gaps) rather than over-count.
 *     Verified live: EURUSD H8 reads clean; W1 reads `delayed` only because its
 *     current weekly bar is still forming (a freshness verdict, not a coverage
 *     gap), with missingCandleCount=0. W1 needs no profile anyway (1 slot/week —
 *     no intra-week closed slots to exclude). Promote a timeframe into this set
 *     or PROFILE_SOURCE_TIMEFRAME only on a demonstrated over-count.
 */
const STORED_PROFILE_TIMEFRAMES: ReadonlySet<ChartTimeframe> = new Set([
  "M1",
  "M5",
  "M15",
  "H1",
  "H4",
  "D1",
]);

/**
 * For a chart timeframe NOT used as a direct profile source (see
 * STORED_PROFILE_TIMEFRAMES), derive its weekly
 * presence profile from a finer STORED timeframe. The presence profile records
 * only WHICH weekly slots an instrument trades in; reading a finer timeframe's
 * bar OPEN times and bucketing them at the COARSER requested interval reproduces
 * exactly the same slot coverage (every coarse slot that traded contains at
 * least one finer bar). M30 ← M15: the producer guarantees M15 is present
 * whenever M30 would be, so an M30 chart gets the same session-aware
 * completeness as M5/M15/H1 instead of falling through to a non-session path.
 */
const PROFILE_SOURCE_TIMEFRAME: Partial<Record<ChartTimeframe, ChartTimeframe>> = {
  M30: "M15",
};

export interface WeeklyPresenceProfile {
  /** Timeframe interval the profile was built for (ms). */
  intervalMs: number;
  /** Number of fixed slots in one trading week for this interval. */
  slotsPerWeek: number;
  /** Distinct calendar weeks observed in the sample. */
  observedWeeks: number;
  /** True once we have enough weeks to trust the expected-slot set. */
  sufficientHistory: boolean;
  /** Slot indices (0..slotsPerWeek-1) the instrument normally trades in. */
  expectedSlots: Set<number>;
}

/** Map an epoch (ms) to its fixed slot index within the trading week. */
export function weeklySlotIndex(openMs: number, intervalMs: number): number {
  const slotsPerWeek = Math.max(1, Math.round(WEEK_MS / intervalMs));
  const raw = Math.floor(openMs / intervalMs) % slotsPerWeek;
  return ((raw % slotsPerWeek) + slotsPerWeek) % slotsPerWeek;
}

/**
 * Build a weekly presence profile from a list of observed bar OPEN epochs (ms)
 * for one symbol+timeframe. PURE — no IO, deterministic.
 */
export function buildWeeklyPresenceProfile(
  openEpochsMs: number[],
  intervalMs: number,
): WeeklyPresenceProfile {
  const slotsPerWeek = Math.max(1, Math.round(WEEK_MS / intervalMs));

  // week index → set of slot indices seen in that week
  const perWeekSlots = new Map<number, Set<number>>();
  for (const ms of openEpochsMs) {
    if (!Number.isFinite(ms) || ms < 0) continue;
    const week = Math.floor(ms / WEEK_MS);
    const slot = weeklySlotIndex(ms, intervalMs);
    let set = perWeekSlots.get(week);
    if (!set) {
      set = new Set();
      perWeekSlots.set(week, set);
    }
    set.add(slot);
  }

  const observedWeeks = perWeekSlots.size;

  // For each slot, how many weeks did it appear in?
  const slotWeekCount = new Map<number, number>();
  for (const slots of perWeekSlots.values()) {
    for (const s of slots) slotWeekCount.set(s, (slotWeekCount.get(s) ?? 0) + 1);
  }

  const expectedSlots = new Set<number>();
  if (observedWeeks > 0) {
    for (const [slot, count] of slotWeekCount) {
      // Strict `>` (NOT `>=`): a slot that traded in exactly half the observed
      // weeks (a 50% tie — see EXPECTED_PRESENCE_RATIO / Task #491) is demoted to
      // market-closed, not kept expected.
      if (count / observedWeeks > EXPECTED_PRESENCE_RATIO) expectedSlots.add(slot);
    }
  }

  return {
    intervalMs,
    slotsPerWeek,
    observedWeeks,
    sufficientHistory: observedWeeks >= MIN_WEEKS_FOR_PROFILE,
    expectedSlots,
  };
}

/** True when the instrument normally trades in the weekly slot containing openMs. */
export function isSlotExpected(profile: WeeklyPresenceProfile, openMs: number): boolean {
  return profile.expectedSlots.has(weeklySlotIndex(openMs, profile.intervalMs));
}

// ── Async profile resolution (cached) ────────────────────────────────────────

interface CacheEntry {
  profile: WeeklyPresenceProfile;
  builtAt: number;
  dayKey: number;
}
const profileCache = new Map<string, CacheEntry>();

/** Test hook — clear the in-memory profile cache. */
export function _resetSessionProfileCache(): void {
  profileCache.clear();
}

async function readBrokerOpenTimes(
  symbol: string,
  timeframe: ChartTimeframe,
  now: number,
): Promise<number[]> {
  const sinceMs = now - PROFILE_LOOKBACK_WEEKS * WEEK_MS;
  const rows = await db
    .select({ openTimeUtc: brokerCandlesTable.openTimeUtc })
    .from(brokerCandlesTable)
    .where(
      and(
        eq(brokerCandlesTable.symbol, symbol.toUpperCase()),
        eq(brokerCandlesTable.timeframe, timeframe),
        gte(brokerCandlesTable.openTimeUtc, new Date(sinceMs)),
      ),
    )
    .orderBy(desc(brokerCandlesTable.openTimeUtc))
    .limit(PROFILE_MAX_ROWS);
  return rows.map((r) => new Date(r.openTimeUtc as unknown as Date).getTime());
}

/**
 * Resolve the weekly presence profile for a symbol+timeframe from observed
 * broker history. Returns null when the read fails (fail-honest: the caller
 * must NOT assert market-closed slots without a profile). Cached per
 * (symbol|timeframe) with a 30-min TTL and a same-day key.
 */
export async function getSessionProfile(
  symbol: string,
  timeframe: ChartTimeframe,
  now: number = Date.now(),
): Promise<WeeklyPresenceProfile | null> {
  const key = `${symbol.toUpperCase()}|${timeframe}`;
  const dayKey = Math.floor(now / DAY_MS);
  const cached = profileCache.get(key);
  if (cached && cached.dayKey === dayKey && now - cached.builtAt < PROFILE_CACHE_TTL_MS) {
    return cached.profile;
  }
  // Resolve which timeframe's bar opens to read for the profile. Under EA v1.54
  // `broker_candles` physically stores nine timeframes, but the profile is built
  // only from the fine-grained STORED_PROFILE_TIMEFRAMES set — optionally DERIVED
  // for a coarser timeframe via PROFILE_SOURCE_TIMEFRAME (M30 ← M15: a finer
  // series reproduces the same weekly slot coverage, keeping M30 session-aware).
  // A timeframe that is neither (e.g. H8, W1) returns null here so the caller
  // fails honest (withholds missing) instead of fabricating weekend gaps.
  const readTimeframe = STORED_PROFILE_TIMEFRAMES.has(timeframe)
    ? timeframe
    : (PROFILE_SOURCE_TIMEFRAME[timeframe] ?? null);
  if (readTimeframe == null) {
    // No stored or derivable source — fail honest (caller withholds missing).
    return null;
  }
  try {
    const opens = await readBrokerOpenTimes(symbol, readTimeframe, now);
    const profile = buildWeeklyPresenceProfile(opens, timeframeMs(timeframe));
    profileCache.set(key, { profile, builtAt: now, dayKey });
    return profile;
  } catch {
    return null;
  }
}
