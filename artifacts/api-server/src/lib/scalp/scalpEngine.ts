// Ruby Scalp Signals — shared scalp evaluation engine (pure, deterministic).
//
// `evaluateScalp(input)` is the single brain behind the Focus Scan card, the
// Broad Scan ranking, and the Ruby Scalp Builder. It is pure (no I/O); the
// service layer gathers live inputs (scanner read, broker specs, account) and
// calls this. Same scoring + same risk math everywhere => no conflicting
// answers.
//
// HARD RULES honoured here:
//  - DEMO/LIVE only. dataSource other than LIVE_FEED (incl. SIMULATOR) is never
//    used for a recommendation — it returns AWAITING_DATA. No fake fallbacks.
//  - Lot size is generated from REAL broker specs (tick value / contract size)
//    and clamped to min/max/step. Never produced outside min/max/step.
//  - TP/SL come from market structure (scanner read) refined with a spread +
//    broker-stops buffer. SL is never at entry and never inside normal noise.
//  - Reward-to-risk is always computed; poor R:R is labelled, not hidden.

import type {
  ScalpAccountInput,
  ScalpDirection,
  ScalpEngineInput,
  ScalpEntryType,
  ScalpResult,
  ScalpSpecInput,
  ScalpScannerInput,
  ScalpMode,
  ScalpTakeProfit,
  ConfidenceLabel,
  RiskBand,
  RiskPersonality,
  TargetRealityCheck,
} from "./scalpTypes.js";
import { blindFlameRead, finalizeScalpVerdict, readFlame } from "./flameRead.js";
import { DEFAULT_ASSISTANT_NAME } from "@workspace/domain/assistant-name";

const DEFAULT_RISK_FRACTION = 0.01; // Focus card default when user gives no risk amount: 1% of equity/balance.
const DEFAULT_LEVERAGE = 100; // conservative margin estimate fallback when broker leverage unknown.

interface ModeProfile {
  label: string;
  validForSeconds: number;
  minQuality: number; // below this, an otherwise-actionable setup is downgraded to FORMING
  spreadRatioWide: number; // spread/stop ratio above which we flag SPREAD_TOO_WIDE
  lateFraction: number; // fraction of entry->TP already travelled that counts as LATE
  minRewardToRisk: number; // below this R:R, setup is "aggressive"/rejected
}

const MODE_PROFILES: Record<ScalpMode, ModeProfile> = {
  SNIPER: { label: "Sniper Scalp", validForSeconds: 240, minQuality: 76, spreadRatioWide: 0.3, lateFraction: 0.45, minRewardToRisk: 1.5 },
  SAFER: { label: "Safer Scalp", validForSeconds: 210, minQuality: 64, spreadRatioWide: 0.22, lateFraction: 0.55, minRewardToRisk: 1.3 },
  FAST: { label: "Fast Scalp", validForSeconds: 90, minQuality: 58, spreadRatioWide: 0.4, lateFraction: 0.7, minRewardToRisk: 1.0 },
  MOMENTUM: { label: "Momentum Scalp", validForSeconds: 150, minQuality: 62, spreadRatioWide: 0.35, lateFraction: 0.65, minRewardToRisk: 1.1 },
  REVERSAL: { label: "Reversal Scalp", validForSeconds: 180, minQuality: 66, spreadRatioWide: 0.3, lateFraction: 0.55, minRewardToRisk: 1.4 },
  ANY: { label: "Scalp", validForSeconds: 180, minQuality: 60, spreadRatioWide: 0.33, lateFraction: 0.6, minRewardToRisk: 1.2 },
};

function num(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function roundTo(v: number, digits: number): number {
  const d = Math.max(0, Math.min(10, digits));
  return Number(v.toFixed(d));
}

function decimalsOf(step: number): number {
  const s = String(step);
  if (s.includes("e") || s.includes("E")) {
    const m = step.toExponential().match(/e-(\d+)/);
    return m ? Number(m[1]) : 8;
  }
  return (s.split(".")[1] || "").length;
}

/** Floor `raw` to the broker volume step, then clamp to [min,max]. Risk-conservative (floors). */
function clampLotToStep(raw: number, step: number, min: number, max: number): { lot: number; clampedToMin: boolean; clampedToMax: boolean } {
  const safeStep = step > 0 ? step : 0.01;
  const dec = decimalsOf(safeStep);
  let lot = Math.floor(raw / safeStep) * safeStep;
  lot = Number(lot.toFixed(dec));
  let clampedToMin = false;
  let clampedToMax = false;
  if (lot < min) {
    lot = min;
    clampedToMin = true;
  }
  if (lot > max) {
    lot = Number((Math.floor(max / safeStep) * safeStep).toFixed(dec));
    if (lot > max) lot = max;
    clampedToMax = true;
  }
  return { lot: Number(lot.toFixed(dec)), clampedToMin, clampedToMax };
}

/** $ change per 1.0 price move per 1.0 lot — broker truth first, contract size fallback. */
function moneyPerPricePerLot(spec: ScalpSpecInput): number | null {
  if (num(spec.tickValue) && num(spec.tickSize) && spec.tickSize > 0) {
    return spec.tickValue / spec.tickSize;
  }
  if (num(spec.contractSize) && spec.contractSize > 0) {
    return spec.contractSize;
  }
  return null;
}

function confidenceLabelFor(q: number): ConfidenceLabel {
  if (q < 40) return "Weak";
  if (q < 55) return "Modest";
  if (q < 70) return "Fair";
  if (q < 85) return "Strong";
  return "Very Strong";
}

function assetClassFor(category: string | null): string {
  switch ((category || "").toLowerCase()) {
    case "forex": return "Forex";
    case "metal":
    case "metals": return "Metals";
    case "index":
    case "indices": return "Indices";
    case "crypto": return "Crypto";
    case "synthetic":
    case "volatility": return "Synthetic/Volatility";
    case "stock":
    case "stocks": return "Stocks";
    default: return "Market";
  }
}

function isLiveData(dataSource: string): boolean {
  return dataSource === "LIVE_FEED";
}

/** Build a bare result skeleton for early-exit (non-actionable) states. */
function rejectResult(
  input: ScalpEngineInput,
  status: ScalpResult["status"],
  noTradeReason: string,
  opts: { canWatch?: boolean; userAction?: ScalpResult["userAction"]; plain?: string } = {},
): ScalpResult {
  const now = input.now ?? Date.now();
  const profile = MODE_PROFILES[input.mode];
  const displayName = input.spec.displayName || input.symbol;
  return {
    symbol: input.symbol,
    displayName,
    assetClass: assetClassFor(input.spec.category),
    direction: null,
    scalpType: profile.label,
    mode: input.mode,
    status,
    qualityScore: 0,
    confidenceLabel: "Weak",
    entryType: null,
    entryZone: null,
    currentPrice: num(input.currentPrice) ? input.currentPrice : null,
    takeProfit: { quick: null, main: null, stretch: null },
    stopLoss: null,
    invalidationPrice: null,
    suggestedLot: null,
    minLot: num(input.spec.minLot) ? input.spec.minLot : null,
    maxLot: num(input.spec.maxLot) ? input.spec.maxLot : null,
    lotStep: num(input.spec.lotStep) ? input.spec.lotStep : null,
    digits: num(input.spec.digits) ? input.spec.digits : null,
    targetProfitAmount: num(input.targetProfitAmount) ? input.targetProfitAmount : null,
    estimatedProfitMainTP: null,
    estimatedRiskAmount: null,
    rewardToRisk: null,
    estimatedMargin: null,
    spreadRisk: "LOW",
    slippageRisk: "LOW",
    newsRisk: input.scanner?.newsRisk ?? "LOW",
    timingStatus: "WAIT_FOR_ENTRY",
    validForSeconds: 0,
    expiresAt: new Date(now).toISOString(),
    chaseWarning: null,
    plainEnglishReason: opts.plain ?? noTradeReason,
    riskWarning: null,
    targetRealityCheck: null,
    userAction: opts.userAction ?? "WAIT",
    canBuildTrade: false,
    canWatch: opts.canWatch ?? false,
    noTradeReason,
    flame: blindFlameRead(input.riskPersonality ?? "BALANCED", {
      scannerReason: input.scanner?.reasonForTrade ?? null,
      execution: input.execution ?? null,
      specSpreadPoints: num(input.spec.spreadPoints) ? input.spec.spreadPoints : null,
    }),
    generatedAt: new Date(now).toISOString(),
  };
}

function resolveRiskBudget(input: ScalpEngineInput): number | null {
  if (num(input.riskAmount) && input.riskAmount > 0) return input.riskAmount;
  const acct = input.account;
  const base = num(acct.equity) ? acct.equity : num(acct.balance) ? acct.balance : null;
  if (num(base) && base > 0) return roundTo(base * DEFAULT_RISK_FRACTION, 2);
  return null;
}

export function evaluateScalp(input: ScalpEngineInput): ScalpResult {
  const now = input.now ?? Date.now();
  const profile = MODE_PROFILES[input.mode];
  const spec = input.spec;
  const scanner = input.scanner;

  // ── Gate: live data only. No scanner read, no fresh price, or non-live feed
  //    (incl. SIMULATOR) => honest waiting state. Never fabricate.
  if (!scanner || !num(input.currentPrice)) {
    return rejectResult(input, "AWAITING_DATA", "Waiting for fresh price before recommending a scalp.", {
      plain: `${DEFAULT_ASSISTANT_NAME} is waiting for live price data on this market before reading a scalp.`,
    });
  }
  if (!isLiveData(scanner.dataSource)) {
    return rejectResult(input, "AWAITING_DATA", "Waiting for a live market price before recommending a scalp.", {
      plain: `${DEFAULT_ASSISTANT_NAME} only builds scalps from live market data. This market does not have a live price right now.`,
    });
  }

  // ── Gate: ONE shared data-sufficiency authority. The scanner row carries the
  //    shared verdict (`evaluateMarketDataSufficiency`); the scalp engine may
  //    only emit an actionable signal when that verdict says the data is
  //    sufficient (`canShowTradeSetup === true`). FAIL-CLOSED: a missing
  //    verdict counts as not-sufficient. This keeps the scanner card and the
  //    scalp card on the SAME truth — never two different sufficiency bars.
  //    Display/advisory tightening only; never an execution gate.
  const sufficiency = scanner.sufficiency ?? null;
  if (!sufficiency || sufficiency.canShowTradeSetup !== true) {
    return rejectResult(
      input,
      "AWAITING_DATA",
      sufficiency?.humanReason ?? "Waiting for enough verified market data before recommending a scalp.",
      {
        plain:
          `${DEFAULT_ASSISTANT_NAME} needs enough verified live candles before reading a scalp here. `
          + (sufficiency?.humanReason ?? "The market data is not confirmed sufficient yet."),
      },
    );
  }

  // ── Gate: market session / tradability (broker truth).
  if (spec.marketOpen === false) {
    return rejectResult(input, "MARKET_CLOSED", "This market is not tradeable right now.");
  }
  const tradeModeUpper = (spec.tradeMode || "").toUpperCase();
  if (spec.tradeAllowed === false || spec.visible === false || tradeModeUpper === "DISABLED" || tradeModeUpper === "CLOSEONLY") {
    return rejectResult(input, "SYMBOL_NOT_TRADEABLE", "Broker currently does not allow opening trades on this symbol.");
  }

  // ── Direction from the scanner read.
  let direction: ScalpDirection | null = null;
  if (scanner.recommendedAction === "BUY") direction = "BUY";
  else if (scanner.recommendedAction === "SELL") direction = "SELL";
  else if (scanner.bias === "bullish") direction = "BUY";
  else if (scanner.bias === "bearish") direction = "SELL";

  if (!direction || scanner.recommendedAction === "REJECT") {
    return rejectResult(input, "NO_CLEAN_SCALP", "No clean scalp right now. Best action: wait.", {
      canWatch: true,
      plain: "There is no clean scalp here right now. The market is not giving a clear direction with enough quality.",
    });
  }

  // ── Direction allowed by broker trade mode?
  if (tradeModeUpper === "LONGONLY" && direction === "SELL") {
    return rejectResult(input, "SYMBOL_NOT_TRADEABLE", "Broker only allows buy trades on this symbol right now.");
  }
  if (tradeModeUpper === "SHORTONLY" && direction === "BUY") {
    return rejectResult(input, "SYMBOL_NOT_TRADEABLE", "Broker only allows sell trades on this symbol right now.");
  }

  const price = input.currentPrice;
  const digits = num(spec.digits) ? spec.digits : 2;
  const point = num(spec.point) && spec.point > 0 ? spec.point : Math.pow(10, -digits);

  // ── Specs needed for honest sizing.
  const mpp = moneyPerPricePerLot(spec);
  if (!spec.hasBrokerTruth || !num(spec.minLot) || !num(spec.maxLot) || !num(spec.lotStep) || !num(mpp)) {
    return rejectResult(input, "AWAITING_DATA", `${DEFAULT_ASSISTANT_NAME} needs live symbol specs before building a scalp for this market.`, {
      canWatch: true,
      plain: `${DEFAULT_ASSISTANT_NAME} needs the broker's live symbol details (lot size, point value) for this market before building a scalp.`,
    });
  }
  const minLot = spec.minLot;
  const maxLot = spec.maxLot;
  const lotStep = spec.lotStep;

  // ── Spread in price terms + spread risk band (relative to the structural stop).
  const structuralStopDist = Math.abs(scanner.entry - scanner.stopLoss);
  const spreadPrice = num(spec.spreadPoints) ? spec.spreadPoints * point : 0;
  const stopsLevelPrice = num(spec.stopsLevelPoints) ? spec.stopsLevelPoints * point : 0;

  // ── Stop loss: start from scanner structure (invalidation), then enforce a
  //    spread + broker-stops + volatility buffer so it never sits inside noise.
  const minStopDist = Math.max(spreadPrice * 2 + stopsLevelPrice, structuralStopDist > 0 ? structuralStopDist : spreadPrice * 3, point * 10);
  let stopDist = Math.max(structuralStopDist, minStopDist);
  if (!(stopDist > 0)) {
    return rejectResult(input, "NO_CLEAN_SCALP", "The stop would sit inside normal market noise, so this scalp is not clean.", {
      canWatch: true,
    });
  }
  const stopLoss = roundTo(direction === "BUY" ? scanner.entry - stopDist : scanner.entry + stopDist, digits);
  const invalidationPrice = stopLoss;
  stopDist = Math.abs(scanner.entry - stopLoss);

  // ── Spread-vs-stop ratio gate.
  const spreadRatio = stopDist > 0 ? spreadPrice / stopDist : 1;
  if (spreadRatio > profile.spreadRatioWide) {
    return rejectResult(input, "SPREAD_TOO_WIDE", "Spread is too wide for a clean scalp right now.", {
      canWatch: true,
      plain: "The spread is too wide for a clean scalp here right now — it would eat too much of the trade.",
    });
  }
  const spreadRisk: RiskBand = spreadRatio > profile.spreadRatioWide * 0.6 ? "MEDIUM" : "LOW";

  // ── News gate.
  const newsRisk: RiskBand = scanner.newsRisk ?? "LOW";
  if (newsRisk === "HIGH") {
    return rejectResult(input, "NEWS_DANGER", "High-impact news risk makes this scalp unsafe right now.", {
      canWatch: true,
      plain: "There is high-impact news risk around this market, so a scalp is unsafe right now.",
    });
  }

  // ── Take-profit ladder from structure (scanner TP) + spread cost awareness.
  const structuralTpDist = Math.abs(scanner.takeProfit - scanner.entry);
  // Main TP must clear the spread to be reachable; fall back to a multiple of stop if structure is missing.
  const mainTpDist = Math.max(structuralTpDist, stopDist * profile.minRewardToRisk, spreadPrice * 4);
  const sign = direction === "BUY" ? 1 : -1;
  const mainTp = roundTo(scanner.entry + sign * mainTpDist, digits);
  const quickTp = roundTo(scanner.entry + sign * mainTpDist * 0.5, digits);
  const stretchTp = roundTo(scanner.entry + sign * mainTpDist * 1.6, digits);
  const takeProfit: ScalpTakeProfit = { quick: quickTp, main: mainTp, stretch: stretchTp };

  // ── Reward-to-risk on the main TP.
  const rewardToRisk = stopDist > 0 ? roundTo(mainTpDist / stopDist, 2) : 0;

  // ── Entry zone + timing (is the price still in a good place to enter?).
  const zoneFrom = scanner.entryZone ? roundTo(scanner.entryZone.low, digits) : roundTo(scanner.entry - spreadPrice * 2 - point * 5, digits);
  const zoneTo = scanner.entryZone ? roundTo(scanner.entryZone.high, digits) : roundTo(scanner.entry + spreadPrice * 2 + point * 5, digits);
  const entryRef = (zoneFrom + zoneTo) / 2;
  // How far has price already travelled toward the TP from the entry reference?
  const movedToward = sign * (price - entryRef);
  const lateFraction = mainTpDist > 0 ? movedToward / mainTpDist : 0;

  const inZone = price >= Math.min(zoneFrom, zoneTo) && price <= Math.max(zoneFrom, zoneTo);

  let status: ScalpResult["status"];
  let timingStatus: ScalpResult["timingStatus"];
  let entryType: ScalpEntryType;
  let chaseWarning: string | null = null;
  let userAction: ScalpResult["userAction"];
  let canBuildTrade: boolean;
  let canWatch = false;

  if (lateFraction >= profile.lateFraction) {
    status = "LATE";
    timingStatus = "LATE";
    entryType = direction === "BUY" ? "MARKET_BUY" : "MARKET_SELL";
    const chaseAt = roundTo(quickTp, digits);
    chaseWarning = `Do not chase ${direction === "BUY" ? "above" : "below"} ${chaseAt}. Price has already moved too far toward target.`;
    userAction = "AVOID";
    canBuildTrade = false;
    canWatch = true;
  } else if (inZone) {
    status = "READY";
    timingStatus = "VALID_NOW";
    entryType = direction === "BUY" ? "MARKET_BUY" : "MARKET_SELL";
    userAction = "READY_TO_REVIEW";
    canBuildTrade = true;
  } else {
    status = "WAIT_FOR_ENTRY";
    timingStatus = "WAIT_FOR_ENTRY";
    // Price not yet at the zone: prepare a pending order into the zone.
    const zoneEdge = direction === "BUY" ? Math.max(zoneFrom, zoneTo) : Math.min(zoneFrom, zoneTo);
    if (direction === "BUY") entryType = price > zoneEdge ? "BUY_LIMIT" : "BUY_STOP";
    else entryType = price < zoneEdge ? "SELL_LIMIT" : "SELL_STOP";
    userAction = "WATCH";
    canBuildTrade = false;
    canWatch = true;
  }

  // ── Quality score (shared, mode-weighted).
  let quality = 0.5 * scanner.confidenceScore + 0.5 * scanner.entrySniperScore;
  const trend = num(scanner.trendStrength) ? scanner.trendStrength : 50;
  // Mode tilts.
  switch (input.mode) {
    case "SNIPER": quality += (scanner.entrySniperScore - 60) * 0.2; break;
    case "SAFER": quality += (rewardToRisk - 1.5) * 6 - (spreadRisk === "MEDIUM" ? 8 : 0); break;
    case "FAST": quality += (trend - 50) * 0.15; break;
    case "MOMENTUM": quality += (trend - 50) * 0.25; break;
    case "REVERSAL": quality += (60 - trend) * 0.15; break;
    case "ANY": break;
  }
  if (spreadRisk === "MEDIUM") quality -= 5;
  if (newsRisk === "MEDIUM") quality -= 5;
  if (status === "LATE") quality -= 18;
  if (rewardToRisk < profile.minRewardToRisk) quality -= 10;

  // ── Flame read (running-momentum intelligence). Pure; built from the live
  //    candle window + price geometry + per-user execution signals. When no
  //    candle window is supplied the read is BLIND (honest NONE) and suggests
  //    no downgrade, so the existing scanner-only behaviour is unchanged.
  const personality: RiskPersonality = input.riskPersonality ?? "BALANCED";
  const flameCore = readFlame({
    direction,
    candles: input.candles ?? null,
    price,
    point,
    spreadPrice,
    stopDist,
    mainTpDist,
    quickTpDist: Math.abs(quickTp - scanner.entry),
    lateFraction,
    inZone,
    execution: input.execution ?? null,
    htfBias: input.htfBias ?? null,
    personality,
    scannerReason: scanner.reasonForTrade ?? null,
    scannerSetupType: scanner.setupType ?? null,
    invalidationPrice,
    quickTpPrice: quickTp,
    mainTpPrice: mainTp,
    digits,
  });
  quality += flameCore.scoreAdjust;
  // ── Learned per-symbol personality (Phase 3). BOUNDED, TIGHTENING-ONLY:
  //    qualityBias is a penalty (≤ 0), defensively clamped so learning can only
  //    ever subtract — it can never raise the score or loosen a gate. Absent →
  //    no effect.
  const learnedBias = Math.min(0, input.symbolPersonality?.qualityBias ?? 0);
  quality += learnedBias;
  let qualityScore = Math.max(0, Math.min(100, Math.round(quality)));

  // ── R:R quality. Poor R:R is labelled, never hidden.
  let riskWarning: string | null = `This scalp is invalid if price ${direction === "BUY" ? "breaks and holds below" : "breaks and holds above"} ${invalidationPrice}.`;
  if (rewardToRisk < profile.minRewardToRisk && (status === "READY" || status === "WAIT_FOR_ENTRY")) {
    // Keep the setup visible but downgrade — aggressive, not clean.
    if (rewardToRisk < 1) {
      status = "NO_CLEAN_SCALP";
      canBuildTrade = false;
      canWatch = true;
      userAction = "WAIT";
    }
  }

  // ── Sniper / mode quality floor: downgrade thin setups to FORMING. The
  //    learned per-symbol personality can RAISE this floor (tightening-only);
  //    minQualityDelta is clamped ≥ 0 so it can never lower it. Absent → no-op.
  const minQualityFloor = profile.minQuality + Math.max(0, input.symbolPersonality?.minQualityDelta ?? 0);
  if ((status === "READY" || status === "WAIT_FOR_ENTRY") && qualityScore < minQualityFloor) {
    status = "FORMING";
    timingStatus = "WAIT_FOR_ENTRY";
    userAction = "WATCH";
    canBuildTrade = false;
    canWatch = true;
  }

  // ── Flame-driven downgrades. Only honoured when the read is NOT blind (i.e.
  //    real candle evidence). These tighten an otherwise-actionable setup; they
  //    never loosen a safety/economic gate (those already ran above).
  let flameKilled = false;
  if (!flameCore.blind && (status === "READY" || status === "WAIT_FOR_ENTRY" || status === "FORMING")) {
    const dg = flameCore.downgrade;
    if (dg.kind === "NO_SCALP") {
      status = "NO_CLEAN_SCALP";
      timingStatus = "WAIT_FOR_ENTRY";
      userAction = "WAIT";
      canBuildTrade = false;
      canWatch = true;
      flameKilled = true;
    } else if (dg.kind === "LATE") {
      status = "LATE";
      timingStatus = "LATE";
      userAction = "AVOID";
      canBuildTrade = false;
      canWatch = true;
      if (!chaseWarning) chaseWarning = dg.reason;
    } else if (dg.kind === "FORMING") {
      status = "FORMING";
      timingStatus = "WAIT_FOR_ENTRY";
      userAction = "WATCH";
      canBuildTrade = false;
      canWatch = true;
    }
  }

  // ── Failed-flame lockout. A recent FAILED flame in THIS direction is still
  //    on a short cooldown — downgrade an otherwise-actionable read so the user
  //    is not nudged straight back into the same losing side. Recommendations
  //    only; this never loosens a gate, it only tightens.
  let lockoutKilled = false;
  if (input.recentFailureLockout && (status === "READY" || status === "WAIT_FOR_ENTRY" || status === "FORMING" || status === "LATE")) {
    status = "NO_CLEAN_SCALP";
    timingStatus = "WAIT_FOR_ENTRY";
    userAction = "WAIT";
    canBuildTrade = false;
    canWatch = true;
    lockoutKilled = true;
  }

  // ── CHART PATTERN TRUTH fold (Task #617). DISPLAY/DOWNGRADE-ONLY child input.
  //    The pattern may only make the read the SAME or MORE conservative: it caps
  //    the quality score, marks a setup conditional/too-late, or refuses on a
  //    failed/invalidated pattern. It NEVER raises the score, NEVER produces a
  //    clean READY the base read did not, and NEVER loosens a safety/economic
  //    gate (all of those already ran above). Absent → no effect.
  let patternKilled = false;
  const pat = input.patternImpact ?? null;
  if (pat) {
    // Quality ceiling: clamp DOWN only.
    if (num(pat.qualityCeiling)) {
      qualityScore = Math.max(0, Math.min(qualityScore, Math.round(pat.qualityCeiling)));
    }
    const actionable = status === "READY" || status === "WAIT_FOR_ENTRY" || status === "FORMING";
    if (actionable) {
      if (pat.status === "failed" || pat.status === "invalidated") {
        // A broken pattern in this structure: no clean scalp.
        status = "NO_CLEAN_SCALP";
        timingStatus = "WAIT_FOR_ENTRY";
        userAction = "WAIT";
        canBuildTrade = false;
        canWatch = true;
        patternKilled = true;
      } else if ((pat.status === "exhausted" || pat.chaseRisk) && status !== "FORMING") {
        // Pattern is exhausted / entry now would be a chase.
        status = "LATE";
        timingStatus = "LATE";
        userAction = "AVOID";
        canBuildTrade = false;
        canWatch = true;
        if (!chaseWarning) {
          chaseWarning = "The chart pattern here looks exhausted — entering now would be chasing a move that has already run.";
        }
      } else if (pat.status === "forming" || pat.conditional || pat.contextOnly) {
        // Forming / conditional / context-only pattern: never a clean READY.
        if (status === "READY") {
          status = "FORMING";
          timingStatus = "WAIT_FOR_ENTRY";
          userAction = "WATCH";
          canBuildTrade = false;
          canWatch = true;
        }
      }
    }
    // Limited room into S/R: keep visible, but warn (never hide).
    if (pat.limitedRoom && status !== "NO_CLEAN_SCALP") {
      riskWarning = `${riskWarning} Limited room before the next level — the pattern target sits close to nearby support/resistance.`;
    }
  }

  // ── Lot sizing from REAL specs + risk budget (+ optional target).
  const riskBudget = resolveRiskBudget(input);
  const sizing = sizeLot({
    direction,
    entry: scanner.entry,
    stopDist,
    mainTpDist,
    mpp,
    minLot,
    maxLot,
    lotStep,
    riskBudget,
    targetProfit: num(input.targetProfitAmount) ? input.targetProfitAmount : null,
    account: input.account,
    spec,
    price,
  });

  let suggestedLot = sizing.lot;
  let estimatedRiskAmount = sizing.estimatedRisk;
  let estimatedProfitMainTP = sizing.estimatedProfit;
  const estimatedMargin = sizing.estimatedMargin;
  let noTradeReason: string | null = null;

  // ── Margin gate.
  if (canBuildTrade && num(estimatedMargin) && num(input.account.freeMargin) && estimatedMargin > input.account.freeMargin) {
    status = "INSUFFICIENT_MARGIN";
    canBuildTrade = false;
    canWatch = true;
    userAction = "WAIT";
    noTradeReason = "Not enough free margin for this scalp at the minimum lot.";
    suggestedLot = null;
    estimatedRiskAmount = null;
    estimatedProfitMainTP = null;
  }

  // ── Below-min-lot for the requested target/risk: can't be done cleanly.
  if (canBuildTrade && sizing.belowMin) {
    noTradeReason = `Your target/risk amount is too small for this symbol's minimum lot. ${DEFAULT_ASSISTANT_NAME} can find another market or you can lower the target.`;
  }

  // ── Flame downgraded this to "not a clean scalp": no honest trade numbers.
  if (flameKilled) {
    suggestedLot = null;
    estimatedRiskAmount = null;
    estimatedProfitMainTP = null;
    if (!noTradeReason) noTradeReason = flameCore.downgrade.reason;
  }

  // ── Failed-flame cooldown: no honest trade numbers while locked out.
  if (lockoutKilled) {
    suggestedLot = null;
    estimatedRiskAmount = null;
    estimatedProfitMainTP = null;
    noTradeReason = `The last ${direction === "BUY" ? "buy" : "sell"} burst here just failed. ${DEFAULT_ASSISTANT_NAME} is giving it a short cool-down before suggesting this side again — wait for a fresh, clean restart.`;
  }

  // ── Failed-pattern refusal: no honest trade numbers (Task #617).
  if (patternKilled) {
    suggestedLot = null;
    estimatedRiskAmount = null;
    estimatedProfitMainTP = null;
    if (!noTradeReason) {
      noTradeReason = "The chart pattern here has broken down, so this is not a clean scalp right now.";
    }
  }

  // ── Target reality check (Builder).
  const targetRealityCheck = num(input.targetProfitAmount)
    ? assessTargetReality({
        target: input.targetProfitAmount,
        riskBudget,
        estimatedProfit: estimatedProfitMainTP,
        estimatedRisk: estimatedRiskAmount,
        rewardToRisk,
        status,
        belowMin: sizing.belowMin,
        cappedByMax: sizing.cappedByMax,
      })
    : null;

  // ── Plain-English reason (no internal names, ever).
  const plainEnglishReason = buildPlainReason({
    direction,
    status,
    mode: input.mode,
    assetClass: assetClassFor(spec.category),
    invalidationPrice,
    mainTp,
    rewardToRisk,
    scannerReason: scanner.reasonForTrade,
  });

  const validForSeconds = status === "LATE" ? Math.round(profile.validForSeconds * 0.3) : profile.validForSeconds;
  const expiresAt = new Date(now + validForSeconds * 1000).toISOString();
  const scalpType = scalpTypeLabel(input.mode, direction, trend, profile.label);
  const slippageRisk: RiskBand = assetClassFor(spec.category) === "Synthetic/Volatility" ? "MEDIUM" : spreadRisk;

  return {
    symbol: input.symbol,
    displayName: spec.displayName || input.symbol,
    assetClass: assetClassFor(spec.category),
    direction,
    scalpType,
    mode: input.mode,
    status,
    qualityScore: status === "READY" || status === "WAIT_FOR_ENTRY" || status === "FORMING" || status === "LATE" ? qualityScore : 0,
    confidenceLabel: confidenceLabelFor(qualityScore),
    entryType: canBuildTrade || status === "WAIT_FOR_ENTRY" || status === "LATE" ? entryType : null,
    entryZone: { from: Math.min(zoneFrom, zoneTo), to: Math.max(zoneFrom, zoneTo) },
    currentPrice: roundTo(price, digits),
    takeProfit,
    stopLoss,
    invalidationPrice,
    suggestedLot,
    minLot,
    maxLot,
    lotStep,
    digits,
    targetProfitAmount: num(input.targetProfitAmount) ? input.targetProfitAmount : null,
    estimatedProfitMainTP,
    estimatedRiskAmount,
    rewardToRisk,
    estimatedMargin,
    spreadRisk,
    slippageRisk,
    newsRisk,
    timingStatus,
    validForSeconds,
    expiresAt,
    chaseWarning,
    plainEnglishReason,
    riskWarning,
    targetRealityCheck,
    userAction,
    canBuildTrade,
    canWatch,
    noTradeReason,
    flame: finalizeScalpVerdict(flameCore.read, {
      status,
      qualityScore,
      direction,
      personality,
    }),
    generatedAt: new Date(now).toISOString(),
  };
}

interface SizeArgs {
  direction: ScalpDirection;
  entry: number;
  stopDist: number;
  mainTpDist: number;
  mpp: number;
  minLot: number;
  maxLot: number;
  lotStep: number;
  riskBudget: number | null;
  targetProfit: number | null;
  account: ScalpAccountInput;
  spec: ScalpSpecInput;
  price: number;
}

interface SizeResult {
  lot: number | null;
  estimatedRisk: number | null;
  estimatedProfit: number | null;
  estimatedMargin: number | null;
  belowMin: boolean;
  cappedByMax: boolean;
}

function sizeLot(a: SizeArgs): SizeResult {
  const perLotRisk = a.stopDist * a.mpp; // $ risk per 1 lot
  const perLotProfit = a.mainTpDist * a.mpp; // $ profit per 1 lot at main TP
  if (!(perLotRisk > 0)) {
    return { lot: null, estimatedRisk: null, estimatedProfit: null, estimatedMargin: null, belowMin: false, cappedByMax: false };
  }

  // Candidate lot from the risk budget (cap) and, if given, the target (driver).
  const candidates: number[] = [];
  if (num(a.riskBudget) && a.riskBudget > 0) candidates.push(a.riskBudget / perLotRisk);
  if (num(a.targetProfit) && a.targetProfit > 0 && perLotProfit > 0) candidates.push(a.targetProfit / perLotProfit);
  // No basis to size — cannot honestly produce a lot.
  if (candidates.length === 0) {
    return { lot: null, estimatedRisk: null, estimatedProfit: null, estimatedMargin: null, belowMin: false, cappedByMax: false };
  }
  const rawLot = Math.min(...candidates);

  const { lot, clampedToMin, clampedToMax } = clampLotToStep(rawLot, a.lotStep, a.minLot, a.maxLot);
  const belowMin = clampedToMin && rawLot < a.minLot;

  const estimatedRisk = roundTo(lot * perLotRisk, 2);
  const estimatedProfit = roundTo(lot * perLotProfit, 2);

  // Margin estimate (best-effort): notional / leverage.
  let estimatedMargin: number | null = null;
  if (num(a.spec.contractSize) && a.spec.contractSize > 0) {
    const leverage = num(a.account.leverage) && a.account.leverage! > 0 ? a.account.leverage! : DEFAULT_LEVERAGE;
    estimatedMargin = roundTo((lot * a.spec.contractSize * a.price) / leverage, 2);
  }

  return { lot, estimatedRisk, estimatedProfit, estimatedMargin, belowMin, cappedByMax: clampedToMax };
}

interface TargetRealityArgs {
  target: number;
  riskBudget: number | null;
  estimatedProfit: number | null;
  estimatedRisk: number | null;
  rewardToRisk: number;
  status: ScalpResult["status"];
  belowMin: boolean;
  cappedByMax: boolean;
}

function assessTargetReality(a: TargetRealityArgs): TargetRealityCheck {
  if (a.status !== "READY" && a.status !== "WAIT_FOR_ENTRY" && a.status !== "FORMING" && a.status !== "LATE") {
    return "NOT_AVAILABLE_RIGHT_NOW";
  }
  if (!num(a.estimatedProfit)) return "NOT_AVAILABLE_RIGHT_NOW";
  // Can the projected profit at main TP reach the target within the risk budget?
  const reaches = a.estimatedProfit >= a.target * 0.9;
  const withinBudget = !num(a.riskBudget) || !num(a.estimatedRisk) || a.estimatedRisk <= a.riskBudget * 1.05;
  if (a.cappedByMax || (!reaches && a.belowMin)) return "TOO_RISKY";
  if (reaches && withinBudget && a.rewardToRisk >= 1.5) return "REALISTIC";
  if (reaches || (a.rewardToRisk >= 1 && withinBudget)) return "AGGRESSIVE_BUT_POSSIBLE";
  return "TOO_RISKY";
}

function scalpTypeLabel(mode: ScalpMode, direction: ScalpDirection, trend: number, fallback: string): string {
  if (mode !== "ANY") return fallback;
  if (trend >= 60) return "Momentum Scalp";
  if (trend <= 40) return "Reversal Scalp";
  return "Sniper Scalp";
}

interface PlainReasonArgs {
  direction: ScalpDirection;
  status: ScalpResult["status"];
  mode: ScalpMode;
  assetClass: string;
  invalidationPrice: number;
  mainTp: number;
  rewardToRisk: number;
  scannerReason?: string;
}

function buildPlainReason(a: PlainReasonArgs): string {
  const side = a.direction === "BUY" ? "buy" : "sell";
  const dirWord = a.direction === "BUY" ? "support and upward pressure" : "resistance and fading upside momentum";
  if (a.status === "READY") {
    return `This is a ${side} scalp because price is reacting to ${dirWord}, and the take-profit sits before the next ${a.direction === "BUY" ? "resistance" : "support"} area so the trade does not need a big move to work. The stop is on the other side of that level with a spread buffer, so the idea is clean while price holds the ${a.invalidationPrice} level.`;
  }
  if (a.status === "WAIT_FOR_ENTRY") {
    return `A ${side} scalp is forming, but price is not yet in the entry zone. Wait for price to come back into the zone before entering — the idea stays valid while it holds the ${a.invalidationPrice} level.`;
  }
  if (a.status === "FORMING") {
    return `A ${side} scalp is forming here but not clean enough yet. Wait for stronger confirmation before entering.`;
  }
  if (a.status === "LATE") {
    return `The ${side} idea was valid, but price has already moved too far toward target. Do not chase — wait for the next clean setup.`;
  }
  return "No clean scalp here right now. The cleanest action is to wait for a better setup.";
}
