// Ruby Draft Read — a deterministic, READ-ONLY assembly of a prepared Ruby read
// over the already-built ChartIntelligenceState. No LLM, no provider re-probe:
// it restates the chart's own truth/understanding/decision layers in plain
// language, answering a small set of fixed intents.
//
// Ruby is strictly read-only. This service NEVER places, modifies, or closes a
// trade, never mutates a connection, and never reads another user's data. The
// caller is responsible for the per-user safety envelope; this module only
// shapes user-safe text from a state the caller already fetched for that user.
//
// Honest by construction: when the feed is dirty / insufficient or the
// understanding engines are unpopulated, the read says so rather than inventing
// a setup. It is decision support only and the chart never executes from it.

import type {
  ChartIntelligenceState,
  ChartMarketUnderstanding,
} from "../data/chart/chartIntelligence.js";
import type { ChartEvidenceDirection } from "../data/chart/engines/marketUnderstandingTypes.js";
import type { ChartConsensusStance } from "../data/chart/chartAgentConsensus.js";
import { buildChartHandshake } from "../data/chart/chartHandshake.js";
import { mirrorTrustSegment } from "../data/chart/brokerPriceAlignment.js";
import { DEFAULT_ASSISTANT_NAME } from "@workspace/domain/assistant-name";

export type RubyDraftIntent =
  | "analyze"
  | "is-this-a-buy"
  | "is-this-a-scalp"
  | "why-not-now"
  | "what-changes-my-mind"
  | "what-invalidates"
  | "hold-or-close"
  | "agent-consensus";

export const RUBY_DRAFT_INTENTS: RubyDraftIntent[] = [
  "analyze",
  "is-this-a-buy",
  "is-this-a-scalp",
  "why-not-now",
  "what-changes-my-mind",
  "what-invalidates",
  "hold-or-close",
  "agent-consensus",
];

export interface RubyDraftReadDraft {
  side: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp: number;
}

export interface RubyDraftConsensusView {
  populated: boolean;
  headline: string;
  stance: ChartConsensusStance;
  conflict: boolean;
  protective: boolean;
  cautions: string[];
}

export interface RubyDraftReadResult {
  intent: RubyDraftIntent;
  symbol: string;
  displaySymbol: string;
  timeframe: string;
  /** True when the state is fresh, understanding engines are populated, AND
   *  Phase 3 confidentReadAllowed gate passes (Chart Truth ≥ 75). */
  feedUsable: boolean;
  /** Mirrors the chart-read honesty signal: "ok" when the feed is confirmed
   *  (feedUsable), "insufficient" when the underlying feed for this
   *  symbol/timeframe is stale/unverified. Decision-support only — this flag
   *  NEVER gates execution (Ruby stays read-only) and never fabricates data. */
  dataQuality: "ok" | "insufficient";
  /** True when confidentReadAllowed from Phase 3 gate (Chart Truth ≥ 75). */
  confidentReadAllowed: boolean;
  /** True when the current candle is still forming (not yet closed). */
  hasFormingCandle: boolean;
  /** True when closed-bar history is thin (< 50 bars). */
  limitedHistory: boolean;
  /**
   * Compact trust line — always present. Shows the data source status.
   * e.g. "Verified M5 candles · Live feed · Mirror synced"
   */
  trustLine: string;
  /** The bias the read is built around. */
  bias: ChartEvidenceDirection;
  /** Direct, plain-language answer to the asked intent. */
  headline: string;
  /** Supporting plain-language points drawn from the state. */
  points: string[];
  /** Risk / caution lines — always surfaced, never hidden. */
  cautions: string[];
  /** Best next action restated from the decision layer (never an order). */
  bestNextAction: string;
  /** Quality label from the readiness/decision layer (e.g. "B", "unrated"). */
  confidenceLabel: string;
  /** Readiness score 0-100, or null when not populated. */
  confidenceScore: number | null;
  /** Advisory/shadow agent-consensus view — never gates anything. */
  agentConsensus: RubyDraftConsensusView;
  disclaimer: string;
}

const disclaimerFor = (assistantName: string): string =>
  `Decision support only — ${assistantName} is read-only and never places, changes, or closes a trade. Confirm live readiness and risk yourself before trading.`;

// Visible "feed not confirmed" caveat — mirrors the chart-read honesty signal so
// every unconfirmed-feed read carries the same caution. Advisory only: it never
// gates execution and Ruby never fabricates a read from missing data.
const FEED_NOT_CONFIRMED_CAUTION =
  "Feed not confirmed at read-time — limited visibility.";

const MIN_BARS_HISTORY = 50;

/**
 * True only when ALL Phase 4 gate conditions hold:
 * - feed is fresh and understanding engines are populated
 * - Chart Truth ≥ 75 (confidentReadAllowed)
 * - Feed not stale (autonomousChartActionAllowed)
 * - Mirror synced (tradeConfirmationAllowed)
 * - AACI chart handshake PASS (derived from the same Phase 3 gate output;
 *   equivalent to what snapshotService computes for AACI consumers)
 *
 * Ruby may only give a directional read when ALL hold — partial contexts still
 * return an answer, but via the honest "syncing" or "partial" message paths.
 */
function feedUsable(state: ChartIntelligenceState): boolean {
  if (
    !state.aiUsable ||
    state.stale ||
    !state.marketUnderstanding.populated ||
    !state.decisionState.populated ||
    !state.gateOutput.confidentReadAllowed ||
    !state.gateOutput.autonomousChartActionAllowed ||
    !state.gateOutput.tradeConfirmationAllowed
  ) {
    return false;
  }
  // Final gate: AACI chart handshake must PASS. The handshake is derived from
  // the same Phase 3 gate output (same logic snapshotService uses), so this
  // adds the explicit requirement without a separate network call.
  const handshake = buildChartHandshake(state.gateOutput, state.chartTruthScore);
  return handshake.overall === "PASS";
}

function buildTrustLine(state: ChartIntelligenceState, hasForming: boolean): string {
  const gate = state.gateOutput;
  const parts: string[] = [];
  if (gate.confidentReadAllowed) {
    parts.push(`Verified ${state.timeframe} candles`);
  } else {
    parts.push(`${state.timeframe} candles syncing`);
  }
  if (gate.autonomousChartActionAllowed) {
    parts.push("Live feed");
  } else {
    parts.push("Feed stale");
  }
  // Honest mirror copy from the real broker-alignment granularity — never claims
  // sync while the price is only drifting (wide) or unverifiable (unknown).
  const mirror = mirrorTrustSegment(gate.tradeConfirmationAllowed, state.brokerAlignment);
  if (mirror) {
    parts.push(mirror);
  }
  if (hasForming) {
    parts.push("Forming candle active");
  }
  return parts.join(" · ");
}

function biasWord(b: ChartEvidenceDirection): string {
  switch (b) {
    case "bullish":
      return "leaning up";
    case "bearish":
      return "leaning down";
    case "neutral":
      return "balanced / no clear edge";
    default:
      return "unclear";
  }
}

function consensusView(state: ChartIntelligenceState): RubyDraftConsensusView {
  const c = state.agentConsensus;
  return {
    populated: c.populated,
    headline: c.populated ? c.headline : c.note,
    stance: c.stance,
    conflict: c.conflict,
    protective: c.protective,
    cautions: [...c.cautions],
  };
}

// Pull the plain-language sentences the chart already produced, so Ruby's voice
// matches the chart's own copy exactly (single source of truth).
function sentence(
  state: ChartIntelligenceState,
  key: keyof ChartIntelligenceState["marketSentences"],
): string {
  const s = state.marketSentences[key];
  return typeof s === "object" && s != null && "text" in s ? s.text : "";
}

function activeLevelLine(mu: ChartMarketUnderstanding): string | null {
  const levels = mu.levels;
  const list = (levels.levels ?? []) as {
    kind: string;
    price: number;
    distancePct: number | null;
    personality: string;
  }[];
  if (list.length === 0) return null;
  // Nearest by absolute distance when known, else first.
  const sorted = [...list].sort((a, b) => {
    const da = a.distancePct == null ? Infinity : Math.abs(a.distancePct);
    const db = b.distancePct == null ? Infinity : Math.abs(b.distancePct);
    return da - db;
  });
  const lv = sorted[0]!;
  const dist =
    lv.distancePct == null
      ? ""
      : ` (${Math.abs(lv.distancePct).toFixed(2)}% away)`;
  return `Nearest level: ${lv.kind} at ${lv.price}${dist}, behaving as ${lv.personality}.`;
}

function baseResult(
  state: ChartIntelligenceState,
  intent: RubyDraftIntent,
): RubyDraftReadResult {
  const hasFormingCandle = state.currentCandle != null;
  const closedBars = state.candleStats.barsAnalyzed;
  const usable = feedUsable(state);
  return {
    intent,
    symbol: state.symbol,
    displaySymbol: state.displaySymbol,
    timeframe: state.timeframe,
    feedUsable: usable,
    dataQuality: usable ? "ok" : "insufficient",
    confidentReadAllowed: state.gateOutput.confidentReadAllowed,
    hasFormingCandle,
    limitedHistory: closedBars > 0 && closedBars < MIN_BARS_HISTORY,
    trustLine: buildTrustLine(state, hasFormingCandle),
    bias: state.decisionState.bias,
    headline: "",
    points: [],
    cautions: [],
    bestNextAction: sentence(state, "bestNextAction"),
    confidenceLabel: state.marketUnderstanding.readiness.quality,
    confidenceScore: state.marketUnderstanding.readiness.score,
    agentConsensus: consensusView(state),
    disclaimer: disclaimerFor(DEFAULT_ASSISTANT_NAME),
  };
}

function pushCautions(state: ChartIntelligenceState, out: string[]): void {
  const risk = sentence(state, "risk");
  if (risk) out.push(risk);
  if (state.decisionState.vetoed) {
    out.push("A veto is active — stand aside until it clears.");
  }
  if (state.agentConsensus.populated) {
    for (const c of state.agentConsensus.cautions) out.push(c);
  }
  if (state.decisionFork.populated && state.decisionFork.downgrade) {
    out.push(
      state.decisionFork.downgradeReason ??
        "Expected follow-through is already failing — treat any setup as downgraded.",
    );
  }
  // Phase 4: forming-candle and limited-history awareness.
  if (state.currentCandle != null) {
    out.push(
      "Buy/sell pressure is forming, but the current candle has not closed — confirmation is not complete.",
    );
  }
  const closedBars = state.candleStats.barsAnalyzed;
  if (closedBars > 0 && closedBars < MIN_BARS_HISTORY) {
    out.push(
      `Limited history (${closedBars} closed bars) — read is advisory; more data improves accuracy.`,
    );
  }
}

/**
 * Strip all directional/actionable fields from a result produced in a
 * gate-blocked path. When chart truth, freshness, or mirror verification
 * fails Ruby MUST NOT surface bias, bestNextAction, confidenceLabel, or
 * confidenceScore — those fields would drive UI/state into directional
 * confidence from unverified data.
 *
 * Only neutral/null values are returned. agentConsensus is also wiped so
 * nothing downstream can pull a directional reading from the consensus block.
 */
function neutralizeDirectionalFields(r: RubyDraftReadResult): RubyDraftReadResult {
  r.bias = "neutral";
  r.bestNextAction = "";
  r.confidenceLabel = "unverifiable";
  r.confidenceScore = null;
  // Agent consensus carries directional stance — blank it out so no directional
  // reading can be inferred from the consensus block when the gate is blocked.
  r.agentConsensus = {
    populated: false,
    headline: "Chart data not verified — agent consensus withheld.",
    stance: "neutral",
    conflict: false,
    protective: false,
    cautions: [],
  };
  return r;
}

// When Chart Truth < 75 OR freshness/mirror gate fails, every intent
// degrades to the honest "syncing" explanation. Directional fields are
// neutralized — no bias, bestNextAction, confidenceLabel, or confidenceScore
// is returned when the gate is blocked.
function honestSyncing(
  state: ChartIntelligenceState,
  intent: RubyDraftIntent,
): RubyDraftReadResult {
  const r = neutralizeDirectionalFields(baseResult(state, intent));
  r.headline =
    "Chart data is syncing. I'll read the market once candles are verified.";
  r.points = [
    state.gateOutput.primaryBlockReason ??
      "Chart Truth score is below the confidence threshold for a verified read.",
    "No directional read, entry, or stop idea is being shown until verification passes.",
  ];
  r.cautions = [
    "Wait for the chart to verify before acting on any signals.",
    ...(state.gateOutput.blockedReasons.slice(1, 3)),
  ].filter(Boolean);
  return r;
}

// When the feed is dirty/insufficient (no usable candles), every intent
// degrades to the same honest read rather than inventing structure.
// Directional fields are neutralized — same contract as honestSyncing.
function honestInsufficient(
  state: ChartIntelligenceState,
  intent: RubyDraftIntent,
): RubyDraftReadResult {
  // If the gate itself is the reason (candles exist but Truth/mirror/freshness
  // failed), use the syncing message which is more precise.
  if (state.aiUsable && !state.stale && !feedUsable(state)) {
    return honestSyncing(state, intent);
  }
  const r = neutralizeDirectionalFields(baseResult(state, intent));
  r.headline =
    "I can't give a real read right now — the chart feed is stale or there aren't enough clean candles.";
  r.points = [
    state.marketUnderstanding.note ||
      "Market-understanding engines are not populated for this symbol/timeframe yet.",
    "No setup, bias, or fork is being invented from missing data.",
  ];
  r.cautions = ["Wait for a fresh, complete feed before acting."];
  return r;
}

function answerAnalyze(state: ChartIntelligenceState): RubyDraftReadResult {
  const r = baseResult(state, "analyze");
  const market = sentence(state, "market");
  r.headline =
    market || `${state.displaySymbol} on ${state.timeframe} is ${biasWord(r.bias)}.`;
  const proving = sentence(state, "proving");
  const failed = sentence(state, "failedToProve");
  const fresh = sentence(state, "signalFreshness");
  const lvl = activeLevelLine(state.marketUnderstanding);
  r.points = [proving, failed, lvl ?? "", fresh].filter(Boolean) as string[];
  pushCautions(state, r.cautions);
  return r;
}

function answerIsThisABuy(state: ChartIntelligenceState): RubyDraftReadResult {
  const r = baseResult(state, "is-this-a-buy");
  const act = state.decisionState.actionability;
  const ready = act === "ready" || act === "prepare";
  if (r.bias === "bullish" && ready && !state.decisionState.vetoed) {
    r.headline = "There's a case for a long here, but it's conditional — not a green light.";
  } else if (r.bias === "bearish") {
    r.headline = "No — the read is leaning down, so a buy fights the evidence.";
  } else {
    r.headline = "Not a clean buy — the edge isn't there yet.";
  }
  const entry = sentence(state, "entryTiming");
  r.points = [
    `Bias is ${biasWord(r.bias)}; readiness is "${state.decisionState.actionability}".`,
    entry,
    sentence(state, "bestNextAction"),
  ].filter(Boolean) as string[];
  pushCautions(state, r.cautions);
  return r;
}

function answerIsThisAScalp(state: ChartIntelligenceState): RubyDraftReadResult {
  const r = baseResult(state, "is-this-a-scalp");
  const scalp = sentence(state, "scalp");
  r.headline = scalp || "No clear scalp read on this timeframe right now.";
  r.points = [
    sentence(state, "entryTiming"),
    sentence(state, "signalFreshness"),
  ].filter(Boolean) as string[];
  pushCautions(state, r.cautions);
  return r;
}

function answerWhyNotNow(state: ChartIntelligenceState): RubyDraftReadResult {
  const r = baseResult(state, "why-not-now");
  r.headline =
    state.decisionState.decision ??
    sentence(state, "bestNextAction") ??
    "Here's what's holding the setup back.";
  const reasons: string[] = [];
  if (state.decisionState.vetoed) reasons.push("A veto is active.");
  const failed = sentence(state, "failedToProve");
  if (failed) reasons.push(failed);
  if (state.decisionFork.populated && state.decisionFork.downgrade) {
    reasons.push(
      state.decisionFork.downgradeReason ?? "Expected follow-through is failing.",
    );
  }
  reasons.push(sentence(state, "whatWouldChange"));
  r.points = reasons.filter(Boolean);
  pushCautions(state, r.cautions);
  return r;
}

function answerWhatChangesMyMind(
  state: ChartIntelligenceState,
): RubyDraftReadResult {
  const r = baseResult(state, "what-changes-my-mind");
  const dr = state.decisionReasoning;
  if (!dr.populated) {
    r.headline =
      dr.note || "Not enough structure to say what would change the read.";
    return r;
  }
  r.headline = sentence(state, "whatWouldChange") || "Here's what would shift this read.";
  const lines: string[] = [];
  for (const c of dr.improve) lines.push(`Strengthens: ${c.text}`);
  for (const c of dr.weaken) lines.push(`Weakens: ${c.text}`);
  if (dr.opposite) {
    lines.push(
      `Opposite case (${biasWord(dr.opposite.direction)}): ${dr.opposite.trigger} → ${dr.opposite.expectation}`,
    );
  }
  r.points = lines.filter(Boolean);
  pushCautions(state, r.cautions);
  return r;
}

function answerWhatInvalidates(
  state: ChartIntelligenceState,
): RubyDraftReadResult {
  const r = baseResult(state, "what-invalidates");
  const dr = state.decisionReasoning;
  r.headline =
    sentence(state, "whatInvalidates") ||
    (dr.populated ? "Here's what kills this read." : dr.note);
  const lines: string[] = [];
  if (dr.populated) for (const c of dr.invalidate) lines.push(c.text);
  // Decision-fork invalidation branch, when present.
  if (state.decisionFork.populated) {
    for (const b of state.decisionFork.branches) {
      if (b.kind === "invalidation") lines.push(b.text);
    }
  }
  r.points = lines.filter(Boolean);
  pushCautions(state, r.cautions);
  return r;
}

function answerHoldOrClose(state: ChartIntelligenceState): RubyDraftReadResult {
  const r = baseResult(state, "hold-or-close");
  // Read-only: this restates evidence; it never closes or modifies anything.
  if (state.decisionState.vetoed || state.decisionFork.downgrade) {
    r.headline =
      "The read has deteriorated — manage risk tightly; I can't act for you.";
  } else if (r.bias !== "neutral" && r.bias !== "unknown") {
    r.headline = `Evidence still ${biasWord(r.bias)} — the thesis isn't broken yet.`;
  } else {
    r.headline = "Edge is fading to balanced — no strong reason to stay exposed.";
  }
  const fork = state.decisionFork;
  if (fork.populated) {
    for (const e of fork.expectations.slice(0, 2)) {
      r.points.push(`Next ${e.horizon === 1 ? "candle" : `${e.horizon} candles`}: ${e.text}`);
    }
  }
  r.points.push(sentence(state, "whatInvalidates"));
  r.points = r.points.filter(Boolean);
  pushCautions(state, r.cautions);
  return r;
}

function answerAgentConsensus(
  state: ChartIntelligenceState,
): RubyDraftReadResult {
  const r = baseResult(state, "agent-consensus");
  const c = state.agentConsensus;
  if (!c.populated) {
    r.headline = c.note;
    r.points = [
      "Specialist agents aren't influencing this read right now (advisory/shadow).",
    ];
    return r;
  }
  r.headline = c.headline;
  r.points = [
    c.detail,
    ...c.agents.map((a) => `${a.name}: ${a.stance.toLowerCase()}`),
  ].filter(Boolean);
  r.cautions = [...c.cautions];
  if (c.protective) {
    r.cautions.push("Governance lowered this read protectively.");
  }
  return r;
}

/**
 * Build a deterministic, read-only Ruby draft read for the given intent over an
 * already-built ChartIntelligenceState. Never throws on shape gaps — degrades to
 * an honest "insufficient" read.
 */
export function buildRubyDraftRead(
  state: ChartIntelligenceState,
  intent: RubyDraftIntent,
  draft?: RubyDraftReadDraft | null,
  assistantName: string = DEFAULT_ASSISTANT_NAME,
): RubyDraftReadResult {
  const result = computeDraftRead(state, intent, draft);
  result.disclaimer = disclaimerFor(assistantName);
  // Honesty: an unconfirmed/insufficient feed always carries the visible
  // "feed not confirmed" caveat — surfaced regardless of which read path ran.
  // This never gates execution; Ruby is read-only.
  if (
    result.dataQuality === "insufficient" &&
    !result.cautions.includes(FEED_NOT_CONFIRMED_CAUTION)
  ) {
    result.cautions = [FEED_NOT_CONFIRMED_CAUTION, ...result.cautions];
  }
  return result;
}

function computeDraftRead(
  state: ChartIntelligenceState,
  intent: RubyDraftIntent,
  _draft?: RubyDraftReadDraft | null,
): RubyDraftReadResult {
  try {
    if (!feedUsable(state)) return honestInsufficient(state, intent);
    switch (intent) {
      case "analyze":
        return answerAnalyze(state);
      case "is-this-a-buy":
        return answerIsThisABuy(state);
      case "is-this-a-scalp":
        return answerIsThisAScalp(state);
      case "why-not-now":
        return answerWhyNotNow(state);
      case "what-changes-my-mind":
        return answerWhatChangesMyMind(state);
      case "what-invalidates":
        return answerWhatInvalidates(state);
      case "hold-or-close":
        return answerHoldOrClose(state);
      case "agent-consensus":
        return answerAgentConsensus(state);
      default:
        return answerAnalyze(state);
    }
  } catch {
    // Fail-open to an honest read; never surface an exception to the user.
    return honestInsufficient(state, intent);
  }
}
