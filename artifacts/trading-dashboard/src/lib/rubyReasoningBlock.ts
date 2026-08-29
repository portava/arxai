// Ruby Reasoning Block — ONE standardized, always-visible reasoning contract
// shared by every Ruby decision surface (Scalp Builder, Scanner card, Opportunity
// Map detail, Ruby Chat, Ruby Chart Read, Trade Setup card, Auto-bot review).
//
// DISPLAY / EXPLANATION CLARITY ONLY. This block grants NO execution permission and
// touches NO live-execution gate, broker dispatch, kill switch, or owner/admin
// permission. It is a pure projection of reasoning data the surface already holds.
//
// HONESTY: builders MUST preserve the upstream honesty gates. When a read is
// downgraded / withheld (insufficient / stale / delayed / blocked) the Decision
// becomes WAIT/conditional, the limitation is stated in Feed/Data, and no direction
// or level is fabricated. If a news/calendar provider is missing we say
// "news/calendar unavailable", never "low risk".
//
// Pure module (no JSX) — keep it free of component exports so it stays testable and
// Vite fast-refresh-safe.

import type {
  RubyMarketReadExplanation,
  RubyMarketEdgeSignal,
  SignalPriceZone,
  ScalpResult,
} from "@workspace/api-client-react";
import type { SetupReason } from "@/components/scanner/RubySetupReason";
import type { ChartRead } from "@/lib/rubyReadPanelState";
import { DEFAULT_ASSISTANT_NAME } from "@workspace/domain/assistant-name";

export interface RubyReasoningEvidence {
  structure: string;
  momentum: string;
  pattern: string;
  /**
   * Trendline read (Task #649) — DISPLAY / EXPLANATION ONLY, a child input that
   * downgrades or contextualizes the read. It NEVER grants direction, a setup, or
   * execution permission. Withheld (mirrors `pattern`) when the read is downgraded.
   */
  trendline: string;
  supportResistance: string;
  feedData: string;
  risk: string;
}

export interface RubyReasoningBlockData {
  /** Conditional SELL scalp / BUY setup / WAIT / NO TRADE / TOO LATE / AVOID … */
  decision: string;
  /** The main reason Ruby leans that way. */
  why: string;
  evidence: RubyReasoningEvidence;
  /** The exact condition that makes the idea stronger. */
  confirmation: string;
  /** The exact condition that cancels the idea. */
  invalidation: string;
  /** One or two simple things a trader can check on the chart. */
  traderTest: string;
  /** The biggest reason not to force the trade. */
  riskNote: string;
}

export const NEWS_UNAVAILABLE_NOTE =
  "News/calendar unavailable — event risk not assessed.";

const NOT_ENOUGH = "Not enough confirmed data to call this yet.";

function clean(s: string | null | undefined): string {
  return (s ?? "").trim();
}

/** Always return a non-empty, honest line so every label renders. */
function orElse(s: string | null | undefined, fallback: string): string {
  const t = clean(s);
  return t.length ? t : fallback;
}

function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 4 : 5;
  return n.toFixed(digits);
}

function fmtZone(z: SignalPriceZone | null | undefined): string {
  if (!z) return "—";
  if (z.from === z.to) return fmtNum(z.from);
  return `${fmtNum(z.from)} – ${fmtNum(z.to)}`;
}

// ── Market-Edge / scanner card (RubyMarketReadExplanation) ──────────────────
// This is the richest source: it carries the full reason chain, levels, evidence,
// the no-trade / late state, and (via the caller) the shared scanner-truth
// downgrade verdict. It drives the feed-limited, near-S/R, WAIT/NO TRADE/TOO LATE
// and low-confidence scenarios.

export interface MarketReadReasoningInput {
  explanation: RubyMarketReadExplanation;
  signal: RubyMarketEdgeSignal;
  /** From the shared scanner-truth gate — true when feed is stale/delayed/insufficient/blocked. */
  downgraded: boolean;
  /** "blocked" | "limited" | "history" | null — downgrade category for honest copy. */
  level?: string | null;
  /** Human downgrade reason from the scanner-truth gate. */
  reason?: string | null;
  /** Event-risk label from the per-symbol truth snapshot, or null when no provider. */
  newsRiskLabel?: string | null;
}

const BIAS_DIR: Record<string, "BUY" | "SELL" | null> = {
  BULLISH: "BUY",
  BEARISH: "SELL",
  RANGING: null,
  MIXED: null,
  UNCLEAR: null,
};

export function buildReasoningFromMarketRead(
  input: MarketReadReasoningInput,
  assistantName: string = DEFAULT_ASSISTANT_NAME,
): RubyReasoningBlockData {
  const { explanation: exp, signal, downgraded } = input;
  const level = input.level ?? null;
  const reason = clean(input.reason);
  const newsMissing = !clean(input.newsRiskLabel);

  // The card chooses simple/advanced at render; for reasoning we read the simple
  // mode (most plain-English) and fall back to advanced if simple is empty.
  const chosen = exp.simple ?? exp.advanced;
  const bias = String(signal.bias ?? "").toUpperCase();
  const dir = BIAS_DIR[bias] ?? null;
  const isLate = !!signal.late?.isLate;
  const isNoTrade = !!exp.noTrade?.isNoTrade;
  const actionable = !!exp.actionable && !downgraded;

  // ── Decision ──────────────────────────────────────────────────────────────
  let decision: string;
  if (downgraded) {
    decision = "WAIT — live feed not confirmed";
  } else if (isNoTrade) {
    decision = "NO TRADE";
  } else if (isLate) {
    decision = dir ? `TOO LATE — ${dir.toLowerCase()} move already extended` : "TOO LATE";
  } else if (dir) {
    decision = actionable ? `${dir} setup` : `Conditional ${dir}`;
  } else {
    decision = "WAIT — no confirmed direction";
  }

  // ── Why ───────────────────────────────────────────────────────────────────
  const why = orElse(
    exp.headline,
    orElse(
      chosen?.why,
      downgraded
        ? `The live feed isn't confirmed, so ${assistantName} is holding back a directional call.`
        : NOT_ENOUGH,
    ),
  );

  // ── Evidence ────────────────────────────────────────────────────────────────
  const structure = orElse(chosen?.whatIsHappening, NOT_ENOUGH);
  const momentum = orElse(
    chosen?.whyNow,
    orElse(chosen?.timingState, NOT_ENOUGH),
  );
  const pattern = downgraded
    ? "Pattern read withheld until the live feed confirms."
    : orElse(chosen?.whyThisDirection, "No confirmed chart pattern called out.");
  const trendline = downgraded
    ? "Trendline read withheld until the live feed confirms."
    : "No specific trendline called out.";

  let supportResistance: string;
  if (downgraded || !actionable) {
    supportResistance =
      "Key support/resistance levels are withheld until the live feed confirms.";
  } else {
    const lv = exp.levels;
    const parts: string[] = [];
    if (lv?.entryZone) parts.push(`entry ${fmtZone(lv.entryZone)}`);
    if (lv?.stopLoss != null) parts.push(`stop ${fmtNum(lv.stopLoss)}`);
    if (lv?.invalidation != null) parts.push(`invalidation ${fmtNum(lv.invalidation)}`);
    supportResistance = parts.length
      ? `Watch nearby levels — ${parts.join(", ")}. Room can be limited near these.`
      : "No clean support/resistance level marked yet — be cautious entering blind.";
  }

  const ds = String(signal.dataSource ?? "").toUpperCase();
  let feedData: string;
  if (downgraded) {
    const cat =
      level === "blocked" ? "blocked" : level === "limited" ? "delayed / limited" : "historical";
    feedData = `Feed not fully confirmed (${cat} read).${reason ? ` ${reason}` : ""}`;
  } else if (ds === "LIVE_FEED") {
    feedData = "Live feed confirmed.";
  } else if (ds === "LIVE_DELAYED") {
    feedData = "Live feed is delayed — treat as lower confidence.";
  } else if (ds === "AWAITING_FEED") {
    feedData = "Awaiting live feed — this read is provisional.";
  } else if (ds.includes("HISTORY")) {
    feedData = "History only — not a live read.";
  } else {
    feedData = "No live feed — this read is provisional.";
  }

  const riskBase = orElse(chosen?.risk, "Manage risk to your plan.");
  const evidenceRisk = newsMissing ? `${riskBase} ${NEWS_UNAVAILABLE_NOTE}` : riskBase;

  // ── Confirmation / Invalidation / Trader Test ───────────────────────────────
  const confirmation = downgraded
    ? "Confirm the live feed first, then re-check the setup before acting."
    : orElse(
        chosen?.whatConfirms,
        actionable && exp.levels?.entryZone
          ? `Strengthens if price respects ${fmtZone(exp.levels.entryZone)} and follows through with momentum.`
          : NOT_ENOUGH,
      );

  const invalidation = downgraded
    ? "Treat the idea as invalid while the feed is unconfirmed or structure breaks against it."
    : orElse(
        chosen?.whatInvalidates,
        actionable && exp.levels?.invalidation != null
          ? `Cancel if price reclaims and holds beyond ${fmtNum(exp.levels.invalidation)}.`
          : NOT_ENOUGH,
      );

  let traderTest: string;
  if (downgraded) {
    traderTest = "Check the chart's feed-status badge before trusting any level or direction.";
  } else if (actionable && exp.levels?.invalidation != null) {
    traderTest = `Mark ${fmtNum(exp.levels.invalidation)} on the chart and watch whether the next candle breaks or rejects it. Don't chase if price stalls there.`;
  } else {
    traderTest = orElse(
      chosen?.whatToDoNext,
      "Mark the nearest visible level and watch whether the next candle breaks or rejects it.",
    );
  }

  // ── Risk Note ───────────────────────────────────────────────────────────────
  let riskNote: string;
  if (isLate) {
    riskNote = orElse(
      signal.late?.reason,
      "This move may already be late — chasing it carries extra risk.",
    );
  } else if (downgraded) {
    riskNote = "This is a conditional read on an unconfirmed feed — not a full-confidence trade.";
  } else if (isNoTrade) {
    riskNote = orElse(
      exp.noTrade?.reason,
      "Sitting out is the higher-probability choice right now.",
    );
  } else {
    riskNote = "Don't force it — wait for your confirmation trigger before committing.";
  }

  return {
    decision,
    why,
    evidence: {
      structure,
      momentum,
      pattern,
      trendline,
      supportResistance,
      feedData,
      risk: evidenceRisk,
    },
    confirmation,
    invalidation,
    traderTest,
    riskNote,
  };
}

// ── Trade Setup card (explain-signal SetupReason) ───────────────────────────
// Thinner source. We keep all labels (honest fallbacks where a dimension isn't
// separately available) so the format matches every other surface.

export interface SetupReasonReasoningInput {
  reason: SetupReason;
  /** Symbol/timeframe context for the trader-test line. */
  symbol?: string;
  /** Optional pattern label if the surface knows one; else honest fallback. */
  patternLabel?: string | null;
  /** True when no news/calendar provider is connected. */
  newsUnavailable?: boolean;
}

export function buildReasoningFromSetupReason(
  input: SetupReasonReasoningInput,
): RubyReasoningBlockData {
  const r = input.reason;
  const dir = r.bias === "BUY" || r.bias === "SELL" ? r.bias : null;
  // Canonical field first; deprecated alias as fallback for older payloads.
  const strength = r.signalStrength ?? r.confidenceScore;
  const lowConf =
    /low|weak|uncertain|conditional/i.test(clean(r.confidenceLabel)) ||
    (Number.isFinite(strength) && strength < 50);

  let decision: string;
  if (!dir) {
    decision = "WAIT — no confirmed direction";
  } else if (lowConf) {
    decision = `Conditional ${dir}`;
  } else {
    decision = `${dir} setup`;
  }

  const cautionLine = r.cautions?.length ? r.cautions.join(" ") : "";

  return {
    decision,
    why: orElse(r.why, NOT_ENOUGH),
    evidence: {
      structure: orElse(r.hedge, orElse(r.why, NOT_ENOUGH)),
      momentum: lowConf
        ? `Confidence is ${orElse(r.confidenceLabel, "limited").toLowerCase()} — momentum isn't fully behind this yet.`
        : orElse(r.confidenceLabel, NOT_ENOUGH),
      pattern: orElse(input.patternLabel, "No confirmed chart pattern called out."),
      trendline: "No specific trendline called out.",
      supportResistance: `Possible TP area ${orElse(r.possibleTpArea, "—")}; suggested SL area ${orElse(r.suggestedStopArea, "—")}. Mind room into nearby support/resistance.`,
      feedData: "Setup read from the current scanner signal — confirm the live feed on the chart before acting.",
      risk: input.newsUnavailable
        ? `${orElse(r.risk, "Manage risk to your plan.")} ${NEWS_UNAVAILABLE_NOTE}`
        : orElse(r.risk, "Manage risk to your plan."),
    },
    confirmation: dir
      ? orElse(
          r.possibleTpArea && `Strengthens if price moves cleanly toward ${r.possibleTpArea}.`,
          NOT_ENOUGH,
        )
      : "Wait for a clear directional break before treating this as a setup.",
    invalidation: orElse(
      r.invalidation,
      r.suggestedStopArea ? `Cancel if price breaks the suggested SL area ${r.suggestedStopArea}.` : NOT_ENOUGH,
    ),
    traderTest: r.suggestedStopArea
      ? `Mark the SL area ${r.suggestedStopArea} on ${orElse(input.symbol, "the chart")} and watch whether price respects or breaks it.`
      : "Mark the nearest visible level and watch whether the next candle breaks or rejects it.",
    riskNote: orElse(
      cautionLine,
      lowConf
        ? "This is a conditional setup, not a full-confidence trade."
        : "Don't force it — wait for your confirmation trigger before committing.",
    ),
  };
}

// ── Scalp Builder card (ScalpResult) ────────────────────────────────────────
// The scalp engine collapses ANY non-live / insufficient read to AWAITING_DATA
// (across both the candle-backed Focus path and the intentionally-blind Broad
// path). We honour that single readiness bit: an AWAITING_DATA read becomes WAIT
// with the limitation stated in Feed/Data and no fabricated direction/levels.

export interface ScalpReasoningInput {
  result: ScalpResult;
  /** Human flame setup label (FLAME_SETUP_LABEL) the card already resolved. */
  patternLabel?: string | null;
}

export function buildReasoningFromScalp(
  input: ScalpReasoningInput,
): RubyReasoningBlockData {
  const r = input.result;
  const awaiting = r.status === "AWAITING_DATA";
  const dir = r.direction === "BUY" || r.direction === "SELL" ? r.direction : null;
  const flame = r.flame && !r.flame.blind ? r.flame : null;
  const chase = clean(r.chaseWarning);

  // ── Decision ──────────────────────────────────────────────────────────────
  let decision: string;
  if (awaiting) {
    decision = "WAIT — awaiting live data";
  } else if (clean(r.noTradeReason)) {
    decision = "NO TRADE";
  } else if (!dir) {
    decision = "WAIT — no confirmed direction";
  } else if (chase) {
    decision = `TOO LATE — ${dir.toLowerCase()} move already extended`;
  } else if (r.canBuildTrade) {
    decision = `${dir} scalp setup`;
  } else {
    decision = `Conditional ${dir} scalp`;
  }

  // ── Evidence ────────────────────────────────────────────────────────────────
  const structure = orElse(r.plainEnglishReason, NOT_ENOUGH);
  const momentum = flame
    ? orElse(flame.whyNow, `Flame momentum read ${flame.scalpScore}/100.`)
    : awaiting
      ? "Awaiting live candles before judging momentum."
      : "Momentum not read on this blind scan.";
  const pattern = awaiting
    ? "Pattern read withheld until live candles confirm."
    : orElse(input.patternLabel, "No specific scalp pattern called out.");
  const trendline = awaiting
    ? "Trendline read withheld until live candles confirm."
    : "No specific trendline called out.";

  let supportResistance: string;
  if (awaiting) {
    supportResistance = "Entry, stop, and target are withheld until live candles confirm.";
  } else {
    const parts: string[] = [];
    if (r.entryZone) parts.push(`entry ${fmtNum(r.entryZone.from)} – ${fmtNum(r.entryZone.to)}`);
    if (r.stopLoss != null) parts.push(`stop ${fmtNum(r.stopLoss)}`);
    if (r.takeProfit?.main != null) parts.push(`main TP ${fmtNum(r.takeProfit.main)}`);
    supportResistance = parts.length
      ? `Plan — ${parts.join(", ")}. Watch room into nearby support/resistance.`
      : "No clean level marked yet — be cautious entering blind.";
  }

  const feedData = awaiting
    ? "Awaiting live feed — no confirmed candles yet, so this read is provisional."
    : flame
      ? "Live 1-minute candles read."
      : "Scanner-level (blind) read — limited candle visibility on this symbol.";

  const newsLabel = clean(r.newsRisk);
  const riskBits = [
    clean(r.spreadRisk) ? `spread ${r.spreadRisk}` : "",
    clean(r.slippageRisk) ? `slippage ${r.slippageRisk}` : "",
    newsLabel ? `news ${newsLabel}` : "",
  ].filter(Boolean);
  let evidenceRisk = riskBits.length
    ? `Risk read — ${riskBits.join(", ")}.`
    : "Manage risk to your plan.";
  if (!newsLabel) evidenceRisk = `${evidenceRisk} ${NEWS_UNAVAILABLE_NOTE}`;
  const rWarn = clean(r.riskWarning);
  if (rWarn) evidenceRisk = `${evidenceRisk} ${rWarn}`;

  // ── Confirmation / Invalidation / Trader Test ───────────────────────────────
  const confirmation = orElse(
    flame?.entryTrigger,
    dir
      ? "Confirms on a clean trigger in your direction with momentum follow-through."
      : "Wait for a clear directional trigger first.",
  );
  const invalidation = orElse(
    flame?.invalidationIdea,
    r.stopLoss != null
      ? `Cancel if price breaks your stop ${fmtNum(r.stopLoss)}.`
      : NOT_ENOUGH,
  );
  const traderTest =
    r.stopLoss != null
      ? `Mark ${fmtNum(r.stopLoss)} (your stop) and watch whether price respects or breaks it. Don't chase if it has already run.`
      : "Mark the nearest visible level and watch whether the next candle breaks or rejects it.";

  // ── Risk Note ───────────────────────────────────────────────────────────────
  const riskNote = orElse(
    r.noTradeReason,
    orElse(
      chase,
      orElse(
        flame?.decayNote,
        awaiting
          ? "No confirmed feed yet — wait for live candles before committing."
          : "Scalps move fast — don't chase; stick to your stop.",
      ),
    ),
  );

  return {
    decision,
    why: orElse(flame?.whyNow, orElse(r.plainEnglishReason, NOT_ENOUGH)),
    evidence: { structure, momentum, pattern, trendline, supportResistance, feedData, risk: evidenceRisk },
    confirmation,
    invalidation,
    traderTest,
    riskNote,
  };
}

// ── Ruby Chart Read (read-chart ChartRead) ──────────────────────────────────
// The read-chart pipeline already honesty-gates: a `gated` read carries NO
// directional structure, and a STRUCTURAL_ONLY read withholds the exact setup
// until the feed confirms. We mirror that: gated/not-confirmed → WAIT with the
// limitation in Feed/Data; structural-only → conditional with levels withheld.

export interface ChartReadReasoningInput {
  read: ChartRead;
  symbol: string;
  timeframe: string;
  /** STRUCTURAL_ONLY verdict from the shared panel resolver. */
  structuralOnly?: boolean;
  /** "feed not confirmed" verdict from the shared panel resolver. */
  feedNotConfirmed?: boolean;
  /** Panel-resolved downgrade reason (same dimension that drove the downgrade). */
  reason?: string | null;
}

function biasDir(bias: string | null | undefined): "BUY" | "SELL" | null {
  const b = clean(bias).toLowerCase();
  if (b.includes("bull")) return "BUY";
  if (b.includes("bear")) return "SELL";
  return null;
}

export function buildReasoningFromChartRead(
  input: ChartReadReasoningInput,
  assistantName: string = DEFAULT_ASSISTANT_NAME,
): RubyReasoningBlockData {
  const { read, symbol, timeframe } = input;
  const reason = clean(input.reason);
  const gated = read.gated === true;
  const structuralOnly = !!input.structuralOnly;
  const feedNotConfirmed = !!input.feedNotConfirmed;
  const withheld = gated || feedNotConfirmed || structuralOnly;
  const dir = biasDir(read.bias);
  const lowConf = /low|weak/i.test(clean(read.confidence));

  // ── Decision ──────────────────────────────────────────────────────────────
  let decision: string;
  if (gated || feedNotConfirmed) {
    decision = "WAIT — live feed not confirmed";
  } else if (structuralOnly) {
    decision = dir ? `Conditional ${dir} — structural read only` : "WAIT — structure only";
  } else if (!dir) {
    decision = "WAIT — no confirmed direction";
  } else if (lowConf) {
    decision = `Conditional ${dir}`;
  } else {
    decision = `${dir} bias`;
  }

  // ── Evidence ────────────────────────────────────────────────────────────────
  const structure = orElse(
    clean(read.htfBias)
      ? `Higher-timeframe bias ${read.htfBias}${clean(read.bias) ? `; ${read.bias} on ${timeframe}` : ""}.`
      : read.bias,
    NOT_ENOUGH,
  );
  const momentum = clean(read.confidence)
    ? `Read confidence ${read.confidence}.`
    : NOT_ENOUGH;
  const pattern = withheld
    ? "Pattern read withheld until the live feed confirms."
    : "No specific chart pattern named.";
  const trendline = withheld
    ? "Trendline read withheld until the live feed confirms."
    : "No specific trendline named.";

  let supportResistance: string;
  if (gated || feedNotConfirmed) {
    supportResistance = "Support/resistance levels are withheld until the live feed confirms.";
  } else if (structuralOnly) {
    supportResistance = `Support ${orElse(read.supportZone, "—")} · Resistance ${orElse(read.resistanceZone, "—")}. Exact entry/stop/target withheld until the feed confirms.`;
  } else {
    supportResistance = `Support ${orElse(read.supportZone, "—")} · Resistance ${orElse(read.resistanceZone, "—")}. Mind room into these levels.`;
  }

  let feedData: string;
  if (gated) {
    feedData = orElse(read.blockedReason, "Feed not confirmed — no directional structure available.");
  } else if (structuralOnly) {
    feedData = `Structural read only — exact setup withheld until ${symbol} ${timeframe} confirms.${reason ? ` ${reason}` : ""}`;
  } else if (feedNotConfirmed) {
    feedData = `Feed not confirmed for ${symbol} ${timeframe}.${reason ? ` ${reason}` : ""}`;
  } else {
    feedData = `Live read on ${symbol} ${timeframe}.`;
  }

  const cautionLine = read.cautions?.length ? read.cautions.join("; ") : "";
  const riskBase = orElse(read.riskNote, "Manage risk to your plan.");
  const evidenceRisk = `${cautionLine ? `${riskBase} — ${cautionLine}` : riskBase} ${NEWS_UNAVAILABLE_NOTE}`;

  // ── Confirmation / Invalidation / Trader Test ───────────────────────────────
  let confirmation: string;
  if (withheld) {
    confirmation = "Confirm the live feed first, then re-check the conditions before acting.";
  } else if (dir === "BUY") {
    confirmation = orElse(read.buyCondition, NOT_ENOUGH);
  } else if (dir === "SELL") {
    confirmation = orElse(read.sellCondition, NOT_ENOUGH);
  } else {
    confirmation = orElse(read.buyCondition, orElse(read.sellCondition, "Wait for a clear directional break first."));
  }

  const invalidation = withheld
    ? "Treat the idea as invalid while the feed is unconfirmed or structure breaks against it."
    : orElse(read.invalidation, NOT_ENOUGH);

  const traderTest =
    clean(read.supportZone) || clean(read.resistanceZone)
      ? `Mark support ${orElse(read.supportZone, "—")} and resistance ${orElse(read.resistanceZone, "—")} on ${symbol}; watch which one price tests first.`
      : "Check the chart's feed-status badge, then mark the nearest visible level and watch whether the next candle breaks or rejects it.";

  const riskNote = gated
    ? orElse(read.blockedReason, "Feed unconfirmed — treat as no-trade until it clears.")
    : structuralOnly || feedNotConfirmed
      ? "Structure only — wait for the feed to confirm before acting on a live setup."
      : orElse(read.riskNote, "Don't force it — wait for your confirmation trigger before committing.");

  return {
    decision,
    why: orElse(read.why, orElse(read.headline, withheld ? `The live feed isn't confirmed, so ${assistantName} is holding back a directional call.` : NOT_ENOUGH)),
    evidence: { structure, momentum, pattern, trendline, supportResistance, feedData, risk: evidenceRisk },
    confirmation,
    invalidation,
    traderTest,
    riskNote,
  };
}

// ── Opportunity Map detail (SelectedMarketPanel snapshot) ────────────────────
// The selected-market snapshot withholds levels (null / levelsWithheld) when the
// stale-level guard fires or there are no confirmed candles. We never render a
// withheld level as a number; a degraded dataState becomes a WAIT/conditional.

export interface OppMapReasoningInput {
  symbol: string;
  timeframe: string;
  bias: string;
  confidenceLabel: string;
  trendState: string;
  volatilityLabel: string;
  entryZone: { low: number; high: number } | null;
  suggestedStop: number | null;
  suggestedTakeProfit: number | null;
  riskRewardRatio: number;
  riskWarnings: string[];
  explanation: {
    hedge: string;
    why: string;
    whyItMatters: string;
    risk: string;
    invalidation: string;
    cautions: string[];
  };
  levelsWithheld?: boolean;
  levelsWithheldReason?: string | null;
  dataState?: string | null;
  dataSourceLabel?: string | null;
  newsRiskLevel?: string | null;
}

export function buildReasoningFromOppMap(
  input: OppMapReasoningInput,
): RubyReasoningBlockData {
  const exp = input.explanation;
  const bias = clean(input.bias).toUpperCase();
  const dir = bias === "BUY" || bias === "SELL" ? bias : null;
  const ds = clean(input.dataState).toUpperCase();
  const feedDegraded = ds === "STALE" || ds === "UNAVAILABLE";
  const withheld = input.levelsWithheld === true || input.entryZone == null || feedDegraded;
  const lowConf = /low|weak|uncertain/i.test(clean(input.confidenceLabel));
  const newsLabel = clean(input.newsRiskLevel);

  // ── Decision ──────────────────────────────────────────────────────────────
  let decision: string;
  if (feedDegraded) {
    decision = "WAIT — live feed not confirmed";
  } else if (!dir) {
    decision = bias === "WAIT" ? "WAIT — no clean setup" : "WAIT — no confirmed direction";
  } else if (withheld) {
    decision = `Conditional ${dir} — levels pending`;
  } else if (lowConf) {
    decision = `Conditional ${dir}`;
  } else {
    decision = `${dir} setup`;
  }

  // ── Evidence ────────────────────────────────────────────────────────────────
  const structure = orElse(
    clean(input.trendState) ? `Trend ${input.trendState}. ${clean(exp.hedge)}`.trim() : exp.hedge,
    NOT_ENOUGH,
  );
  const momentum = `Confidence ${orElse(input.confidenceLabel, "—")}; volatility ${orElse(input.volatilityLabel, "—")}.`;
  const pattern = orElse(exp.whyItMatters, "No specific pattern called out.");
  const trendline = withheld
    ? "Trendline read withheld until a confirmed live feed."
    : "No specific trendline called out.";

  let supportResistance: string;
  if (withheld || !input.entryZone) {
    supportResistance = orElse(
      input.levelsWithheldReason,
      "Entry, stop, and target are withheld until a confirmed live feed.",
    );
  } else {
    supportResistance = `Entry ${fmtNum(input.entryZone.low)} – ${fmtNum(input.entryZone.high)}, stop ${fmtNum(input.suggestedStop)}, target ${fmtNum(input.suggestedTakeProfit)} (R:R 1:${input.riskRewardRatio}). Mind room into nearby support/resistance.`;
  }

  let feedData: string;
  if (ds === "LIVE_CONFIRMED") {
    feedData = `Live feed confirmed${clean(input.dataSourceLabel) ? ` (${input.dataSourceLabel})` : ""}.`;
  } else if (ds === "SYNCING") {
    feedData = "Feed is syncing — treat this read as provisional.";
  } else if (ds === "STALE") {
    feedData = "Feed is stale — treat as lower confidence and confirm before acting.";
  } else if (ds === "UNAVAILABLE") {
    feedData = "No live feed — this read is provisional.";
  } else {
    feedData = "Confirm the live feed on the chart before acting.";
  }

  const riskBase = orElse(exp.risk, "Manage risk to your plan.");
  const evidenceRisk = newsLabel
    ? `${riskBase} News risk ${newsLabel}.`
    : `${riskBase} ${NEWS_UNAVAILABLE_NOTE}`;

  // ── Confirmation / Invalidation / Trader Test ───────────────────────────────
  const confirmation = dir
    ? input.suggestedTakeProfit != null && !withheld
      ? `Strengthens if price moves cleanly toward ${fmtNum(input.suggestedTakeProfit)}.`
      : "Confirm the feed, then look for follow-through in your direction."
    : "Wait for a clear directional break before treating this as a setup.";
  const invalidation = orElse(
    exp.invalidation,
    input.suggestedStop != null && !withheld
      ? `Cancel if price breaks the stop ${fmtNum(input.suggestedStop)}.`
      : NOT_ENOUGH,
  );
  const traderTest =
    input.suggestedStop != null && !withheld
      ? `Mark ${fmtNum(input.suggestedStop)} on ${input.symbol} and watch whether price respects or breaks it.`
      : "Mark the nearest visible level and watch whether the next candle breaks or rejects it.";

  const riskNote = orElse(
    exp.cautions?.length ? exp.cautions.join(" ") : "",
    orElse(
      input.riskWarnings?.length ? input.riskWarnings.join(" ") : "",
      withheld
        ? "Levels are withheld on an unconfirmed feed — wait for confirmation before committing."
        : "Don't force it — wait for your confirmation trigger before committing.",
    ),
  );

  return {
    decision,
    why: orElse(exp.why, orElse(exp.hedge, NOT_ENOUGH)),
    evidence: { structure, momentum, pattern, trendline, supportResistance, feedData, risk: evidenceRisk },
    confirmation,
    invalidation,
    traderTest,
    riskNote,
  };
}

// ── Auto-bot proposed-trade review (AIInsightCard) ───────────────────────────
// The AI Insight card already enforces a display ceiling: when the shared
// Trade-Health contract says the read is NOT live-confirmed (mayDescribeSetup ===
// false) the concrete setup narrative is withheld. We mirror that exactly — a
// withheld read becomes WAIT with the limitation in Feed/Data and no fabricated
// setup. The block grants NO execution permission to the auto-bot.

export interface AIInsightReasoningInput {
  setupQuality?: number | null;
  invalidation?: string | null;
  warning?: string | null;
  managementSuggestion?: string | null;
  explanation?: string | null;
  mayDescribeSetup?: boolean;
  readinessLabel?: string | null;
  readinessTrustLine?: string | null;
  /** Optional direction/symbol when the proposing surface knows them. */
  direction?: "BUY" | "SELL" | null;
  symbol?: string | null;
}

export function buildReasoningFromAIInsight(
  input: AIInsightReasoningInput,
): RubyReasoningBlockData {
  const withheld = input.mayDescribeSetup === false;
  const dir = input.direction === "BUY" || input.direction === "SELL" ? input.direction : null;
  const q = input.setupQuality;
  const lowQuality = typeof q === "number" && Number.isFinite(q) && q < 60;

  // ── Decision ──────────────────────────────────────────────────────────────
  let decision: string;
  if (withheld) {
    decision = "WAIT — read not live-confirmed";
  } else if (dir) {
    decision = lowQuality ? `Conditional ${dir}` : `${dir} setup`;
  } else if (typeof q === "number" && Number.isFinite(q)) {
    decision = lowQuality ? "Conditional setup" : "Setup looks actionable";
  } else {
    decision = "Review setup";
  }

  // ── Evidence ────────────────────────────────────────────────────────────────
  const structure = withheld
    ? "Setup structure withheld until the live feed confirms."
    : orElse(input.explanation, NOT_ENOUGH);
  const momentum = withheld
    ? orElse(input.readinessLabel, "Read not live-confirmed.")
    : typeof q === "number" && Number.isFinite(q)
      ? `Setup quality ${q}%.`
      : NOT_ENOUGH;
  const pattern = withheld
    ? "Pattern read withheld until the live feed confirms."
    : "No specific chart pattern named.";
  const trendline = withheld
    ? "Trendline read withheld until the live feed confirms."
    : "No specific trendline named.";
  const supportResistance = withheld
    ? "Entry, stop, and target are withheld until the live feed confirms."
    : "Watch nearby support/resistance before entering.";
  const feedData = withheld
    ? orElse(input.readinessTrustLine, "Read isn't live-confirmed yet.")
    : "Read presented as live-confirmed by the bot pipeline — verify the chart's feed-status badge.";
  const riskBase = orElse(input.warning, "Manage risk to your plan.");
  const evidenceRisk = `${riskBase} ${NEWS_UNAVAILABLE_NOTE}`;

  // ── Confirmation / Invalidation / Trader Test ───────────────────────────────
  const confirmation = withheld
    ? "Confirm the live feed first, then re-check the setup before acting."
    : orElse(input.managementSuggestion, NOT_ENOUGH);
  const invalidation = withheld
    ? "Treat the idea as invalid while the feed is unconfirmed."
    : orElse(input.invalidation, NOT_ENOUGH);
  const traderTest =
    "Check the chart's feed-status badge and the invalidation level before trusting this proposal.";
  const riskNote = orElse(
    input.warning,
    withheld
      ? "Read not confirmed — treat as no-trade until the feed clears."
      : "Don't force it — wait for your confirmation trigger before committing.",
  );

  return {
    decision,
    why: withheld
      ? orElse(input.readinessTrustLine, "Read isn't live-confirmed yet — the detailed setup is withheld.")
      : orElse(input.explanation, NOT_ENOUGH),
    evidence: { structure, momentum, pattern, trendline, supportResistance, feedData, risk: evidenceRisk },
    confirmation,
    invalidation,
    traderTest,
    riskNote,
  };
}

// ── Auto-bot proposed-trade review (Self-Trade decision cycle) ───────────────
// The fleet decision cycle is SHADOW / decision-only — it dispatches NOTHING.
// We mirror its outcome honestly: a non-approving outcome (WAIT / DENIED /
// BLOCKED / WATCH_ONLY / PREPARE_ONLY) or a blocking FAIL check becomes
// WAIT / NO TRADE with the limitation surfaced. The block grants NO execution
// permission and the copy never implies one.

export interface SelfTradeReasoningInput {
  outcome: string;
  side?: string | null;
  reason?: string | null;
  setup?: string | null;
  confidence?: number | null;
  noTradeScore?: number | null;
  riskState?: string | null;
  conflictState?: string | null;
  symbol?: string | null;
  timeframe?: string | null;
  thesis?: {
    whyNow?: string[];
    entryZone?: { from: number; to: number } | null;
    stopLoss?: number | null;
    takeProfits?: { to: number }[];
    invalidation?: number | null;
    edge?: number | null;
    newsRisk?: string | null;
  } | null;
  checks?: {
    label?: string;
    key?: string;
    status?: string;
    detail?: string;
    blocking?: boolean;
  }[];
}

export function buildReasoningFromSelfTrade(
  input: SelfTradeReasoningInput,
): RubyReasoningBlockData {
  const outcome = clean(input.outcome).toUpperCase();
  const side = clean(input.side).toUpperCase();
  const dir = side === "BUY" || side === "SELL" ? side : null;
  const t = input.thesis ?? null;
  const checks = input.checks ?? [];
  const blockingDetail = checks.find(
    (c) => clean(c.status).toUpperCase() === "FAIL" && c.blocking === true,
  );
  const blockingFail = !!blockingDetail;
  const approved = outcome === "APPROVED" || outcome === "APPROVED_REDUCED";
  const blocked = outcome === "DENIED" || outcome === "BLOCKED" || blockingFail;
  const newsLabel = clean(t?.newsRisk);

  // ── Decision ──────────────────────────────────────────────────────────────
  let decision: string;
  if (blocked) {
    decision = "NO TRADE";
  } else if (outcome === "WAIT") {
    decision = dir ? `WAIT — ${dir.toLowerCase()} pending confirmation` : "WAIT — no clean setup";
  } else if (outcome === "WATCH_ONLY") {
    decision = "WATCH ONLY";
  } else if (outcome === "PREPARE_ONLY") {
    decision = "PREPARE ONLY";
  } else if (outcome === "ASSIGNED_TO_ANOTHER") {
    decision = "NO TRADE — assigned to another agent";
  } else if (approved && dir) {
    decision = `${dir} setup`;
  } else if (approved) {
    decision = "Setup approved";
  } else if (dir) {
    decision = `Conditional ${dir}`;
  } else {
    decision = "Review setup";
  }

  // ── Evidence ────────────────────────────────────────────────────────────────
  const structure = orElse(input.reason, orElse(input.setup, NOT_ENOUGH));
  const momentum =
    typeof input.confidence === "number" && Number.isFinite(input.confidence)
      ? `Agent confidence ${Math.round(input.confidence)}/100.`
      : NOT_ENOUGH;
  const pattern = orElse(input.setup, "No specific setup pattern named.");
  const trendline = "No specific trendline called out.";

  let supportResistance: string;
  if (t && (t.entryZone || t.stopLoss != null)) {
    const parts: string[] = [];
    if (t.entryZone) parts.push(`entry ${fmtNum(t.entryZone.from)} – ${fmtNum(t.entryZone.to)}`);
    if (t.stopLoss != null) parts.push(`stop ${fmtNum(t.stopLoss)}`);
    if (t.takeProfits && t.takeProfits.length) {
      parts.push(`targets ${t.takeProfits.map((x) => fmtNum(x.to)).join(", ")}`);
    }
    supportResistance = `Proposed plan — ${parts.join(", ")}. Mind room into nearby support/resistance.`;
  } else {
    supportResistance = "No proposed levels — entry, stop, and target withheld.";
  }

  const feedData = blocked
    ? "Decision-cycle review only (SHADOW) — this proposal is not live-confirmed and dispatches nothing."
    : "Auto-bot decision-cycle read (SHADOW, no dispatch) — verify the chart's feed-status badge before trusting it.";

  const riskBase = clean(input.riskState)
    ? `Risk state ${input.riskState}.`
    : "Manage risk to the agent's envelope.";
  const evidenceRisk = newsLabel
    ? `${riskBase} News risk ${newsLabel}.`
    : `${riskBase} ${NEWS_UNAVAILABLE_NOTE}`;

  // ── Confirmation / Invalidation / Trader Test ───────────────────────────────
  const firstTp = t?.takeProfits?.[0]?.to ?? null;
  const confirmation =
    firstTp != null && !blocked
      ? `Strengthens if price moves cleanly toward ${fmtNum(firstTp)}.`
      : "Confirm the feed and re-check the gates before this could ever act.";
  const invalidation =
    t?.invalidation != null
      ? `Cancel if price breaks ${fmtNum(t.invalidation)}.`
      : t?.stopLoss != null
        ? `Cancel if price breaks the stop ${fmtNum(t.stopLoss)}.`
        : NOT_ENOUGH;
  const traderTest =
    t?.stopLoss != null
      ? `Mark ${fmtNum(t.stopLoss)} on ${orElse(input.symbol, "the chart")} and watch whether price respects or breaks it.`
      : "Mark the nearest visible level and watch whether the next candle breaks or rejects it.";

  const conflict = clean(input.conflictState);
  const riskNote = blocked
    ? orElse(
        blockingDetail
          ? `${orElse(blockingDetail.label, blockingDetail.key ?? "Gate")}: ${clean(blockingDetail.detail)}`.trim()
          : "",
        orElse(input.reason, "Blocked by a safety gate — treat as no-trade."),
      )
    : conflict && conflict.toUpperCase() !== "NONE"
      ? `Signal conflict (${conflict}) — don't force it.`
      : orElse(input.reason, "Don't force it — the bot never bypasses a safety gate.");

  const why = blocked
    ? orElse(input.reason, "A safety gate blocked this proposal.")
    : orElse(
        t?.whyNow && t.whyNow.length ? t.whyNow.join(" ") : "",
        orElse(input.reason, NOT_ENOUGH),
      );

  return {
    decision,
    why,
    evidence: { structure, momentum, pattern, trendline, supportResistance, feedData, risk: evidenceRisk },
    confirmation,
    invalidation,
    traderTest,
    riskNote,
  };
}
