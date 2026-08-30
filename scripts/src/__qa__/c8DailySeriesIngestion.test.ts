// C8 daily-close ingestion — adapters, integrity guard, fingerprint, snapshot.
//
// Everything here runs OFFLINE. The adapters take their fetch and their file
// reader as constructor arguments, so every network shape this suite cares
// about — a bot challenge served as HTTP 200, an HTML error page, a truncated
// CSV, a vendor that ships rows newest-first — is exercised with a scripted
// response rather than by hoping a host misbehaves during CI.
//
// What must hold, each with a way to fail:
//   1. PROVENANCE IS MANDATORY. Every adapter stamps source, symbol, the exact
//      request, fetched-at, adjustment and terms; a series missing any of them
//      is REFUSED by the guard, and an "unknown" adjustment is refused too.
//   2. A 200 THAT IS NOT DATA IS A REFUSAL, not an empty market. This is the
//      Stooq shape observed live from the build sandbox on 2026-08-29.
//   3. BLANKS ARE NOT ZEROS. FRED's holiday convention is an empty cell; it is
//      dropped and counted, never parsed as a price.
//   4. THE GUARD REJECTS EACH DEFECT CLASS, one test per class, and refuses the
//      series WHOLE rather than trimming.
//   5. THE FINGERPRINT is stable across formatting and unstable across every
//      change that matters — including the adjustment basis — and does NOT
//      move when only the fetch metadata moves.
//   6. THE CALENDAR is right where it can be checked by hand, and REFUSES to
//      answer outside its supported span.
//   7. A SNAPSHOT that was edited after it was written fails its own
//      fingerprint.
//
// Run: pnpm --filter @workspace/scripts run test:c8-daily-series

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_ABS_LOG_JUMP,
  FileImportSource,
  FredCsvSource,
  StockAnalysisJsonSource,
  StooqCsvSource,
  US_EQUITY_CALENDAR_SUPPORTED,
  checkSeriesIntegrity,
  dataFingerprint,
  expectedTradingDays,
  isCalendarSpanRefusal,
  isSeriesRefusal,
  parseSnapshot,
  provenanceDigest,
  provenanceDigestPreimage,
  serialiseSnapshot,
  usEquityHolidaysForYear,
  usEquityNonTradingReason,
  type DailyBar,
  type DailySeries,
  type FetchLike,
  type IntegrityDefectCode,
  type SeriesProvenance,
} from "@workspace/markets";

const AT = "2026-08-29T00:00:00.000Z";
const RANGE = { from: "2024-01-01", to: "2024-12-31" };

/** A scripted fetch. Every test says exactly what the network returned. */
function scriptedFetch(res: { ok?: boolean; status?: number; body: string }): FetchLike {
  return async () => ({
    ok: res.ok ?? true,
    status: res.status ?? 200,
    text: async () => res.body,
  });
}

function throwingFetch(message: string): FetchLike {
  return async () => {
    throw new Error(message);
  };
}

const GOOD_PROVENANCE: SeriesProvenance = {
  source: "test",
  sourceSymbol: "TEST",
  request: "test://fixture",
  fetchedAt: AT,
  adjustment: "split_dividend_adjusted",
  termsOfUse: "DOCUMENTED_PUBLIC",
  detail: "fixture",
};

function seriesOf(bars: DailyBar[], prov: Partial<SeriesProvenance> = {}): DailySeries {
  return { symbol: "TEST", bars, provenance: { ...GOOD_PROVENANCE, ...prov } };
}

/** A clean run of real session dates at a flat-ish price. */
function cleanBars(from: string, to: string): DailyBar[] {
  const days = expectedTradingDays(from, to);
  assert.ok(!isCalendarSpanRefusal(days), "fixture range must be inside the calendar's span");
  return (days as string[]).map((d, i) => ({ date: d, close: 100 + i * 0.01 }));
}

function codes(r: { defects: { code: IntegrityDefectCode }[] }): IntegrityDefectCode[] {
  return r.defects.map((d) => d.code);
}

// ── 1. provenance is mandatory ───────────────────────────────────────────────

test("every adapter stamps a complete provenance including the exact request", async () => {
  const fred = new FredCsvSource(
    scriptedFetch({ body: "observation_date,NASDAQ100\n2024-01-02,16543.1\n2024-01-03,16368.5\n" }),
  );
  const r = await fred.fetchDailyCloses("NDX", RANGE, AT);
  assert.ok(!isSeriesRefusal(r));
  for (const k of ["source", "sourceSymbol", "request", "fetchedAt", "adjustment", "termsOfUse", "detail"] as const) {
    assert.ok(typeof r.provenance[k] === "string" && r.provenance[k].length > 0, `provenance.${k} must be present`);
  }
  assert.equal(r.provenance.sourceSymbol, "NASDAQ100");
  assert.match(r.provenance.request, /fredgraph\.csv\?id=NASDAQ100/);
  assert.equal(r.provenance.fetchedAt, AT, "fetchedAt is the SUPPLIED instant — this path never reads a clock");
  assert.equal(r.provenance.adjustment, "price_only_index", "a FRED index level must never claim to be an adjusted ETF");
});

test("a series with an incomplete provenance is REFUSED by the guard", () => {
  const bars = cleanBars("2024-01-02", "2024-03-28");
  const r = checkSeriesIntegrity({
    symbol: "TEST",
    bars,
    provenance: { ...GOOD_PROVENANCE, source: "" },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ["PROVENANCE_INCOMPLETE"]);
  assert.deepEqual(r.defects[0]!.sample, ["source"]);
});

test('an "unknown" adjustment is REFUSED — the instrument must be named, not guessed', () => {
  const r = checkSeriesIntegrity(seriesOf(cleanBars("2024-01-02", "2024-03-28"), { adjustment: "unknown" }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("ADJUSTMENT_UNKNOWN"));
});

test("the Stooq adapter defaults to an unknown adjustment, so its series cannot pass unexamined", () => {
  const s = new StooqCsvSource(scriptedFetch({ body: "" }));
  assert.equal(s.adjustment, "unknown");
  assert.equal(s.termsOfUse, "UNVERIFIED");
});

test("a file import records the importer's DECLARED adjustment as declared, not as measured", async () => {
  const src = new FileImportSource(async () => "date,close\n2024-01-02,100\n2024-01-03,101\n", {
    path: "/fixture/spy.csv",
    adjustment: "raw_unadjusted",
    originNote: "downloaded by hand for the test",
  });
  const r = await src.fetchDailyCloses("SPY", RANGE, AT);
  assert.ok(!isSeriesRefusal(r));
  assert.equal(r.provenance.adjustment, "raw_unadjusted");
  assert.match(r.provenance.detail, /DECLARED BY THE IMPORTER/);
  assert.match(r.provenance.detail, /measured nothing/);
  assert.equal(r.provenance.request, "file:/fixture/spy.csv");
});

// ── 2. a 200 that is not data ────────────────────────────────────────────────

test("HTTP 200 carrying a JavaScript browser check is BOT_CHALLENGE, not an empty market", async () => {
  // The exact shape observed live from stooq.com on 2026-08-29.
  const challenge =
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' +
    "<noscript>This site requires JavaScript to verify your browser. Please enable JavaScript and reload.</noscript>" +
    '<script>fetch("/__verify")</script></body></html>';
  const s = new StooqCsvSource(scriptedFetch({ status: 200, body: challenge }));
  const r = await s.fetchDailyCloses("SPY", RANGE, AT);
  assert.ok(isSeriesRefusal(r));
  assert.equal(r.code, "BOT_CHALLENGE");
  assert.match(r.detail, /does not solve bot checks/);
});

test("plain HTML where CSV was expected is NOT_THE_EXPECTED_FORMAT, and an empty body is EMPTY_RESPONSE", async () => {
  const html = new FredCsvSource(scriptedFetch({ body: "<html><body>Service unavailable</body></html>" }));
  const a = await html.fetchDailyCloses("NDX", RANGE, AT);
  assert.ok(isSeriesRefusal(a));
  assert.equal(a.code, "NOT_THE_EXPECTED_FORMAT");

  const empty = new FredCsvSource(scriptedFetch({ body: "   \n  " }));
  const b = await empty.fetchDailyCloses("NDX", RANGE, AT);
  assert.ok(isSeriesRefusal(b));
  assert.equal(b.code, "EMPTY_RESPONSE");
});

test("a non-200 is HTTP_ERROR and a thrown fetch is NETWORK_UNREACHABLE — never a silent empty series", async () => {
  const notFound = new StockAnalysisJsonSource(scriptedFetch({ ok: false, status: 404, body: "nope" }));
  const a = await notFound.fetchDailyCloses("SPY", RANGE, AT);
  assert.ok(isSeriesRefusal(a));
  assert.equal(a.code, "HTTP_ERROR");
  assert.equal(a.status, 404);

  const down = new StockAnalysisJsonSource(throwingFetch("ENOTFOUND"));
  const b = await down.fetchDailyCloses("SPY", RANGE, AT);
  assert.ok(isSeriesRefusal(b));
  assert.equal(b.code, "NETWORK_UNREACHABLE");
});

test("an unmapped symbol is refused rather than guessed into a vendor ticker", async () => {
  const s = new FredCsvSource(scriptedFetch({ body: "should never be requested" }));
  const r = await s.fetchDailyCloses("NOT_A_SYMBOL", RANGE, AT);
  assert.ok(isSeriesRefusal(r));
  assert.equal(r.code, "SYMBOL_NOT_SUPPORTED");
});

// ── 3. blanks are not zeros; newest-first is sorted ──────────────────────────

test("FRED's blank holiday cells are DROPPED and COUNTED, never parsed as a zero price", async () => {
  const body =
    "observation_date,SP500\n" +
    "2024-01-02,4742.83\n" +
    "2024-01-03,4704.81\n" +
    "2024-01-15,\n" + // MLK Day — FRED emits the row with no value
    "2024-01-16,4765.98\n";
  const r = await new FredCsvSource(scriptedFetch({ body })).fetchDailyCloses("SPX", RANGE, AT);
  assert.ok(!isSeriesRefusal(r));
  assert.equal(r.bars.length, 3);
  assert.ok(!r.bars.some((b) => b.date === "2024-01-15"), "the blank row must not become a bar");
  assert.ok(!r.bars.some((b) => b.close === 0), "a blank must never become a zero close");
  assert.match(r.provenance.detail, /1 weekday row\(s\) carried no value/);
});

test("a newest-first vendor is sorted ascending, and the raw/adjusted choice is explicit", async () => {
  const body = JSON.stringify({
    data: [
      { t: "2024-01-04", o: 1, h: 1, l: 1, c: 200, v: 1, a: 190 },
      { t: "2024-01-03", o: 1, h: 1, l: 1, c: 100, v: 1, a: 95 },
    ],
  });
  const adj = await new StockAnalysisJsonSource(scriptedFetch({ body }), "adjusted").fetchDailyCloses("SPY", RANGE, AT);
  assert.ok(!isSeriesRefusal(adj));
  assert.deepEqual(
    adj.bars.map((b) => b.date),
    ["2024-01-03", "2024-01-04"],
    "rows arrive newest-first and must be sorted",
  );
  assert.deepEqual(adj.bars.map((b) => b.close), [95, 190], "adjusted mode evaluates the adjusted close");
  assert.equal(adj.provenance.adjustment, "split_dividend_adjusted");

  const raw = await new StockAnalysisJsonSource(scriptedFetch({ body }), "raw").fetchDailyCloses("SPY", RANGE, AT);
  assert.ok(!isSeriesRefusal(raw));
  assert.deepEqual(raw.bars.map((b) => b.close), [100, 200], "raw mode evaluates the tape print");
  assert.deepEqual(raw.bars.map((b) => b.adjustedClose), [95, 190], "and carries the adjusted close for audit");
  assert.equal(raw.provenance.adjustment, "raw_unadjusted");
});

test("an ambiguous m/d/yyyy date is refused, not guessed", async () => {
  const body = "date,close\n03/04/2024,100\n2024-03-05,101\n2024-03-06,102\n";
  const src = new FileImportSource(async () => body, {
    path: "/fixture/us.csv",
    adjustment: "raw_unadjusted",
    originNote: "test",
  });
  const r = await src.fetchDailyCloses("SPY", RANGE, AT);
  assert.ok(!isSeriesRefusal(r));
  assert.equal(r.bars.length, 2, "03/04/2024 is two different days depending on the vendor — it is dropped");
  assert.match(r.provenance.detail, /1 unparsable row\(s\) dropped/);
});

// ── 4. the guard rejects each defect class ───────────────────────────────────

test("guard: a clean real-calendar series PASSES, and says which checks actually ran", () => {
  const r = checkSeriesIntegrity(seriesOf(cleanBars("2024-01-02", "2024-12-31")), {
    requiredCoverage: [{ label: "window", start: "2024-02-01", end: "2024-11-30" }],
  });
  assert.equal(r.ok, true, r.detail);
  for (const c of [
    "MISSING_TRADING_DAY",
    "NON_TRADING_DAY_BAR",
    "DUPLICATE_DATE",
    "OUT_OF_ORDER",
    "SUSPICIOUS_JUMP",
    "COVERAGE_SHORT",
  ] as const) {
    assert.ok(r.checksPassed.includes(c), `${c} must have RUN and passed, not been skipped`);
  }
});

test("guard: EMPTY — an empty read is a failed read, not a flat market", () => {
  const r = checkSeriesIntegrity(seriesOf([]));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("EMPTY"));
});

test("guard: MISSING_TRADING_DAY — a hole is named, and the series is refused WHOLE", () => {
  const bars = cleanBars("2024-01-02", "2024-03-28");
  const removed = bars.filter((b) => b.date !== "2024-02-14" && b.date !== "2024-02-15");
  const r = checkSeriesIntegrity(seriesOf(removed));
  assert.equal(r.ok, false);
  const d = r.defects.find((x) => x.code === "MISSING_TRADING_DAY");
  assert.ok(d);
  assert.equal(d.count, 2);
  assert.deepEqual(d.sample, ["2024-02-14", "2024-02-15"]);
  assert.match(d.detail, /refused whole/i);
});

test("guard: NON_TRADING_DAY_BAR — the real FRED Good-Friday phantom bar is caught", () => {
  // Not hypothetical: FRED's NASDAQ100 carries 7689.715 on 2019-04-19, which is
  // Good Friday and had no session. Accepting it would shift every subsequent
  // trading-day OFFSET by one and silently move the turn-of-month entry/exit
  // bars for the following month.
  const bars = cleanBars("2019-04-01", "2019-05-31");
  const withPhantom = [...bars, { date: "2019-04-19", close: 7689.715 }].sort((a, b) =>
    a.date < b.date ? -1 : 1,
  );
  const r = checkSeriesIntegrity(seriesOf(withPhantom), { maxAbsLogJump: 100 });
  assert.equal(r.ok, false);
  const d = r.defects.find((x) => x.code === "NON_TRADING_DAY_BAR");
  assert.ok(d);
  assert.match(d.sample.join(" "), /2019-04-19 \(HOLIDAY/);
});

test("guard: DUPLICATE_DATE and OUT_OF_ORDER are distinct defects", () => {
  const bars = cleanBars("2024-01-02", "2024-03-28");
  const dup = [...bars];
  dup.splice(5, 0, { ...bars[5]! });
  const rDup = checkSeriesIntegrity(seriesOf(dup));
  assert.ok(codes(rDup).includes("DUPLICATE_DATE"));
  assert.ok(!codes(rDup).includes("OUT_OF_ORDER"), "a duplicate must not masquerade as disorder");

  const rev = [...bars].reverse();
  const rRev = checkSeriesIntegrity(seriesOf(rev));
  assert.ok(codes(rRev).includes("OUT_OF_ORDER"));
  assert.ok(!codes(rRev).includes("DUPLICATE_DATE"));
});

test("guard: NON_POSITIVE_PRICE — a zero or negative close is refused", () => {
  const bars = cleanBars("2024-01-02", "2024-03-28");
  bars[3] = { date: bars[3]!.date, close: 0 };
  const r = checkSeriesIntegrity(seriesOf(bars));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("NON_POSITIVE_PRICE"));
  assert.ok(
    r.checksSkipped.some((s) => s.code === "SUSPICIOUS_JUMP"),
    "the jump check must be reported as NOT CHECKED rather than silently passed",
  );
});

test("guard: MALFORMED_DATE — 2024-02-30 does not exist", () => {
  const bars = cleanBars("2024-01-02", "2024-03-28");
  bars[2] = { date: "2024-02-30", close: 100 };
  const r = checkSeriesIntegrity(seriesOf(bars));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("MALFORMED_DATE"));
});

test("guard: SUSPICIOUS_JUMP catches an unadjusted split but not a real crash day", () => {
  const split = cleanBars("2024-01-02", "2024-03-28");
  split[10] = { date: split[10]!.date, close: split[9]!.close / 2 }; // a 2:1 split, unadjusted
  for (let i = 11; i < split.length; i++) split[i] = { date: split[i]!.date, close: split[10]!.close + (i - 10) * 0.01 };
  const rSplit = checkSeriesIntegrity(seriesOf(split));
  assert.ok(codes(rSplit).includes("SUSPICIOUS_JUMP"));

  const crash = cleanBars("2024-01-02", "2024-03-28");
  crash[10] = { date: crash[10]!.date, close: crash[9]!.close * 0.88 }; // −12%, worse than any 2008 or 2020 day
  for (let i = 11; i < crash.length; i++) crash[i] = { date: crash[i]!.date, close: crash[10]!.close + (i - 10) * 0.01 };
  const rCrash = checkSeriesIntegrity(seriesOf(crash));
  assert.ok(
    !codes(rCrash).includes("SUSPICIOUS_JUMP"),
    `a −12% day must not trip a threshold of ${DEFAULT_MAX_ABS_LOG_JUMP}`,
  );
});

test("guard: COVERAGE_SHORT — a series that cannot span the declared window is refused", () => {
  const r = checkSeriesIntegrity(seriesOf(cleanBars("2024-01-02", "2024-06-28")), {
    requiredCoverage: [{ label: "holdoutWindow", start: "2024-01-01", end: "2024-12-31" }],
  });
  assert.equal(r.ok, false);
  const d = r.defects.find((x) => x.code === "COVERAGE_SHORT");
  assert.ok(d);
  assert.match(d.sample[0]!, /holdoutWindow needs 2024-01-01\.\.2024-12-31/);
});

test('guard: calendar:"none" reports the gap checks as NOT CHECKED, never as passed', () => {
  const bars = cleanBars("2024-01-02", "2024-03-28").filter((b) => b.date !== "2024-02-14");
  const r = checkSeriesIntegrity(seriesOf(bars), { calendar: "none" });
  assert.equal(r.ok, true, "with no calendar there is nothing to compare against");
  assert.ok(!r.checksPassed.includes("MISSING_TRADING_DAY"));
  const skipped = r.checksSkipped.find((s) => s.code === "MISSING_TRADING_DAY");
  assert.ok(skipped);
  assert.match(skipped.reason, /NOT CHECKED, not passed/);
  assert.equal(r.calendarRuleset, "NONE (not checked)");
});

// ── 5. the fingerprint ───────────────────────────────────────────────────────

test("fingerprint: stable across price formatting, unstable across every change that matters", () => {
  const bars: DailyBar[] = [
    { date: "2024-01-02", close: 100.1 },
    { date: "2024-01-03", close: 101.25 },
  ];
  const base = dataFingerprint({ symbol: "SPY", adjustment: "split_dividend_adjusted", bars });

  assert.equal(
    dataFingerprint({
      symbol: "SPY",
      adjustment: "split_dividend_adjusted",
      bars: [
        { date: "2024-01-02", close: 100.10000 },
        { date: "2024-01-03", close: 101.25 },
      ],
    }),
    base,
    "100.1 and 100.10000 are the same price",
  );

  assert.equal(
    dataFingerprint({
      symbol: "SPY",
      adjustment: "split_dividend_adjusted",
      // adjustedClose is carried for audit and is NOT what the evaluation reads
      bars: bars.map((b) => ({ ...b, adjustedClose: 12345 })),
    }),
    base,
    "a column the evaluation never reads must not change the identity of the data",
  );

  const changed: Array<[string, string]> = [
    ["a price", dataFingerprint({ symbol: "SPY", adjustment: "split_dividend_adjusted", bars: [bars[0]!, { date: "2024-01-03", close: 101.26 }] })],
    ["a date", dataFingerprint({ symbol: "SPY", adjustment: "split_dividend_adjusted", bars: [bars[0]!, { date: "2024-01-04", close: 101.25 }] })],
    ["the order", dataFingerprint({ symbol: "SPY", adjustment: "split_dividend_adjusted", bars: [bars[1]!, bars[0]!] })],
    ["the symbol", dataFingerprint({ symbol: "QQQ", adjustment: "split_dividend_adjusted", bars })],
    ["the adjustment basis", dataFingerprint({ symbol: "SPY", adjustment: "raw_unadjusted", bars })],
    ["a dropped bar", dataFingerprint({ symbol: "SPY", adjustment: "split_dividend_adjusted", bars: [bars[0]!] })],
  ];
  for (const [what, fp] of changed) {
    assert.notEqual(fp, base, `changing ${what} must change the fingerprint`);
  }
});

test("fingerprint: a non-finite price has no identity — it throws rather than hashing a fabrication", () => {
  assert.throws(
    () => dataFingerprint({ symbol: "SPY", adjustment: "raw_unadjusted", bars: [{ date: "2024-01-02", close: Number.NaN }] }),
    /non-finite/,
  );
});

// ── 6. the calendar ──────────────────────────────────────────────────────────

test("calendar: hand-checkable holidays, including the observed-day shifts", () => {
  // 2021-01-01 was a Friday: New Year's Day observed on the day itself.
  assert.equal(usEquityNonTradingReason("2021-01-01")?.kind, "HOLIDAY");
  // 2022-01-01 was a Saturday. NYSE does NOT close the preceding Friday.
  assert.equal(usEquityNonTradingReason("2021-12-31"), null);
  // Independence Day 2021 fell on a Sunday, observed Monday the 5th.
  assert.equal(usEquityNonTradingReason("2021-07-05")?.kind, "HOLIDAY");
  assert.equal(usEquityNonTradingReason("2021-07-04")?.kind, "WEEKEND");
  // Juneteenth is a market holiday only from 2022.
  assert.equal(usEquityNonTradingReason("2021-06-18"), null);
  assert.equal(usEquityNonTradingReason("2022-06-20")?.kind, "HOLIDAY");
  // Good Friday 2019 (Easter was 2019-04-21).
  assert.equal(usEquityNonTradingReason("2019-04-19")?.kind, "HOLIDAY");
  // Named special closures.
  assert.equal(usEquityNonTradingReason("2012-10-29")?.kind, "SPECIAL_CLOSURE");
  assert.equal(usEquityNonTradingReason("2018-12-05")?.kind, "SPECIAL_CLOSURE");
  assert.equal(usEquityNonTradingReason("2025-01-09")?.kind, "SPECIAL_CLOSURE");
  // 2007-01-02 was the Ford day of mourning — the year's first session was the 3rd.
  assert.equal(usEquityNonTradingReason("2007-01-02")?.kind, "SPECIAL_CLOSURE");
  assert.equal(usEquityNonTradingReason("2007-01-03"), null);
});

test("calendar: a US equity year has 9 or 10 recurring holidays, and 2024 is exactly right", () => {
  assert.deepEqual(usEquityHolidaysForYear(2024), [
    "2024-01-01", // New Year's Day (Monday)
    "2024-01-15", // MLK
    "2024-02-19", // Washington's Birthday
    "2024-03-29", // Good Friday
    "2024-05-27", // Memorial Day
    "2024-06-19", // Juneteenth
    "2024-07-04", // Independence Day
    "2024-09-02", // Labor Day
    "2024-11-28", // Thanksgiving
    "2024-12-25", // Christmas
  ]);
  for (let y = 2005; y <= 2026; y++) {
    const n = usEquityHolidaysForYear(y).length;
    assert.ok(n >= 8 && n <= 10, `${y} produced ${n} holidays`);
  }
});

test("calendar: REFUSES outside its supported span instead of extrapolating", () => {
  const before = expectedTradingDays("1990-01-01", "1990-12-31");
  assert.ok(isCalendarSpanRefusal(before));
  assert.match(before.detail, /asserted only over/);
  const after = expectedTradingDays("2026-01-01", "2030-12-31");
  assert.ok(isCalendarSpanRefusal(after));
  assert.equal(US_EQUITY_CALENDAR_SUPPORTED.to, "2026-12-31");
});

// ── 7. snapshots ─────────────────────────────────────────────────────────────

test("snapshot: round-trips, and a snapshot edited after it was written fails its own fingerprint", () => {
  const series = seriesOf(cleanBars("2024-01-02", "2024-03-28"));
  const text = serialiseSnapshot(series);
  const ok = parseSnapshot(text);
  assert.ok(ok.ok);
  assert.equal(ok.series.bars.length, series.bars.length);
  assert.equal(
    ok.fingerprint,
    dataFingerprint({ symbol: series.symbol, adjustment: series.provenance.adjustment, bars: series.bars }),
  );

  const tampered = text.replace(/"close": 100(\D)/, '"close": 999$1');
  assert.notEqual(tampered, text, "the fixture must actually have been edited");
  const bad = parseSnapshot(tampered);
  assert.equal(bad.ok, false);
  assert.equal(bad.ok === false ? bad.code : "", "FINGERPRINT_MISMATCH");
});

// ── 7b. the provenance digest — the licence gate's own tamper-evidence ───────
//
// The bar fingerprint deliberately excludes the provenance so that a re-fetch of
// the same bars keeps the same no-respin identity. The cost of that correct
// choice is that `termsOfUse: "UNVERIFIED"` — an owner gate that is supposed to
// ride WITH the data — sat outside every integrity check the module advertised.
// These are the tests that make the gate's arrival provable, not just its
// departure.

test("snapshot: promoting the UNVERIFIED licence stamp by hand is CAUGHT — the gate is tamper-evident now", () => {
  const series = seriesOf(cleanBars("2024-01-02", "2024-03-28"), { termsOfUse: "UNVERIFIED" });
  const text = serialiseSnapshot(series);
  assert.equal(parseSnapshot(text).ok, true, "the honest snapshot must parse");

  const forged = text.replace('"termsOfUse": "UNVERIFIED"', '"termsOfUse": "DOCUMENTED_PUBLIC"');
  assert.notEqual(forged, text, "the fixture must actually have been edited");

  // The bars are untouched, so the OLD check — the one the module used to have —
  // still passes on this file. That is precisely why a second digest was needed.
  const asJson = JSON.parse(forged) as { fingerprint: string; bars: DailyBar[]; symbol: string };
  assert.equal(
    asJson.fingerprint,
    dataFingerprint({ symbol: asJson.symbol, adjustment: "split_dividend_adjusted", bars: asJson.bars }),
    "the bar fingerprint is untouched by a provenance edit — this is the hole",
  );

  const bad = parseSnapshot(forged);
  assert.equal(bad.ok, false);
  assert.equal(bad.ok === false ? bad.code : "", "PROVENANCE_MISMATCH");
  assert.match(bad.ok === false ? bad.detail : "", /DOCUMENTED_PUBLIC/);
});

test("snapshot: every provenance field is covered — source, request and fetchedAt too, not just the licence", () => {
  const series = seriesOf(cleanBars("2024-01-02", "2024-02-29"));
  const text = serialiseSnapshot(series);
  const edits: Array<[string, string]> = [
    ['"source": "test"', '"source": "a-vendor-with-a-licence"'],
    ['"request": "test://fixture"', '"request": "https://example.invalid/real"'],
    [`"fetchedAt": "${AT}"`, '"fetchedAt": "2020-01-01T00:00:00.000Z"'],
    ['"sourceSymbol": "TEST"', '"sourceSymbol": "SPY"'],
    ['"detail": "fixture"', '"detail": "audited"'],
  ];
  for (const [from, to] of edits) {
    const forged = text.replace(from, to);
    assert.notEqual(forged, text, `the fixture edit ${from} must apply`);
    const r = parseSnapshot(forged);
    assert.equal(r.ok, false, `${from} must be caught`);
    assert.equal(r.ok === false ? r.code : "", "PROVENANCE_MISMATCH");
  }
});

test("snapshot: a snapshot with NO provenanceDigest is MALFORMED — deleting the digest is not a way past it", () => {
  const series = seriesOf(cleanBars("2024-01-02", "2024-02-29"), { termsOfUse: "UNVERIFIED" });
  const o = JSON.parse(serialiseSnapshot(series)) as Record<string, unknown>;
  assert.equal(typeof o.provenanceDigest, "string");
  delete o.provenanceDigest;
  const r = parseSnapshot(JSON.stringify(o));
  assert.equal(r.ok, false);
  assert.equal(r.ok === false ? r.code : "", "MALFORMED");
  assert.match(r.ok === false ? r.detail : "", /provenanceDigest/);
});

test("provenanceDigest: a crafted free-text detail cannot forge a field boundary", () => {
  // `detail` is adapter free text. Without escaping, a detail ending in a
  // newline plus `termsOfUse="DOCUMENTED_PUBLIC"` could make two different
  // provenance blocks share a preimage.
  const honest = { ...GOOD_PROVENANCE, termsOfUse: "UNVERIFIED" as const, detail: "x" };
  const crafted = {
    ...GOOD_PROVENANCE,
    termsOfUse: "UNVERIFIED" as const,
    detail: 'x"\ntermsOfUse="DOCUMENTED_PUBLIC',
  };
  assert.notEqual(provenanceDigest(honest), provenanceDigest(crafted));
  assert.equal(provenanceDigestPreimage(honest).split("\n").length, 8, "version line + 7 fields, always");
  assert.equal(provenanceDigestPreimage(crafted).split("\n").length, 8, "the crafted detail adds no row");
});

test("provenanceDigest: it is NOT a data identity — a re-fetch moves it while dataFingerprint holds", () => {
  const bars = cleanBars("2024-01-02", "2024-02-29");
  const first = seriesOf(bars, { fetchedAt: "2026-01-01T00:00:00.000Z" });
  const later = seriesOf(bars, { fetchedAt: "2026-06-01T00:00:00.000Z" });
  const fp = (s: DailySeries): string =>
    dataFingerprint({ symbol: s.symbol, adjustment: s.provenance.adjustment, bars: s.bars });
  assert.equal(fp(first), fp(later), "the no-respin identity must survive pressing the button twice");
  assert.notEqual(
    provenanceDigest(first.provenance),
    provenanceDigest(later.provenance),
    "the provenance digest must move, which is exactly why it cannot be folded into the fingerprint",
  );
});

test("provenanceDigest: an incomplete provenance has no digest — it throws rather than hashing 'undefined'", () => {
  const broken = { ...GOOD_PROVENANCE } as Partial<SeriesProvenance>;
  delete broken.termsOfUse;
  assert.throws(() => provenanceDigest(broken as SeriesProvenance), /termsOfUse is missing/);
});

test("snapshot: a file-import of an ARX snapshot carries the ORIGINAL provenance forward", async () => {
  const series = seriesOf(cleanBars("2024-01-02", "2024-03-28"), { source: "fred-csv", detail: "the original detail" });
  const text = serialiseSnapshot(series);
  const src = new FileImportSource(async () => text, {
    path: "/fixture/snap.json",
    adjustment: "unknown", // ignored: a snapshot describes itself
    originNote: "re-import",
  });
  const r = await src.fetchDailyCloses("TEST", { from: "2024-01-01", to: "2024-12-31" }, AT);
  assert.ok(!isSeriesRefusal(r));
  assert.equal(r.provenance.source, "fred-csv", "the snapshot's own source survives the re-import");
  assert.equal(r.provenance.adjustment, "split_dividend_adjusted");
  assert.match(r.provenance.detail, /the original detail/);
});
