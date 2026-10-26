import { detectChartPatterns, findSwings, scanCandlestickCatalogue, isObservedDoji, CANDLE_DEFINITIONS, CANDLE_CRITERIA_VERSION, type ChartPatternCandle } from "@workspace/domain/chart-patterns";
import { resolveShootingStarTruth, detectEngulfing, resolveStructureBreakTruth, type DetectedPattern } from "@workspace/domain/market";

export interface SmartChartAnalysisContext {
  symbol: string;
  /** Canonical API timeframe, e.g. M5, H1, MN1. */
  timeframe: string;
  source: string | null;
  /** Observed opaque SHA-256 identity, never a locally invented identifier. */
  sourceIdentity: string | null;
}
export interface SmartChartAnalysisBar extends ChartPatternCandle {
  /** Bar open and close, both Unix seconds. */
  time: number;
  closeTime: number;
  isFinal: boolean;
}
export interface SmartChartAnalysisBatch {
  evidence: SmartChartAnalysisContext;
  bars: readonly SmartChartAnalysisBar[];
}
export interface SmartChartBoundBars {
  status: "ready" | "unavailable";
  reason: string | null;
  bars: SmartChartAnalysisBar[];
}
export interface SmartChartAnalysisInput extends SmartChartAnalysisContext {
  asOfMs: number;
  bars: readonly SmartChartAnalysisBar[];
  /** Both range endpoints and replayCutoff use Unix seconds. */
  visibleRange?: { from: number; to: number };
  replayCutoff?: number;
  dataState?: "current" | "stale" | "historical";
}
export interface SmartChartFinding {
  id: string;
  title: string;
  /** Related geometry variants share one summary slot; basic anatomy stays in details. */
  family?: string;
  summaryEligible?: boolean;
  explanation: string;
  status: "developing" | "confirmed" | "invalidated" | "observed";
  /** Actual observation/confirmation close times, Unix seconds. */
  confirmedAt?: number;
  asOf: number;
  anchors: { time: number; price: number; role: string }[];
  levels: { price: number; label: string }[];
  invalidation: string | null;
  caveat: string;
}
export interface SmartChartAnalysisResult {
  status: "ready" | "unavailable";
  reason: string | null;
  contextKey: string;
  asOf: number | null;
  closedBarsUsed: number;
  coverage: { available: number; analyzed: number; truncated: boolean; note: string | null };
  /** At most three summary chips; render geometry only for the focused finding. */
  findings: SmartChartFinding[];
  allFindings: SmartChartFinding[];
  catalogue?: { criteriaVersion:string; definedVariants:number; geometryFamilies:number; note:string };
}

const INTERVAL_SECONDS: Record<string, number> = {
  M1: 60, M2: 120, M3: 180, M4: 240, M5: 300, M6: 360, M10: 600,
  M12: 720, M15: 900, M20: 1200, M30: 1800, H1: 3600, H2: 7200,
  H3: 10800, H4: 14400, H6: 21600, H8: 28800, H12: 43200,
  D1: 86400, W1: 604800, MN1: 2592000,
};
/** Matches the existing normalized chart contract, including its 30-day MN1. */
export function smartChartIntervalSeconds(timeframe: string): number | null {
  return INTERVAL_SECONDS[timeframe] ?? null;
}
const MAX_ANALYSIS_BARS = 600;
const EVENT_LOOKBACK = 12;
const SHAPE_LOOKBACK = 24;
const finite = (n: number) => Number.isFinite(n);
const positive = (n: number) => finite(n) && n > 0;
const price = (n: number) => Number(n.toPrecision(7)).toString();
function contextKey(c: SmartChartAnalysisContext): string {
  return JSON.stringify([c.symbol, c.timeframe, c.source, c.sourceIdentity]);
}
function validContext(c: SmartChartAnalysisContext): boolean {
  return typeof c.symbol === "string" && c.symbol.trim().length > 0 && c.symbol.trim() === c.symbol
    && smartChartIntervalSeconds(c.timeframe) != null && typeof c.source === "string"
    && c.source.trim().length > 0 && c.source.trim() === c.source && c.source !== "unknown"
    && typeof c.sourceIdentity === "string" && /^[a-f0-9]{64}$/.test(c.sourceIdentity);
}
/** Bind actual response batches before mixing current bars and older pages.
 * The caller must retain the response's evidence, never stamp today's identity
 * onto old bars. Exact duplicate observations can overlap; conflicting ones cannot. */
export function bindSmartChartBars(
  context: SmartChartAnalysisContext,
  batches: readonly SmartChartAnalysisBatch[],
): SmartChartBoundBars {
  const unavailable = (reason: string): SmartChartBoundBars => ({ status: "unavailable", reason, bars: [] });
  if (!validContext(context)) return unavailable("The chart's original data source is not verified.");
  const key = contextKey(context);
  const byTime = new Map<number, SmartChartAnalysisBar>();
  for (const batch of batches) {
    if (!validContext(batch.evidence) || contextKey(batch.evidence) !== key)
      return unavailable("Chart history does not match this symbol, timeframe and original data source.");
    for (const bar of batch.bars) {
      if (!finite(bar.time)) return unavailable("A candle has an invalid observation time.");
      const previous = byTime.get(bar.time);
      if (previous && (previous.closeTime !== bar.closeTime || previous.open !== bar.open
        || previous.high !== bar.high || previous.low !== bar.low || previous.close !== bar.close
        || previous.isComplete !== bar.isComplete || previous.isFinal !== bar.isFinal || previous.isForming !== bar.isForming))
        return unavailable("Overlapping history disagrees about the same candle; analysis is withheld.");
      byTime.set(bar.time, { ...bar });
    }
  }
  return { status: "ready", reason: null, bars: [...byTime.values()].sort((a, b) => a.time - b.time) };
}

type Ranked = { finding: SmartChartFinding; observedAt: number; scale: number };
const statusRank = { confirmed: 3, invalidated: 2, developing: 1, observed: 0 };
function caveat(input: SmartChartAnalysisInput): string {
  const scope = input.replayCutoff != null ? "Replay: only candles known by this point are analyzed. "
    : input.visibleRange ? "Historical chart window; later candles are not used. "
    : input.dataState !== "current" && input.dataState !== "stale" ? "Historical candle analysis. " : "";
  const freshness = input.dataState === "stale" ? "The feed is stale; this describes stored candles. " : "";
  return scope + freshness + "A chart pattern describes price behavior; it does not predict the next move or authorize a trade. Volume confirmation and actual order flow were not measured.";
}
function validBar(bar: SmartChartAnalysisBar, interval: number): boolean {
  return finite(bar.time) && bar.time > 0 && finite(bar.closeTime)
    && Math.abs(bar.closeTime - bar.time - interval) < 0.001
    && [bar.open, bar.high, bar.low, bar.close].every(positive)
    && bar.high >= Math.max(bar.open, bar.close, bar.low)
    && bar.low <= Math.min(bar.open, bar.close, bar.high)
    && typeof bar.isComplete === "boolean" && typeof bar.isFinal === "boolean" && typeof bar.isForming === "boolean"
    && bar.isComplete === bar.isFinal && !(bar.isComplete && bar.isForming);
}

/** Pure automatic analysis. It observes the selected historical endpoint, never
 * later candles, and reports a bounded catalog without a confidence percentage. */
export function analyzeSmartChart(input: SmartChartAnalysisInput): SmartChartAnalysisResult {
  const key = contextKey(input);
  const unavailable = (reason: string): SmartChartAnalysisResult => ({ status: "unavailable", reason,
    contextKey: key, asOf: null, closedBarsUsed: 0, coverage: { available: 0, analyzed: 0, truncated: false, note: null }, findings: [], allFindings: [] });
  if (!validContext(input)) return unavailable("Analysis is waiting for this chart's original data-source evidence.");
  if (!finite(input.asOfMs) || input.asOfMs <= 0) return unavailable("The analysis observation time is unavailable.");
  const range = input.visibleRange;
  if (range && (!finite(range.from) || !finite(range.to) || range.from < 0 || range.from > range.to))
    return unavailable("The visible chart window is invalid.");
  if (input.replayCutoff != null && (!finite(input.replayCutoff) || input.replayCutoff <= 0 || input.replayCutoff > input.asOfMs / 1000))
    return unavailable("The replay observation boundary is invalid.");
  const observation = input.asOfMs / 1000;
  // Range selects bar OPEN times. Replay selects when complete bars were known.
  const cutoff = Math.min(observation, input.replayCutoff ?? Infinity);
  const interval = smartChartIntervalSeconds(input.timeframe)!;
  const selected: SmartChartAnalysisBar[] = [];
  let prior = -Infinity;
  for (const bar of input.bars) {
    if (!finite(bar.time)) return unavailable("A candle has an invalid observation time.");
    if (input.replayCutoff == null && (!range || bar.time <= range.to)
      && bar.isComplete === true && finite(bar.closeTime) && bar.closeTime > observation)
      return unavailable("A future candle close cannot be confirmed.");
    if (bar.time >= cutoff || (range && bar.time > range.to)) continue;
    if (bar.time <= prior) return unavailable("Candles are not in a unique chronological sequence.");
    prior = bar.time;
    if (!validBar(bar, interval)) return unavailable("Candle prices, timeframe or completion evidence disagree.");
    if (bar.isComplete && bar.closeTime > observation) return unavailable("A future candle close cannot be confirmed.");
    if (!bar.isComplete || bar.isForming || bar.closeTime > cutoff || (range && bar.time < range.from)) continue;
    selected.push(bar);
  }
  if (selected.length === 0) return unavailable("No confirmed closed candles are available in this chart window.");
  const bars = selected.slice(-MAX_ANALYSIS_BARS);
  const last = bars[bars.length - 1]!;
  const note = caveat(input);
  const rows = new Map<string, Ranked>();
  const add = (finding: SmartChartFinding, observedAt: number, scale: number) => {
    if (!finding.anchors.every(a => positive(a.price) && finite(a.time)) || !finding.levels.every(l => positive(l.price))) return;
    const prev = rows.get(finding.id);
    if (!prev || finding.asOf >= prev.finding.asOf) rows.set(finding.id, { finding, observedAt, scale });
  };
  // The shared API detector is reused unchanged. H&S is checked at causal
  // prefixes so a later swing cannot move its first knowable confirmation back.
  for (let end = Math.max(20, bars.length - SHAPE_LOOKBACK + 1); end <= bars.length; end++) {
    const prefix = bars.slice(0, end);
    for (const raw of detectChartPatterns(prefix).patterns) {
      if (raw.id === "head_and_shoulders" || raw.id === "inverse_head_and_shoulders") {
        const finding = headAndShoulders(raw, bars, note);
        if (finding) add(finding, Math.max(...finding.anchors.map(a => a.time)), 3);
      } else if (end === bars.length && !["bullish_engulfing", "bearish_engulfing"].includes(raw.id)) {
        const finding = catalogFinding(raw, bars, note);
        if (finding) add(finding, Math.max(...finding.anchors.map(a => a.time)), 2);
      }
    }
  }
  for (let end = Math.max(1, bars.length - EVENT_LOOKBACK + 1); end <= bars.length; end++) {
    const prefix = bars.slice(Math.max(0, end - 60), end);
    const candle = prefix[prefix.length - 1]!;
    const body = Math.abs(candle.close - candle.open), span = candle.high - candle.low;
    // Explicit geometric convention, not a reliability probability.
    if (isObservedDoji(candle)) {
      add({ id: `doji:${candle.time}`, title: "Doji", status: "observed", asOf: candle.closeTime,
        explanation: `Open ${price(candle.open)} and close ${price(candle.close)} are nearly equal: the body is ${price(body / span * 100)}% of the candle's range. Neither side kept much ground; this does not establish a direction.`,
        anchors: [{ time: candle.time, price: candle.close, role: "doji" }], levels: [], invalidation: null,
        caveat: `${note} Doji convention: body at most 10% of a nonzero high-low range.` }, candle.time, 0);
    }
    const feed = { candles: prefix, feedConfirmed: input.dataState === "current", feedStale: input.dataState === "stale" };
    const engulfing = detectEngulfing(feed);
    if (engulfing.detected) {
      const bullish = engulfing.direction === "buy", previous = prefix[prefix.length - 2]!;
      const invalidation = bullish ? candle.low : candle.high;
      const later = bars.slice(end);
      const failed = later.some(b => bullish ? b.close < invalidation : b.close > invalidation);
      add({ id: `${engulfing.id}:${candle.time}`, title: engulfing.name, status: failed ? "invalidated" : "confirmed",
        confirmedAt: candle.closeTime, asOf: failed ? last.closeTime : candle.closeTime,
        explanation: `The ${bullish ? "up" : "down"} candle's body (${price(body)}) fully covers the previous ${bullish ? "down" : "up"} body (${price(Math.abs(previous.close - previous.open))}) after a ${bullish ? "decline" : "rise"}. The closed two-candle shape is confirmed; a market reversal is not.${failed ? ` A later close crossed ${price(invalidation)} against it.` : ""}`,
        anchors: [{ time: previous.time, price: previous.close, role: "previous_body" }, { time: candle.time, price: candle.close, role: "engulfing" }],
        levels: [{ price: invalidation, label: "Pattern invalidation" }], invalidation: `A close ${bullish ? "below" : "above"} ${price(invalidation)} invalidates this reversal idea.`, caveat: note }, candle.time, 1);
    }
    const star = resolveShootingStarTruth(feed);
    if (star.detected && star.confirmationLevel != null && star.invalidationLevel != null) {
      const index = prefix.findLastIndex(b => b.low === star.confirmationLevel && b.high === star.invalidationLevel);
      const at = prefix[index];
      if (at) {
        const absoluteIndex = end - prefix.length + index;
        const next = bars[absoluteIndex + 1];
        const failed = bars.slice(absoluteIndex + 1).some(b => b.close > at.high);
        const confirmed = next != null && next.close < at.low;
        const status = failed ? "invalidated" : confirmed ? "confirmed" : next ? "observed" : "developing";
        add({ id: `shooting_star:${at.time}`, title: "Shooting Star", status,
          ...(confirmed ? { confirmedAt: next.closeTime } : {}), asOf: failed ? last.closeTime : next?.closeTime ?? at.closeTime,
          explanation: `After an advance, the upper wick reaches ${price(at.high)} while the body stays near the low ${price(at.low)}. ${failed ? "A later close above the high invalidated the rejection." : confirmed ? `The next candle closed at ${price(next.close)}, below ${price(at.low)}, confirming the rejection.` : next ? "The next close did not confirm the rejection." : `The next candle must close below ${price(at.low)} to confirm this rejection.`}`,
          anchors: [{ time: at.time, price: at.high, role: "shooting_star" }], levels: [{ price: at.low, label: "Confirmation below" }, { price: at.high, label: "Invalidation above" }],
          invalidation: `A close above ${price(at.high)} invalidates the rejection.`, caveat: note }, at.time, 1);
      }
    }
  }
  // Existing structure math uses the entire prior fitting window, so use a
  // fixed recent 30-bar scope and expose that scope rather than implying a line
  // was fitted to the whole loaded history.
  const structureBars = bars.slice(-30);
  const structure = resolveStructureBreakTruth({ candles: structureBars, feedConfirmed: false, feedStale: input.dataState === "stale" });
  if (structure.type === "trendline_break" && structure.level != null && positive(structure.level)) {
    const confirmed = structure.brokeOnClose && structure.status === "confirmed";
    add({ id: `trendline_break:${last.time}`, title: confirmed ? "Trendline break" : "Unconfirmed trendline test", status: confirmed ? "confirmed" : "observed",
      ...(confirmed ? { confirmedAt: last.closeTime } : {}), asOf: last.closeTime,
      explanation: confirmed ? `The latest candle closed at ${price(last.close)}, ${last.close > structure.level ? "above" : "below"} the fitted boundary at ${price(structure.level)}. The fit uses ${structureBars.length - 1} prior candles; this is a close beyond that line, not a guarantee of continuation.` : `A wick crossed the fitted boundary at ${price(structure.level)}, but the close at ${price(last.close)} did not confirm a break.`,
      anchors: [{ time: last.time, price: last.close, role: "break_observation" }], levels: [{ price: structure.level, label: "Fitted boundary" }],
      invalidation: confirmed ? `A close back ${last.close > structure.level ? "below" : "above"} ${price(structure.level)} would lose this break.` : null, caveat: note }, last.time, 2);
  }
  const catalogue = scanCandlestickCatalogue(bars, { asOf: last.closeTime, intervalSeconds: interval, eventLookback: EVENT_LOOKBACK });
  for (const observed of catalogue.observations) {
    const def=observed.definition;
    // Standard Doji retains the established core wording. Basic anatomy is
    // useful in details for the latest bar, not repeated as historical signals.
    if(def.id==="doji"||(!def.summaryEligible&&observed.endIndex!==bars.length-1))continue;
    const event=bars[observed.endIndex]!;
    add({id:`${def.id}:${event.time}`,title:def.name,family:def.family,summaryEligible:def.summaryEligible,
      status:"observed",asOf:observed.observedAt,
      explanation:observed.explanation,
      anchors:bars.slice(observed.startIndex,observed.endIndex+1).map((bar,i)=>({time:bar.time,price:bar.close,role:i===observed.endIndex-observed.startIndex?def.id:"pattern_start"})),
      levels:observed.referenceLevel==null?[]:[{price:observed.referenceLevel,label:"Observed reference"}],
      invalidation:null,caveat:`${note} Criteria (${CANDLE_CRITERIA_VERSION}): ${def.criteria} This is a completed shape, not confirmed future movement.`
    },event.time,def.summaryEligible?1:-1);
  }
  const ranked = [...rows.values()].sort((a, b) => b.observedAt - a.observedAt
    || statusRank[b.finding.status] - statusRank[a.finding.status] || b.scale - a.scale || a.finding.id.localeCompare(b.finding.id));
  const allFindings = ranked.map(r => r.finding);
  const summaryFamilies = new Set<string>();
  const findings = allFindings.filter(f => {
    if(f.summaryEligible===false)return false;
    const family = f.family ?? f.id.split(":")[0]!;
    if (summaryFamilies.has(family)) return false;
    summaryFamilies.add(family);
    return true;
  }).slice(0, 3);
  return { status: "ready", reason: allFindings.length ? null : "No supported pattern is confirmed in this window.", contextKey: key,
    asOf: last.closeTime, closedBarsUsed: bars.length,
    coverage: { available: selected.length, analyzed: bars.length, truncated: selected.length > bars.length,
      note: selected.length > bars.length ? `Analyzing the latest ${bars.length} of ${selected.length} closed candles in view; earlier pattern context is outside this window.` : null },
    findings, allFindings,
    catalogue: {criteriaVersion:CANDLE_CRITERIA_VERSION,definedVariants:CANDLE_DEFINITIONS.length,
      geometryFamilies:new Set(CANDLE_DEFINITIONS.map(d=>d.family)).size,
      note:"Explicit ARX candle-shape conventions; related variants are not independent confirmations. The complete owner catalogue remains in progress."} };
}

function headAndShoulders(raw: DetectedPattern, bars: SmartChartAnalysisBar[], note: string): SmartChartFinding | null {
  const inverse = raw.id === "inverse_head_and_shoulders";
  const left = raw.keyPoints.find(p => p.role === "left_shoulder"), head = raw.keyPoints.find(p => p.role === "head"), right = raw.keyPoints.find(p => p.role === "right_shoulder");
  if (!left || !head || !right || left.index < 5 || !(left.index < head.index && head.index < right.index) || right.index + 2 >= bars.length) return null;
  const before = bars.slice(left.index - 5, left.index + 1);
  const priorTrend = inverse ? before[before.length - 1]!.close < before[0]!.close : before[before.length - 1]!.close > before[0]!.close;
  const alignedSteps = before.slice(1).filter((b, i) => inverse ? b.close < before[i]!.close : b.close > before[i]!.close).length;
  if (!priorTrend || alignedSteps < 3) return null;
  const leftPrice = inverse ? bars[left.index]!.low : bars[left.index]!.high;
  const headPrice = inverse ? bars[head.index]!.low : bars[head.index]!.high;
  const rightPrice = inverse ? bars[right.index]!.low : bars[right.index]!.high;
  // Require one real intervening opposite pivot on EACH side of the head.
  // The legacy catalog allowed one shared trough and a horizontal mean; the
  // displayed neckline instead joins the two observed pivot prices.
  const swings = findSwings(bars, 2).filter(s => s.kind === (inverse ? "high" : "low"));
  const first = swings.filter(s => s.index > left.index && s.index < head.index).at(-1);
  const second = swings.find(s => s.index > head.index && s.index < right.index);
  if (!first || !second) return null;
  const neckline = (i: number) => first.price + (second.price - first.price) * (i - first.index) / (second.index - first.index);
  let confirmedAt: number | undefined, invalidated = false;
  for (let i = right.index + 2; i < bars.length; i++) {
    const close = bars[i]!.close, line = neckline(i);
    if (inverse ? close < headPrice : close > headPrice) { invalidated = true; break; }
    const beyond = inverse ? close > line : close < line;
    if (confirmedAt != null && !beyond) { invalidated = true; break; }
    if (confirmedAt == null && beyond) confirmedAt = bars[i]!.closeTime;
  }
  const last = bars[bars.length - 1]!, line = neckline(bars.length - 1);
  if (!positive(line)) return null;
  const status = invalidated ? "invalidated" : confirmedAt != null ? "confirmed" : "developing";
  return { id: `${raw.id}:${bars[left.index]!.time}:${bars[head.index]!.time}:${bars[right.index]!.time}`, title: raw.name, status,
    ...(confirmedAt != null ? { confirmedAt } : {}), asOf: last.closeTime,
    explanation: `Two ${inverse ? "higher lows" : "lower peaks"} surround a ${inverse ? "lower" : "higher"} head at ${price(headPrice)}. The neckline joins ${price(first.price)} and ${price(second.price)} and is now near ${price(line)}. ${invalidated ? "A later close broke the reversal's conditions." : confirmedAt != null ? `A candle closed ${inverse ? "above" : "below"} that line after the right shoulder was observable.` : `A close ${inverse ? "above" : "below"} the neckline is still needed; the shape is developing.`}`,
    anchors: [
      { time: bars[left.index]!.time, price: leftPrice, role: "left_shoulder" },
      { time: bars[first.index]!.time, price: first.price, role: "neckline_left" },
      { time: bars[head.index]!.time, price: headPrice, role: "head" },
      { time: bars[second.index]!.time, price: second.price, role: "neckline_right" },
      { time: bars[right.index]!.time, price: rightPrice, role: "right_shoulder" },
    ], levels: [{ price: line, label: "Projected neckline" }, { price: headPrice, label: "Head invalidation" }],
    invalidation: `A close ${inverse ? "below" : "above"} the head at ${price(headPrice)}, or back through the neckline after confirmation, invalidates this reading.`, caveat: note };
}

function catalogFinding(raw: DetectedPattern, bars: SmartChartAnalysisBar[], note: string): SmartChartFinding | null {
  const points = raw.keyPoints.filter(p => Number.isInteger(p.index) && p.index >= 0 && p.index < bars.length && positive(p.price));
  if (points.length === 0 || points.length !== raw.keyPoints.length) return null;
  const status: SmartChartFinding["status"] = raw.status === "confirmed" ? "confirmed" : raw.status === "invalidated" || raw.status === "failed" ? "invalidated" : raw.status === "forming" ? "developing" : "observed";
  const last = bars[bars.length - 1]!;
  const levels = [{ price: raw.levels.confirmation, label: "Confirmation level" }, { price: raw.levels.invalidation, label: "Invalidation level" }].filter((v): v is { price: number; label: string } => v.price != null && positive(v.price));
  return { id: `${raw.id}:${points.map(p => bars[p.index]!.time).join(":")}`, title: raw.name, status,
    // Legacy catalog does not expose earliest causal confirmation; report this
    // observation time, never backdate a discovery to a swing's own bar.
    ...(status === "confirmed" ? { confirmedAt: last.closeTime } : {}), asOf: last.closeTime,
    explanation: `${(raw.rationale[0] ?? "Observed price geometry.").replace(" (stop run)", "")}${levels[0] ? ` The measured ${levels[0].label.toLowerCase()} is ${price(levels[0].price)}.` : ""} ${status === "developing" ? "The shape is still developing." : status === "invalidated" ? "Its confirmation conditions no longer hold." : "This describes the observed shape, not its future outcome."}`,
    anchors: points.map(p => ({ time: bars[p.index]!.time, price: p.price, role: p.role })), levels,
    invalidation: raw.failureModes[0] ?? null, caveat: note };
}
