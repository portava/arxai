// Self-Trade decision modules — pure verdict helpers derived FROM the already
// computed RubyMarketEdgeSignal (no candle math is duplicated here). Each module
// answers one focused question for the ordered decision pipeline.

import type { RubyMarketEdgeSignal } from "../signal-intelligence/signalIntelligence.types.js";
import { clamp, round } from "../signal-intelligence/_math.js";
import type {
  ConfidenceDecayVerdict,
  EntryZoneVerdict,
  ExecutionContext,
  LateEntryVerdict,
  MtfAlignmentVerdict,
  NoTradeVerdict,
  RegimeFit,
  SetupClassification,
  SetupKind,
  SpreadSlippageVerdict,
  TradeSide,
} from "./selfTradeDecision.types.js";

// ── MarketRegimeDetector ─────────────────────────────────────────────────────

export function detectMarketRegime(signal: RubyMarketEdgeSignal): RegimeFit {
  const regime = signal.regime;
  switch (regime) {
    case "TRENDING":
      return { regime, tradeable: true, fitScore: 90, note: "Directional trend in force." };
    case "BREAKOUT":
      return { regime, tradeable: true, fitScore: 82, note: "Breakout regime — momentum available." };
    case "VOLATILE":
      return { regime, tradeable: true, fitScore: 62, note: "Volatile — workable but wider risk." };
    case "RANGING":
      return { regime, tradeable: true, fitScore: 48, note: "Ranging — only edge-of-range fades." };
    case "QUIET":
      return { regime, tradeable: false, fitScore: 22, note: "Quiet regime — low expansion, skip." };
    default:
      return { regime: regime || "UNKNOWN", tradeable: false, fitScore: 0, note: "Regime unknown — insufficient data." };
  }
}

// ── SetupClassifier ──────────────────────────────────────────────────────────

export function classifySetup(signal: RubyMarketEdgeSignal): SetupClassification {
  if (!signal.hasSufficientData || signal.direction === "NEUTRAL") {
    return { setup: "NONE", side: null, score: 0, reasons: ["No directional read / insufficient data."] };
  }
  const side: TradeSide = signal.direction === "BUY" ? "BUY" : "SELL";
  const early = signal.earlyTrend;
  const reasons: string[] = [];
  let setup: SetupKind = "NONE";

  if (signal.fakeout.detected && (signal.fakeout.kind === "LIQUIDITY_SWEEP")) {
    setup = "LIQUIDITY_SWEEP";
    reasons.push(signal.fakeout.reason || "Liquidity sweep detected.");
  } else if (early.bosChoch === "CHOCH_UP" || early.bosChoch === "CHOCH_DOWN") {
    setup = "REVERSAL";
    reasons.push(`Change of character (${early.bosChoch}).`);
  } else if (early.bosChoch === "BOS_UP" || early.bosChoch === "BOS_DOWN") {
    setup = "BREAKOUT_RETEST";
    reasons.push(`Break of structure (${early.bosChoch}).`);
  } else if (early.structure === "HH_HL" || early.structure === "LH_LL") {
    setup = "TREND_CONTINUATION";
    reasons.push(`Trend structure ${early.structure}.`);
  } else if (signal.regime === "RANGING") {
    setup = "RANGE_FADE";
    reasons.push("Range conditions — fade the edge.");
  }

  if (setup === "NONE") {
    return { setup, side: null, score: 0, reasons: reasons.length ? reasons : ["No clean setup formed."] };
  }
  // Setup quality folds direction conviction + entry quality + edge (already
  // computed by the signal engine — never re-derived).
  const score = round(
    clamp(signal.scores.direction * 0.4 + signal.scores.entry * 0.3 + signal.edgeScore * 0.3, 0, 100),
  );
  return { setup, side, score, reasons };
}

// ── MultiTimeframeAlignment ──────────────────────────────────────────────────

export function evaluateMtfAlignment(
  primary: RubyMarketEdgeSignal,
  htf: RubyMarketEdgeSignal[],
): MtfAlignmentVerdict {
  const ltfBias = primary.bias;
  if (htf.length === 0) {
    return {
      aligned: true,
      agreementScore: 60,
      htfBias: "UNKNOWN",
      ltfBias,
      conflict: false,
      note: "No higher-timeframe context supplied.",
    };
  }
  const usable = htf.filter((s) => s.hasSufficientData);
  if (usable.length === 0) {
    return {
      aligned: true,
      agreementScore: 50,
      htfBias: "UNKNOWN",
      ltfBias,
      conflict: false,
      note: "Higher-timeframe data insufficient.",
    };
  }
  const dir = primary.direction;
  let agree = 0;
  let against = 0;
  for (const s of usable) {
    if (s.direction === "NEUTRAL") continue;
    if (s.direction === dir) agree++;
    else against++;
  }
  const total = agree + against;
  const agreementScore = total === 0 ? 50 : round((agree / total) * 100);
  const conflict = against > agree;
  const htfBias = usable[0]!.bias;
  return {
    aligned: !conflict,
    agreementScore,
    htfBias,
    ltfBias,
    conflict,
    note: conflict
      ? "Higher timeframe opposes the entry direction."
      : total === 0
        ? "Higher timeframe is neutral."
        : "Higher timeframe supports the entry direction.",
  };
}

// ── EntryZoneEngine ──────────────────────────────────────────────────────────

export function evaluateEntryZone(
  signal: RubyMarketEdgeSignal,
  currentPrice: number | null,
): EntryZoneVerdict {
  const zone = signal.entryZone;
  if (!zone) {
    return { state: "NO_ZONE", distancePct: null, note: "No entry zone derivable yet." };
  }
  if (currentPrice == null) {
    return { state: "NO_ZONE", distancePct: null, note: "No current price to compare." };
  }
  const mid = (zone.from + zone.to) / 2;
  const distancePct = mid !== 0 ? round((Math.abs(currentPrice - mid) / Math.abs(mid)) * 100, 3) : null;
  const inZone =
    currentPrice >= Math.min(zone.from, zone.to) && currentPrice <= Math.max(zone.from, zone.to);
  if (inZone) return { state: "AT_ENTRY", distancePct, note: "Price inside the entry zone." };
  if (distancePct != null && distancePct <= 0.25)
    return { state: "APPROACHING", distancePct, note: "Price approaching the entry zone." };
  return { state: "FAR", distancePct, note: "Price away from the entry zone." };
}

// ── LateEntryDetector ────────────────────────────────────────────────────────

export function evaluateLateEntry(signal: RubyMarketEdgeSignal): LateEntryVerdict {
  return {
    isLate: signal.late.isLate,
    doNotChase: signal.late.doNotChase,
    reason: signal.late.reason,
  };
}

// ── SpreadSlippageGuard ──────────────────────────────────────────────────────

export function evaluateSpreadSlippage(
  execution: ExecutionContext,
  maxSpreadPoints: number | null,
): SpreadSlippageVerdict {
  const spread = execution.liveSpreadPoints;
  if (spread == null) {
    return { status: "UNKNOWN", spreadPoints: null, maxSpreadPoints, note: "Live spread not reported." };
  }
  if (maxSpreadPoints != null && spread > maxSpreadPoints) {
    return {
      status: "BLOCKED",
      spreadPoints: spread,
      maxSpreadPoints,
      note: `Spread ${spread} exceeds max ${maxSpreadPoints}.`,
    };
  }
  if (maxSpreadPoints != null && spread > maxSpreadPoints * 0.7) {
    return {
      status: "WIDE",
      spreadPoints: spread,
      maxSpreadPoints,
      note: `Spread ${spread} approaching the ${maxSpreadPoints} cap.`,
    };
  }
  return { status: "OK", spreadPoints: spread, maxSpreadPoints, note: `Spread ${spread} acceptable.` };
}

// ── NoTradeScore ─────────────────────────────────────────────────────────────

export function computeNoTradeScore(
  signal: RubyMarketEdgeSignal,
  regime: RegimeFit,
): NoTradeVerdict {
  if (!signal.hasSufficientData) {
    return { score: 95, isNoTrade: true, reason: "Insufficient data to read the market." };
  }
  let s = 0;
  const reasons: string[] = [];
  if (signal.direction === "NEUTRAL") {
    s += 45;
    reasons.push("no clear direction");
  }
  if (!regime.tradeable) {
    s += 25;
    reasons.push(`regime ${regime.regime.toLowerCase()}`);
  }
  if (signal.edgeScore < 35) {
    s += 25;
    reasons.push("thin edge");
  }
  if (signal.late.doNotChase) {
    s += 30;
    reasons.push("entry already passed");
  } else if (signal.late.isLate) {
    s += 15;
    reasons.push("late entry");
  }
  if (!signal.evidence.meetsMinimum) {
    s += 20;
    reasons.push("evidence below minimum");
  }
  s = clamp(s, 0, 100);
  return {
    score: round(s),
    isNoTrade: s >= 55,
    reason: s >= 55 ? `Better to wait: ${reasons.join(", ")}.` : null,
  };
}

// ── ConfidenceDecay ──────────────────────────────────────────────────────────

export function applyConfidenceDecay(
  signal: RubyMarketEdgeSignal,
  now: number,
): ConfidenceDecayVerdict {
  const base = signal.scores.overall;
  const firstSeen = Date.parse(signal.generatedAt);
  const ageSeconds = Number.isFinite(firstSeen) ? Math.max(0, Math.round((now - firstSeen) / 1000)) : 0;
  const validForSeconds = Math.max(1, signal.validForSeconds);
  const fraction = clamp(ageSeconds / validForSeconds, 0, 1);
  // Linear decay to 40% of base across the validity window; expired ⇒ floor.
  const expired = signal.freshness === "EXPIRED" || ageSeconds >= validForSeconds;
  const decayed = expired ? round(base * 0.3) : round(base * (1 - fraction * 0.6));
  return {
    base: round(base),
    decayed,
    ageSeconds,
    validForSeconds,
    expired,
    note: expired
      ? "Signal expired — confidence floored."
      : `Decayed ${Math.round(fraction * 100)}% through validity window.`,
  };
}
