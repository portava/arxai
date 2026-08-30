// US equity DAILY trading calendar — which dates a US cash-equity session
// exists on. Declared rule set, stated as a rule set.
//
// WHY THIS FILE EXISTS SEPARATELY FROM ../calendar.ts
// ---------------------------------------------------
// `getTradingCalendar` deliberately returns `null` for EQUITY_RTH: it holds a
// weekly intraday schedule and has no honest per-exchange session table, so it
// refuses rather than handing equities the FX 24×5 window. That refusal is
// correct and is NOT weakened here. This module answers a different, coarser,
// and answerable question: on which DATES does a NYSE/Nasdaq session exist?
// Daily-close gap detection needs exactly that and nothing finer.
//
// PROVENANCE OF THE RULES
// -----------------------
// Everything below is DECLARED — a rule set written down here, not a feed. The
// recurring holidays are the published NYSE/Nasdaq rule (same full-closure
// schedule on both exchanges). The special closures are the individually-named
// market-wide closures inside the supported span. Both are stamped so a caller
// can see it is reading an assumption, however well-founded.
//
// SUPPORTED SPAN. The rules are asserted only for 1998-01-01 .. 2026-12-31 —
// MLK became a market holiday in 1998, Juneteenth in 2022, and the special
// closure list is only enumerated over this span. `expectedTradingDays` REFUSES
// a range outside it rather than extrapolating: a calendar that silently keeps
// answering past its own knowledge is how a fabricated holiday becomes a
// fabricated gap becomes a fabricated return.
//
// EARLY CLOSES ARE NOT MODELLED and do not need to be: a 1pm session still
// produces a daily bar, so a half day is a trading day for this purpose.
//
// Pure: no I/O, no clock, no randomness.

import { ISO_DATE_RE } from "./types.js";

export const US_EQUITY_CALENDAR_SUPPORTED = { from: "1998-01-01", to: "2026-12-31" } as const;

/** Rule-set identity — folded into the integrity report so a report names the calendar it used. */
export const US_EQUITY_CALENDAR_RULESET = "US_EQUITY_NYSE_NASDAQ_FULL_CLOSURES_V1";

/**
 * Market-wide full closures that no recurring rule generates. Each is a named,
 * dated event; the list is exhaustive over the supported span.
 */
export const US_EQUITY_SPECIAL_CLOSURES: Readonly<Record<string, string>> = Object.freeze({
  "2001-09-11": "September 11 attacks — markets closed",
  "2001-09-12": "September 11 attacks — markets closed",
  "2001-09-13": "September 11 attacks — markets closed",
  "2001-09-14": "September 11 attacks — markets closed",
  "2004-06-11": "National day of mourning — President Reagan",
  "2007-01-02": "National day of mourning — President Ford",
  "2012-10-29": "Hurricane Sandy",
  "2012-10-30": "Hurricane Sandy",
  "2018-12-05": "National day of mourning — President G.H.W. Bush",
  "2025-01-09": "National day of mourning — President Carter",
});

// ── date helpers (UTC-only; a session date has no time zone here) ────────────

function utc(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d);
}

export function isoOf(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function msOfIso(iso: string): number {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  return utc(y, m, d);
}

/** True for a syntactically valid ISO date that round-trips (rejects 2005-02-30). */
export function isValidIsoDate(iso: string): boolean {
  if (!ISO_DATE_RE.test(iso)) return false;
  return isoOf(msOfIso(iso)) === iso;
}

const DAY_MS = 86_400_000;

/** 0=Sunday … 6=Saturday. */
function dow(ms: number): number {
  return new Date(ms).getUTCDay();
}

/** nth (1-based) weekday `wd` of month. */
function nthWeekday(y: number, m: number, wd: number, n: number): number {
  const first = utc(y, m, 1);
  const shift = (wd - dow(first) + 7) % 7;
  return first + (shift + (n - 1) * 7) * DAY_MS;
}

/** Last weekday `wd` of month. */
function lastWeekday(y: number, m: number, wd: number): number {
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = utc(y, m, lastDay);
  const back = (dow(last) - wd + 7) % 7;
  return last - back * DAY_MS;
}

/**
 * The observed date for a fixed-date holiday: Saturday shifts BACK to Friday,
 * Sunday shifts FORWARD to Monday. NYSE applies this to New Year's Day,
 * Juneteenth, Independence Day and Christmas.
 *
 * One documented exception, and it is the reason this is not a one-liner: when
 * January 1 falls on a SATURDAY the NYSE does NOT close the preceding Friday
 * (December 31), because that Friday belongs to the prior year's session count.
 * `null` says "no closure this year", not "closure on some day I guessed".
 */
function observed(ms: number, opts?: { noSaturdayShiftBack?: boolean }): number | null {
  const d = dow(ms);
  if (d === 6) return opts?.noSaturdayShiftBack ? null : ms - DAY_MS;
  if (d === 0) return ms + DAY_MS;
  return ms;
}

/** Gregorian Easter Sunday (Anonymous Gregorian computus). */
export function easterSunday(y: number): number {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(y, month, day);
}

/**
 * Every recurring full-closure holiday observed in calendar year `y`, as ISO
 * dates. Weekend-falling holidays that are not observed are simply absent.
 */
export function usEquityHolidaysForYear(y: number): string[] {
  const out: number[] = [];
  const push = (ms: number | null) => {
    if (ms !== null) out.push(ms);
  };

  push(observed(utc(y, 1, 1), { noSaturdayShiftBack: true })); // New Year's Day
  if (y >= 1998) push(nthWeekday(y, 1, 1, 3)); // MLK Day — 3rd Monday of January
  push(nthWeekday(y, 2, 1, 3)); // Washington's Birthday — 3rd Monday of February
  push(easterSunday(y) - 2 * DAY_MS); // Good Friday
  push(lastWeekday(y, 5, 1)); // Memorial Day — last Monday of May
  if (y >= 2022) push(observed(utc(y, 6, 19))); // Juneteenth
  push(observed(utc(y, 7, 4))); // Independence Day
  push(nthWeekday(y, 9, 1, 1)); // Labor Day — 1st Monday of September
  push(nthWeekday(y, 11, 4, 4)); // Thanksgiving — 4th Thursday of November
  push(observed(utc(y, 12, 25))); // Christmas

  // A holiday can only be observed inside its own year (the Jan-1-on-Saturday
  // case is the only cross-year candidate and it is refused above).
  return out
    .map(isoOf)
    .filter((iso) => Number(iso.slice(0, 4)) === y)
    .sort();
}

const holidayCache = new Map<number, Set<string>>();

function holidaySet(y: number): Set<string> {
  let s = holidayCache.get(y);
  if (s === undefined) {
    s = new Set(usEquityHolidaysForYear(y));
    holidayCache.set(y, s);
  }
  return s;
}

export interface NonTradingReason {
  kind: "WEEKEND" | "HOLIDAY" | "SPECIAL_CLOSURE";
  detail: string;
}

/**
 * Why this date has no US equity session, or `null` if it does.
 * Throws on a malformed date — a bad date is a caller bug, not a closed market.
 */
export function usEquityNonTradingReason(iso: string): NonTradingReason | null {
  if (!isValidIsoDate(iso)) throw new Error(`usEquityNonTradingReason: not a valid ISO date: ${iso}`);
  const special = US_EQUITY_SPECIAL_CLOSURES[iso];
  if (special !== undefined) return { kind: "SPECIAL_CLOSURE", detail: special };
  const d = dow(msOfIso(iso));
  if (d === 0 || d === 6) return { kind: "WEEKEND", detail: d === 0 ? "Sunday" : "Saturday" };
  if (holidaySet(Number(iso.slice(0, 4))).has(iso)) {
    return { kind: "HOLIDAY", detail: "recurring NYSE/Nasdaq full-closure holiday" };
  }
  return null;
}

export function isUsEquityTradingDay(iso: string): boolean {
  return usEquityNonTradingReason(iso) === null;
}

export type CalendarSpanRefusal = {
  refused: true;
  code: "CALENDAR_SPAN_UNSUPPORTED";
  detail: string;
};

/**
 * Every expected session date in [from, to], inclusive.
 *
 * REFUSES a range outside the supported span instead of extrapolating. An
 * extrapolated holiday rule is an invented non-trading day, and an invented
 * non-trading day silently deletes a real bar from a gap report.
 */
export function expectedTradingDays(from: string, to: string): string[] | CalendarSpanRefusal {
  if (!isValidIsoDate(from) || !isValidIsoDate(to)) {
    return { refused: true, code: "CALENDAR_SPAN_UNSUPPORTED", detail: `malformed range ${from}..${to}` };
  }
  if (from > to) {
    return { refused: true, code: "CALENDAR_SPAN_UNSUPPORTED", detail: `inverted range ${from}..${to}` };
  }
  if (from < US_EQUITY_CALENDAR_SUPPORTED.from || to > US_EQUITY_CALENDAR_SUPPORTED.to) {
    return {
      refused: true,
      code: "CALENDAR_SPAN_UNSUPPORTED",
      detail:
        `requested ${from}..${to} but ${US_EQUITY_CALENDAR_RULESET} is asserted only over ` +
        `${US_EQUITY_CALENDAR_SUPPORTED.from}..${US_EQUITY_CALENDAR_SUPPORTED.to} — ` +
        "extending it is a rules update, not an inference",
    };
  }
  const out: string[] = [];
  for (let ms = msOfIso(from); ms <= msOfIso(to); ms += DAY_MS) {
    const iso = isoOf(ms);
    if (usEquityNonTradingReason(iso) === null) out.push(iso);
  }
  return out;
}

export function isCalendarSpanRefusal(v: unknown): v is CalendarSpanRefusal {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { code?: unknown }).code === "CALENDAR_SPAN_UNSUPPORTED"
  );
}
