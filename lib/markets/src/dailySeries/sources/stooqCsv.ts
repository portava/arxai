// Source adapter: Stooq daily CSV (stooq.com/q/d/l). No credential.
//
// STATUS FROM THIS SANDBOX: BLOCKED — and the way it is blocked is the point.
// -------------------------------------------------------------------------
// Probed 2026-08-29 from the build sandbox. Stooq answers HTTP **200** with
// `text/html` carrying a JavaScript proof-of-work browser check
// ("This site requires JavaScript to verify your browser"), for both
// stooq.com and stooq.pl, for `spy.us` and `^spx`, with and without a browser
// User-Agent. Zero CSV rows came back.
//
// Two consequences, both deliberate:
//
//   1. A 200-with-HTML is the nastiest failure shape there is, because a CSV
//      parser reads it as "no rows" and the caller reports an empty market
//      instead of a blocked host. This adapter classifies the body BEFORE
//      parsing and returns a typed BOT_CHALLENGE refusal.
//   2. The challenge is NOT solved here and must not be. Defeating a
//      bot-detection check is out of bounds regardless of how easy the
//      proof-of-work is. If Stooq is wanted, the owner fetches the CSV in a
//      browser and drops the file in for `FileImportSource`.
//
// ADJUSTMENT IS DECLARED `unknown` BY DEFAULT, ON PURPOSE. Stooq's adjustment
// basis for `.us` history is not established by anything this repository has
// verified, and the fetch that would have let us check it is blocked. An
// `unknown` adjustment makes the integrity guard REFUSE the series — which is
// the correct outcome, not a bug. The owner can pass `declaredAdjustment` once
// they have established the basis (compare a close on a known ex-dividend date
// against the raw tape); that override is an OWNER-AUTHORED fact and is
// recorded as declared-by-caller in the provenance detail, never as measured.

import type {
  DailySeriesSource,
  FetchLike,
  PriceAdjustment,
  SeriesFetchResult,
  SeriesRange,
} from "../types.js";
import { classifyBody, parseDateValueCsv, sortBars, clipToRange } from "../parse.js";

/** ARX symbol → Stooq ticker. Unmapped symbols are refused, never guessed. */
export const STOOQ_SYMBOL_MAP: Readonly<Record<string, string>> = Object.freeze({
  SPY: "spy.us",
  QQQ: "qqq.us",
  DIA: "dia.us",
  IVV: "ivv.us",
  SPX: "^spx",
  NDX: "^ndx",
  DJI: "^dji",
});

export const STOOQ_BASE = "https://stooq.com/q/d/l/";

export function stooqRequestUrl(ticker: string, range: SeriesRange): string {
  const compact = (iso: string) => iso.replace(/-/g, "");
  const q = new URLSearchParams({
    s: ticker,
    i: "d",
    d1: compact(range.from),
    d2: compact(range.to),
  });
  return `${STOOQ_BASE}?${q.toString()}`;
}

export interface StooqOptions {
  /**
   * OWNER-declared adjustment basis. Default `unknown`, which the integrity
   * guard refuses. Setting this is an owner assertion about the vendor, and it
   * is stamped as such.
   */
  declaredAdjustment?: PriceAdjustment;
}

export class StooqCsvSource implements DailySeriesSource {
  readonly name = "stooq-csv";
  readonly adjustment: PriceAdjustment;
  readonly termsOfUse = "UNVERIFIED" as const;
  private readonly declared: boolean;

  constructor(
    private readonly fetchImpl: FetchLike,
    opts: StooqOptions = {},
  ) {
    this.adjustment = opts.declaredAdjustment ?? "unknown";
    this.declared = opts.declaredAdjustment !== undefined;
  }

  async fetchDailyCloses(symbol: string, range: SeriesRange, at: string): Promise<SeriesFetchResult> {
    const ticker = STOOQ_SYMBOL_MAP[symbol.toUpperCase()];
    if (ticker === undefined) {
      return {
        refused: true,
        code: "SYMBOL_NOT_SUPPORTED",
        detail: `"${symbol}" has no Stooq ticker mapping. Known: ${Object.keys(STOOQ_SYMBOL_MAP).join(", ")}`,
      };
    }
    const url = stooqRequestUrl(ticker, range);

    let status = 0;
    let body: string;
    try {
      const res = await this.fetchImpl(url, { headers: { accept: "text/csv" } });
      status = res.status;
      body = await res.text();
      if (!res.ok) {
        return { refused: true, code: "HTTP_ERROR", status, detail: `Stooq returned ${status} for ${ticker}` };
      }
    } catch (e) {
      return {
        refused: true,
        code: "NETWORK_UNREACHABLE",
        detail: `fetch to stooq.com failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const cls = classifyBody(body);
    if (cls === "empty") return { refused: true, code: "EMPTY_RESPONSE", detail: `Stooq returned an empty body (${status})` };
    if (cls === "bot_challenge") {
      return {
        refused: true,
        code: "BOT_CHALLENGE",
        detail:
          `Stooq answered HTTP ${status} with a JavaScript browser-verification challenge instead of CSV. ` +
          "This adapter does not solve bot checks. Fetch the CSV in a browser and use FileImportSource",
      };
    }
    if (cls === "html") {
      return { refused: true, code: "NOT_THE_EXPECTED_FORMAT", detail: `Stooq returned HTML, not CSV (status ${status})` };
    }

    // Stooq daily CSV header: Date,Open,High,Low,Close,Volume
    const parsed = parseDateValueCsv(body, { dateHeaders: ["date"], valueColumn: "close" });
    if ("error" in parsed) {
      return { refused: true, code: "NOT_THE_EXPECTED_FORMAT", detail: `Stooq CSV: ${parsed.error}` };
    }
    const bars = clipToRange(sortBars(parsed.bars), range.from, range.to);

    return {
      symbol: symbol.toUpperCase(),
      bars,
      provenance: {
        source: this.name,
        sourceSymbol: ticker,
        request: url,
        fetchedAt: at,
        adjustment: this.adjustment,
        termsOfUse: this.termsOfUse,
        detail:
          `Stooq daily CSV for ${ticker}. Adjustment basis ${
            this.declared
              ? `DECLARED BY CALLER as "${this.adjustment}" — an owner assertion about the vendor, not a measurement made here`
              : `UNKNOWN (not established by this repository); the integrity guard will refuse this series until it is`
          }. ${parsed.blankRows} blank row(s) dropped, ${parsed.unparsableRows} unparsable row(s) dropped.`,
      },
    };
  }
}
