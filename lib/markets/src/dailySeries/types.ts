// Daily-close series — the shapes. Provenance is part of the data, not a note.
//
// WHY A SERIES WITHOUT PROVENANCE IS NOT DATA
// -------------------------------------------
// "SPY daily closes, 2005–2025" names four different instruments depending on
// how the vendor adjusted the prices:
//
//   split_dividend_adjusted — total-return-ish: the series a buy-and-hold
//                             investor actually experienced. Historical values
//                             are RESTATED every time a dividend is paid, so
//                             the same request re-run tomorrow returns
//                             different numbers for 2005.
//   split_adjusted_only     — corporate-action-clean but dividend-blind.
//   raw_unadjusted          — what printed on the tape that day. A 2:1 split
//                             looks like a -50% day.
//   price_only_index        — an index level (S&P 500, Nasdaq Composite). Not
//                             a tradable instrument at all, and it excludes
//                             dividends by construction.
//
// Over twenty years these diverge by tens of percent. A backtest that does not
// know which one it holds is not measuring what it thinks it is measuring, and
// a strategy whose return comes from an unadjusted split is a fabrication with
// a chart. So `adjustment` is REQUIRED on every bar set, `"unknown"` is a legal
// value, and the integrity guard REFUSES an unknown-adjustment series rather
// than picking the flattering interpretation.
//
// Pure types + typed outcomes. No I/O here; the source adapters under
// ./sources/ are the only things in this subtree that touch a network, and each
// one takes its fetch implementation as an argument so it is testable offline.

/** How the vendor adjusted the prices. There is no "probably" value. */
export type PriceAdjustment =
  | "split_dividend_adjusted"
  | "split_adjusted_only"
  | "raw_unadjusted"
  | "price_only_index"
  | "unknown";

/**
 * One daily bar. `close` is the price the series is EVALUATED on and carries
 * the adjustment stated in the provenance. `adjustedClose` is present only when
 * the source shipped BOTH a raw and an adjusted close in the same row; it is
 * carried for audit, never silently swapped in.
 */
export interface DailyBar {
  /** ISO yyyy-mm-dd, the session date. Lexical order is chronological order. */
  date: string;
  close: number;
  adjustedClose?: number;
}

/**
 * Where a bar set came from, exactly. Every field is required because every
 * one of them changes what the numbers mean.
 */
export interface SeriesProvenance {
  /** Adapter identity, e.g. "fred-csv", "stooq-csv", "file-import". */
  source: string;
  /** The symbol AS THE SOURCE NAMES IT — not the ARX symbol. */
  sourceSymbol: string;
  /** The exact request made: a URL, or `file:<path>` for an import. */
  request: string;
  /** ISO instant supplied by the caller. This module never reads a clock. */
  fetchedAt: string;
  /** Which of the four instruments this actually is. */
  adjustment: PriceAdjustment;
  /**
   * Whether the source's licence/terms for this use are established.
   * "UNVERIFIED" is not a blocker for research plumbing, but it IS a blocker
   * the owner must clear before a series backs a capital decision, so it rides
   * with the data instead of living in someone's memory.
   */
  termsOfUse: "DOCUMENTED_PUBLIC" | "UNVERIFIED";
  /** Free-text detail: series id, vendor caveats, restatement behaviour. */
  detail: string;
}

/** A bar set plus the provenance that says what it is. */
export interface DailySeries {
  /** The ARX-side symbol the caller asked for. */
  symbol: string;
  bars: DailyBar[];
  provenance: SeriesProvenance;
}

/** Why a fetch could not honestly produce a series. Never a silent empty. */
export type SeriesFetchRefusal =
  | { refused: true; code: "NETWORK_UNREACHABLE"; detail: string }
  | { refused: true; code: "HTTP_ERROR"; status: number; detail: string }
  | { refused: true; code: "BOT_CHALLENGE"; detail: string }
  | { refused: true; code: "NOT_THE_EXPECTED_FORMAT"; detail: string }
  | { refused: true; code: "EMPTY_RESPONSE"; detail: string }
  | { refused: true; code: "CREDENTIAL_REQUIRED"; detail: string }
  | { refused: true; code: "SYMBOL_NOT_SUPPORTED"; detail: string }
  | { refused: true; code: "READ_FAILED"; detail: string };

export function isSeriesRefusal(v: unknown): v is SeriesFetchRefusal {
  return typeof v === "object" && v !== null && (v as { refused?: unknown }).refused === true;
}

export type SeriesFetchResult = DailySeries | SeriesFetchRefusal;

/** Inclusive ISO-date request range. */
export interface SeriesRange {
  from: string;
  to: string;
}

/**
 * The pluggable source adapter. One method, one promise, and a result that is
 * either a provenance-stamped series or a TYPED refusal — there is no third
 * outcome and no path that returns bars without saying where they came from.
 */
export interface DailySeriesSource {
  /** Stable adapter name; appears in provenance.source. */
  readonly name: string;
  /**
   * What this adapter's bars ARE. Declared up front so a caller can reject a
   * source on adjustment grounds before spending a request.
   */
  readonly adjustment: PriceAdjustment;
  readonly termsOfUse: SeriesProvenance["termsOfUse"];
  /**
   * @param symbol   ARX-side symbol.
   * @param range    inclusive ISO date range.
   * @param at       ISO instant for provenance.fetchedAt — supplied, never read.
   */
  fetchDailyCloses(symbol: string, range: SeriesRange, at: string): Promise<SeriesFetchResult>;
}

/** Minimal fetch shape the network adapters need. Injected, never imported. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
