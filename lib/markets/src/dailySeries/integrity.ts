// DATA INTEGRITY GUARD — the gate every series must pass before it can feed C8.
//
// THE ONE RULE
// ------------
// A series that fails ANY check is REFUSED, whole, with a typed reason. It is
// never trimmed to the clean part, never interpolated across a gap, never
// re-sorted, and never "mostly fine". Every one of those repairs is a decision
// about what the market did on a day we have no record of, and a backtest built
// on such a decision is measuring the repair.
//
// A refusal is a real, useful outcome: it tells the owner exactly which dates
// to go and get. Silence about a hole is the failure mode this guard exists to
// prevent.
//
// WHAT IS CHECKED, AND WHY EACH ONE IS A REAL DEFECT
// --------------------------------------------------
//   PROVENANCE_INCOMPLETE   — a bar set that cannot say what it is.
//   ADJUSTMENT_UNKNOWN      — "unknown" adjustment. Over 20 years an
//                             unadjusted and an adjusted equity series are
//                             different instruments; guessing which one you
//                             hold is the guess this repository forbids.
//   MALFORMED_DATE          — non-ISO or non-existent (2015-02-30).
//   NON_POSITIVE_PRICE      — close ≤ 0 or non-finite. Vendors emit 0 and
//                             empty cells for non-trading days; a 0 close
//                             produces an infinite return.
//   DUPLICATE_DATE          — two bars for one session. Silently keeping
//                             either one is picking a price.
//   OUT_OF_ORDER            — descending or shuffled rows. Several sources
//                             ship newest-first; a caller that assumes
//                             ascending computes every return backwards.
//   NON_TRADING_DAY_BAR     — a bar on a date the calendar says had no
//                             session. Means the calendar and the data
//                             disagree — wrong exchange, wrong instrument, or
//                             a vendor placeholder row.
//   MISSING_TRADING_DAY     — an expected session with no bar. THE gap check.
//   SUSPICIOUS_JUMP         — |log return| over the declared threshold.
//                             Calibrated to catch an unadjusted split
//                             (2:1 ≈ −0.69 in logs) without firing on real
//                             crash days (the worst S&P/Nasdaq daily moves of
//                             2008 and 2020 are inside ±0.14).
//   COVERAGE_SHORT          — the series does not span a window the caller
//                             declared it must cover.
//   CALENDAR_SPAN_UNSUPPORTED — the calendar refuses to assert over this range.
//
// Pure: no I/O, no clock, no randomness.

import type { DailyBar, DailySeries } from "./types.js";
import { ISO_DATE_RE } from "./types.js";
import {
  expectedTradingDays,
  isCalendarSpanRefusal,
  isValidIsoDate,
  usEquityNonTradingReason,
  US_EQUITY_CALENDAR_RULESET,
} from "./usEquityCalendar.js";

/**
 * Default |log return| ceiling. 0.25 ≈ a −22% / +28% single day.
 *
 * Reference points, so the number is a judgement made in public rather than a
 * magic constant: the worst S&P 500 close-to-close day of 2008 is about −0.095
 * in logs and of 2020 about −0.13; a 2:1 split shows as −0.69 and a 4:1 as
 * −1.39 in an unadjusted series. 0.25 sits in the empty band between the two
 * populations.
 */
export const DEFAULT_MAX_ABS_LOG_JUMP = 0.25;

/** Cap on dates listed per defect — a report, not a data dump. */
const SAMPLE_CAP = 12;

export type IntegrityDefectCode =
  | "EMPTY"
  | "PROVENANCE_INCOMPLETE"
  | "ADJUSTMENT_UNKNOWN"
  | "MALFORMED_DATE"
  | "NON_POSITIVE_PRICE"
  | "DUPLICATE_DATE"
  | "OUT_OF_ORDER"
  | "NON_TRADING_DAY_BAR"
  | "MISSING_TRADING_DAY"
  | "SUSPICIOUS_JUMP"
  | "COVERAGE_SHORT"
  | "CALENDAR_SPAN_UNSUPPORTED";

export interface IntegrityDefect {
  code: IntegrityDefectCode;
  /** How many instances of this defect exist in total. */
  count: number;
  /** Up to SAMPLE_CAP offending dates (or identifiers), for the report. */
  sample: string[];
  detail: string;
}

export interface RequiredCoverage {
  /** Name shown in the defect detail, e.g. "fitWindow". */
  label: string;
  start: string;
  end: string;
}

export interface IntegrityOptions {
  /** Windows the series MUST span. Coverage is checked, never assumed. */
  requiredCoverage?: readonly RequiredCoverage[];
  maxAbsLogJump?: number;
  /**
   * Which session calendar the dates are checked against. "us_equity" uses the
   * declared NYSE/Nasdaq full-closure rule set. "none" skips the two
   * calendar-dependent checks and SAYS SO in the report — an honest "not
   * checked", never a silent pass.
   */
  calendar?: "us_equity" | "none";
}

export interface IntegrityReport {
  ok: boolean;
  symbol: string;
  source: string;
  adjustment: string;
  /** Which calendar ruleset the gap check ran against, or "NONE (not checked)". */
  calendarRuleset: string;
  barCount: number;
  /** Span of the bars as presented, or null when there are none. */
  span: { start: string; end: string } | null;
  defects: IntegrityDefect[];
  /** Checks that RAN and found nothing — so a report can distinguish
   *  "clean" from "never looked". */
  checksPassed: IntegrityDefectCode[];
  checksSkipped: { code: IntegrityDefectCode; reason: string }[];
  detail: string;
}

function defect(
  code: IntegrityDefectCode,
  instances: string[],
  detail: string,
): IntegrityDefect {
  return { code, count: instances.length, sample: instances.slice(0, SAMPLE_CAP), detail };
}

/**
 * Check a series. Returns a report; `ok` is true only when EVERY check that ran
 * found nothing. Callers must branch on `ok` — there is no partially-usable
 * series here.
 */
export function checkSeriesIntegrity(series: DailySeries, opts: IntegrityOptions = {}): IntegrityReport {
  const defects: IntegrityDefect[] = [];
  const passed: IntegrityDefectCode[] = [];
  const skipped: { code: IntegrityDefectCode; reason: string }[] = [];
  const bars = series.bars;
  const p = series.provenance;
  const calendarMode = opts.calendar ?? "us_equity";
  const maxJump = opts.maxAbsLogJump ?? DEFAULT_MAX_ABS_LOG_JUMP;

  // ── provenance ────────────────────────────────────────────────────────────
  const missingProv: string[] = [];
  for (const k of ["source", "sourceSymbol", "request", "fetchedAt", "adjustment", "termsOfUse"] as const) {
    const v = p?.[k];
    if (typeof v !== "string" || v.length === 0) missingProv.push(k);
  }
  if (missingProv.length > 0) {
    defects.push(
      defect(
        "PROVENANCE_INCOMPLETE",
        missingProv,
        "a bar set that cannot say where it came from is not evidence — every provenance field is required",
      ),
    );
  } else {
    passed.push("PROVENANCE_INCOMPLETE");
  }

  if (p?.adjustment === "unknown") {
    defects.push(
      defect(
        "ADJUSTMENT_UNKNOWN",
        ["adjustment"],
        "adjustment basis is 'unknown' — an unadjusted and an adjusted equity series are different " +
          "instruments over twenty years, and this guard will not pick the flattering reading",
      ),
    );
  } else if (missingProv.length === 0) {
    passed.push("ADJUSTMENT_UNKNOWN");
  }

  // ── shape ─────────────────────────────────────────────────────────────────
  if (bars.length === 0) {
    defects.push(defect("EMPTY", [], "series has no bars — an empty read is a failed read, not a flat market"));
    return report(series, defects, passed, skipped, calendarMode, null);
  }
  passed.push("EMPTY");

  const badDates: string[] = [];
  const badPrices: string[] = [];
  for (const b of bars) {
    if (typeof b.date !== "string" || !ISO_DATE_RE.test(b.date) || !isValidIsoDate(b.date)) {
      badDates.push(String(b.date));
    }
    if (typeof b.close !== "number" || !Number.isFinite(b.close) || b.close <= 0) {
      badPrices.push(`${String(b.date)}=${String(b.close)}`);
    }
  }
  if (badDates.length > 0) {
    defects.push(defect("MALFORMED_DATE", badDates, "dates must be real ISO yyyy-mm-dd session dates"));
  } else {
    passed.push("MALFORMED_DATE");
  }
  if (badPrices.length > 0) {
    defects.push(
      defect(
        "NON_POSITIVE_PRICE",
        badPrices,
        "a close must be a finite positive number — vendors emit 0 and blanks for non-trading days and a 0 close makes returns infinite",
      ),
    );
  } else {
    passed.push("NON_POSITIVE_PRICE");
  }

  // Ordering and duplicates are checked on the presented sequence; a malformed
  // date makes those checks meaningless, so they are SKIPPED and said to be.
  if (badDates.length > 0) {
    skipped.push({ code: "DUPLICATE_DATE", reason: "malformed dates present — ordering checks are meaningless" });
    skipped.push({ code: "OUT_OF_ORDER", reason: "malformed dates present — ordering checks are meaningless" });
    skipped.push({ code: "NON_TRADING_DAY_BAR", reason: "malformed dates present" });
    skipped.push({ code: "MISSING_TRADING_DAY", reason: "malformed dates present" });
    skipped.push({ code: "COVERAGE_SHORT", reason: "malformed dates present" });
  } else {
    const seen = new Map<string, number>();
    const dupes: string[] = [];
    const disorder: string[] = [];
    for (let i = 0; i < bars.length; i++) {
      const d = bars[i]!.date;
      const prevCount = seen.get(d) ?? 0;
      if (prevCount > 0 && !dupes.includes(d)) dupes.push(d);
      seen.set(d, prevCount + 1);
      if (i > 0 && bars[i - 1]!.date >= d) disorder.push(`${bars[i - 1]!.date}->${d}`);
    }
    if (dupes.length > 0) {
      defects.push(
        defect("DUPLICATE_DATE", dupes, "two bars for one session — keeping either one silently picks a price"),
      );
    } else {
      passed.push("DUPLICATE_DATE");
    }
    // A duplicate also trips the >= comparison; only report OUT_OF_ORDER for
    // pairs that are strictly descending, so the two defects stay distinct.
    const strictlyDescending = disorder.filter((s) => {
      const [a, b] = s.split("->") as [string, string];
      return a > b;
    });
    if (strictlyDescending.length > 0) {
      defects.push(
        defect(
          "OUT_OF_ORDER",
          strictlyDescending,
          "bars are not ascending by date — several sources ship newest-first, and a caller that assumes " +
            "ascending computes every return backwards. Sorting here would hide which source did it",
        ),
      );
    } else {
      passed.push("OUT_OF_ORDER");
    }

    // ── calendar-dependent checks ───────────────────────────────────────────
    // Span uses the lexical min/max, not the first/last positions, so a
    // disordered series still gets a truthful span for the calendar query.
    const allDates = bars.map((b) => b.date).sort();
    const lo = allDates[0]!;
    const hi = allDates[allDates.length - 1]!;

    if (calendarMode === "none") {
      skipped.push({ code: "NON_TRADING_DAY_BAR", reason: "calendar:'none' — NOT CHECKED, not passed" });
      skipped.push({ code: "MISSING_TRADING_DAY", reason: "calendar:'none' — NOT CHECKED, not passed" });
    } else {
      const expected = expectedTradingDays(lo, hi);
      if (isCalendarSpanRefusal(expected)) {
        defects.push(defect("CALENDAR_SPAN_UNSUPPORTED", [`${lo}..${hi}`], expected.detail));
        skipped.push({ code: "NON_TRADING_DAY_BAR", reason: "calendar refused the span" });
        skipped.push({ code: "MISSING_TRADING_DAY", reason: "calendar refused the span" });
      } else {
        const onClosedDay: string[] = [];
        for (const d of allDates) {
          const why = usEquityNonTradingReason(d);
          if (why !== null) onClosedDay.push(`${d} (${why.kind}: ${why.detail})`);
        }
        if (onClosedDay.length > 0) {
          defects.push(
            defect(
              "NON_TRADING_DAY_BAR",
              onClosedDay,
              `bars exist on dates ${US_EQUITY_CALENDAR_RULESET} says had no session — the data and the calendar ` +
                "disagree (wrong exchange, wrong instrument, or vendor placeholder rows)",
            ),
          );
        } else {
          passed.push("NON_TRADING_DAY_BAR");
        }

        const have = new Set(allDates);
        const missing = expected.filter((d) => !have.has(d));
        if (missing.length > 0) {
          defects.push(
            defect(
              "MISSING_TRADING_DAY",
              missing,
              `${missing.length} expected session(s) in ${lo}..${hi} have no bar. The series is REFUSED whole: ` +
                "trimming to the clean part changes the window, and interpolating invents a price",
            ),
          );
        } else {
          passed.push("MISSING_TRADING_DAY");
        }
      }
    }

    // ── coverage ────────────────────────────────────────────────────────────
    const req = opts.requiredCoverage ?? [];
    if (req.length === 0) {
      skipped.push({ code: "COVERAGE_SHORT", reason: "caller declared no required windows" });
    } else {
      const short: string[] = [];
      for (const w of req) {
        if (lo > w.start || hi < w.end) {
          short.push(`${w.label} needs ${w.start}..${w.end}, series spans ${lo}..${hi}`);
        }
      }
      if (short.length > 0) {
        defects.push(
          defect(
            "COVERAGE_SHORT",
            short,
            "the series does not span a window the caller declared it must cover — a short series would " +
              "silently evaluate a different period than the one pre-registered",
          ),
        );
      } else {
        passed.push("COVERAGE_SHORT");
      }
    }
  }

  // ── jumps ─────────────────────────────────────────────────────────────────
  if (badPrices.length > 0 || badDates.length > 0) {
    skipped.push({ code: "SUSPICIOUS_JUMP", reason: "malformed dates or non-positive prices present" });
  } else {
    const jumps: string[] = [];
    for (let i = 1; i < bars.length; i++) {
      const a = bars[i - 1]!;
      const b = bars[i]!;
      const lr = Math.log(b.close / a.close);
      if (Math.abs(lr) > maxJump) {
        jumps.push(`${a.date}->${b.date} ${a.close}->${b.close} (log ${lr.toFixed(4)})`);
      }
    }
    if (jumps.length > 0) {
      defects.push(
        defect(
          "SUSPICIOUS_JUMP",
          jumps,
          `|log return| exceeded ${maxJump} — the usual cause is an UNADJUSTED corporate action (a 2:1 split ` +
            "reads as log −0.69). Real crash days do not reach this band. Resolve the cause; do not raise the bar",
        ),
      );
    } else {
      passed.push("SUSPICIOUS_JUMP");
    }
  }

  const sorted = bars.map((b) => b.date).sort();
  return report(series, defects, passed, skipped, calendarMode, {
    start: sorted[0]!,
    end: sorted[sorted.length - 1]!,
  });
}

function report(
  series: DailySeries,
  defects: IntegrityDefect[],
  passed: IntegrityDefectCode[],
  skipped: { code: IntegrityDefectCode; reason: string }[],
  calendarMode: "us_equity" | "none",
  span: { start: string; end: string } | null,
): IntegrityReport {
  const ok = defects.length === 0;
  return {
    ok,
    symbol: series.symbol,
    source: series.provenance?.source ?? "(none)",
    adjustment: series.provenance?.adjustment ?? "(none)",
    calendarRuleset: calendarMode === "us_equity" ? US_EQUITY_CALENDAR_RULESET : "NONE (not checked)",
    barCount: series.bars.length,
    span,
    defects,
    checksPassed: passed,
    checksSkipped: skipped,
    detail: ok
      ? `PASS: ${series.bars.length} bars, ${passed.length} checks ran clean, ${skipped.length} not applicable`
      : `REFUSED: ${defects.map((d) => `${d.code}×${d.count}`).join(", ")} — the series is refused whole, not trimmed`,
  };
}

/** Human-readable multi-line report. Used by the CLIs and the dry run. */
export function formatIntegrityReport(r: IntegrityReport): string {
  const lines: string[] = [];
  lines.push(`  symbol      ${r.symbol}`);
  lines.push(`  source      ${r.source}`);
  lines.push(`  adjustment  ${r.adjustment}`);
  lines.push(`  calendar    ${r.calendarRuleset}`);
  lines.push(`  bars        ${r.barCount}${r.span ? ` spanning ${r.span.start}..${r.span.end}` : ""}`);
  lines.push(`  verdict     ${r.ok ? "PASS" : "REFUSED"}`);
  for (const d of r.defects) {
    lines.push(`  DEFECT ${d.code} ×${d.count}`);
    lines.push(`    ${d.detail}`);
    for (const s of d.sample) lines.push(`      - ${s}`);
    if (d.count > d.sample.length) lines.push(`      … ${d.count - d.sample.length} more`);
  }
  if (r.checksPassed.length > 0) lines.push(`  checks clean  ${r.checksPassed.join(", ")}`);
  for (const s of r.checksSkipped) lines.push(`  NOT CHECKED   ${s.code} — ${s.reason}`);
  return lines.join("\n");
}
