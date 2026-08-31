// explainMarketRead — composes a RubyMarketEdgeSignal into ONE plain-English
// explanation (Simple + Advanced) that always answers: what is happening, why,
// why this market, why this direction, why now, early/ready/late, entry zone,
// risk, what confirms, what invalidates, what to do next.
//
// PURE & deterministic: no IO, no Date.now(). It NEVER fabricates — a blind /
// insufficient signal collapses to an honest watching read with no invented
// levels, actionable=false, and the missing context named. No internal enum
// keys or backend wording are ever surfaced in user-facing copy. "Speaks in
// levels": every level referenced in the text is echoed verbatim from the
// signal (the levels object), so copy and numbers can never disagree.

import type {
  ConfidenceBand,
  ExplanationMode,
  MarketRegime,
  NewsRiskLevel,
  PriceZone,
  RubyMarketEdgeSignal,
  RubyMarketReadExplanation,
  SignalBias,
  SignalDirection,
  SignalEvidenceItem,
  SignalLifecycleStage,
  NoTradeIntelligence,
} from "./signalIntelligence.types.js";

const DISCLAIMER =
  "Decision support only — confirm live readiness and risk before trading.";

// ── Formatting ────────────────────────────────────────────────────────────────

function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  const s = a >= 100 ? n.toFixed(2) : a >= 1 ? n.toFixed(4) : n.toFixed(5);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

function zoneText(z: PriceZone | null): string | null {
  if (!z || !Number.isFinite(z.from) || !Number.isFinite(z.to)) return null;
  if (z.from === z.to) return fmtPrice(z.from);
  const lo = Math.min(z.from, z.to);
  const hi = Math.max(z.from, z.to);
  return `${fmtPrice(lo)}–${fmtPrice(hi)}`;
}

// ── Plain-English label maps (no internal enum keys ever leak) ─────────────────

const BIAS_LABEL: Record<SignalBias, string> = {
  BULLISH: "bullish",
  BEARISH: "bearish",
  RANGING: "range-bound",
  MIXED: "mixed",
  UNCLEAR: "unclear",
};

const DIRECTION_LABEL: Record<SignalDirection, string> = {
  BUY: "buy",
  SELL: "sell",
  NEUTRAL: "no clear side",
};

const REGIME_LABEL: Record<MarketRegime, string> = {
  TRENDING: "trending",
  RANGING: "range-bound",
  VOLATILE: "volatile",
  QUIET: "quiet",
  BREAKOUT: "breaking out",
  UNKNOWN: "still unclear",
};

const BAND_LONG: Record<ConfidenceBand, string> = {
  NONE: "no",
  LOW: "a low",
  MODEST: "a modest",
  FAIR: "a fair",
  STRONG: "a strong",
  VERY_STRONG: "a very strong",
};

const BAND_SHORT: Record<ConfidenceBand, string> = {
  NONE: "no",
  LOW: "low",
  MODEST: "modest",
  FAIR: "fair",
  STRONG: "strong",
  VERY_STRONG: "very strong",
};

const STAGE_PLAIN: Record<SignalLifecycleStage, string> = {
  WATCHING: "there is no active setup yet — just watching this market",
  TREND_FORMING: "a trend is forming",
  SETUP_FORMING: "a setup is forming",
  ENTRY_APPROACHING: "an entry is approaching",
  ENTRY_WINDOW_OPEN: "the entry window is open",
  LATE: "the clean entry has already passed",
  INVALID: "the setup has broken down",
  EXPIRED: "the read has expired",
};

const NEWS_TEXT: Record<NewsRiskLevel, string> = {
  none: "no notable news risk",
  low: "low news risk",
  medium: "some news risk",
  high: "high news risk",
  critical: "critical news risk",
};

type TimingClass = "early" | "approaching" | "ready" | "late" | "inactive";

function timingOf(stage: SignalLifecycleStage): TimingClass {
  switch (stage) {
    case "TREND_FORMING":
    case "SETUP_FORMING":
      return "early";
    case "ENTRY_APPROACHING":
      return "approaching";
    case "ENTRY_WINDOW_OPEN":
      return "ready";
    case "LATE":
      return "late";
    default:
      return "inactive"; // WATCHING, INVALID, EXPIRED
  }
}

const TIMING_TEXT: Record<TimingClass, string> = {
  early: "Early — the setup is still forming.",
  approaching: "Approaching — price is nearing the entry.",
  ready: "Ready — the entry window is open now.",
  late: "Late — the clean entry has already passed.",
  inactive: "Not active — there is no clean setup to act on yet.",
};

const TIMING_SHORT: Record<TimingClass, string> = {
  early: "forming",
  approaching: "approaching",
  ready: "ready",
  late: "late",
  inactive: "watching",
};

function topLabels(items: SignalEvidenceItem[], n: number): string[] {
  return [...items]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, n)
    .map((i) => i.label);
}

function joinAnd(parts: string[]): string {
  const clean = parts.filter(Boolean);
  if (clean.length === 0) return "";
  if (clean.length === 1) return clean[0]!;
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  return `${clean.slice(0, -1).join(", ")}, and ${clean[clean.length - 1]}`;
}

// ── Shared derived context ────────────────────────────────────────────────────

interface Derived {
  name: string;
  biasL: string;
  dirL: string;
  regimeL: string;
  bandLong: string;
  bandShort: string;
  stagePlain: string;
  timing: TimingClass;
  edge: number;
  overall: number;
  forTop: string[];
  againstTop: string[];
  conflicts: string[];
  entryZ: string | null;
  watchZ: string | null;
  lateZ: string | null;
  sl: string | null;
  inval: string | null;
  tps: string[];
  newsL: NewsRiskLevel;
  meetsMin: boolean;
  hasData: boolean;
  liveFeed: boolean;
  late: boolean;
  doNotChase: boolean;
  neutral: boolean;
  sessionNote: string;
  isHighLiquidity: boolean;
  invalSide: "above" | "below";
}

function derive(signal: RubyMarketEdgeSignal): Derived {
  const newsL: NewsRiskLevel = "none"; // overwritten below if carried
  return {
    name: signal.displayName || signal.symbol,
    biasL: BIAS_LABEL[signal.bias],
    dirL: DIRECTION_LABEL[signal.direction],
    regimeL: REGIME_LABEL[signal.regime],
    bandLong: BAND_LONG[signal.confidenceBand],
    bandShort: BAND_SHORT[signal.confidenceBand],
    stagePlain: STAGE_PLAIN[signal.lifecycleStage],
    timing: timingOf(signal.lifecycleStage),
    edge: Math.round(signal.edgeScore),
    overall: Math.round(signal.scores.overall),
    forTop: topLabels(signal.evidence.for, 3),
    againstTop: topLabels(signal.evidence.against, 2),
    conflicts: signal.evidence.conflicts.slice(0, 2),
    entryZ: zoneText(signal.entryZone),
    watchZ: zoneText(signal.watchZone),
    lateZ: zoneText(signal.doNotChaseZone),
    sl: signal.stopLoss != null ? fmtPrice(signal.stopLoss) : null,
    inval: signal.invalidationPrice != null ? fmtPrice(signal.invalidationPrice) : null,
    tps: signal.takeProfitZones.map((z) => zoneText(z)).filter((s): s is string => !!s),
    newsL,
    meetsMin: signal.evidence.meetsMinimum,
    hasData: signal.hasSufficientData,
    liveFeed: signal.dataSource === "LIVE_FEED",
    late: signal.late.isLate,
    doNotChase: signal.late.doNotChase,
    neutral: signal.direction === "NEUTRAL",
    sessionNote: signal.session.note,
    isHighLiquidity: signal.session.isHighLiquidity,
    invalSide: signal.direction === "SELL" ? "above" : "below",
  };
}

// News risk is not a typed field on the signal; it is folded into evidence
// ("Elevated news/event risk"). Detect it from the against-evidence so the copy
// stays honest without inventing a level.
function newsRiskFromEvidence(d: Derived, signal: RubyMarketEdgeSignal): NewsRiskLevel {
  const hit = signal.evidence.against.find((i) => i.key === "news_risk");
  if (!hit) return "none";
  return hit.weight >= 18 ? "critical" : "high";
}

// ── bestAction / actionable / no-trade (gating-aware, shared by both modes) ────

function computeActionable(d: Derived): boolean {
  return (
    d.hasData &&
    d.liveFeed &&
    !d.neutral &&
    d.meetsMin &&
    !d.doNotChase &&
    (d.timing === "ready" || d.timing === "approaching")
  );
}

function computeMissingContext(d: Derived): string[] {
  const out: string[] = [];
  if (!d.hasData) out.push("live candles");
  if (!d.liveFeed) out.push("a live data feed");
  if (!d.meetsMin) out.push("enough confirming evidence");
  if (d.neutral) out.push("a clear direction");
  return out;
}

function computeBestAction(d: Derived, stage: SignalLifecycleStage): string {
  if (!d.hasData || !d.liveFeed) return "Wait — there isn't enough live data to act yet.";
  if (stage === "INVALID" || stage === "EXPIRED")
    return "Skip — this read is no longer valid.";
  if (d.neutral) return "No clean trade here — wait for a clearer setup.";
  if (d.late || d.doNotChase)
    return "Do not chase — wait for a pullback or the next setup.";
  if (!d.meetsMin) return "Hold off — there isn't enough confirming evidence yet.";
  if (d.timing === "ready") {
    return d.entryZ
      ? `Entry is open near ${d.entryZ} — manage risk to ${d.sl ?? "your stop"}.`
      : "Entry is open — wait for a precise level, then manage risk.";
  }
  if (d.timing === "approaching") {
    const lvl = d.entryZ ?? d.watchZ;
    return lvl
      ? `Get ready — wait for price to reach ${lvl}.`
      : "Get ready — wait for the entry to define.";
  }
  if (d.timing === "early") return "Watch — let the setup mature before acting.";
  return "Watch — no action needed yet.";
}

// `confidence` here is a FIXED per-branch strength score, not a measured or
// calibrated probability. Surfaces must render it as a qualitative band (e.g.
// "strong case to wait") and never as "N% sure" — that would present a
// hand-set rule constant as a statistic.
function computeNoTrade(
  d: Derived,
  stage: SignalLifecycleStage,
  actionable: boolean,
): NoTradeIntelligence {
  if (actionable) {
    return {
      isNoTrade: false,
      confidence: Math.max(0, 35 - Math.round(d.edge / 4)),
      reason: null,
    };
  }
  let confidence: number;
  let reason: string;
  if (!d.hasData || !d.liveFeed) {
    confidence = 90;
    reason = "Not enough live data to read this market — acting blind isn't worth it.";
  } else if (stage === "INVALID" || stage === "EXPIRED") {
    confidence = 92;
    reason = "The setup is no longer valid, so there's nothing clean to trade.";
  } else if (d.neutral) {
    confidence = 78;
    reason = "No side has the edge right now — better to wait for direction.";
  } else if (d.late || d.doNotChase) {
    confidence = 74;
    reason = "The clean entry has passed — chasing here pays a poor reward-to-risk.";
  } else if (!d.meetsMin) {
    confidence = 66;
    reason = "There isn't enough confirming evidence yet to justify the risk.";
  } else if (d.timing === "early") {
    confidence = 60;
    reason = "The setup is still forming — it's early to commit.";
  } else {
    confidence = 45;
    reason = "Price hasn't reached the entry yet — wait for it to come to you.";
  }
  return { isNoTrade: true, confidence, reason };
}

// ── Per-mode composer ─────────────────────────────────────────────────────────

function buildMode(
  d: Derived,
  bestAction: string,
  advanced: boolean,
): ExplanationMode {
  // what is happening
  const whatIsHappening = !d.hasData
    ? `${d.name}: there isn't enough live data yet to read this market.`
    : advanced
      ? `${d.name} is ${d.regimeL} with a ${d.biasL} bias. Right now ${d.stagePlain}.`
      : `${d.name} is ${d.regimeL} and looks ${d.biasL}; ${d.stagePlain}.`;

  // why
  let why: string;
  if (d.forTop.length === 0) {
    why = "There isn't enough confirming evidence yet to back a read.";
  } else if (advanced) {
    const against = d.againstTop.length > 0 ? d.againstTop.join(", ") : "nothing of note";
    const conflict = d.conflicts.length > 0 ? ` Conflicts: ${d.conflicts.join("; ")}.` : "";
    why = `For: ${d.forTop.join(", ")}. Against: ${against}.${conflict}`;
  } else {
    why = `${joinAnd(d.forTop.slice(0, 2))} support the read.`;
  }

  // why this market
  const whyThisMarket = advanced
    ? `This market shows ${d.bandLong} edge (${d.edge}/100) with overall quality ${d.overall}/100 on this timeframe.`
    : `This market currently shows ${d.bandLong} edge (${d.edge}/100).`;

  // why this direction
  let whyThisDirection: string;
  if (d.neutral) {
    whyThisDirection = "No side has the edge — the direction is unclear.";
  } else {
    const driver = d.forTop[0] ?? "the current structure";
    whyThisDirection = advanced
      ? `The ${d.dirL} side is favored by ${driver}${d.againstTop.length > 0 ? `, though ${d.againstTop[0]} works against it` : ""}.`
      : `The ${d.dirL} side is favored by ${driver}.`;
  }

  // why now
  const liq = d.isHighLiquidity ? " Liquidity is strong this session." : "";
  const whyNow = advanced
    ? `${TIMING_TEXT[d.timing]}${liq} ${d.sessionNote}`.trim()
    : `${TIMING_TEXT[d.timing]}${liq}`;

  // timing
  const timingState = TIMING_TEXT[d.timing];

  // entry zone — speak in levels
  let entryZone: string;
  if (d.timing === "ready" || d.timing === "approaching") {
    entryZone = d.entryZ ? `Entry zone ${d.entryZ}.` : "No precise entry level published yet.";
  } else if (d.timing === "late") {
    entryZone = d.lateZ
      ? `Already extended past ${d.lateZ} — do not chase.`
      : "Already extended — wait for a pullback before any entry.";
  } else {
    entryZone = d.watchZ ? `Watching ${d.watchZ} for a setup.` : "No level to watch yet.";
  }

  // risk
  const riskParts: string[] = [];
  if (d.sl) riskParts.push(`Protective stop near ${d.sl}.`);
  if (d.inval) riskParts.push(`Idea fails on a close ${d.invalSide} ${d.inval}.`);
  if (d.newsL !== "none") riskParts.push(`Note ${NEWS_TEXT[d.newsL]}.`);
  const risk = riskParts.length > 0
    ? riskParts.join(" ")
    : "Risk level not published yet — wait for a defined stop before sizing.";

  // what confirms
  let whatConfirms: string;
  if (d.neutral || d.forTop.length === 0) {
    whatConfirms = "Wait for structure and momentum to line up on the same side.";
  } else {
    const lvl = d.entryZ ?? d.watchZ ?? "the level";
    whatConfirms = `A hold of ${lvl} with ${d.forTop[0]} confirms it.`;
  }

  // what invalidates
  let whatInvalidates: string;
  if (d.inval && !d.neutral) {
    whatInvalidates = `A close ${d.invalSide} ${d.inval} invalidates it${d.againstTop[0] ? `; watch for ${d.againstTop[0]}` : ""}.`;
  } else if (d.againstTop[0]) {
    whatInvalidates = `${d.againstTop[0]} would invalidate it.`;
  } else {
    whatInvalidates = "A break of the opposing structure invalidates it.";
  }

  return {
    whatIsHappening,
    why,
    whyThisMarket,
    whyThisDirection,
    whyNow,
    timingState,
    entryZone,
    risk,
    whatConfirms,
    whatInvalidates,
    whatToDoNext: bestAction,
  };
}

// ── Public seam ───────────────────────────────────────────────────────────────

export function explainMarketRead(
  signal: RubyMarketEdgeSignal,
): RubyMarketReadExplanation {
  const d = derive(signal);
  d.newsL = newsRiskFromEvidence(d, signal);

  const bestAction = computeBestAction(d, signal.lifecycleStage);
  const actionable = computeActionable(d);
  const missingContext = computeMissingContext(d);
  const noTrade = computeNoTrade(d, signal.lifecycleStage, actionable);

  let headline: string;
  if (!d.hasData) {
    headline = `${d.name}: watching — not enough live data yet.`;
  } else if (d.neutral) {
    headline = `${d.name}: ${TIMING_SHORT[d.timing]} — no clear side yet.`;
  } else {
    headline = `${d.name}: ${TIMING_SHORT[d.timing]} — ${d.dirL} bias, ${d.bandShort} edge.`;
  }

  return {
    headline,
    defaultMode: "SIMPLE",
    simple: buildMode(d, bestAction, false),
    advanced: buildMode(d, bestAction, true),
    levels: {
      entryZone: signal.entryZone,
      watchZone: signal.watchZone,
      lateZone: signal.doNotChaseZone,
      invalidation: signal.invalidationPrice,
      takeProfits: signal.takeProfitZones,
      stopLoss: signal.stopLoss,
    },
    bestAction,
    noTrade,
    hasSufficientData: d.hasData,
    actionable,
    missingContext,
    disclaimer: DISCLAIMER,
  };
}
