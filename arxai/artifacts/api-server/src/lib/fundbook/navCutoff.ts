// ARX Fund Book — NAV cutoff / cycle resolution. Pure, no DB, no IO.
// Deterministic and unit-testable in isolation.
//
// RESERVED FOR THE FUTURE CAPITAL MOVEMENTS FLOW (Fund Book task "Capital
// movements & fee engine"). This helper is intentionally standalone and is NOT
// yet wired into any deposit/withdrawal request → approval → settle lifecycle
// (that lifecycle does not exist yet). When that task is built, it will call
// `resolveNavCycle(approvalAt)` at the moment an admin APPROVES a capital
// movement to decide whether the movement is priced at today's NAV cut
// (current cycle) or the next one — it must not be used to move investor
// balances, change live trading settings, or settle units on its own.
//
// Policy this module encodes (overridable via options for the future
// admin-configurable NAV-cutoff setting):
//   - The official NAV cut runs once per day at 5:00 PM America/New_York.
//   - Approved BEFORE 5:00 PM NY  ⇒ CURRENT cycle (priced at today's cut).
//   - Approved AT or AFTER 5:00 PM NY ⇒ NEXT cycle (priced at tomorrow's cut).
//   - Daylight saving time is handled via the IANA "America/New_York" zone, so
//     the wall-clock 5:00 PM cut maps to the correct UTC instant year-round
//     (EDT UTC-04:00 in summer, EST UTC-05:00 in winter).

/** Official NAV cutoff timezone (IANA). */
export const NAV_CUTOFF_TIMEZONE = "America/New_York" as const;
/** Official NAV cutoff hour (24h, local NY time): 5:00 PM. */
export const NAV_CUTOFF_HOUR = 17 as const;
/** Official NAV cutoff minute. */
export const NAV_CUTOFF_MINUTE = 0 as const;

export interface NavCutoffOptions {
  /** Cutoff hour in 24h local time. Defaults to 17 (5:00 PM). */
  cutoffHour?: number;
  /** Cutoff minute. Defaults to 0. */
  cutoffMinute?: number;
  /** IANA timezone for the cut. Defaults to "America/New_York". */
  timeZone?: string;
}

export type NavCycleTiming = "CURRENT_CYCLE" | "NEXT_CYCLE";

export interface NavCycleResolution {
  /** CURRENT_CYCLE if approved before the cut, NEXT_CYCLE if at/after it. */
  timing: NavCycleTiming;
  /** Calendar date (YYYY-MM-DD, in the cutoff zone) whose cut prices this. */
  navCutDate: string;
  /** Exact UTC instant of the NAV cut this movement is priced at. */
  navCutAt: Date;
  /** Local calendar date of the approval (YYYY-MM-DD, in the cutoff zone). */
  approvalLocalDate: string;
  /** Local wall-clock time of the approval (HH:MM:SS, in the cutoff zone). */
  approvalLocalTime: string;
  /** The configured cutoff, e.g. "5:00 PM". */
  cutoffLabel: string;
  /** The cutoff timezone (IANA), e.g. "America/New_York". */
  timeZone: string;
  /** Whether the NAV cut instant falls in daylight saving time. */
  isDstAtCut: boolean;
  /** Zone abbreviation at the cut, e.g. "EDT" / "EST". */
  zoneAbbrevAtCut: string;
  /** UTC offset at the cut, e.g. "-04:00" / "-05:00". */
  utcOffsetAtCut: string;
  /** Plain-English summary for admin / operator visibility. */
  explanation: string;
}

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
}

/** Wall-clock parts of an instant in a given IANA timezone. */
function getZonedParts(instant: Date, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  // Intl with hour12:false can emit "24" for midnight; normalise to 0.
  const hour = Number(map["hour"]) % 24;
  return {
    year: Number(map["year"]),
    month: Number(map["month"]),
    day: Number(map["day"]),
    hour,
    minute: Number(map["minute"]),
    second: Number(map["second"]),
  };
}

/** Timezone offset (ms east of UTC; negative for the Americas) at an instant. */
function getOffsetMs(instantMs: number, timeZone: string): number {
  const p = getZonedParts(new Date(instantMs), timeZone);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - instantMs;
}

/** Convert a wall-clock time in `timeZone` to the corresponding UTC instant. */
function zonedWallTimeToUtc(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  // First guess using the offset at the naive instant, then refine once so DST
  // boundaries (spring-forward / fall-back) resolve to the correct instant.
  const offset1 = getOffsetMs(wallAsUtc, timeZone);
  let utcMs = wallAsUtc - offset1;
  const offset2 = getOffsetMs(utcMs, timeZone);
  if (offset2 !== offset1) utcMs = wallAsUtc - offset2;
  return new Date(utcMs);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "YYYY-MM-DD" for a calendar date. */
function isoDate(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Add `days` to a calendar date, returning new {year,month,day}. */
function addCalendarDays(
  year: number,
  month: number,
  day: number,
  days: number,
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Zone abbreviation (e.g. "EDT") at an instant in a timezone. */
function zoneAbbrev(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(
    instant,
  );
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
}

/** "-04:00" style UTC offset at an instant in a timezone. */
function utcOffsetLabel(instant: Date, timeZone: string): string {
  const offsetMs = getOffsetMs(instant.getTime(), timeZone);
  const sign = offsetMs < 0 ? "-" : "+";
  const abs = Math.abs(offsetMs);
  const hours = Math.floor(abs / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  return `${sign}${pad2(hours)}:${pad2(minutes)}`;
}

/**
 * Whether an instant is in DST for a timezone, relative to that year's January
 * (northern/southern-hemisphere-agnostic: DST is whichever offset differs from
 * the January-1 standard reference for the same year).
 */
function isDst(instant: Date, timeZone: string): boolean {
  const p = getZonedParts(instant, timeZone);
  const janRefMs = Date.UTC(p.year, 0, 1, 12, 0, 0);
  const janOffset = getOffsetMs(janRefMs, timeZone);
  const here = getOffsetMs(instant.getTime(), timeZone);
  return here !== janOffset;
}

function formatCutoffLabel(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${pad2(minute)} ${period}`;
}

function formatWallTime(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${pad2(minute)} ${period}`;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatHumanDate(year: number, month: number, day: number): string {
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

/**
 * Resolve which NAV cycle an approved capital movement belongs to.
 *
 * @param approvalAt The instant the movement is APPROVED (any Date / instant).
 * @param options    Optional cutoff overrides (hour/minute/timezone).
 * @throws if `approvalAt` is not a valid Date.
 */
export function resolveNavCycle(approvalAt: Date, options: NavCutoffOptions = {}): NavCycleResolution {
  if (!(approvalAt instanceof Date) || Number.isNaN(approvalAt.getTime())) {
    throw new Error("resolveNavCycle: approvalAt must be a valid Date");
  }
  const timeZone = options.timeZone ?? NAV_CUTOFF_TIMEZONE;
  const cutoffHour = options.cutoffHour ?? NAV_CUTOFF_HOUR;
  const cutoffMinute = options.cutoffMinute ?? NAV_CUTOFF_MINUTE;

  const local = getZonedParts(approvalAt, timeZone);

  // Minutes-of-day comparison against the cutoff (at/after cutoff ⇒ NEXT).
  const approvalMinutes = local.hour * 60 + local.minute + (local.second > 0 ? 1 / 60 : 0);
  const cutoffMinutes = cutoffHour * 60 + cutoffMinute;
  const beforeCutoff = approvalMinutes < cutoffMinutes;
  const timing: NavCycleTiming = beforeCutoff ? "CURRENT_CYCLE" : "NEXT_CYCLE";

  const cutCal = beforeCutoff
    ? { year: local.year, month: local.month, day: local.day }
    : addCalendarDays(local.year, local.month, local.day, 1);

  const navCutAt = zonedWallTimeToUtc(
    cutCal.year,
    cutCal.month,
    cutCal.day,
    cutoffHour,
    cutoffMinute,
    0,
    timeZone,
  );

  const navCutDate = isoDate(cutCal.year, cutCal.month, cutCal.day);
  const approvalLocalDate = isoDate(local.year, local.month, local.day);
  const approvalLocalTime = `${pad2(local.hour)}:${pad2(local.minute)}:${pad2(local.second)}`;
  const cutoffLabel = formatCutoffLabel(cutoffHour, cutoffMinute);
  const zoneAbbrevAtCut = zoneAbbrev(navCutAt, timeZone);
  const utcOffsetAtCut = utcOffsetLabel(navCutAt, timeZone);
  const isDstAtCut = isDst(navCutAt, timeZone);

  const approvalHuman = `${formatHumanDate(local.year, local.month, local.day)} at ${formatWallTime(local.hour, local.minute)} ${zoneAbbrev(approvalAt, timeZone)}`;
  const cutHuman = `${formatHumanDate(cutCal.year, cutCal.month, cutCal.day)} ${cutoffLabel} ${zoneAbbrevAtCut}`;
  const relation = beforeCutoff
    ? `before the ${cutoffLabel} ${timeZone} NAV cut`
    : `at or after the ${cutoffLabel} ${timeZone} NAV cut`;
  const cycleWord = beforeCutoff ? "the current NAV cycle (today's cut)" : "the next NAV cycle (tomorrow's cut)";
  const explanation = `Approved ${approvalHuman} (${relation}); priced at ${cycleWord}: ${cutHuman}.`;

  return {
    timing,
    navCutDate,
    navCutAt,
    approvalLocalDate,
    approvalLocalTime,
    cutoffLabel,
    timeZone,
    isDstAtCut,
    zoneAbbrevAtCut,
    utcOffsetAtCut,
    explanation,
  };
}
