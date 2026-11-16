// Release-time schedule + DST-correct wall-clock → UTC conversion.
//
// FRED's releases/dates feed gives a release DATE only. The US statistical
// agencies publish their release CLOCK times in US Eastern time (BLS CPI and
// the Employment Situation at 08:30 ET, the FOMC statement at 14:00 ET, ...).
// Eastern time is UTC-5 in winter and UTC-4 in summer, so a fixed UTC hour is
// wrong for half the year. This module converts the published ET wall time to
// UTC for that specific date using the IANA zone (Intl, full ICU in Node), which
// is correct on both sides of the DST switch and independent of the host TZ.
//
// A release whose clock time is not on the published schedule stays
// date-precision (`timePrecision: "date"`): it is never given an invented time.

/** Offset (ms) of `timeZone` from UTC at instant `utcMs` (e.g. -4h for EDT). */
export function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(parts["year"]!, parts["month"]! - 1, parts["day"]!, parts["hour"]! % 24, parts["minute"]!, parts["second"]!);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * The UTC instant of wall-clock `hh:mm` on calendar date `ymd` in `timeZone`.
 * Throws on a malformed date/time rather than guessing.
 */
export function zonedWallTimeToUtcIso(ymd: string, hhmm: string, timeZone: string): string {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  const tm = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!dm || !tm) throw new Error(`bad wall time ${ymd} ${hhmm}`);
  const wallAsUtc = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]));
  // Two passes: the offset at the first guess can differ from the offset at the
  // answer when the guess falls across a DST switch.
  let utc = wallAsUtc - zoneOffsetMs(wallAsUtc, timeZone);
  utc = wallAsUtc - zoneOffsetMs(utc, timeZone);
  return new Date(utc).toISOString();
}

export const US_EASTERN = "America/New_York";

/** Published release clock times (US Eastern) for the FRED releases ARX surfaces. */
export const FRED_RELEASE_TIMES_ET: ReadonlyArray<{ re: RegExp; et: string; publisher: string }> = [
  { re: /(federal open market committee|fomc)/i, et: "14:00", publisher: "Federal Reserve Board" },
  { re: /employment situation/i, et: "08:30", publisher: "BLS" },
  { re: /consumer price index/i, et: "08:30", publisher: "BLS" },
  { re: /producer price index/i, et: "08:30", publisher: "BLS" },
  { re: /gross domestic product/i, et: "08:30", publisher: "BEA" },
  { re: /personal income (and|&) outlays|personal consumption expenditures/i, et: "08:30", publisher: "BEA" },
  { re: /retail (and food services )?(sales|trade)|advance monthly sales for retail/i, et: "08:30", publisher: "Census Bureau" },
  { re: /unemployment insurance weekly claims/i, et: "08:30", publisher: "Department of Labor" },
  { re: /job openings and labor turnover/i, et: "10:00", publisher: "BLS" },
  { re: /durable goods/i, et: "08:30", publisher: "Census Bureau" },
  { re: /industrial production/i, et: "09:15", publisher: "Federal Reserve Board" },
  { re: /new residential construction|housing starts/i, et: "08:30", publisher: "Census Bureau" },
  { re: /new residential sales|new home sales/i, et: "10:00", publisher: "Census Bureau" },
  { re: /consumer sentiment/i, et: "10:00", publisher: "University of Michigan" },
];

export interface ScheduledReleaseTime {
  eventTimeUtc: string;
  timePrecision: "exact" | "date";
  timeSource: "official_release_schedule" | "date_only";
  /** Plain statement of where the time came from. */
  timeNote: string;
}

/** Date-only sentinel used when no published time is known (never shown as a clock time). */
export const DATE_ONLY_SENTINEL_SUFFIX = "T00:00:00.000Z";

export function scheduledFredReleaseTime(releaseName: string, ymd: string): ScheduledReleaseTime {
  const hit = FRED_RELEASE_TIMES_ET.find((r) => r.re.test(releaseName));
  if (!hit) {
    return {
      eventTimeUtc: `${ymd}${DATE_ONLY_SENTINEL_SUFFIX}`,
      timePrecision: "date",
      timeSource: "date_only",
      timeNote: "FRED lists the release date only; no published release time is known, so no clock time is shown.",
    };
  }
  return {
    eventTimeUtc: zonedWallTimeToUtcIso(ymd, hit.et, US_EASTERN),
    timePrecision: "exact",
    timeSource: "official_release_schedule",
    timeNote: `${hit.publisher} publishes this release at ${hit.et} US Eastern; converted to UTC for this date (DST-aware).`,
  };
}

/**
 * Whether an event's time is a date-only sentinel. FRED is the only source that
 * can publish a date without a time; a FRED event whose time is not the
 * midnight sentinel carries a real (schedule-derived) release time. With no
 * eventTime given, a FRED event is treated as date-only (fail-safe).
 */
export function isDateOnlyCalendarTime(source: string | null | undefined, eventTime?: Date | string | null): boolean {
  if (!(typeof source === "string" && source.trim().toLowerCase() === "fred")) return false;
  if (eventTime == null) return true;
  const ms = +new Date(eventTime);
  if (!Number.isFinite(ms)) return true;
  return new Date(ms).toISOString().endsWith(DATE_ONLY_SENTINEL_SUFFIX);
}
