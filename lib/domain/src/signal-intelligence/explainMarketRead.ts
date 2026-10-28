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
  SignalDirection,
  SignalEvidenceItem,
  SignalLifecycleStage,
  SignalScoreDimension,
  NoTradeIntelligence,
  NoTradeRuleKey,
} from "./signalIntelligence.types.js";
import { SIGNAL_SCORE_DIMENSION_COUNT } from "./signalIntelligence.types.js";
import { confidenceBandFor } from "./scoring.js";
import {
  MIN_EVIDENCE_NET_SCORE,
  MIN_EVIDENCE_SUPPORTING_ITEMS,
  isHighConfidenceOpposingTrap,
  minimumEvidenceShortfall,
} from "./freshnessEvidence.js";

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

const DIRECTION_LABEL: Record<SignalDirection, string> = {
  BUY: "buy",
  SELL: "sell",
  NEUTRAL: "no clear side",
};

// ── Structure sentence (what was measured, from which window) ────────────────
//
// The regime (classifyRegime: 20-bar slope / band / range expansion) and the
// swing structure (readEarlyTrend: last swing highs/lows) are separate
// classifiers. Owner screenshot 2026-10-27 (V75 1m): "V75 is range-bound and
// looks bullish" paired the regime word RANGING (small 20-bar drift) with a
// higher-highs/higher-lows swing read, which reads as a contradiction. The
// sentence now leads with the swing structure and states the regime as the
// measurement it is, and names the closed-bar window it ran over.

const SWING_REGIME_CLAUSE: Record<MarketRegime, string> = {
  TRENDING: ", and price is trending",
  RANGING: ", but net movement over the last 20 closed bars is small",
  VOLATILE: ", with bar ranges expanding sharply",
  QUIET: ", in quiet, compressed trade",
  BREAKOUT: ", and price is pushing a window extreme",
  UNKNOWN: "",
};

const RANGE_REGIME_CLAUSE: Record<MarketRegime, string> = {
  TRENDING: ", though price is drifting steadily within it",
  RANGING: "",
  VOLATILE: ", with bar ranges expanding sharply",
  QUIET: ", in quiet, compressed trade",
  BREAKOUT: ", and price is pushing the edge of that band",
  UNKNOWN: "",
};

const CHOPPY_REGIME_CLAUSE: Record<MarketRegime, string> = {
  TRENDING: ", though price is drifting steadily",
  RANGING: ", and net movement over the last 20 closed bars is small",
  VOLATILE: ", with bar ranges expanding sharply",
  QUIET: ", in quiet, compressed trade",
  BREAKOUT: ", and price is pushing a window extreme",
  UNKNOWN: "",
};

/** "M1" → "1m", "H4" → "4h", "D1" → "daily"; aliases pass through. */
function timeframeWord(tf: string): string {
  const t = (tf ?? "").trim();
  let m = /^M(\d+)$/.exec(t);
  if (m) return `${m[1]}m`;
  m = /^H(\d+)$/.exec(t);
  if (m) return `${m[1]}h`;
  if (t === "D1") return "daily";
  if (t === "W1") return "weekly";
  if (t === "MN1") return "monthly";
  return t;
}

function structureSentence(signal: RubyMarketEdgeSignal): string {
  const name = signal.displayName || signal.symbol;
  const n = signal.structureWindow;
  const tf = timeframeWord(signal.timeframe);
  const w = typeof n === "number" && Number.isFinite(n) && n > 0
    ? ` in the last ${Math.round(n)} closed${tf ? ` ${tf}` : ""} bars`
    : "";
  const regime = signal.regime;
  switch (signal.earlyTrend?.structure) {
    case "HH_HL":
      return `${name} shows higher highs and higher lows across its recent swings${w} (bullish structure)${SWING_REGIME_CLAUSE[regime] ?? ""}`;
    case "LH_LL":
      return `${name} shows lower highs and lower lows across its recent swings${w} (bearish structure)${SWING_REGIME_CLAUSE[regime] ?? ""}`;
    case "RANGE":
      return `${name} is range-bound — price is held in a tight band${w}${RANGE_REGIME_CLAUSE[regime] ?? ""}`;
    case "CHOPPY":
      return `${name} shows no clean swing structure${w}${CHOPPY_REGIME_CLAUSE[regime] ?? ""}`;
    default:
      return `${name}'s structure is still unclear${w}`;
  }
}

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

// Plain names for score dimensions that fell back to a fixed default.
const DIMENSION_PLAIN: Record<SignalScoreDimension, string> = {
  direction: "direction",
  entry: "entry",
  execution: "execution",
  risk: "reward-to-risk",
  newsSafety: "news",
  timing: "timing",
  survivability: "room to target",
};

// ── Shared derived context ────────────────────────────────────────────────────

interface Derived {
  name: string;
  dirL: string;
  structureL: string;
  /** Band of the OVERALL quality number — only ever said next to `overall`. */
  bandShort: string;
  /** Band of the EDGE number actually shown (`edge`) — the only adjective ever
   * written before the word "edge". Overall quality bands never describe edge. */
  edgeBandLong: string;
  edgeBandShort: string;
  /**
   * True only when every dimension folded into overall/edge was observed
   * (confidenceBandBasis FULL). Otherwise no band adjective is written for
   * either number — they are partly fixed defaults.
   */
  banded: boolean;
  /** Plain names of the score inputs that were defaults (empty when unknown). */
  unmeasured: string[];
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
  /** Plain-English names of the minimum-evidence sub-rules that failed. */
  evidenceShortfall: string[];
  /** Independent supporting items found (the minimum needs 2). */
  forCount: number;
  /** Net evidence score 0–100 (the minimum needs 25). */
  net: number;
  /** Structural bias unresolved (bias UNCLEAR). */
  biasUnclear: boolean;
  hasData: boolean;
  liveFeed: boolean;
  late: boolean;
  doNotChase: boolean;
  neutral: boolean;
  sessionNote: string;
  isHighLiquidity: boolean;
  /** 24/7 synthetic index — no FX session statement applies. */
  isSynthetic: boolean;
  invalSide: "above" | "below";
  /** Why no level is published (see levelsWithheldReasonFor), else null. */
  levelsWithheld: string | null;
}

function derive(signal: RubyMarketEdgeSignal): Derived {
  const newsL: NewsRiskLevel = "none"; // overwritten below if carried
  const edge = Math.round(signal.edgeScore);
  // Banded from the rounded number the copy prints, so "(30/100)" and its
  // adjective can never straddle a band boundary.
  const edgeBand = confidenceBandFor(edge);
  return {
    name: signal.displayName || signal.symbol,
    dirL: DIRECTION_LABEL[signal.direction],
    structureL: structureSentence(signal),
    bandShort: BAND_SHORT[signal.confidenceBand],
    edgeBandLong: BAND_LONG[edgeBand],
    edgeBandShort: BAND_SHORT[edgeBand],
    // Fail closed: an absent basis (older producer) is not a FULL basis.
    banded: signal.confidenceBandBasis === "FULL",
    unmeasured: (signal.scores.unmeasured ?? []).map((k) => DIMENSION_PLAIN[k] ?? k),
    stagePlain: STAGE_PLAIN[signal.lifecycleStage],
    timing: timingOf(signal.lifecycleStage),
    edge,
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
    evidenceShortfall: evidenceShortfallText(signal),
    forCount: signal.evidence.for.length,
    net: Math.round(Number.isFinite(signal.evidence.netScore) ? signal.evidence.netScore : 0),
    biasUnclear: signal.bias === "UNCLEAR",
    hasData: signal.hasSufficientData,
    liveFeed: signal.dataSource === "LIVE_FEED",
    late: signal.late.isLate,
    doNotChase: signal.late.doNotChase,
    neutral: signal.direction === "NEUTRAL",
    sessionNote: signal.session.note,
    isHighLiquidity: signal.session.isHighLiquidity,
    isSynthetic: (signal.assetClass ?? "").toLowerCase() === "synthetic",
    invalSide: signal.direction === "SELL" ? "above" : "below",
    levelsWithheld: null,
  };
}

/**
 * Why the read publishes NO entry/watch/stop/invalidation level — null whenever
 * any of them is present. Built ONLY from facts on the signal (data sufficiency,
 * live-feed tag, scanner geometry), never a guessed cause: on a live feed with
 * enough candles the honest fact is that no scanner entry/stop is attached.
 */
function levelsWithheldReasonFor(d: Derived, signal: RubyMarketEdgeSignal): string | null {
  if (d.entryZ || d.watchZ || d.sl || d.inval) return null;
  if (!d.hasData) return "there aren't enough confirmed live candles for this read yet";
  if (!d.liveFeed) return "the data behind this read isn't a confirmed live feed";
  // The service records the gate that dropped the scanner's geometry; cite it.
  const binding = signal.scannerBinding;
  const why = binding && !binding.bound ? (binding.reason ?? "").trim().replace(/\.$/, "") : "";
  if (why) return `no scanner entry or stop is attached to this read because ${why}`;
  if (binding?.bound) return "the scanner read is bound, but it defines no entry or stop for this stage yet";
  return "no scanner entry or stop is attached to this read yet";
}

function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

// Names the minimum-evidence sub-rules that failed, from the same rule inputs
// and thresholds the producer applied (freshnessEvidence.minimumEvidenceShortfall).
// No direction is reported by its own no-trade branch, so it is not repeated.
function evidenceShortfallText(signal: RubyMarketEdgeSignal): string[] {
  if (signal.evidence.meetsMinimum) return [];
  const supporting = signal.evidence.for.length;
  const net = Math.round(signal.evidence.netScore);
  const highConfOpposingTrap =
    !!signal.fakeout && isHighConfidenceOpposingTrap(signal.fakeout, signal.direction);
  const failed = minimumEvidenceShortfall({
    direction: signal.direction,
    bias: signal.bias,
    supportingCount: supporting,
    netScore: net,
    highConfOpposingTrap,
  });
  const out: string[] = [];
  for (const f of failed) {
    switch (f) {
      case "TOO_FEW_SUPPORTING":
        out.push(
          supporting === 0
            ? `no supporting signals yet (at least ${MIN_EVIDENCE_SUPPORTING_ITEMS} needed)`
            : `only ${supporting} supporting signal${supporting === 1 ? "" : "s"} (at least ${MIN_EVIDENCE_SUPPORTING_ITEMS} needed)`,
        );
        break;
      case "NET_TOO_LOW":
        out.push(`net supporting evidence ${net}/100 (at least ${MIN_EVIDENCE_NET_SCORE} needed)`);
        break;
      case "UNCLEAR_STRUCTURE":
        out.push("the price structure is unclear");
        break;
      case "OPPOSING_TRAP":
        out.push("a likely trap works against this side");
        break;
      default:
        break;
    }
  }
  return out;
}

// "6 of 7 score inputs are unmeasured (entry, execution, …)" — or, when the
// producer did not report which (older signal), a plain "the score basis is not
// reported".
function unmeasuredText(d: Derived): string {
  if (d.unmeasured.length === 0) return "the score basis is not reported";
  const n = d.unmeasured.length;
  return `${n} of ${SIGNAL_SCORE_DIMENSION_COUNT} score inputs ${n === 1 ? "is" : "are"} unmeasured (${joinAnd(d.unmeasured)})`;
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

// Mirrors `meetsMinimum` (freshnessEvidence.ts): direction not NEUTRAL, bias
// not UNCLEAR, >= 2 independent supporting items, net score >= 25, and no
// high-confidence opposing trap. Each failing sub-rule is NAMED with the count
// the read actually found, instead of a vague "enough confirming evidence".
const MIN_FOR_ITEMS = MIN_EVIDENCE_SUPPORTING_ITEMS;
const MIN_NET_SCORE = MIN_EVIDENCE_NET_SCORE;

function evidenceGaps(d: Derived): string[] {
  const out: string[] = [];
  if (d.forCount < MIN_FOR_ITEMS) {
    const need = MIN_FOR_ITEMS - d.forCount;
    out.push(
      `${need === 1 ? "one more independent confirming signal" : `${need} independent confirming signals`} (${d.forCount} of ${MIN_FOR_ITEMS} found)`,
    );
  }
  if (d.net < MIN_NET_SCORE) {
    out.push(`stronger net evidence (${d.net}/100 so far, ${MIN_NET_SCORE} needed)`);
  }
  if (d.biasUnclear) out.push("a clear structural bias");
  // By elimination the only remaining failing rule is the opposing trap.
  if (out.length === 0) out.push("the opposing fakeout/trap risk to clear");
  return out;
}

function computeMissingContext(d: Derived): string[] {
  const out: string[] = [];
  if (!d.hasData) out.push("live candles");
  if (!d.liveFeed) out.push("a live data feed");
  if (!d.meetsMin) {
    if (d.hasData && !d.neutral) out.push(...evidenceGaps(d));
    else out.push("enough confirming evidence");
  }
  if (d.neutral) out.push("a clear direction");
  // The server published no stop — say so here too, matching the Risk row.
  if (d.hasData && !d.sl) out.push("a defined stop level");
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

function computeNoTrade(
  d: Derived,
  stage: SignalLifecycleStage,
  actionable: boolean,
): NoTradeIntelligence {
  if (actionable) {
    return {
      isNoTrade: false,
      confidence: Math.max(0, 35 - Math.round(d.edge / 4)),
      basis: "EDGE_DERIVED",
      ruleKey: null,
      reason: null,
    };
  }
  // `confidence` below is a FIXED weight per rule (basis RULE_TIER), not a
  // measured probability — the surfaces render the rule's reason, never "% sure".
  let confidence: number;
  let ruleKey: NoTradeRuleKey;
  let reason: string;
  if (!d.hasData || !d.liveFeed) {
    confidence = 90;
    ruleKey = "NO_LIVE_DATA";
    reason = "Not enough live data to read this market — acting blind isn't worth it.";
  } else if (stage === "INVALID" || stage === "EXPIRED") {
    confidence = 92;
    ruleKey = "INVALID_OR_EXPIRED";
    reason = "The setup is no longer valid, so there's nothing clean to trade.";
  } else if (d.neutral) {
    confidence = 78;
    ruleKey = "NO_DIRECTION";
    reason = "No side has the edge right now — better to wait for direction.";
  } else if (d.late || d.doNotChase) {
    confidence = 74;
    ruleKey = "LATE";
    reason = "The clean entry has passed — chasing here pays a poor reward-to-risk.";
  } else if (!d.meetsMin) {
    confidence = 66;
    ruleKey = "BELOW_MIN_EVIDENCE";
    reason =
      d.evidenceShortfall.length > 0
        ? `There isn't enough confirming evidence yet to justify the risk: ${joinAnd(d.evidenceShortfall)}.`
        : "There isn't enough confirming evidence yet to justify the risk.";
  } else if (d.timing === "early") {
    confidence = 60;
    ruleKey = "EARLY";
    reason = "The setup is still forming — it's early to commit.";
  } else {
    confidence = 45;
    ruleKey = "NOT_AT_ENTRY";
    reason = "Price hasn't reached the entry yet — wait for it to come to you.";
  }
  return { isNoTrade: true, confidence, basis: "RULE_TIER", ruleKey, reason };
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
      ? `${d.structureL}. Right now ${d.stagePlain}.`
      : `${d.structureL}; ${d.stagePlain}.`;

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

  // why this market — the adjective before "edge" is the band of the edge
  // number; the overall-quality band is only ever said next to the overall
  // number. A read below the minimum-evidence rule says so in the same words as
  // the best-action line, never as a sized edge.
  // When any score input was a fixed default (basis not FULL) neither number
  // gets a band adjective: the number is shown with what was not measured.
  const edgeClause = d.banded
    ? `${d.edgeBandLong} edge (${d.edge}/100)`
    : `an edge score of ${d.edge}/100`;
  const qualityClause = d.banded
    ? `overall setup quality is ${d.bandShort} (${d.overall}/100) on this timeframe`
    : `overall setup quality is ${d.overall}/100 on this timeframe, not graded because ${unmeasuredText(d)}`;
  let whyThisMarket: string;
  if (!d.meetsMin) {
    whyThisMarket = advanced
      ? `This market shows ${edgeClause} — not enough confirming evidence yet; ${qualityClause}.`
      : `This market shows ${edgeClause} — not enough confirming evidence yet.`;
  } else if (!d.banded) {
    whyThisMarket = advanced
      ? `This market shows ${edgeClause}; ${qualityClause}.`
      : `This market currently shows ${edgeClause}, not graded because ${unmeasuredText(d)}.`;
  } else {
    whyThisMarket = advanced
      ? `This market shows ${edgeClause}; ${qualityClause}.`
      : `This market currently shows ${edgeClause}.`;
  }

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
  // No liquidity is MEASURED anywhere, so no liquidity claim is made: Simple
  // mode names the main session hours (FX/metals/crypto only — never for a 24/7
  // synthetic index); Advanced appends the session note, which for a synthetic
  // says plainly that session liquidity does not apply.
  const sessionHours = d.isHighLiquidity && !d.isSynthetic ? ` ${d.sessionNote}` : "";
  const whyNow = advanced
    ? `${TIMING_TEXT[d.timing]} ${d.sessionNote}`.trim()
    : `${TIMING_TEXT[d.timing]}${sessionHours}`;

  // timing
  const timingState = TIMING_TEXT[d.timing];

  // entry zone — speak in levels
  let entryZone: string;
  if (d.timing === "ready" || d.timing === "approaching") {
    entryZone = d.entryZ
      ? `Entry zone ${d.entryZ}.`
      : d.levelsWithheld
        ? `No precise entry level published yet — ${d.levelsWithheld}.`
        : "No precise entry level published yet.";
  } else if (d.timing === "late") {
    entryZone = d.lateZ
      ? `Already extended past ${d.lateZ} — do not chase.`
      : "Already extended — wait for a pullback before any entry.";
  } else {
    entryZone = d.watchZ
      ? `Watching ${d.watchZ} for a setup.`
      : d.levelsWithheld
        ? `No level to watch yet — ${d.levelsWithheld}.`
        : "No level to watch yet.";
  }

  // risk
  const riskParts: string[] = [];
  if (d.sl) riskParts.push(`Protective stop near ${d.sl}.`);
  if (d.inval) riskParts.push(`Idea fails on a close ${d.invalSide} ${d.inval}.`);
  if (d.newsL !== "none") riskParts.push(`Note ${NEWS_TEXT[d.newsL]}.`);
  const risk = riskParts.length > 0
    ? riskParts.join(" ")
    : d.levelsWithheld
      ? `Risk level not published yet — ${d.levelsWithheld}. Wait for a defined stop before sizing.`
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
  d.levelsWithheld = levelsWithheldReasonFor(d, signal);

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
    headline = !d.meetsMin
      ? `${d.name}: ${TIMING_SHORT[d.timing]} — ${d.dirL} bias, no tradeable edge yet (${d.edge}/100).`
      : d.banded
        ? `${d.name}: ${TIMING_SHORT[d.timing]} — ${d.dirL} bias, ${d.edgeBandShort} edge (${d.edge}/100).`
        : `${d.name}: ${TIMING_SHORT[d.timing]} — ${d.dirL} bias, edge ${d.edge}/100 (partly unmeasured inputs).`;
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
    levelsWithheldReason: d.levelsWithheld ? `${capitalize(d.levelsWithheld)}.` : null,
    disclaimer: DISCLAIMER,
  };
}
