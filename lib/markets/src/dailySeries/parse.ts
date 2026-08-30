// Response parsing for the daily-close adapters. Pure string → bars.
//
// Two things here earn their own file:
//
//   1. BOT-CHALLENGE DETECTION. Several free price endpoints answer HTTP 200
//      with an HTML interstitial ("enable JavaScript to verify your browser").
//      A naive CSV parser reads that as zero rows and reports "no data" — a
//      blocked host disguised as an empty market. `classifyBody` names it, and
//      the adapters return BOT_CHALLENGE. Solving such a challenge is out of
//      scope by policy; being blocked is a finding to report, not to work
//      around.
//
//   2. BLANK CELLS ARE NOT ZEROS. FRED emits a row for every weekday and
//      leaves the value EMPTY on market holidays; other vendors use ".", "N/A"
//      or "null". Every one of those is "no session", and every one of them
//      becomes 0 if fed to Number(). A 0 close makes a −100% return. Blanks are
//      DROPPED and COUNTED, and the count rides in the provenance detail so a
//      reader can see how many rows were non-values rather than wondering.
//
// Pure: no I/O, no clock.

import type { DailyBar } from "./types.js";
import { isValidIsoDate } from "./usEquityCalendar.js";

export type BodyClass = "ok" | "bot_challenge" | "html" | "empty";

const CHALLENGE_MARKERS = [
  "requires javascript to verify",
  "enable javascript and reload",
  "checking your browser",
  "cf-browser-verification",
  "__verify",
  "captcha",
];

/**
 * What kind of body came back, regardless of the HTTP status. A 200 that is
 * HTML when CSV was requested is a failed read.
 */
export function classifyBody(body: string): BodyClass {
  const t = body.trim();
  if (t.length === 0) return "empty";
  const head = t.slice(0, 4000).toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<head")) {
    return CHALLENGE_MARKERS.some((m) => head.includes(m)) ? "bot_challenge" : "html";
  }
  if (CHALLENGE_MARKERS.some((m) => head.includes(m))) return "bot_challenge";
  return "ok";
}

/** Values a vendor uses to mean "no observation". Never parsed as a price. */
const NON_VALUES = new Set(["", ".", "na", "n/a", "null", "nan", "-"]);

export function isNonValue(cell: string): boolean {
  return NON_VALUES.has(cell.trim().toLowerCase());
}

export interface CsvParseOk {
  bars: DailyBar[];
  /** Rows present but carrying no value — dropped, never zeroed. */
  blankRows: number;
  /** Rows whose date cell was not a real ISO date — dropped and counted. */
  unparsableRows: number;
  header: string[];
}

export type CsvParseResult = CsvParseOk | { error: string };

function splitCsvLine(line: string): string[] {
  // Daily-close CSVs from these sources are comma-separated with no quoted
  // fields. A quoted field would signal a different format than expected, so it
  // is surfaced as an error rather than half-parsed.
  return line.split(",").map((c) => c.trim());
}

/**
 * Parse a simple `date,value[,…]` CSV.
 *
 * @param dateHeaders  acceptable names for the date column (case-insensitive).
 * @param valueHeader  the close column name, or a 0-based index when the
 *                     source's header is the series id (FRED) rather than a
 *                     fixed word.
 */
export function parseDateValueCsv(
  body: string,
  opts: { dateHeaders: readonly string[]; valueColumn: string | number },
): CsvParseResult {
  if (body.includes('"')) {
    return { error: "CSV contains quoted fields — not the flat date,value shape this adapter expects" };
  }
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return { error: `CSV has ${lines.length} non-empty line(s) — no data rows` };

  const header = splitCsvLine(lines[0]!);
  const lowerHeader = header.map((h) => h.toLowerCase());
  const dateIdx = lowerHeader.findIndex((h) => opts.dateHeaders.some((d) => d.toLowerCase() === h));
  if (dateIdx < 0) {
    return { error: `no date column among [${header.join(", ")}]; expected one of [${opts.dateHeaders.join(", ")}]` };
  }
  const valueColumn = opts.valueColumn;
  let valueIdx: number;
  if (typeof valueColumn === "number") {
    valueIdx = valueColumn;
  } else {
    const wanted = valueColumn.toLowerCase();
    valueIdx = lowerHeader.findIndex((h) => h === wanted);
    if (valueIdx < 0) return { error: `no "${valueColumn}" column among [${header.join(", ")}]` };
  }
  if (valueIdx >= header.length) {
    return { error: `value column index ${valueIdx} is past the ${header.length}-column header` };
  }

  const bars: DailyBar[] = [];
  let blankRows = 0;
  let unparsableRows = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    const rawDate = cells[dateIdx] ?? "";
    const rawValue = cells[valueIdx] ?? "";
    const date = normaliseDate(rawDate);
    if (date === null) {
      unparsableRows++;
      continue;
    }
    if (isNonValue(rawValue)) {
      blankRows++;
      continue;
    }
    const close = Number(rawValue);
    if (!Number.isFinite(close)) {
      unparsableRows++;
      continue;
    }
    bars.push({ date, close });
  }
  return { bars, blankRows, unparsableRows, header };
}

/**
 * Accepts `yyyy-mm-dd` and `yyyymmdd`. Returns null for anything else —
 * including a US `m/d/yyyy`, which is deliberately REFUSED rather than guessed
 * at, because `03/04/2016` is two different days depending on the vendor.
 */
export function normaliseDate(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{8}$/.test(s)) {
    const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    return isValidIsoDate(iso) ? iso : null;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const iso = s.slice(0, 10);
    return isValidIsoDate(iso) ? iso : null;
  }
  return null;
}

/** Ascending by date. Adapters sort; the integrity guard still checks. */
export function sortBars(bars: DailyBar[]): DailyBar[] {
  return [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Keep only bars inside an inclusive ISO range. */
export function clipToRange(bars: readonly DailyBar[], from: string, to: string): DailyBar[] {
  return bars.filter((b) => b.date >= from && b.date <= to);
}
