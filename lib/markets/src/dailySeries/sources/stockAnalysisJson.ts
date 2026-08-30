// Source adapter: stockanalysis.com history JSON. No credential.
//
// STATUS FROM THIS SANDBOX: REACHABLE (probed 2026-08-29). `range=Max` for SPY
// returned 8,452 daily rows back to 1993-02-01, each row carrying BOTH a raw
// close (`c`) and a split/dividend-adjusted close (`a`) — the only reachable
// source found that covers the full 2005–2025 fit+holdout span with an ADJUSTED
// ETF series.
//
// TERMS OF USE ARE UNVERIFIED AND THAT IS RECORDED IN THE DATA.
// This is an undocumented endpoint belonging to a website, not a published data
// API. Nothing in this repository establishes a licence for using it, so every
// series it produces is stamped `termsOfUse: "UNVERIFIED"`. That stamp does not
// block research plumbing; it is an OWNER gate that must be cleared before this
// series backs a capital decision, and it travels with the bars so it cannot be
// forgotten between the fetch and the decision.
//
// ROWS COME BACK NEWEST-FIRST. They are sorted ascending here, and the
// integrity guard checks ordering independently — a source that silently
// changes its order must not be able to reverse every return in the backtest.
//
// WHICH CLOSE IS EVALUATED is an explicit constructor choice, never a default
// that quietly changes what instrument you hold:
//   mode "adjusted" (default) — close = `a`. Split AND dividend adjusted; the
//                               series a buy-and-hold holder experienced.
//                               NOTE: this vendor RESTATES history on every
//                               dividend, so the same request re-run after an
//                               ex-date yields a different fingerprint. That is
//                               correct behaviour for the no-respin rule (it is
//                               genuinely different data) and it is why a
//                               fetched series must be SNAPSHOTTED to a file
//                               before it feeds a one-shot evaluation.
//   mode "raw"                — close = `c` (unadjusted tape print), with `a`
//                               carried alongside as adjustedClose for audit.

import type {
  DailySeriesSource,
  FetchLike,
  PriceAdjustment,
  SeriesFetchResult,
  SeriesRange,
  DailyBar,
} from "../types.js";
import { classifyBody, normaliseDate, sortBars, clipToRange } from "../parse.js";

export const STOCKANALYSIS_BASE = "https://stockanalysis.com/api/symbol/s";

/** ARX symbol → site path segment. Unmapped symbols are refused, never guessed. */
export const STOCKANALYSIS_SYMBOL_MAP: Readonly<Record<string, string>> = Object.freeze({
  SPY: "spy",
  QQQ: "qqq",
  DIA: "dia",
  IVV: "ivv",
  VOO: "voo",
});

export function stockAnalysisRequestUrl(path: string, range: "Max" | "10Y" | "20Y" | "5Y"): string {
  return `${STOCKANALYSIS_BASE}/${path}/history?range=${range}&period=Daily`;
}

export type StockAnalysisMode = "adjusted" | "raw";

interface RawRow {
  t?: unknown;
  c?: unknown;
  a?: unknown;
}

export class StockAnalysisJsonSource implements DailySeriesSource {
  readonly name = "stockanalysis-json";
  readonly adjustment: PriceAdjustment;
  readonly termsOfUse = "UNVERIFIED" as const;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly mode: StockAnalysisMode = "adjusted",
  ) {
    this.adjustment = mode === "adjusted" ? "split_dividend_adjusted" : "raw_unadjusted";
  }

  async fetchDailyCloses(symbol: string, range: SeriesRange, at: string): Promise<SeriesFetchResult> {
    const path = STOCKANALYSIS_SYMBOL_MAP[symbol.toUpperCase()];
    if (path === undefined) {
      return {
        refused: true,
        code: "SYMBOL_NOT_SUPPORTED",
        detail: `"${symbol}" has no stockanalysis.com mapping. Known: ${Object.keys(STOCKANALYSIS_SYMBOL_MAP).join(", ")}`,
      };
    }
    // The endpoint takes a coarse range, not dates, so the widest is requested
    // and the result is clipped locally to exactly what was asked for.
    const url = stockAnalysisRequestUrl(path, "Max");

    let status = 0;
    let body: string;
    try {
      const res = await this.fetchImpl(url, { headers: { accept: "application/json" } });
      status = res.status;
      body = await res.text();
      if (!res.ok) {
        return { refused: true, code: "HTTP_ERROR", status, detail: `stockanalysis.com returned ${status} for ${path}` };
      }
    } catch (e) {
      return {
        refused: true,
        code: "NETWORK_UNREACHABLE",
        detail: `fetch to stockanalysis.com failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const cls = classifyBody(body);
    if (cls === "empty") return { refused: true, code: "EMPTY_RESPONSE", detail: `empty body (status ${status})` };
    if (cls === "bot_challenge") {
      return { refused: true, code: "BOT_CHALLENGE", detail: "browser-verification interstitial returned instead of JSON" };
    }
    if (cls === "html") {
      return { refused: true, code: "NOT_THE_EXPECTED_FORMAT", detail: `HTML returned, not JSON (status ${status})` };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (e) {
      return {
        refused: true,
        code: "NOT_THE_EXPECTED_FORMAT",
        detail: `body is not JSON: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const rows = (payload as { data?: unknown })?.data;
    if (!Array.isArray(rows)) {
      return { refused: true, code: "NOT_THE_EXPECTED_FORMAT", detail: "JSON has no `data` array" };
    }

    const bars: DailyBar[] = [];
    let unparsable = 0;
    for (const r of rows as RawRow[]) {
      const date = typeof r.t === "string" ? normaliseDate(r.t) : null;
      const rawClose = typeof r.c === "number" ? r.c : Number.NaN;
      const adjClose = typeof r.a === "number" ? r.a : Number.NaN;
      const chosen = this.mode === "adjusted" ? adjClose : rawClose;
      if (date === null || !Number.isFinite(chosen)) {
        unparsable++;
        continue;
      }
      const bar: DailyBar = { date, close: chosen };
      if (Number.isFinite(adjClose)) bar.adjustedClose = adjClose;
      bars.push(bar);
    }
    const clipped = clipToRange(sortBars(bars), range.from, range.to);

    return {
      symbol: symbol.toUpperCase(),
      bars: clipped,
      provenance: {
        source: this.name,
        sourceSymbol: path,
        request: url,
        fetchedAt: at,
        adjustment: this.adjustment,
        termsOfUse: this.termsOfUse,
        detail:
          `stockanalysis.com daily history for ${path}, mode "${this.mode}" ⇒ close = ` +
          `${this.mode === "adjusted" ? "`a` (split AND dividend adjusted)" : "`c` (raw tape print)"}. ` +
          `Endpoint returns a coarse range (requested "Max") and was clipped locally to ${range.from}..${range.to}; ` +
          `${rows.length} row(s) returned, ${unparsable} unparsable dropped, ${clipped.length} kept in range. ` +
          "UNDOCUMENTED site endpoint — licence UNVERIFIED, an owner gate before this backs a capital decision. " +
          "Adjusted history is RESTATED on every ex-dividend date, so this series must be snapshotted to a file " +
          "before it feeds a one-shot evaluation.",
      },
    };
  }
}
