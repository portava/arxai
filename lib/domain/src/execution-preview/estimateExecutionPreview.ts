// Execution Preview — pure estimator (Task #196).
//
// estimateExecutionPreview(input) -> ExecutionPreview. Pure & deterministic:
// no IO, no Date.now, no randomness. The caller assembles every input (broker
// spec, quote, ATR, slippage history, balance) and surfaces the result in the
// trade modal. Nothing here can place, modify, or block a trade.
//
// Money model, in order of authority (all money is US dollars):
//   1. The broker's own figures for this symbol (arx_symbol_specs, reported by
//      the EA): tick value / tick size when the account's deposit currency is
//      USD, else contract size when the symbol's profit currency is USD.
//   2. ARX's standard contract model: currency pairs are 100,000 base units
//      per lot, so a pip is worth 10 units of the QUOTE currency — dollars for
//      XXXUSD, converted at the pair's own price for USDXXX, and withheld for
//      crosses (EURGBP, GBPJPY) that need a third rate; synthetic indices are
//      $1 per price unit per lot. Spec-derived + documented, never a
//      fabricated broker number; `dataQuality` says which basis was used.
//   3. Otherwise money is WITHHELD (null + a plain note saying exactly what is
//      missing) and costs stay in points.
//
// "Forex" means BOTH halves of the symbol are ISO-4217 fiat codes (the same
// strict rule as the server's contractSize.ts). Metals (XAUUSD = 100 oz,
// XAGUSD = 5,000 oz), crypto and stock indices have broker-specific contract
// sizes, so without the broker's figures they are never priced with the FX
// lot — the loose "six letters / contains USD" test overstated a gold spread
// ~1,000x.

import type {
  AccountImpact,
  BrokerContractSpec,
  AfterCostOutcome,
  BrokerCondition,
  CostAmount,
  ExecutionDataQuality,
  ExecutionPreview,
  ExecutionPreviewInput,
  ExpectedFillRange,
  MultiEntryPlan,
  OrderTypeOption,
  SlippageEstimate,
  SurvivabilityEstimate,
} from "./executionPreview.types";

const DISCLAIMER =
  "Estimated execution economics for planning only — real fills can differ. Not financial advice.";

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
function isPos(x: number | null | undefined): x is number {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}

function lc(symbol: string): string {
  return symbol.toLowerCase();
}
function isSynthetic(symbol: string): boolean {
  const s = lc(symbol);
  return s.includes("volatility") || s.includes("boom") || s.includes("crash") ||
    s.includes("jump") || s.includes("step") || s.includes("(1s)");
}
/**
 * ISO-4217 fiat codes. Mirrors FIAT_CODES in the server's contractSize.ts:
 * metals (XAU/XAG/XPT/XPD), crypto and index tickers are deliberately absent so
 * they never inherit the 100,000-unit FX lot.
 */
const FIAT_CODES: ReadonlySet<string> = new Set([
  "USD", "EUR", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF", "SEK", "NOK", "DKK",
  "SGD", "HKD", "ZAR", "MXN", "PLN", "TRY", "CZK", "HUF", "CNH", "CNY", "RUB",
  "INR", "THB", "ILS", "KRW",
]);
/** Strict forex: both halves are fiat codes (a broker suffix like `.raw` is ok). */
function isForex(symbol: string): boolean {
  return splitFiatPair(symbol) != null;
}
function isJpy(symbol: string): boolean {
  return symbol.toUpperCase().includes("JPY");
}

/** Infer the smallest price increment when the broker has not reported one. */
function inferPointSize(price: number, symbol: string): number {
  const abs = Math.abs(price);
  if (isJpy(symbol)) return 0.001;       // JPY pairs ~ 3 digits
  if (abs >= 1000) return 0.01;          // indices / XAUUSD-class
  if (abs >= 100) return 0.01;
  if (abs >= 10) return 0.001;
  if (abs > 0) return 0.00001;           // major forex ~ 5 digits
  return 0.00001;
}

/**
 * Base / quote halves of a symbol's name, tolerating a broker suffix that is
 * separated (`EURUSD.raw`) or lower-case (`EURUSDm`, `XAUUSDpro`). An upper-case
 * tail (`BTCUSDT`) is not a suffix, so it does not parse.
 */
function nameHalves(symbol: string): { base: string; quote: string } | null {
  const m = /^([A-Za-z]{3})([A-Za-z]{3})(?:[._-][A-Za-z0-9]+|[a-z][a-z0-9]*)?$/.exec(symbol.replace(/\s/g, ""));
  if (!m) return null;
  return { base: m[1]!.toUpperCase(), quote: m[2]!.toUpperCase() };
}

function currencyCode(v: string | null | undefined): string | null {
  return typeof v === "string" && /^[A-Za-z]{3}$/.test(v.trim()) ? v.trim().toUpperCase() : null;
}

/** "as of 2026-10-28 10:00 UTC" for a broker report time, or "" when unknown. */
function asOf(reportedAt: string | null | undefined): string {
  if (!reportedAt) return "";
  const t = Date.parse(reportedAt);
  if (!Number.isFinite(t)) return "";
  return `, as of ${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The standard FX lot: 100,000 units of the base currency. */
const FX_STANDARD_LOT_UNITS = 100_000;

/** Strict fiat pair halves (same rule as isForex), or null. */
function splitFiatPair(symbol: string): { base: string; quote: string } | null {
  const m = /^([A-Z]{3})([A-Z]{3})([._-][A-Z0-9]+)?$/.exec(symbol.replace(/\s/g, "").toUpperCase());
  if (!m || !FIAT_CODES.has(m[1]!) || !FIAT_CODES.has(m[2]!)) return null;
  return { base: m[1]!, quote: m[2]! };
}

/**
 * Profit-currency → US-dollar factor, from this symbol alone (the same two
 * cases the server's resolveQuoteToAccountFx and Quick Trade's risk readout
 * accept): USD profit → 1; a USD-base pair (USDJPY) → 1 / its own price.
 * Anything else needs a third rate ARX does not hold here → null.
 */
function profitToUsd(
  symbol: string,
  profit: string,
  price: number | null,
): { factor: number; converted: boolean } | null {
  if (profit === "USD") return { factor: 1, converted: false };
  const halves = nameHalves(symbol);
  if (halves && halves.base === "USD" && halves.quote === profit && isPos(price)) {
    return { factor: 1 / price, converted: true };
  }
  return null;
}

function noUsdRate(symbol: string, profit: string, price: number | null): string {
  const halves = nameHalves(symbol);
  if (halves && halves.base === "USD" && halves.quote === profit && !isPos(price)) {
    return `${symbol}'s profit is booked in ${profit}, and there is no live price to convert it to US dollars`;
  }
  return `${symbol}'s profit is booked in ${profit}, and ARX has no ${profit}→USD rate here`;
}

/**
 * How money is derived for this symbol: US dollars per 1.0 of price per 1.00
 * lot, plus the plain-English basis (or the reason it is withheld).
 */
interface ValueModel {
  perPricePerLot: number | null;
  /** True when the figure comes from the broker's own report. */
  fromBroker: boolean;
  /** Data-quality note: the basis used, or why money is withheld. */
  note: string;
  /** Short clause for the account-impact note when withheld. */
  withheldBecause: string | null;
}

function resolveValueModel(a: {
  symbol: string;
  contract: BrokerContractSpec | null;
  accountCurrency: string | null;
  hasBrokerTruth: boolean;
  /** Reference price (entry / quote), used to convert USD-base pairs. */
  price: number | null;
}): ValueModel {
  const { symbol, contract, hasBrokerTruth, price } = a;
  const when = asOf(contract?.reportedAt);
  const account = currencyCode(a.accountCurrency);

  // 1a. Broker tick value / tick size — money per tick in the deposit currency.
  const hasTick = contract != null && isPos(contract.tickValue) && isPos(contract.tickSize);
  if (hasTick && account === "USD") {
    return {
      perPricePerLot: contract!.tickValue! / contract!.tickSize!,
      fromBroker: true,
      note: `Money values use the tick value your broker reported for ${symbol} ` +
        `($${contract!.tickValue} per ${contract!.tickSize} price step per lot${when}).`,
      withheldBecause: null,
    };
  }

  // 1b. Broker contract size — money in the symbol's profit currency,
  // converted to dollars when that is possible from this symbol alone.
  if (contract != null && isPos(contract.contractSize)) {
    const reported = currencyCode(contract.profitCurrency);
    const profit = reported ?? nameHalves(symbol)?.quote ?? null;
    const fromName = reported == null && profit != null;
    const fx = profit != null ? profitToUsd(symbol, profit, price) : null;
    if (fx != null) {
      return {
        perPricePerLot: contract.contractSize * fx.factor,
        fromBroker: true,
        note: `Money values use the contract size your broker reported for ${symbol} ` +
          `(${contract.contractSize.toLocaleString("en-US")} units per lot${when})` +
          (fromName ? `; its profit currency (${profit}) is read from the symbol name` : "") +
          (fx.converted ? `; ${profit} amounts are converted to US dollars at the pair's own price.` : "."),
        withheldBecause: null,
      };
    }
    if (!isSynthetic(symbol) && !isForex(symbol)) {
      const because = profit == null
        ? `your broker reported a contract size for ${symbol} but not the currency its profit is booked in`
        : noUsdRate(symbol, profit, price);
      return {
        perPricePerLot: null,
        fromBroker: false,
        note: `Money values withheld — ${because}, so costs are shown in points only.`,
        withheldBecause: because,
      };
    }
  }

  // 2. ARX's standard contract model.
  if (isSynthetic(symbol)) {
    return {
      perPricePerLot: 1,
      fromBroker: false,
      note: "Money values use ARX's standard contract model for this symbol, not broker-reported tick value.",
      withheldBecause: null,
    };
  }
  const pair = splitFiatPair(symbol);
  if (pair) {
    // 100,000 base units per lot: a pip is worth 10 units of the QUOTE
    // currency (1,000 for JPY quotes), which is dollars only for XXXUSD.
    const fx = profitToUsd(symbol, pair.quote, price);
    if (fx == null) {
      const because = noUsdRate(symbol, pair.quote, price);
      return {
        perPricePerLot: null,
        fromBroker: false,
        note: `Money values withheld — ${because}, so costs are shown in points only.`,
        withheldBecause: because,
      };
    }
    return {
      perPricePerLot: FX_STANDARD_LOT_UNITS * fx.factor,
      fromBroker: false,
      note: "Money values use ARX's standard contract model for currency pairs (100,000 units per lot), " +
        "not broker-reported tick value" +
        (fx.converted ? `; ${pair.quote} amounts are converted to US dollars at the pair's own price.` : "."),
      withheldBecause: null,
    };
  }

  // 3. Withheld — say exactly what is missing.
  let because: string;
  if (hasTick) {
    because = account == null
      ? `your broker reported a tick value for ${symbol}, but ARX does not know which currency your account is in`
      : `your broker reported ${symbol}'s tick value in your account's currency (${account}), not US dollars`;
  } else if (!hasBrokerTruth) {
    because = `ARX has no broker report for ${symbol} yet, and it only has a standard contract model for plain currency pairs (like EURUSD) and synthetic indices`;
  } else {
    because = `your broker has not reported a contract size or tick value for ${symbol}, and ARX only has a standard contract model for plain currency pairs (like EURUSD) and synthetic indices`;
  }
  return {
    perPricePerLot: null,
    fromBroker: false,
    note: `Money values withheld — ${because}, so costs are shown in points only.`,
    withheldBecause: because,
  };
}

/** Money value of ONE point of price movement, per `lots` lots. */
function moneyPerPoint(model: ValueModel, pointSize: number, lots: number): number | null {
  if (!isPos(pointSize) || !isPos(lots) || model.perPricePerLot == null) return null;
  return model.perPricePerLot * pointSize * lots;
}

export function estimateExecutionPreview(input: ExecutionPreviewInput): ExecutionPreview {
  const {
    symbol, side, orderType, lots, spec, hasBrokerTruth, quote, atrPrice,
    slippageHistory, accountBalance, leverage, riskPercent, openExposure,
    maxSpreadPoints,
  } = input;

  const blockers: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  let degraded = false;

  const bid = isPos(quote.bid) ? quote.bid : null;
  const ask = isPos(quote.ask) ? quote.ask : null;
  const mid = bid != null && ask != null ? (bid + ask) / 2 : (bid ?? ask ?? null);
  const sideAdverseEntry = side === "BUY" ? (ask ?? mid) : (bid ?? mid);
  const referencePrice = isPos(input.entry) ? input.entry : sideAdverseEntry;

  // Point size: broker truth preferred, else inferred from price magnitude.
  let pointInferred = false;
  let pointSize: number;
  if (isPos(spec.point)) {
    pointSize = spec.point;
  } else if (referencePrice != null) {
    pointSize = inferPointSize(referencePrice, symbol);
    pointInferred = true;
    degraded = true;
    notes.push("Broker tick size not reported yet — point size estimated from price.");
  } else {
    pointSize = inferPointSize(1, symbol);
    pointInferred = true;
    degraded = true;
  }

  const valueModel = resolveValueModel({
    symbol,
    contract: input.contract ?? null,
    accountCurrency: input.accountCurrency ?? null,
    hasBrokerTruth,
    price: referencePrice,
  });
  const mpp = moneyPerPoint(valueModel, pointSize, lots);
  if (mpp == null) {
    if (isPos(pointSize) && isPos(lots) && valueModel.perPricePerLot == null) {
      notes.push(valueModel.note);
    } else {
      notes.push("Lot size or price increment unavailable — money values can't be computed.");
    }
    degraded = true;
  } else {
    notes.push(valueModel.note);
  }

  // ── Spread cost ───────────────────────────────────────────────────────────
  let spreadPoints = 0;
  if (bid != null && ask != null && isPos(pointSize)) {
    spreadPoints = Math.max(0, (ask - bid) / pointSize);
  } else {
    degraded = true;
    notes.push("No live bid/ask — spread cost can't be measured right now.");
  }
  const spreadCost: CostAmount = {
    points: round(spreadPoints, 2),
    money: mpp != null ? round(spreadPoints * (mpp / lots) * lots, 2) : null,
  };
  // money/point already includes lots, so spread money = spreadPoints * mpp.
  spreadCost.money = mpp != null ? round(spreadPoints * mpp, 2) : null;

  // ── Slippage (scaled by lot) ───────────────────────────────────────────────
  const slippage = estimateSlippage({
    symbol, lots, pointSize, spreadPoints, atrPrice, slippageHistory, mpp,
    orderType,
  });
  if (slippage.source !== "HISTORY") degraded = true;

  // ── Expected fill range ────────────────────────────────────────────────────
  let expectedFillRange: ExpectedFillRange | null = null;
  if (referencePrice != null && isPos(pointSize)) {
    const adverse = side === "BUY" ? 1 : -1; // adverse = price moves against us on entry
    const expSlipPrice = slippage.expectedPoints * pointSize;
    const worstSlipPrice = slippage.worstPoints * pointSize;
    const expected = referencePrice + adverse * expSlipPrice;
    const worst = referencePrice + adverse * worstSlipPrice;
    const low = Math.min(referencePrice, expected, worst);
    const high = Math.max(referencePrice, expected, worst);
    const dp = pointDecimals(pointSize);
    expectedFillRange = {
      low: round(low, dp),
      high: round(high, dp),
      expected: round(expected, dp),
    };
  }

  // ── Starting drawdown (pain before profit) = spread + expected slippage ─────
  const startPoints = spreadPoints + slippage.expectedPoints;
  const startingDrawdown: CostAmount = {
    points: round(startPoints, 2),
    money: mpp != null ? round(startPoints * mpp, 2) : null,
  };

  // ── Break-even distance (cover entry cost) ─────────────────────────────────
  const breakEven: CostAmount = {
    points: round(startPoints, 2),
    money: mpp != null ? round(startPoints * mpp, 2) : null,
  };

  // ── Directional sanity: SL/TP must sit on the correct side of entry ────────
  // A BUY's stop is below entry and its target above; a SELL is the mirror.
  // A wrongly-sided level isn't a real stop/target, so we refuse to price it
  // (rather than show a misleadingly "profitable" or "survivable" setup) and
  // raise a plain-English blocker. Levels on the correct side flow through.
  let slValid = true;
  let tpValid = true;
  if (referencePrice != null) {
    if (isPos(input.stopLoss)) {
      const slOnCorrectSide = side === "BUY"
        ? input.stopLoss < referencePrice
        : input.stopLoss > referencePrice;
      if (!slOnCorrectSide) {
        slValid = false;
        blockers.push(
          side === "BUY"
            ? "For a buy, your stop loss must sit below your entry price — move it lower."
            : "For a sell, your stop loss must sit above your entry price — move it higher.",
        );
      }
    }
    if (isPos(input.takeProfit)) {
      const tpOnCorrectSide = side === "BUY"
        ? input.takeProfit > referencePrice
        : input.takeProfit < referencePrice;
      if (!tpOnCorrectSide) {
        tpValid = false;
        blockers.push(
          side === "BUY"
            ? "For a buy, your take profit must sit above your entry price — move it higher."
            : "For a sell, your take profit must sit below your entry price — move it lower.",
        );
      }
    }
  }
  const effectiveStopLoss = slValid ? input.stopLoss : null;
  const effectiveTakeProfit = tpValid ? input.takeProfit : null;

  // ── After-cost SL / TP / R:R ───────────────────────────────────────────────
  const afterCost = computeAfterCost({
    side, entry: referencePrice, stopLoss: effectiveStopLoss, takeProfit: effectiveTakeProfit,
    pointSize, mpp, costPoints: startPoints,
  });

  // ── Survivability ──────────────────────────────────────────────────────────
  const survivability = computeSurvivability({
    side, entry: referencePrice, stopLoss: effectiveStopLoss, atrPrice,
  });
  if (survivability.survivesNormalPullback === false) {
    warnings.push("Your stop is tight versus recent volatility — a normal pullback could close it early.");
  }

  // ── Account impact ─────────────────────────────────────────────────────────
  const accountImpact = computeAccountImpact({
    referencePrice, lots, leverage, accountBalance, mpp, pointSize,
    side, stopLoss: effectiveStopLoss, costPoints: startPoints, riskPercent, symbol,
    valueModel,
  });
  if (
    accountImpact.riskPctOfBalance != null && riskPercent != null &&
    accountImpact.riskPctOfBalance > riskPercent + 0.01
  ) {
    warnings.push(
      `This trade risks about ${round(accountImpact.riskPctOfBalance, 1)}% of your balance — more than your ${round(riskPercent, 1)}% target.`,
    );
  }

  // ── Order-type comparison ──────────────────────────────────────────────────
  const orderTypes = compareOrderTypes({
    chosen: orderType, spreadPoints, slippage, mpp,
  });

  // ── Multi-entry exposure + scaling ─────────────────────────────────────────
  const multiEntry = buildMultiEntry({
    side, lots, openExposure, riskMoney: accountImpact.riskMoney,
  });
  if (multiEntry?.opposesExisting) {
    warnings.push("You already hold an opposite position on this symbol — confirm you mean to hedge or reduce, not stack.");
  }

  // ── Broker-condition downgrade / block ─────────────────────────────────────
  const brokerCondition = evaluateBrokerCondition({
    spec, side, lots, spreadPoints, maxSpreadPoints, bid, ask, quote,
  });
  if (brokerCondition.verdict === "BLOCK") {
    for (const r of brokerCondition.reasons) blockers.push(r);
  } else if (brokerCondition.verdict === "DOWNGRADE") {
    for (const r of brokerCondition.reasons) warnings.push(r);
  }

  // ── Input sanity blockers ──────────────────────────────────────────────────
  if (!isPos(lots)) blockers.push("Enter a trade size greater than zero to preview costs.");

  const dataQuality: ExecutionDataQuality = {
    hasBrokerTruth,
    degraded,
    notes,
  };

  return {
    symbol,
    side,
    orderType,
    lots,
    referencePrice: referencePrice != null ? round(referencePrice, pointDecimals(pointSize)) : null,
    pointSize,
    pointInferred,
    moneyPerPoint: mpp != null ? round(mpp, 4) : null,
    spreadCost,
    slippage,
    expectedFillRange,
    startingDrawdown,
    breakEven,
    afterCost,
    survivability,
    accountImpact,
    orderTypes,
    multiEntry,
    brokerCondition,
    dataQuality,
    blockers,
    warnings,
    disclaimer: DISCLAIMER,
  };
}

function pointDecimals(pointSize: number): number {
  if (!isPos(pointSize)) return 5;
  return clamp(Math.round(-Math.log10(pointSize)), 0, 8);
}

// ── Slippage estimate ────────────────────────────────────────────────────────
function estimateSlippage(a: {
  symbol: string;
  lots: number;
  pointSize: number;
  spreadPoints: number;
  atrPrice: number | null;
  slippageHistory: ExecutionPreviewInput["slippageHistory"];
  mpp: number | null;
  orderType: ExecutionPreviewInput["orderType"];
}): SlippageEstimate {
  const { lots, pointSize, spreadPoints, atrPrice, slippageHistory, mpp, orderType } = a;
  // Limit/stop orders fill at their price (or not at all) — far less slippage
  // than a market order. Apply a market multiplier.
  const marketMult = orderType === "MARKET" ? 1 : 0.35;
  // Lot scaling: bigger orders walk the book. Baseline at 0.10 lots, grows with
  // size (sub-linear). At 1.0 lot ≈ +50%, at 5.0 lots ≈ +100%.
  const lotMult = 1 + Math.min(1, Math.max(0, (lots - 0.1)) * 0.25);

  let baseExpected: number;
  let baseWorst: number;
  let source: SlippageEstimate["source"];
  let note: string;

  if (slippageHistory && slippageHistory.sampleCount > 0 && slippageHistory.meanPoints >= 0) {
    baseExpected = slippageHistory.meanPoints;
    baseWorst = Math.max(slippageHistory.worstPoints, slippageHistory.meanPoints);
    source = "HISTORY";
    note = `Based on your last ${slippageHistory.sampleCount} fills on this symbol.`;
  } else if (atrPrice != null && atrPrice > 0 && pointSize > 0) {
    // ~2% of one ATR as a typical market-order slip, in points.
    const atrPoints = atrPrice / pointSize;
    baseExpected = Math.max(spreadPoints * 0.5, atrPoints * 0.02);
    baseWorst = Math.max(spreadPoints, atrPoints * 0.06);
    source = "VOLATILITY_FALLBACK";
    note = "No fill history yet — estimated from recent volatility. Real slippage may differ.";
  } else {
    // Last resort: half-spread expected, full-spread worst.
    baseExpected = spreadPoints * 0.5;
    baseWorst = spreadPoints;
    source = "SPREAD_FALLBACK";
    note = "No fill history or volatility read — estimated from the current spread. Real slippage may differ.";
  }

  const expectedPoints = Math.max(0, baseExpected * marketMult * lotMult);
  const worstPoints = Math.max(expectedPoints, baseWorst * marketMult * lotMult);
  return {
    source,
    expectedPoints: round(expectedPoints, 2),
    worstPoints: round(worstPoints, 2),
    expectedMoney: mpp != null ? round(expectedPoints * mpp, 2) : null,
    worstMoney: mpp != null ? round(worstPoints * mpp, 2) : null,
    note,
  };
}

// ── After-cost SL / TP / R:R ──────────────────────────────────────────────────
function computeAfterCost(a: {
  side: ExecutionPreviewInput["side"];
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  pointSize: number;
  mpp: number | null;
  costPoints: number;
}): AfterCostOutcome {
  const { entry, stopLoss, takeProfit, pointSize, mpp, costPoints } = a;
  if (entry == null || !isPos(pointSize)) {
    return { stopLossMoney: null, takeProfitMoney: null, riskRewardRatio: null, grossRiskRewardRatio: null };
  }
  const slPts = isPos(stopLoss) ? Math.abs(entry - stopLoss) / pointSize : null;
  const tpPts = isPos(takeProfit) ? Math.abs(entry - takeProfit) / pointSize : null;

  // Cost makes the effective loss larger and the effective gain smaller.
  const netLossPts = slPts != null ? slPts + costPoints : null;
  const netGainPts = tpPts != null ? Math.max(0, tpPts - costPoints) : null;

  const grossRr = slPts != null && tpPts != null && slPts > 0 ? tpPts / slPts : null;
  const netRr = netLossPts != null && netGainPts != null && netLossPts > 0
    ? netGainPts / netLossPts
    : null;

  return {
    stopLossMoney: netLossPts != null && mpp != null ? round(netLossPts * mpp, 2) : null,
    takeProfitMoney: netGainPts != null && mpp != null ? round(netGainPts * mpp, 2) : null,
    riskRewardRatio: netRr != null ? round(netRr, 2) : null,
    grossRiskRewardRatio: grossRr != null ? round(grossRr, 2) : null,
  };
}

// ── Survivability ─────────────────────────────────────────────────────────────
function computeSurvivability(a: {
  side: ExecutionPreviewInput["side"];
  entry: number | null;
  stopLoss: number | null;
  atrPrice: number | null;
}): SurvivabilityEstimate {
  const { entry, stopLoss, atrPrice } = a;
  if (entry == null || !isPos(stopLoss) || atrPrice == null || atrPrice <= 0) {
    return {
      score: 0,
      stopDistanceAtr: null,
      survivesNormalPullback: null,
      survivesStructureInvalidation: null,
      note: "Add a stop loss and a volatility read to gauge how well it survives market noise.",
    };
  }
  const stopDist = Math.abs(entry - stopLoss);
  const atrs = stopDist / atrPrice;
  // 1 ATR ≈ a normal pullback; 2 ATR ≈ beyond typical structure noise.
  const survivesNormalPullback = atrs >= 1;
  const survivesStructureInvalidation = atrs >= 2;
  // Score: 0 at 0 ATR, ~70 at 1 ATR, ~90 at 2 ATR, capped 100.
  const score = clamp(Math.round((atrs / 2) * 90), 0, 100);
  let note: string;
  if (atrs >= 2) note = "Your stop sits beyond typical market noise — strong room to breathe.";
  else if (atrs >= 1) note = "Your stop clears a normal pullback but not a deeper shakeout.";
  else note = "Your stop is inside normal market noise — it may be hit by routine wiggles.";
  return {
    score,
    stopDistanceAtr: round(atrs, 2),
    survivesNormalPullback,
    survivesStructureInvalidation,
    note,
  };
}

// ── Account impact ────────────────────────────────────────────────────────────
function computeAccountImpact(a: {
  referencePrice: number | null;
  lots: number;
  leverage: number | null;
  accountBalance: number | null;
  mpp: number | null;
  pointSize: number;
  side: ExecutionPreviewInput["side"];
  stopLoss: number | null;
  costPoints: number;
  riskPercent: number | null;
  symbol: string;
  valueModel: ValueModel;
}): AccountImpact {
  const {
    referencePrice, lots, leverage, accountBalance, mpp, pointSize, stopLoss,
    costPoints, valueModel,
  } = a;

  // Margin: contract notional / leverage, in dollars. Notional = price ×
  // (dollars per 1.0 of price per lot) × lots — for USDJPY that is 100,000
  // USD per lot, for EURUSD price × 100,000, for XAUUSD price × 100 oz.
  let marginRequired: number | null = null;
  const modelled = valueModel.perPricePerLot != null;
  if (modelled && isPos(referencePrice) && isPos(lots) && isPos(leverage)) {
    const notional = referencePrice * valueModel.perPricePerLot! * lots;
    marginRequired = round(notional / leverage, 2);
  }
  const marginPct =
    marginRequired != null && isPos(accountBalance)
      ? round((marginRequired / accountBalance) * 100, 2)
      : null;

  // Risk money = (stop distance + entry cost) in money.
  let riskMoney: number | null = null;
  if (isPos(referencePrice) && isPos(stopLoss) && isPos(pointSize) && mpp != null) {
    const slPts = Math.abs(referencePrice - stopLoss) / pointSize;
    riskMoney = round((slPts + costPoints) * mpp, 2);
  }
  const riskPct =
    riskMoney != null && isPos(accountBalance)
      ? round((riskMoney / accountBalance) * 100, 2)
      : null;

  let note: string;
  if (!modelled) {
    note = `Margin and risk are not shown in money — ${valueModel.withheldBecause ?? "money values can't be derived for this symbol"}.`;
  } else if (marginRequired == null && riskMoney == null) {
    note = "Add your balance and a stop loss to see margin and risk in money.";
  } else if (riskMoney != null) {
    note = "Risk includes the stop distance plus expected entry cost.";
  } else {
    note = valueModel.fromBroker
      ? "Margin estimated from your broker's reported figures for this symbol."
      : "Margin estimated from the standard contract model for this symbol.";
  }
  return { marginRequired, marginPctOfBalance: marginPct, riskMoney, riskPctOfBalance: riskPct, note };
}

// ── Order-type comparison ─────────────────────────────────────────────────────
function compareOrderTypes(a: {
  chosen: ExecutionPreviewInput["orderType"];
  spreadPoints: number;
  slippage: SlippageEstimate;
  mpp: number | null;
}): OrderTypeOption[] {
  const { spreadPoints, slippage, mpp } = a;
  const marketSlipMoney = slippage.expectedMoney;
  // Market: fills now, pays spread + slippage.
  const market: OrderTypeOption = {
    type: "MARKET",
    fillLikelihood: 99,
    expectedCostMoney:
      mpp != null ? round(spreadPoints * mpp + (marketSlipMoney ?? 0), 2) : null,
    recommended: false,
    note: "Fills immediately at the current price; you pay the spread and any slippage.",
  };
  // Limit: cheaper (little/no slippage) but may not fill.
  const limit: OrderTypeOption = {
    type: "LIMIT",
    fillLikelihood: 60,
    expectedCostMoney: mpp != null ? round(spreadPoints * mpp * 0.5, 2) : null,
    recommended: false,
    note: "Waits for your price — usually cheaper, but it may never fill if price runs away.",
  };
  // Stop: enters on momentum confirmation, pays spread + some slippage.
  const stop: OrderTypeOption = {
    type: "STOP",
    fillLikelihood: 80,
    expectedCostMoney:
      mpp != null ? round(spreadPoints * mpp + (marketSlipMoney ?? 0) * 0.7, 2) : null,
    recommended: false,
    note: "Triggers only if price breaks your level — good for breakouts, with some slippage.",
  };
  // Recommend the cheapest viable type: prefer LIMIT when slippage is material,
  // else MARKET for certainty.
  const slipMaterial = slippage.expectedPoints > spreadPoints;
  if (slipMaterial) limit.recommended = true;
  else market.recommended = true;
  return [market, limit, stop];
}

// ── Multi-entry exposure + scaling ────────────────────────────────────────────
function buildMultiEntry(a: {
  side: ExecutionPreviewInput["side"];
  lots: number;
  openExposure: ExecutionPreviewInput["openExposure"];
  riskMoney: number | null;
}): MultiEntryPlan | null {
  const { side, lots, openExposure, riskMoney } = a;
  if (!openExposure || openExposure.openLots <= 0) return null;
  const addsToSameDirection = openExposure.netSide === side;
  const opposesExisting = openExposure.netSide != null && openExposure.netSide !== side;
  const combinedLots = round(openExposure.openLots + lots, 2);
  let scalingNote: string;
  if (opposesExisting) {
    scalingNote = "This order opposes your existing position. Treat it as a hedge or partial close, not a new entry.";
  } else if (addsToSameDirection) {
    scalingNote = "You're adding to an existing position. Keep total risk within your plan — consider a smaller add or move your stop to protect the first entry.";
  } else {
    scalingNote = "You already hold exposure on this symbol — size this entry with the combined total in mind.";
  }
  return {
    hasExistingExposure: true,
    combinedLots,
    combinedRiskMoney: riskMoney != null ? riskMoney : null,
    addsToSameDirection,
    opposesExisting,
    scalingNote,
  };
}

// ── Broker-condition downgrade / block ────────────────────────────────────────
function evaluateBrokerCondition(a: {
  spec: ExecutionPreviewInput["spec"];
  side: ExecutionPreviewInput["side"];
  lots: number;
  spreadPoints: number;
  maxSpreadPoints: number;
  bid: number | null;
  ask: number | null;
  quote: ExecutionPreviewInput["quote"];
}): BrokerCondition {
  const { spec, side, lots, spreadPoints, maxSpreadPoints, bid, ask, quote } = a;
  const reasons: string[] = [];
  let verdict: BrokerCondition["verdict"] = "OK";
  const escalate = (v: BrokerCondition["verdict"]) => {
    if (v === "BLOCK") verdict = "BLOCK";
    else if (v === "DOWNGRADE" && verdict !== "BLOCK") verdict = "DOWNGRADE";
  };

  // Trade-mode hard blocks (only when the broker has reported them).
  const modeBlocksEntry =
    spec.tradeMode === "DISABLED" ||
    spec.tradeMode === "CLOSEONLY" ||
    (spec.tradeMode === "LONGONLY" && side === "SELL") ||
    (spec.tradeMode === "SHORTONLY" && side === "BUY");
  if (spec.tradeAllowed === false || spec.visible === false || modeBlocksEntry) {
    reasons.push("Your broker isn't allowing new entries on this symbol right now.");
    escalate("BLOCK");
  }
  if (spec.marketOpen === false) {
    reasons.push("The market for this symbol is closed at your broker right now.");
    escalate("BLOCK");
  }

  // No live prices — cannot price the trade; downgrade (advisory, not a block).
  if (bid == null || ask == null) {
    reasons.push("No live price right now — costs below are estimated and may be off.");
    escalate("DOWNGRADE");
  }

  // Stale quote — downgrade.
  if (quote.quoteAgeMs == null || quote.quoteAgeMs > 5_000) {
    reasons.push("The latest price looks stale — wait for a fresh quote for an accurate read.");
    escalate("DOWNGRADE");
  }

  // Spread blow-out vs tolerance.
  if (spreadPoints > 0 && spreadPoints > maxSpreadPoints) {
    reasons.push("The spread is wider than your limit — entering now would cost more than usual.");
    escalate("DOWNGRADE");
  }

  // Volume bounds (only when broker reported them).
  if (isPos(spec.minVolume) && lots < spec.minVolume) {
    reasons.push("Your trade size is below your broker's minimum for this symbol.");
    escalate("BLOCK");
  }
  if (isPos(spec.maxVolume) && lots > spec.maxVolume) {
    reasons.push("Your trade size is above your broker's maximum for this symbol.");
    escalate("BLOCK");
  }

  return { verdict, reasons };
}
