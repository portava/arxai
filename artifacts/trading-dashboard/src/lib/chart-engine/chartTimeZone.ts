/**
 * Display time zone for the ARX native chart. Pure helpers only: no
 * lightweight-charts runtime import and no chart-workspace import.
 *
 * The zone is DISPLAY-ONLY. Candle times, drawing anchors, view-link events,
 * data requests, goToTime and replayCountAtClose all stay Unix UTC seconds;
 * these helpers only relabel them and map typed wall-clock input back to a UTC
 * second. No selectable zone represents broker server time.
 */

/** Closed allowlist. "local" is the browser's own zone, resolved once per page. */
export const CHART_TIME_ZONES = [
  "UTC", "local", "America/New_York", "America/Chicago", "Europe/London", "Europe/Berlin",
  "Asia/Dubai", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney",
] as const;
export type ChartTimeZone = typeof CHART_TIME_ZONES[number];

/** Exact, case-sensitive allowlist match. */
export function isChartTimeZone(value: unknown): value is ChartTimeZone {
  return typeof value === "string" && (CHART_TIME_ZONES as readonly string[]).includes(value);
}

/** lightweight-charts TickMarkType numbers (typings.d.ts: Year 0 … TimeWithSeconds 4). */
export type ChartTickMarkType = 0 | 1 | 2 | 3 | 4;

const UTC_ALIASES = new Set(["UTC", "Etc/UTC", "Etc/GMT", "GMT", "Etc/Universal", "Etc/Zulu", "Universal", "Zulu", "Etc/UCT", "UCT", "Etc/Greenwich", "Greenwich", "Etc/GMT0", "Etc/GMT+0", "Etc/GMT-0", "GMT0", "GMT+0", "GMT-0"]);

let cachedBrowserZone: string | null = null;
/** The browser's IANA zone, resolved once and cached for the page. An empty or
 * unusable value caches "UTC", so "Browser local" then reads as UTC. */
export function browserZone(): string {
  if (cachedBrowserZone !== null) return cachedBrowserZone;
  let zone = "UTC";
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof resolved === "string" && resolved) {
      new Intl.DateTimeFormat("en-US", { timeZone: resolved });
      zone = resolved;
    }
  } catch { zone = "UTC"; }
  cachedBrowserZone = UTC_ALIASES.has(zone) ? "UTC" : zone;
  return cachedBrowserZone;
}
/** Test hook: forget the cached browser zone. */
export function __resetBrowserZoneCacheForTests(): void { cachedBrowserZone = null; }

/** The IANA zone to format in. "local" becomes the browser zone; anything
 * unsupported becomes "UTC". */
export function resolveTimeZone(zone: ChartTimeZone | string | undefined, bz?: string): string {
  if (zone === "local") {
    const local = bz ?? browserZone();
    if (!local || UTC_ALIASES.has(local)) return "UTC";
    return formatterFor(local) ? local : "UTC";
  }
  return isChartTimeZone(zone) ? zone : "UTC";
}

const DAILY_TIMEFRAMES = new Set(["D1", "W1", "MN1"]);
/** Daily, weekly and monthly bars are stamped at UTC midnight, so they keep UTC
 * labels: "2026-10-27 20:00 EDT" for the 28 Oct bar would read as the wrong day. */
export function effectiveDisplayZone(zone: ChartTimeZone | undefined, timeframe: string): ChartTimeZone {
  if (DAILY_TIMEFRAMES.has(timeframe)) return "UTC";
  return isChartTimeZone(zone) ? zone : "UTC";
}

/** "UTC" whenever the zone resolves to UTC (including a UTC browser fallback),
 * the IANA id for a named zone, and "Browser local (<zone>)" for local. */
export function zoneShortLabel(zone: ChartTimeZone): string {
  const iana = resolveTimeZone(zone);
  if (iana === "UTC") return "UTC";
  return zone === "local" ? `Browser local (${iana})` : iana;
}

const formatters = new Map<string, Intl.DateTimeFormat | null>();
function formatterFor(iana: string): Intl.DateTimeFormat | null {
  let formatter = formatters.get(iana);
  if (formatter !== undefined) return formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: iana, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short",
    });
  } catch { formatter = null; }
  formatters.set(iana, formatter);
  return formatter;
}

interface WallParts { year: number; month: number; day: number; hour: number; minute: number; second: number; abbr: string }
const pad = (value: number, width = 2) => String(value).padStart(width, "0");

function utcParts(ms: number): WallParts {
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), abbr: "UTC" };
}
/** Wall-clock parts of a whole-second instant in a resolved IANA zone. */
function wallParts(ms: number, iana: string): WallParts {
  if (iana === "UTC") return utcParts(ms);
  const formatter = formatterFor(iana);
  if (!formatter) return utcParts(ms);
  const out: WallParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0, abbr: "" };
  for (const part of formatter.formatToParts(ms)) {
    switch (part.type) {
      case "year": out.year = Number(part.value); break;
      case "month": out.month = Number(part.value); break;
      case "day": out.day = Number(part.value); break;
      case "hour": out.hour = Number(part.value) % 24; break;
      case "minute": out.minute = Number(part.value); break;
      case "second": out.second = Number(part.value); break;
      case "timeZoneName": out.abbr = part.value; break;
    }
  }
  return out;
}
/** The wall clock as if it were a UTC instant (ms). */
function wallAsUtcMs(p: Pick<WallParts, "year" | "month" | "day" | "hour" | "minute" | "second">, ms = 0): number {
  const d = new Date(0);
  d.setUTCFullYear(p.year, p.month - 1, p.day);
  d.setUTCHours(p.hour, p.minute, p.second, ms);
  return d.getTime();
}

const wholeSecondMs = (sec: number) => Math.floor(sec) * 1000;

/** "YYYY-MM-DD HH:MM[:SS] ABBR". Under UTC this is byte-identical to the
 * previous ISO-slice labels for whole-second input; fractions are floored. */
export function formatChartTime(sec: number, zone: ChartTimeZone, options: { seconds?: boolean } = {}): string {
  if (!Number.isFinite(sec)) return "time unavailable";
  const iana = resolveTimeZone(zone);
  const ms = wholeSecondMs(sec);
  if (iana === "UTC") return `${new Date(ms).toISOString().slice(0, options.seconds ? 19 : 16).replace("T", " ")} UTC`;
  const p = wallParts(ms, iana);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}${options.seconds ? `:${pad(p.second)}` : ""} ${p.abbr}`;
}

/** A datetime-local value, "YYYY-MM-DDTHH:MM[:SS]", for an instant in a zone. */
export function toWallClockInput(sec: number, zone: ChartTimeZone, seconds: boolean): string {
  if (!Number.isFinite(sec)) return "";
  const iana = resolveTimeZone(zone);
  const ms = wholeSecondMs(sec);
  if (iana === "UTC") return new Date(ms).toISOString().slice(0, seconds ? 19 : 16);
  const p = wallParts(ms, iana);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}${seconds ? `:${pad(p.second)}` : ""}`;
}

export type WallClockParse = { kind: "ok"; time: number; ambiguous: boolean } | { kind: "gap" } | { kind: "invalid" };
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?$/;

/**
 * Map a typed wall clock in a zone to its UTC second. "gap" is a local time
 * skipped by a clock change (never in UTC); a repeated local time resolves to
 * its earlier occurrence with ambiguous=true. In UTC the result equals
 * Date.parse(`${value}Z`) / 1000 for every value this accepts.
 */
export function parseWallClockInZone(value: string, zone: ChartTimeZone): WallClockParse {
  const match = typeof value === "string" ? WALL_CLOCK.exec(value) : null;
  if (!match) return { kind: "invalid" };
  const wall = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6] ?? 0) };
  const fractionMs = match[7] ? Number(match[7].slice(1).padEnd(3, "0")) : 0;
  const wallMs = wallAsUtcMs(wall);
  const check = utcParts(wallMs);
  if (check.year !== wall.year || check.month !== wall.month || check.day !== wall.day || check.hour !== wall.hour || check.minute !== wall.minute || check.second !== wall.second) {
    return { kind: "invalid" };
  }
  const iana = resolveTimeZone(zone);
  if (iana === "UTC") return { kind: "ok", time: wallAsUtcMs(wall, fractionMs) / 1000, ambiguous: false };
  const offsetAt = (instant: number) => wallAsUtcMs(wallParts(instant, iana)) - instant;
  const DAY = 86_400_000;
  const candidates = new Set<number>();
  for (const probe of [wallMs - DAY, wallMs, wallMs + DAY]) candidates.add(wallMs - offsetAt(probe));
  const valid = [...candidates].filter(instant => wallAsUtcMs(wallParts(instant, iana)) === wallMs).sort((a, b) => a - b);
  if (!valid.length) return { kind: "gap" };
  return { kind: "ok", time: (valid[0]! + fractionMs) / 1000, ambiguous: valid.length > 1 };
}

/** Re-express a typed wall clock from one zone in another; "" when it cannot be. */
export function convertWallClock(value: string, fromZone: ChartTimeZone, toZone: ChartTimeZone, seconds: boolean): string {
  if (!value) return "";
  if (resolveTimeZone(fromZone) === resolveTimeZone(toZone)) return value;
  const parsed = parseWallClockInZone(value, fromZone);
  return parsed.kind === "ok" ? toWallClockInput(parsed.time, toZone, seconds) : "";
}

const monthNames = new Map<string, string>();
/** Short month name as lightweight-charts derives it: a local Date on the 1st,
 * toLocaleString(locale, {month:"short"}). */
function shortMonth(year: number, month: number, locale: string): string {
  const key = `${locale}|${year}|${month}`;
  let name = monthNames.get(key);
  if (name === undefined) {
    const date = new Date(year, month - 1, 1);
    try { name = date.toLocaleString(locale || undefined, { month: "short" }); }
    catch { name = date.toLocaleString("en-US", { month: "short" }); }
    if (monthNames.size > 500) monthNames.clear();
    monthNames.set(key, name);
  }
  return name;
}

/**
 * Axis tick label in the display zone. Under UTC it returns null, so the
 * library default is used unchanged. Elsewhere tick positions stay at the
 * library's UTC boundaries, so day/month/year ticks keep a date context when
 * they do not fall on local midnight. en-US outputs are 8 characters or fewer.
 */
export function tickMarkLabel(sec: number, type: ChartTickMarkType, zone: ChartTimeZone, locale: string): string | null {
  const iana = resolveTimeZone(zone);
  if (iana === "UTC" || !Number.isFinite(sec)) return null;
  const p = wallParts(wholeSecondMs(sec), iana);
  const hm = `${pad(p.hour)}:${pad(p.minute)}`;
  const midnight = p.hour === 0 && p.minute === 0 && p.second === 0;
  switch (type) {
    case 0: return midnight && p.month === 1 && p.day === 1 ? pad(p.year, 4) : `${shortMonth(p.year, p.month, locale)} '${pad(p.year % 100)}`;
    case 1: return midnight && p.day === 1 ? shortMonth(p.year, p.month, locale) : `${pad(p.day)} ${shortMonth(p.year, p.month, locale)}`;
    case 2: return midnight ? pad(p.day) : `${pad(p.day)} ${hm}`;
    case 3: return hm;
    case 4: return `${hm}:${pad(p.second)}`;
    default: return null;
  }
}

/** lightweight-charts' default crosshair date ("dd MMM 'yy"), replicated
 * replacement for replacement (dev.mjs formatDate). */
function libraryDate(p: WallParts, locale: string): string {
  return "dd MMM 'yy"
    .replace(/yyyy/g, pad(p.year, 4))
    .replace(/yy/g, pad(p.year % 100))
    .replace(/MMM/g, shortMonth(p.year, p.month, locale))
    .replace(/MM/g, pad(p.month))
    .replace(/dd/g, pad(p.day));
}

/**
 * Crosshair time-axis label. Under UTC it reproduces the library default for
 * timeVisible:true, secondsVisible:false: "dd MMM 'yy   HH:MM" (3 spaces).
 * Other zones use the same shape from the local wall clock plus " ABBR".
 */
export function crosshairTimeLabel(sec: number, zone: ChartTimeZone, locale: string): string {
  if (!Number.isFinite(sec)) return "";
  const iana = resolveTimeZone(zone);
  const p = wallParts(iana === "UTC" ? sec * 1000 : wholeSecondMs(sec), iana);
  const text = `${libraryDate(p, locale)}   ${pad(p.hour)}:${pad(p.minute)}`;
  return iana === "UTC" ? text : `${text} ${p.abbr}`;
}

/** PNG header capture line. UTC keeps the existing "Captured <ISO>" line. */
export function captureLabel(nowMs: number, zone: ChartTimeZone): string {
  const iso = new Date(nowMs).toISOString();
  if (resolveTimeZone(zone) === "UTC") return `Captured ${iso}`;
  return `Captured ${formatChartTime(nowMs / 1000, zone, { seconds: true })} (${iso})`;
}
