// Source adapter: FRED public graph CSV (fredgraph.csv). No credential.
//
// WHAT THESE SERIES ARE — the part that must not be glossed
// ---------------------------------------------------------
// Every equity series FRED carries here is a PRICE-ONLY INDEX LEVEL. It is not
// a tradable instrument, it has no dividends in it, and it is not an ETF's
// adjusted close. For a 4-session turn-of-month hold the missing dividend is
// small but it is systematically POSITIVE and always in the strategy's favour,
// so a price-only index UNDERSTATES a long strategy's return: the conservative
// direction, but a difference that must be stated rather than absorbed.
//
// COVERAGE IS PER-SERIES AND SOME OF IT IS LICENCE-TRUNCATED. `SP500` and
// `DJIA` return only the trailing ~10 years no matter what start date is
// requested — the licence, enforced upstream. `NASDAQCOM` and `NASDAQ100` carry
// full history. The map below records the OBSERVED behaviour with the date it
// was observed; nothing here assumes a series covers a window, and the
// integrity guard's COVERAGE_SHORT check is what actually enforces it.
//
// FRED emits a row for EVERY WEEKDAY and leaves the value blank on market
// holidays. Those blanks are dropped and counted (see ../parse.ts) — a blank
// is not a zero price.

import type {
  DailySeriesSource,
  FetchLike,
  PriceAdjustment,
  SeriesFetchResult,
  SeriesRange,
} from "../types.js";
import { classifyBody, parseDateValueCsv, sortBars, clipToRange } from "../parse.js";

export interface FredSeriesEntry {
  seriesId: string;
  /** What FRED's own page calls it. */
  title: string;
  /** Observed earliest date available, and when that was observed. */
  observedCoverage: string;
}

/**
 * ARX symbol → FRED series. Explicit, because guessing a vendor ticker from an
 * ARX symbol is exactly the kind of silent substitution that ends with the
 * wrong instrument in a capital decision. An unmapped symbol is REFUSED.
 */
export const FRED_SERIES_MAP: Readonly<Record<string, FredSeriesEntry>> = Object.freeze({
  SPX: {
    seriesId: "SP500",
    title: "S&P 500 index level",
    observedCoverage:
      "LICENCE-TRUNCATED to the trailing ~10 years (observed 2026-08-29: earliest row 2016-08-29 " +
      "even when an earlier start is requested). Does NOT cover a 2005-2015 fit window",
  },
  DJI: {
    seriesId: "DJIA",
    title: "Dow Jones Industrial Average index level",
    observedCoverage: "LICENCE-TRUNCATED to the trailing ~10 years (observed 2026-08-29: earliest row 2016-08-29)",
  },
  NDX: {
    seriesId: "NASDAQ100",
    title: "Nasdaq 100 index level",
    observedCoverage: "full history (observed 2026-08-29: rows from 2004-01-02 and earlier)",
  },
  COMP: {
    seriesId: "NASDAQCOM",
    title: "Nasdaq Composite index level",
    observedCoverage: "full history (observed 2026-08-29: rows from 2004-01-02 and earlier)",
  },
});

export const FRED_BASE = "https://fred.stlouisfed.org/graph/fredgraph.csv";

export function fredRequestUrl(seriesId: string, range: SeriesRange): string {
  const q = new URLSearchParams({ id: seriesId, cosd: range.from, coed: range.to });
  return `${FRED_BASE}?${q.toString()}`;
}

export class FredCsvSource implements DailySeriesSource {
  readonly name = "fred-csv";
  readonly adjustment: PriceAdjustment = "price_only_index";
  readonly termsOfUse = "DOCUMENTED_PUBLIC" as const;

  constructor(private readonly fetchImpl: FetchLike) {}

  async fetchDailyCloses(symbol: string, range: SeriesRange, at: string): Promise<SeriesFetchResult> {
    const entry = FRED_SERIES_MAP[symbol.toUpperCase()];
    if (entry === undefined) {
      return {
        refused: true,
        code: "SYMBOL_NOT_SUPPORTED",
        detail:
          `"${symbol}" has no FRED series mapping. Known: ${Object.keys(FRED_SERIES_MAP).join(", ")}. ` +
          "Guessing a vendor ticker from an ARX symbol is how the wrong instrument gets evaluated",
      };
    }
    const url = fredRequestUrl(entry.seriesId, range);

    let status = 0;
    let body: string;
    try {
      const res = await this.fetchImpl(url, { headers: { accept: "text/csv" } });
      status = res.status;
      body = await res.text();
      if (!res.ok) {
        return { refused: true, code: "HTTP_ERROR", status, detail: `FRED returned ${status} for ${entry.seriesId}` };
      }
    } catch (e) {
      return {
        refused: true,
        code: "NETWORK_UNREACHABLE",
        detail: `fetch to fred.stlouisfed.org failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const cls = classifyBody(body);
    if (cls === "empty") return { refused: true, code: "EMPTY_RESPONSE", detail: `FRED returned an empty body (${status})` };
    if (cls === "bot_challenge") {
      return { refused: true, code: "BOT_CHALLENGE", detail: "FRED returned a browser-verification interstitial, not CSV" };
    }
    if (cls === "html") {
      return { refused: true, code: "NOT_THE_EXPECTED_FORMAT", detail: `FRED returned HTML, not CSV (status ${status})` };
    }

    // FRED's value column is named after the series id, so it is addressed by
    // index rather than by a fixed word.
    const parsed = parseDateValueCsv(body, { dateHeaders: ["observation_date", "date"], valueColumn: 1 });
    if ("error" in parsed) {
      return { refused: true, code: "NOT_THE_EXPECTED_FORMAT", detail: `FRED CSV: ${parsed.error}` };
    }
    const bars = clipToRange(sortBars(parsed.bars), range.from, range.to);

    return {
      symbol: symbol.toUpperCase(),
      bars,
      provenance: {
        source: this.name,
        sourceSymbol: entry.seriesId,
        request: url,
        fetchedAt: at,
        adjustment: this.adjustment,
        termsOfUse: this.termsOfUse,
        detail:
          `FRED ${entry.seriesId} — ${entry.title}. PRICE-ONLY INDEX LEVEL: no dividends, not a tradable ` +
          `instrument, not an ETF adjusted close. Coverage: ${entry.observedCoverage}. ` +
          `${parsed.blankRows} weekday row(s) carried no value (FRED's holiday convention) and were dropped, ` +
          `never zeroed; ${parsed.unparsableRows} row(s) were unparsable and dropped.`,
      },
    };
  }
}
