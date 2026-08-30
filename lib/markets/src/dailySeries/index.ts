// @workspace/markets/dailySeries — daily-close ingestion for the C8 gate.
//
// The shape of the thing:
//
//   SOURCE ADAPTER  →  DailySeries (bars + MANDATORY provenance)
//        ↓
//   INTEGRITY GUARD →  IntegrityReport. ok=false REFUSES the series WHOLE.
//        ↓                              Never trimmed. Never interpolated.
//   SNAPSHOT        →  a file with its own verified fingerprint
//        ↓
//   dataFingerprint →  the harness's no-respin key
//
// Nothing in this subtree places, sizes, or authorises a trade, and nothing
// imports the dispatch/gate path. The only I/O is inside the source adapters,
// and each one takes its fetch/read implementation as a constructor argument —
// so the whole subtree is exercisable offline and no test needs a network.

export type {
  DailyBar,
  DailySeries,
  DailySeriesSource,
  FetchLike,
  PriceAdjustment,
  SeriesFetchRefusal,
  SeriesFetchResult,
  SeriesProvenance,
  SeriesRange,
} from "./types.js";
export { isSeriesRefusal, ISO_DATE_RE } from "./types.js";

export {
  US_EQUITY_CALENDAR_RULESET,
  US_EQUITY_CALENDAR_SUPPORTED,
  US_EQUITY_SPECIAL_CLOSURES,
  easterSunday,
  expectedTradingDays,
  isCalendarSpanRefusal,
  isUsEquityTradingDay,
  isValidIsoDate,
  isoOf,
  msOfIso,
  usEquityHolidaysForYear,
  usEquityNonTradingReason,
} from "./usEquityCalendar.js";
export type { CalendarSpanRefusal, NonTradingReason } from "./usEquityCalendar.js";

export {
  DEFAULT_MAX_ABS_LOG_JUMP,
  checkSeriesIntegrity,
  formatIntegrityReport,
} from "./integrity.js";
export type {
  IntegrityDefect,
  IntegrityDefectCode,
  IntegrityOptions,
  IntegrityReport,
  RequiredCoverage,
} from "./integrity.js";

export {
  FINGERPRINT_PRECISION,
  FINGERPRINT_VERSION,
  PROVENANCE_DIGEST_VERSION,
  canonicalPrice,
  dataFingerprint,
  fingerprintPreimage,
  provenanceDigest,
  provenanceDigestPreimage,
} from "./fingerprint.js";
export type { FingerprintInput } from "./fingerprint.js";

export {
  classifyBody,
  clipToRange,
  isNonValue,
  normaliseDate,
  parseDateValueCsv,
  sortBars,
} from "./parse.js";
export type { BodyClass, CsvParseOk, CsvParseResult } from "./parse.js";

export { SNAPSHOT_FORMAT, parseSnapshot, serialiseSnapshot } from "./snapshot.js";
export type { SeriesSnapshot, SnapshotParseResult } from "./snapshot.js";

export { FRED_BASE, FRED_SERIES_MAP, FredCsvSource, fredRequestUrl } from "./sources/fredCsv.js";
export type { FredSeriesEntry } from "./sources/fredCsv.js";
export { STOOQ_BASE, STOOQ_SYMBOL_MAP, StooqCsvSource, stooqRequestUrl } from "./sources/stooqCsv.js";
export type { StooqOptions } from "./sources/stooqCsv.js";
export {
  STOCKANALYSIS_BASE,
  STOCKANALYSIS_SYMBOL_MAP,
  StockAnalysisJsonSource,
  stockAnalysisRequestUrl,
} from "./sources/stockAnalysisJson.js";
export type { StockAnalysisMode } from "./sources/stockAnalysisJson.js";
export { FileImportSource } from "./sources/fileImport.js";
export type { FileImportOptions, ReadTextFile } from "./sources/fileImport.js";
