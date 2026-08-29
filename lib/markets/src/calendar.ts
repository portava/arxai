// TradingCalendarService — when an instrument is actually trading, and the
// trading-time measure μ.
//
// WHY μ EXISTS
// ------------
// Volatility accumulates in TRADING time, not wall-clock time. A model that
// scales risk by √(wall-clock elapsed) will size a Friday-evening FX position as
// though the market were about to move for 60 hours, when in fact it is shut for
// 48 of them and the entire move arrives as a single Sunday-open gap. The
// diffusion term and the gap term are different animals and must be measured
// separately:
//
//   μ(t0, t1)     — minutes the market is actually OPEN in [t0, t1). This is the
//                   integral of the openness indicator over wall time, and it is
//                   what the √t diffusion term should scale by.
//   gaps(t0, t1)  — how many session boundaries the horizon crosses. Each one
//                   carries its own jump variance, because price discovery that
//                   happened while the book was shut lands in one print.
//
// Deriv synthetics trade continuously by construction, so μ IS wall-clock
// elapsed for them and gaps is always 0. That is not an approximation — those
// instruments are generated 24/7 and have no session boundary to gap across.
//
// SCOPE: pure arithmetic over UTC instants plus a static lookup into the
// approved-universe data (which venue an instrument belongs to). No I/O, no
// clock reads of its own (every entry point takes the instant as an argument),
// and — deliberately — nothing from the dispatch/gate path. This module cannot
// place, size, or authorise a trade; it answers a question about the clock.
//
// NOT MODELLED (stated rather than silently assumed): market holidays, early
// closes, and broker-specific maintenance windows. `mu` therefore OVERSTATES
// open time across a holiday, which is the conservative direction for a range
// estimate but the wrong direction for a gap count. Wiring a holiday source in
// is a later work order; until then callers must not treat μ as exact across a
// known holiday.
//
// EQUITY_RTH is a venue WITHOUT a calendar here: exchange-traded stocks and
// indices follow per-exchange regular-trading-hours schedules (NYSE ≠ Xetra ≠
// TSE) that this module does not yet hold. Handing them the FX 24×5 window —
// the previous behaviour — silently overstated μ by ~3× and understated gaps
// (every overnight close is a gap for an RTH instrument). `getTradingCalendar`
// therefore returns `null` for EQUITY_RTH: an honest "no calendar", never a
// wrong one. Callers must degrade (refuse the μ-dependent computation), not
// substitute a guess.

import { ARX_TOP_250 } from "./universe.js";
import type { ArxAssetClass } from "./types.js";

/** Venues differ only in their weekly schedule (or, for EQUITY_RTH, in not
 *  having an honest schedule here yet — see the header note). */
export type Venue = "DERIV_SYNTHETIC" | "FX" | "CRYPTO_24_7" | "EQUITY_RTH";

/**
 * The session a UTC instant falls in. Bands are deliberately NON-OVERLAPPING so
 * `sessionOf` has a single answer; the real London/New-York overlap is named as
 * its own band rather than being silently assigned to one of its parents.
 */
export type SessionName =
  | "CONTINUOUS"
  | "ASIA"
  | "LONDON"
  | "LONDON_NY_OVERLAP"
  | "NEW_YORK";

export interface TradingCalendar {
  readonly venue: Venue;
  /** Is the market open at this instant? */
  isOpen(tMs: number): boolean;
  /** Which session this instant falls in, or `null` when the market is shut. */
  sessionOf(tMs: number): SessionName | null;
  /**
   * The next closed→open transition at or after `tMs`, or `null` for a venue
   * that never closes. Returns `tMs` itself only if a transition lands exactly
   * on it; if the market is already open, this is the NEXT open after the
   * current session ends.
   */
  nextOpen(tMs: number): number | null;
  /**
   * The most recent open→closed transition at or before `tMs`, or `null` for a
   * venue that never closes.
   */
  prevClose(tMs: number): number | null;
  /** Minutes the market is open within [t0, t1). Zero when t1 <= t0. */
  muMinutes(t0Ms: number, t1Ms: number): number;
  /** Session boundaries (weekly closes) crossed within (t0, t1]. */
  gapsBetween(t0Ms: number, t1Ms: number): number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const WEEK_MS = 7 * DAY_MS;

/**
 * 1970-01-04 was a Sunday, so this is a Sunday-00:00-UTC-aligned origin. Using
 * it (rather than the Unix epoch, a Thursday) keeps every week-offset
 * calculation free of an alignment fudge.
 */
const SUNDAY_ORIGIN_MS = Date.UTC(1970, 0, 4);

/**
 * The FX week: opens Sunday 22:00 UTC, closes Friday 22:00 UTC — 120 hours, the
 * conventional 24×5. Expressed as an offset from the Sunday origin so the whole
 * schedule is one half-open interval per week.
 *
 * These two constants are the calendar's only judgement calls; brokers differ by
 * an hour or two around the rollover. They are named here so a venue with a
 * different rollover is a config change, not a rewrite.
 */
export const FX_WEEK_OPEN_MS = 22 * 60 * MINUTE_MS; // Sunday 22:00 UTC
export const FX_WEEK_CLOSE_MS = 5 * DAY_MS + 22 * 60 * MINUTE_MS; // Friday 22:00 UTC

/** Open interval within a week, as [start, end) offsets from Sunday 00:00 UTC. */
interface WeeklyWindow {
  startMs: number;
  endMs: number;
}

const WINDOWS: Partial<Record<Venue, WeeklyWindow>> = {
  // Continuous: the whole week is one open interval.
  DERIV_SYNTHETIC: { startMs: 0, endMs: WEEK_MS },
  FX: { startMs: FX_WEEK_OPEN_MS, endMs: FX_WEEK_CLOSE_MS },
  // Crypto trades continuously too — same window, its own venue tag so the
  // classification is explicit rather than an accident of the synthetic check.
  CRYPTO_24_7: { startMs: 0, endMs: WEEK_MS },
  // EQUITY_RTH deliberately absent — see the header note.
};

/** Zero-based week index since the Sunday origin, and the offset within it. */
function weekOf(tMs: number): { index: number; offsetMs: number } {
  const delta = tMs - SUNDAY_ORIGIN_MS;
  const index = Math.floor(delta / WEEK_MS);
  return { index, offsetMs: delta - index * WEEK_MS };
}

/** Length of the overlap of [0, x) with [a, b). */
function overlapFromZero(x: number, a: number, b: number): number {
  if (x <= a) return 0;
  return Math.min(x, b) - a > 0 ? Math.min(x, b) - a : 0;
}

/**
 * Total open milliseconds from the Sunday origin up to `tMs`. Monotonic in
 * `tMs`, so μ over any interval is just a difference of two of these — no
 * looping, exact for arbitrarily long horizons, and correct for instants before
 * the origin (`Math.floor` handles the negative week index).
 */
function cumulativeOpenMs(tMs: number, w: WeeklyWindow): number {
  const { index, offsetMs } = weekOf(tMs);
  const perWeek = w.endMs - w.startMs;
  return index * perWeek + overlapFromZero(offsetMs, w.startMs, w.endMs);
}

/**
 * Deriv's synthetic families are generated continuously and are not tied to any
 * exchange session. Detection is by name because that is what every ARX surface
 * carries ("Volatility 75 Index", "Boom 500 Index", "Step Index", "R_75").
 */
export function isSyntheticInstrument(instrument: string): boolean {
  const s = instrument.trim().toUpperCase();
  return (
    s.includes("VOLATILITY") ||
    s.includes("BOOM") ||
    s.includes("CRASH") ||
    s.includes("JUMP") ||
    s.includes("STEP") ||
    s.includes("RANGE BREAK") ||
    /\bR_\d+\b/.test(s)
  );
}

/**
 * Uppercased lookup of every name the approved universe knows an instrument
 * by → its asset class. Built lazily once; pure static data, no I/O.
 */
let assetClassIndex: Map<string, ArxAssetClass> | null = null;
function assetClassOf(instrument: string): ArxAssetClass | null {
  if (assetClassIndex === null) {
    assetClassIndex = new Map();
    for (const m of ARX_TOP_250) {
      const names = [m.standardSymbol, ...m.providerSymbols, ...m.brokerAliases, ...m.aliases];
      for (const name of names) {
        const key = name.trim().toUpperCase();
        if (key && !assetClassIndex.has(key)) assetClassIndex.set(key, m.assetClass);
      }
    }
  }
  return assetClassIndex.get(instrument.trim().toUpperCase()) ?? null;
}

/**
 * Which venue's schedule an instrument follows. Synthetics by name (that is
 * what every ARX surface carries); everything else by the approved universe's
 * asset class:
 *
 *   crypto              → CRYPTO_24_7  (continuous — a weekend BTC position IS
 *                                       diffusing; the old FX default said μ=0)
 *   stock / etf / index → EQUITY_RTH   (no honest calendar yet — see header)
 *   forex / metal / energy / commodity → FX 24×5
 *
 * An instrument the universe does not know keeps the FX default — the
 * long-standing behaviour, and the conservative one for the majors-and-metals
 * traffic that actually reaches this module unresolved.
 */
export function venueOf(instrument: string): Venue {
  if (isSyntheticInstrument(instrument)) return "DERIV_SYNTHETIC";
  const assetClass = assetClassOf(instrument);
  if (assetClass === "crypto") return "CRYPTO_24_7";
  if (assetClass === "stock" || assetClass === "etf" || assetClass === "index") {
    return "EQUITY_RTH";
  }
  return "FX";
}

function sessionForOffset(offsetInDayMs: number): SessionName {
  const hour = offsetInDayMs / (60 * MINUTE_MS);
  // Non-overlapping UTC bands. The 12:00–16:00 London/New-York overlap — the
  // highest-liquidity window of the day — is named rather than folded into
  // either neighbour, because "which session" is usually asked in order to
  // reason about liquidity.
  if (hour >= 22 || hour < 7) return "ASIA";
  if (hour < 12) return "LONDON";
  if (hour < 16) return "LONDON_NY_OVERLAP";
  return "NEW_YORK";
}

class WeeklyWindowCalendar implements TradingCalendar {
  constructor(
    readonly venue: Venue,
    private readonly w: WeeklyWindow,
  ) {}

  private get continuous(): boolean {
    return this.w.startMs === 0 && this.w.endMs === WEEK_MS;
  }

  isOpen(tMs: number): boolean {
    if (this.continuous) return true;
    const { offsetMs } = weekOf(tMs);
    return offsetMs >= this.w.startMs && offsetMs < this.w.endMs;
  }

  sessionOf(tMs: number): SessionName | null {
    if (this.continuous) return "CONTINUOUS";
    if (!this.isOpen(tMs)) return null;
    const { offsetMs } = weekOf(tMs);
    return sessionForOffset(offsetMs % DAY_MS);
  }

  nextOpen(tMs: number): number | null {
    if (this.continuous) return null;
    const { index, offsetMs } = weekOf(tMs);
    const weekStart = SUNDAY_ORIGIN_MS + index * WEEK_MS;
    if (offsetMs < this.w.startMs) return weekStart + this.w.startMs;
    return weekStart + WEEK_MS + this.w.startMs;
  }

  prevClose(tMs: number): number | null {
    if (this.continuous) return null;
    const { index, offsetMs } = weekOf(tMs);
    const weekStart = SUNDAY_ORIGIN_MS + index * WEEK_MS;
    if (offsetMs >= this.w.endMs) return weekStart + this.w.endMs;
    return weekStart - WEEK_MS + this.w.endMs;
  }

  muMinutes(t0Ms: number, t1Ms: number): number {
    if (!(t1Ms > t0Ms)) return 0;
    const ms = cumulativeOpenMs(t1Ms, this.w) - cumulativeOpenMs(t0Ms, this.w);
    return ms / MINUTE_MS;
  }

  gapsBetween(t0Ms: number, t1Ms: number): number {
    if (this.continuous) return 0;
    if (!(t1Ms > t0Ms)) return 0;
    // Count weekly close instants in (t0, t1]. Closes sit at `endMs` within each
    // week, so this is a count of week indices whose close lands in the range.
    const closesUpTo = (t: number): number => {
      const { index, offsetMs } = weekOf(t);
      return index + (offsetMs >= this.w.endMs ? 1 : 0);
    };
    return closesUpTo(t1Ms) - closesUpTo(t0Ms);
  }
}

const CALENDARS: Partial<Record<Venue, TradingCalendar>> = {
  DERIV_SYNTHETIC: new WeeklyWindowCalendar("DERIV_SYNTHETIC", WINDOWS.DERIV_SYNTHETIC!),
  FX: new WeeklyWindowCalendar("FX", WINDOWS.FX!),
  CRYPTO_24_7: new WeeklyWindowCalendar("CRYPTO_24_7", WINDOWS.CRYPTO_24_7!),
};

/**
 * The calendar an instrument trades on, or `null` when no honest calendar
 * exists for its venue (EQUITY_RTH today). A caller handed `null` must refuse
 * its μ-dependent computation — substituting another venue's window is exactly
 * the silent-wrong-answer this fix removed. Venue may be forced by the caller.
 */
export function getTradingCalendar(instrument: string, venue?: Venue): TradingCalendar | null {
  return CALENDARS[venue ?? venueOf(instrument)] ?? null;
}

/** Wall-clock minutes in [t0, t1) — the quantity μ must never be confused with. */
export function wallClockMinutes(t0Ms: number, t1Ms: number): number {
  return t1Ms > t0Ms ? (t1Ms - t0Ms) / MINUTE_MS : 0;
}
