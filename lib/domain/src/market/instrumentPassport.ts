// ── ARX Instrument Passport (D3b) ────────────────────────────────────────────
//
// ONE canonical record per approved ARX Focus market carrying every
// instrument-level fact the platform needs to convert between units without
// guessing: asset class, venues, pip size, contract size, quote currency,
// lot limits, session calendar, settlement behaviour — each fact tagged with
// its PROVENANCE (statically DECLARED market convention vs BROKER_REPORTED
// runtime truth from `arx_symbol_specs`).
//
// WHY THIS MODULE EXISTS
//
// Instrument metadata was scattered across three sources that could drift:
//   1. `artifacts/api-server/src/brain/symbols/symbolRegistry.ts`
//      (base/quote currency, broker symbol, category),
//   2. `artifacts/api-server/src/lib/marketModel/instrumentSpec.ts`
//      (the pip/point unit contract) + `lib/mt5/contractSize.ts`
//      (contract size / profit currency),
//   3. provider specs (`lib/data/providers/derivProvider.ts` venue ids,
//      `@workspace/markets` provider symbols).
// A drifted copy of any of these facts is exactly the class of bug that booked
// realized P/L 100,000× wrong (missing contract size — see contractSize.ts).
// Those modules keep their APIs but now READ THROUGH this passport; a drift
// test (`test:instrument-passport-drift`) asserts no consumer carries its own
// divergent copy of a passport fact.
//
// UNIT CLOSURE
//
// Every unit conversion (price points → pips → quote-currency P&L → integer
// minor units for `@workspace/money`) is defined HERE, ONCE, over exact
// bigint decimal arithmetic. A conversion either round-trips EXACTLY or
// returns a typed refusal — it can never silently round, guess a unit, or
// apply an FX convention to a non-FX instrument. The property test
// (`test:instrument-passport`) proves the round trip is exact for every
// passport entry; the 100,000× class of bug is structurally impossible
// because there is no code path that produces a currency amount without a
// complete, provenance-tagged unit chain.
//
// HONESTY CONTRACT (default-deny, same as instrumentSpec/contractSize):
// a fact that is broker truth is NOT invented statically. It is declared
// `null` with provenance BROKER_REPORTED and the unit chain refuses to
// complete without the broker spec. Refusal is a valid result.
//
// This module is PURE: no IO, no DB, no HTTP, no imports outside this
// directory. It is imported by BOTH the api-server and the trading-dashboard.

import {
  ARX_FOCUS_MARKETS,
  resolveArxMarket,
  type ArxFocusMarket,
  type ArxMarketCategory,
} from "./arxFocusMarkets";

// ─── Strict ISO-4217 forex-pair classification (single definition) ──────────
//
// Moved here (unchanged) from `artifacts/api-server/src/lib/mt5/forexPair.ts`,
// which now re-exports these — the passport is the one place an FX convention
// may be decided, and the api-server modules are views over it.
//
// A loose `/^[A-Z]{6}$/` test calls XAUUSD, XAGUSD and BTCUSD "forex" and
// applies FX conventions to them — mis-sizing gold by 1,000× and silver by
// 20×. BOTH halves of the symbol must be real ISO-4217 fiat codes before any
// FX convention may be assumed.

/**
 * ISO-4217 fiat codes ARX trades or quotes against. Deliberately a fixed
 * allowlist: metals (XAU/XAG/XPT/XPD), crypto (BTC/ETH/…) and index tickers
 * must NOT be in here, or they inherit FX conventions.
 */
export const FIAT_CODES: ReadonlySet<string> = new Set([
  "USD", "EUR", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF", "SEK", "NOK", "DKK",
  "SGD", "HKD", "ZAR", "MXN", "PLN", "TRY", "CZK", "HUF", "CNH", "CNY", "RUB",
  "INR", "THB", "ILS", "KRW",
]);

/** The standard FX lot: 100,000 units of the base currency. */
export const FX_STANDARD_LOT_UNITS = 100_000;

/**
 * Split a symbol into ISO-4217 base/quote, tolerating a broker suffix
 * (`EURUSD.raw`, `EURUSD_i`, `EURUSD-ECN`). Returns null unless BOTH halves are
 * real fiat codes — so XAUUSD, BTCUSD and US30 all return null.
 */
export function splitForexPair(symbol: string): { base: string; quote: string } | null {
  const m = /^([A-Z]{3})([A-Z]{3})([._-][A-Z0-9]+)?$/.exec(symbol.trim().toUpperCase());
  if (!m) return null;
  const base = m[1]!;
  const quote = m[2]!;
  if (!FIAT_CODES.has(base) || !FIAT_CODES.has(quote)) return null;
  return { base, quote };
}

/** Strict forex classifier: BOTH halves must be ISO-4217 fiat currency codes. */
export function isForexPair(symbol: string): boolean {
  return splitForexPair(symbol) != null;
}

/**
 * The classic FX pip convention as an EXACT decimal string: 0.01 for
 * JPY-quoted fiat pairs, 0.0001 otherwise, null for anything that is not a
 * strict fiat pair. THE single definition — `instrumentSpec.decidePipSize`
 * reads through this.
 */
export function fxConventionPipSize(symbol: string): "0.01" | "0.0001" | null {
  const pair = splitForexPair(symbol);
  if (!pair) return null;
  return pair.quote === "JPY" ? "0.01" : "0.0001";
}

/** Numeric view of {@link fxConventionPipSize} for float-based consumers. */
export function fxConventionPipSizeNumber(symbol: string): number | null {
  const s = fxConventionPipSize(symbol);
  return s === null ? null : Number(s);
}

// ─── Exact decimal arithmetic (bigint; no float ever touches a unit) ────────

/** An exact decimal: value = units / 10^scale. */
export interface ExactDec {
  units: bigint;
  scale: number;
}

const MAX_DIV_EXTRA_DIGITS = 24;

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/** Parse a plain decimal string ("−12.3450", "0.0001") exactly, or null. */
export function parseExactDec(text: string): ExactDec | null {
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) return null;
  const sign = m[1] === "-" ? -1n : 1n;
  const frac = m[3] ?? "";
  return { units: sign * BigInt(m[2]! + frac), scale: frac.length };
}

/**
 * Parse a finite JS number (a broker-reported double) exactly as the decimal
 * it prints as. Exponent forms are expanded. Null for non-finite.
 */
export function numberToExactDec(v: number): ExactDec | null {
  if (!Number.isFinite(v)) return null;
  if (Number.isInteger(v)) return { units: BigInt(v), scale: 0 };
  const s = String(v);
  if (!/[eE]/.test(s)) return parseExactDec(s);
  const expanded = v.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
  return parseExactDec(expanded);
}

/**
 * Canonical form: zero is scale-0, trailing fractional zeros are stripped,
 * and a negative scale (a quotient of coarse values, e.g. 4050 ÷ 0.01) is
 * folded back into the units so equal values always compare identically.
 */
export function decNormalize(d: ExactDec): ExactDec {
  let { units, scale } = d;
  if (units === 0n) return { units: 0n, scale: 0 };
  while (scale > 0 && units % 10n === 0n) {
    units /= 10n;
    scale -= 1;
  }
  if (scale < 0) {
    units *= pow10(-scale);
    scale = 0;
  }
  return { units, scale };
}

/** Exact multiplication. */
export function decMul(a: ExactDec, b: ExactDec): ExactDec {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

/**
 * EXACT division: a / b as a terminating decimal, or null when the quotient
 * does not terminate within {@link MAX_DIV_EXTRA_DIGITS} extra digits. There
 * is deliberately NO rounding fallback — an inexact unit conversion must be
 * refused, never approximated.
 */
export function decDivExact(a: ExactDec, b: ExactDec): ExactDec | null {
  if (b.units === 0n) return null;
  for (let k = 0; k <= MAX_DIV_EXTRA_DIGITS; k++) {
    const numerator = a.units * pow10(k);
    if (numerator % b.units === 0n) {
      return decNormalize({ units: numerator / b.units, scale: a.scale - b.scale + k });
    }
  }
  return null;
}

/** Exact decimal string (no exponent), preserving the stored scale. */
export function decToString(d: ExactDec): string {
  // A negative scale (from decDivExact of coarse values) is normalised to 0.
  const norm = d.scale < 0 ? { units: d.units * pow10(-d.scale), scale: 0 } : d;
  const neg = norm.units < 0n;
  const abs = neg ? -norm.units : norm.units;
  if (norm.scale === 0) return `${neg ? "-" : ""}${abs.toString()}`;
  const s = abs.toString().padStart(norm.scale + 1, "0");
  return `${neg ? "-" : ""}${s.slice(0, -norm.scale)}.${s.slice(-norm.scale)}`;
}

/** Value equality (independent of stored scale). */
export function decEquals(a: ExactDec, b: ExactDec): boolean {
  const na = decNormalize(a);
  const nb = decNormalize(b);
  return na.units === nb.units && na.scale === nb.scale;
}

function decIsPositive(d: ExactDec): boolean {
  return d.units > 0n;
}

// ─── Passport types ─────────────────────────────────────────────────────────

/** Where a passport fact comes from. */
export type FieldProvenance =
  /** A market-wide convention or a truth the symbol itself states. Static. */
  | "DECLARED"
  /** Broker/EA truth (`arx_symbol_specs`) — cannot be known statically. */
  | "BROKER_REPORTED";

/** Why a broker-reported field is statically null. */
export type PassportNullReason = "AWAITS_BROKER_SPEC";

/**
 * A provenance-tagged passport fact. A `BROKER_REPORTED` field is `null` in
 * the static passport WITH a reason — it is completed at runtime from the
 * per-user broker spec, never guessed.
 */
export type PassportField<T> =
  | { value: T; provenance: FieldProvenance; reason: null }
  | { value: null; provenance: "BROKER_REPORTED"; reason: PassportNullReason };

/** How the instrument settles / gaps between sessions. Declared, descriptive. */
export type SettlementBehavior =
  /** Continuous synthetic/crypto market: no session close, no weekend gap. */
  | "CONTINUOUS_24_7"
  /** FX/metals OTC week: closed weekends; Sunday-open gap risk. */
  | "WEEKEND_GAP"
  /** Cash-session index: daily session close; overnight + weekend gap risk. */
  | "CASH_SESSION_GAP";

export interface InstrumentPassport {
  /** App-wide routing key — identical to the ARX Focus canonicalSymbol. */
  canonicalSymbol: string;
  displayName: string;
  /** Asset class — the ARX Focus category (single taxonomy, not a second one). */
  assetClass: ArxMarketCategory;
  /** Ordered venue/data-source preference (descriptive, never a gate). */
  venues: readonly string[];
  /** Venue/broker symbol spellings (from the Focus registry's mt5Aliases). */
  venueSymbols: readonly string[];
  /** Base instrument code when the symbol itself states it (EUR, XAU, BTC). */
  baseCurrency: PassportField<string>;
  /** Quote/profit currency when the symbol itself states it. */
  quoteCurrency: PassportField<string>;
  /** One pip as an exact decimal string. Declared only for strict fiat pairs. */
  pipSize: PassportField<string>;
  /** One broker point as an exact decimal string. Always broker truth. */
  pointSize: PassportField<string>;
  /** Units of base per 1.00 lot. Declared only for strict fiat pairs. */
  contractSize: PassportField<string>;
  minLot: PassportField<string>;
  lotStep: PassportField<string>;
  /** Session calendar reference — the Focus registry sessionProfile. */
  sessionCalendarRef: string;
  settlementBehavior: SettlementBehavior;
}

// ─── Passport construction (derived 1:1 from the Focus registry) ────────────

function declared<T>(value: T): PassportField<T> {
  return { value, provenance: "DECLARED", reason: null };
}

function brokerReported<T>(): PassportField<T> {
  return { value: null, provenance: "BROKER_REPORTED", reason: "AWAITS_BROKER_SPEC" };
}

/** Non-fiat 6-char symbols whose halves the symbol text itself declares. */
const SYMBOL_STATED_HALVES: Readonly<Record<string, { base: string; quote: string }>> = {
  XAUUSD: { base: "XAU", quote: "USD" },
  XAGUSD: { base: "XAG", quote: "USD" },
  BTCUSD: { base: "BTC", quote: "USD" },
  ETHUSD: { base: "ETH", quote: "USD" },
};

function settlementFor(mk: ArxFocusMarket): SettlementBehavior {
  if (mk.sessionProfile === "24_7") return "CONTINUOUS_24_7";
  if (mk.sessionProfile === "cash_session") return "CASH_SESSION_GAP";
  return "WEEKEND_GAP";
}

function buildPassport(mk: ArxFocusMarket): InstrumentPassport {
  const fx = splitForexPair(mk.canonicalSymbol);
  const stated = SYMBOL_STATED_HALVES[mk.canonicalSymbol.toUpperCase()] ?? null;
  const pip = fxConventionPipSize(mk.canonicalSymbol);

  return {
    canonicalSymbol: mk.canonicalSymbol,
    displayName: mk.displayName,
    assetClass: mk.category,
    venues: [...mk.dataSourcePriority],
    venueSymbols: [...mk.mt5Aliases],
    baseCurrency: fx ? declared(fx.base) : stated ? declared(stated.base) : brokerReported(),
    quoteCurrency: fx ? declared(fx.quote) : stated ? declared(stated.quote) : brokerReported(),
    pipSize: pip !== null ? declared<string>(pip) : brokerReported(),
    // A broker's point (4-digit vs 5-digit pricing) is never a convention.
    pointSize: brokerReported(),
    contractSize: fx ? declared(String(FX_STANDARD_LOT_UNITS)) : brokerReported(),
    minLot: brokerReported(),
    lotStep: brokerReported(),
    sessionCalendarRef: mk.sessionProfile,
    settlementBehavior: settlementFor(mk),
  };
}

/**
 * The canonical registry: EXACTLY one passport per approved ARX Focus market,
 * in the canonical default order. Derived, so a market cannot exist without a
 * passport and a passport cannot exist without an approved market.
 */
export const INSTRUMENT_PASSPORTS: readonly InstrumentPassport[] =
  ARX_FOCUS_MARKETS.map(buildPassport);

const PASSPORT_BY_CANONICAL: Map<string, InstrumentPassport> = new Map(
  INSTRUMENT_PASSPORTS.map((p) => [p.canonicalSymbol.toUpperCase(), p]),
);

/**
 * Resolve any canonical / alias / venue spelling to its passport via the ARX
 * Focus resolver, or null for anything outside the approved universe.
 */
export function resolveInstrumentPassport(input: string): InstrumentPassport | null {
  const mk = resolveArxMarket(input);
  if (!mk) return null;
  return PASSPORT_BY_CANONICAL.get(mk.canonicalSymbol.toUpperCase()) ?? null;
}

/** Passport by exact canonical symbol (case-insensitive), or null. */
export function getInstrumentPassport(canonicalSymbol: string): InstrumentPassport | null {
  return PASSPORT_BY_CANONICAL.get(canonicalSymbol.trim().toUpperCase()) ?? null;
}

/**
 * The code-like venue id for a passport (e.g. "R_75" for V75, "BOOM300N" for
 * BOOM300): the first venue spelling with no spaces that differs from the
 * canonical, else the canonical itself. Used by provider-spec views.
 */
export function venueCodeSymbol(pp: InstrumentPassport): string {
  const code = pp.venueSymbols.find(
    (v) => /^[A-Za-z0-9_]+$/.test(v) && v.toUpperCase() !== pp.canonicalSymbol.toUpperCase(),
  );
  return code ?? pp.canonicalSymbol;
}

// ─── Unit chain: the complete, provenance-tagged conversion basis ───────────

/** Broker/EA-reported fields from `arx_symbol_specs` (any may be absent). */
export interface BrokerReportedSpec {
  point?: number | null;
  contractSize?: number | null;
  profitCurrency?: string | null;
  minVolume?: number | null;
  volumeStep?: number | null;
}

export type UnitChainReason =
  | "PIP_SIZE_UNKNOWN"
  | "PIP_SIZE_INVALID"
  | "CONTRACT_SIZE_UNKNOWN"
  | "CONTRACT_SIZE_INVALID"
  | "QUOTE_CURRENCY_UNKNOWN"
  | "QUOTE_SCALE_UNKNOWN";

export interface UnitChain {
  canonicalSymbol: string;
  pipSize: ExactDec;
  pipProvenance: FieldProvenance;
  contractSize: ExactDec;
  contractProvenance: FieldProvenance;
  quoteCurrency: string;
  quoteProvenance: FieldProvenance;
  /** ISO-4217 minor-unit exponent for the quote currency (caller-supplied). */
  quoteScale: number;
}

export type UnitChainResult =
  | { chain: UnitChain; reason: null }
  | { chain: null; reason: UnitChainReason };

/**
 * Complete a passport into a usable unit chain, merging broker truth.
 *
 * PER-FIELD ORDER OF AUTHORITY (mirrors the existing certified resolvers —
 * do not "simplify" it into one rule):
 *   - pipSize: DECLARED FX convention first, else broker point
 *     (instrumentSpec.decidePipSize — "pips" on FX universally means the
 *     convention, not the 5-digit broker point a tenth its size).
 *   - contractSize: BROKER spec first, else the declared FX standard lot
 *     (contractSize.decideContractSize — broker truth beats convention).
 *     An INVALID broker value fails closed; it never falls through.
 *   - quoteCurrency: broker profitCurrency first, else the declared quote.
 *
 * `quoteScaleFor` is the caller's currency-scale authority — pass
 * `scaleForCurrency` from `@workspace/money` so there is exactly one scale
 * table in the codebase. Unknown scale ⇒ typed refusal, never an assumed 2.
 */
export function completeUnitChain(
  pp: InstrumentPassport,
  opts: {
    broker?: BrokerReportedSpec | null;
    quoteScaleFor: (currency: string) => number | null;
  },
): UnitChainResult {
  const broker = opts.broker ?? null;

  // pipSize — declared convention beats broker point.
  let pipSize: ExactDec | null = null;
  let pipProvenance: FieldProvenance = "DECLARED";
  if (pp.pipSize.value !== null) {
    pipSize = parseExactDec(pp.pipSize.value);
    if (pipSize === null || !decIsPositive(pipSize)) {
      return { chain: null, reason: "PIP_SIZE_INVALID" };
    }
  } else if (broker?.point != null) {
    const dec = numberToExactDec(broker.point);
    if (dec === null || !decIsPositive(dec)) {
      return { chain: null, reason: "PIP_SIZE_INVALID" };
    }
    pipSize = dec;
    pipProvenance = "BROKER_REPORTED";
  } else {
    return { chain: null, reason: "PIP_SIZE_UNKNOWN" };
  }

  // contractSize — broker truth beats the declared FX standard lot. An
  // invalid broker value FAILS CLOSED (mirrors decideContractSize).
  let contractSize: ExactDec | null = null;
  let contractProvenance: FieldProvenance = "BROKER_REPORTED";
  if (broker?.contractSize != null) {
    const dec = numberToExactDec(broker.contractSize);
    if (dec === null || !decIsPositive(dec)) {
      return { chain: null, reason: "CONTRACT_SIZE_INVALID" };
    }
    contractSize = dec;
  } else if (pp.contractSize.value !== null) {
    contractSize = parseExactDec(pp.contractSize.value);
    contractProvenance = "DECLARED";
    if (contractSize === null || !decIsPositive(contractSize)) {
      return { chain: null, reason: "CONTRACT_SIZE_INVALID" };
    }
  } else {
    return { chain: null, reason: "CONTRACT_SIZE_UNKNOWN" };
  }

  // quoteCurrency — broker profit currency beats the symbol-stated quote.
  let quoteCurrency: string | null = null;
  let quoteProvenance: FieldProvenance = "BROKER_REPORTED";
  const brokerCcy = broker?.profitCurrency?.trim().toUpperCase() || null;
  if (brokerCcy && /^[A-Z]{3}$/.test(brokerCcy)) {
    quoteCurrency = brokerCcy;
  } else if (pp.quoteCurrency.value !== null) {
    quoteCurrency = pp.quoteCurrency.value;
    quoteProvenance = "DECLARED";
  } else {
    return { chain: null, reason: "QUOTE_CURRENCY_UNKNOWN" };
  }

  const quoteScale = opts.quoteScaleFor(quoteCurrency);
  if (quoteScale === null || !Number.isInteger(quoteScale) || quoteScale < 0) {
    return { chain: null, reason: "QUOTE_SCALE_UNKNOWN" };
  }

  return {
    chain: {
      canonicalSymbol: pp.canonicalSymbol,
      pipSize,
      pipProvenance,
      contractSize,
      contractProvenance,
      quoteCurrency,
      quoteProvenance,
      quoteScale,
    },
    reason: null,
  };
}

// ─── Unit conversions (single definition; exact or refused) ─────────────────

export type UnitConversionReason =
  | "NOT_A_DECIMAL"
  | "LOTS_NOT_POSITIVE"
  | "NOT_WHOLE_PIPS"
  | "NOT_WHOLE_POINTS"
  | "NOT_EXACT"
  | "NOT_REPRESENTABLE_AT_QUOTE_SCALE";

export type PipsResult =
  | { pips: bigint; reason: null }
  | { pips: null; reason: UnitConversionReason };

export type PointsResult =
  | { points: bigint; reason: null }
  | { points: null; reason: UnitConversionReason };

export type DeltaResult =
  | { delta: ExactDec; reason: null }
  | { delta: null; reason: UnitConversionReason };

/** A quote-currency P&L amount in exact integer minor units. */
export interface QuoteMinorAmount {
  /** Integer minor units (cents, yen, …) — feed to `Money.fromMinor`. */
  minorUnits: bigint;
  currency: string;
  scale: number;
  /** The same amount as an exact decimal string. */
  decimal: string;
}

export type QuotePnlResult =
  | { amount: QuoteMinorAmount; reason: null }
  | { amount: null; reason: UnitConversionReason };

function toDec(value: string | ExactDec): ExactDec | null {
  return typeof value === "string" ? parseExactDec(value) : value;
}

/** A whole count of pips → the exact price delta. Always exact. */
export function pipsToPriceDelta(pips: bigint, chain: UnitChain): ExactDec {
  return decNormalize(decMul({ units: pips, scale: 0 }, chain.pipSize));
}

/** A price delta → a WHOLE count of pips, or a typed refusal. */
export function priceDeltaToPips(delta: string | ExactDec, chain: UnitChain): PipsResult {
  const d = toDec(delta);
  if (d === null) return { pips: null, reason: "NOT_A_DECIMAL" };
  const q = decDivExact(d, chain.pipSize);
  if (q === null) return { pips: null, reason: "NOT_EXACT" };
  const n = decNormalize(q);
  if (n.scale !== 0) return { pips: null, reason: "NOT_WHOLE_PIPS" };
  return { pips: n.units, reason: null };
}

/** A whole count of broker points (at the given point size) → price delta. */
export function pointsToPriceDelta(points: bigint, pointSize: string | ExactDec): DeltaResult {
  const p = toDec(pointSize);
  if (p === null || !decIsPositive(p)) return { delta: null, reason: "NOT_A_DECIMAL" };
  return { delta: decNormalize(decMul({ units: points, scale: 0 }, p)), reason: null };
}

/** A price delta → a WHOLE count of broker points, or a typed refusal. */
export function priceDeltaToPoints(
  delta: string | ExactDec,
  pointSize: string | ExactDec,
): PointsResult {
  const d = toDec(delta);
  const p = toDec(pointSize);
  if (d === null || p === null || !decIsPositive(p)) {
    return { points: null, reason: "NOT_A_DECIMAL" };
  }
  const q = decDivExact(d, p);
  if (q === null) return { points: null, reason: "NOT_EXACT" };
  const n = decNormalize(q);
  if (n.scale !== 0) return { points: null, reason: "NOT_WHOLE_POINTS" };
  return { points: n.units, reason: null };
}

/**
 * Price delta × lots → quote-currency P&L in exact integer minor units.
 *
 *   pnl = delta × contractSize × lots   (denominated in chain.quoteCurrency)
 *
 * Refuses (typed) when the exact product is not representable at the quote
 * currency's minor-unit scale — it NEVER rounds. Rounding a P&L is a ledger
 * decision that belongs to `@workspace/money` with a named mode, not to a
 * unit conversion.
 */
export function priceDeltaToQuotePnl(
  delta: string | ExactDec,
  lots: string,
  chain: UnitChain,
): QuotePnlResult {
  const d = toDec(delta);
  if (d === null) return { amount: null, reason: "NOT_A_DECIMAL" };
  const l = parseExactDec(lots);
  if (l === null) return { amount: null, reason: "NOT_A_DECIMAL" };
  if (!decIsPositive(l)) return { amount: null, reason: "LOTS_NOT_POSITIVE" };

  const pnl = decNormalize(decMul(decMul(d, chain.contractSize), l));
  if (pnl.scale > chain.quoteScale) {
    return { amount: null, reason: "NOT_REPRESENTABLE_AT_QUOTE_SCALE" };
  }
  const minorUnits = pnl.units * pow10(chain.quoteScale - pnl.scale);
  const asScale: ExactDec = { units: minorUnits, scale: chain.quoteScale };
  return {
    amount: {
      minorUnits,
      currency: chain.quoteCurrency,
      scale: chain.quoteScale,
      decimal: decToString(asScale),
    },
    reason: null,
  };
}

/** Inverse of {@link priceDeltaToQuotePnl}: minor units ÷ (contract × lots). */
export function quotePnlToPriceDelta(
  minorUnits: bigint,
  lots: string,
  chain: UnitChain,
): DeltaResult {
  const l = parseExactDec(lots);
  if (l === null) return { delta: null, reason: "NOT_A_DECIMAL" };
  if (!decIsPositive(l)) return { delta: null, reason: "LOTS_NOT_POSITIVE" };
  const pnl: ExactDec = { units: minorUnits, scale: chain.quoteScale };
  const perUnit = decDivExact(pnl, decMul(chain.contractSize, l));
  if (perUnit === null) return { delta: null, reason: "NOT_EXACT" };
  return { delta: decNormalize(perUnit), reason: null };
}

/** pips → quote-currency minor units (composition; exact or refused). */
export function pipsToQuotePnl(pips: bigint, lots: string, chain: UnitChain): QuotePnlResult {
  return priceDeltaToQuotePnl(pipsToPriceDelta(pips, chain), lots, chain);
}

/** quote-currency minor units → WHOLE pips (composition; exact or refused). */
export function quotePnlToPips(minorUnits: bigint, lots: string, chain: UnitChain): PipsResult {
  const d = quotePnlToPriceDelta(minorUnits, lots, chain);
  if (d.delta === null) return { pips: null, reason: d.reason };
  return priceDeltaToPips(d.delta, chain);
}
