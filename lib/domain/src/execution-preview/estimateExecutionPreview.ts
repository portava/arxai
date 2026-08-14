// Execution Preview — pure estimator (Task #196).
//
// estimateExecutionPreview(input) -> ExecutionPreview. Pure & deterministic:
// no IO, no Date.now, no randomness. The caller assembles every input (broker
// spec, quote, ATR, slippage history, balance) and surfaces the result in the
// trade modal. Nothing here can place, modify, or block a trade.
//
// Money model: where the broker has not reported a tick value (always, for now,
// since the EA reports `point` but not tickValue), money is derived from ARX's
// standard per-symbol contract model — the SAME assumptions the live position
// sizer already uses (forex $10 per pip per lot; synthetics / indices $1 per
// price unit per lot). This is spec-derived + a documented model, never a
// fabricated broker number; `dataQuality` says so honestly.

import type {
  AccountImpact,
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
function isForex(symbol: string): boolean {
  const s = symbol.replace(/\s/g, "").toUpperCase();
  if (/^[A-Z]{6}$/.test(s)) return true;
  return s.includes("USD") || s.includes("EUR") || s.includes("GBP") ||
    s.includes("JPY") || s.includes("CHF") || s.includes("AUD") ||
    s.includes("CAD") || s.includes("NZD");
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
 * Money value of ONE point of price movement, per `lots` lots. Mirrors the live
 * position sizer's contract model so previews and sizing agree.
 *   forex:        $10 per pip per lot; pip = 10 points (5/3-digit) → per-point
 *                 derived from pip size & point size.
 *   synthetic/    $1 per 1.0 of price per lot → per-point = pointSize.
 *   indices/other treated synthetic-style ($1 per price unit per lot).
 */
function moneyPerPoint(symbol: string, pointSize: number, lots: number): number | null {
  if (!isPos(pointSize) || !isPos(lots)) return null;
  if (isForex(symbol) && !isSynthetic(symbol)) {
    const pipSize = isJpy(symbol) ? 0.01 : 0.0001;
    const pipValuePerLot = 10; // $10 per pip per standard lot (model)
    const valuePerPricePerLot = pipValuePerLot / pipSize; // money per 1.0 price per lot
    return valuePerPricePerLot * pointSize * lots;
  }
  // synthetics / indices / stocks: $1 per 1.0 price unit per lot
  return 1 * pointSize * lots;
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

  const mpp = moneyPerPoint(symbol, pointSize, lots);
  if (mpp == null) {
    notes.push("Lot size or price increment unavailable — money values can't be computed.");
    degraded = true;
  } else if (!hasBrokerTruth || pointInferred) {
    notes.push("Money values use ARX's standard contract model for this symbol, not broker-reported tick value.");
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
}): AccountImpact {
  const {
    referencePrice, lots, leverage, accountBalance, mpp, pointSize, stopLoss,
    costPoints, symbol,
  } = a;

  // Margin: contract notional / leverage. Notional uses the contract model.
  let marginRequired: number | null = null;
  if (isPos(referencePrice) && isPos(lots) && isPos(leverage)) {
    const contractSize = isForex(symbol) && !isSynthetic(symbol) ? 100_000 : 1;
    const notional = referencePrice * contractSize * lots;
    // For synthetics/indices the "$1 per price unit per lot" model implies a
    // notional ≈ price * lots; either way notional/leverage is the margin.
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
  if (marginRequired == null && riskMoney == null) {
    note = "Add your balance and a stop loss to see margin and risk in money.";
  } else if (riskMoney != null) {
    note = "Risk includes the stop distance plus expected entry cost.";
  } else {
    note = "Margin estimated from the standard contract model for this symbol.";
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
