// Live Trade Health & Management — PURE BUILDERS (Task #198).
//
// All functions here are pure & deterministic (no IO, DB, HTTP, Date.now, or
// randomness — callers pass `nowMs`/ages in). They convert a real open position
// + the original Ruby signal + the live broker price into a health state, TP
// progress, SL distance, and break-even / partial / conflict / correlation /
// overtrading GUIDANCE. Nothing here closes, modifies, or places a trade.
//
// HONESTY: when an input is missing the output degrades honestly — `unknown`
// progress, a NOT_AVAILABLE check, or a "based on floating P/L only" note —
// never a fabricated value. No internal enum token (UPPER_SNAKE) is ever placed
// in a user-facing string.

import type { HandshakeOverallStatus } from "../handshake/handshake.types";
import type { SmartChartLayer, SmartChartSeverity } from "../smart-chart/smartChart.types";
import type {
  BreakEvenSuggestion,
  ConflictWarning,
  CorrelationWarning,
  OpenPositionInput,
  OriginalSignalInput,
  OvertradingInput,
  OvertradingWarning,
  PartialCloseSuggestion,
  SetupAlternative,
  SlDistance,
  TradeHealthAssessment,
  TradeHealthCheck,
  TradeHealthHandshake,
  TradeHealthReport,
  TradeHealthState,
  TradeStyle,
  TradeStyleMatch,
  TpProgress,
} from "./tradeHealth.types";

// ── Small numeric helpers ────────────────────────────────────────────────────

function isFiniteNum(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function clampPct(n: number): number {
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

// Freshness ladders (advisory; distinct from the authoritative 15s dispatch
// heartbeat gate). A position read older than these is treated as less trusted.
const PRICE_FRESH_MS = 90 * 1000; // ≤ 90s → fresh
const PRICE_STALE_MS = 5 * 60 * 1000; // > 5 min → stale

// ── TP progress ──────────────────────────────────────────────────────────────

/**
 * Progress (0..100) from entry toward take-profit, measured at the live price.
 * Honest: returns `known:false` (and an explanatory note) when entry, TP, or the
 * live price is missing, or when TP is not on the profitable side of entry.
 */
export function computeTpProgress(p: OpenPositionInput): TpProgress {
  if (!isFiniteNum(p.takeProfit)) {
    return { known: false, progressPct: null, note: "No take-profit is set on this position." };
  }
  if (!isFiniteNum(p.entryPrice) || !isFiniteNum(p.currentPrice)) {
    return {
      known: false,
      progressPct: null,
      note: "Waiting for a live price before progress to target can be measured.",
    };
  }
  const span = p.side === "BUY" ? p.takeProfit - p.entryPrice : p.entryPrice - p.takeProfit;
  if (!(span > 0)) {
    return {
      known: false,
      progressPct: null,
      note: "The take-profit is not on the profitable side of entry, so progress can't be measured.",
    };
  }
  const moved = p.side === "BUY" ? p.currentPrice - p.entryPrice : p.entryPrice - p.currentPrice;
  const pct = clampPct((moved / span) * 100);
  const note =
    pct >= 100
      ? "Price has reached the take-profit target."
      : pct <= 0
        ? "Price has not moved toward the target yet."
        : `Price is about ${pct}% of the way to the take-profit target.`;
  return { known: true, progressPct: pct, note };
}

// ── SL distance / risk-buffer consumed ───────────────────────────────────────

/**
 * How much of the entry→stop buffer is still intact, plus the raw price
 * distance to the stop. Honest: `known:false` when the stop or live price is
 * missing, or when the stop is not on the protective side of entry.
 */
export function computeSlDistance(p: OpenPositionInput): SlDistance {
  if (!isFiniteNum(p.stopLoss)) {
    return {
      known: false,
      distancePrice: null,
      bufferRemainingPct: null,
      note: "No stop-loss is set on this position — its downside is uncapped.",
    };
  }
  if (!isFiniteNum(p.currentPrice)) {
    return {
      known: false,
      distancePrice: null,
      bufferRemainingPct: null,
      note: "Waiting for a live price before the distance to the stop can be measured.",
    };
  }
  const distancePrice = Math.abs(p.currentPrice - p.stopLoss);
  let bufferRemainingPct: number | null = null;
  if (isFiniteNum(p.entryPrice)) {
    const buffer = p.side === "BUY" ? p.entryPrice - p.stopLoss : p.stopLoss - p.entryPrice;
    if (buffer > 0) {
      const remaining = p.side === "BUY" ? p.currentPrice - p.stopLoss : p.stopLoss - p.currentPrice;
      bufferRemainingPct = clampPct((remaining / buffer) * 100);
    }
  }
  const note =
    bufferRemainingPct == null
      ? "Distance to the stop is shown; the stop sits beyond entry so a buffer percentage isn't meaningful."
      : bufferRemainingPct <= 0
        ? "Price is at or beyond the stop level."
        : `About ${bufferRemainingPct}% of the room to the stop is still intact.`;
  return { known: true, distancePrice, bufferRemainingPct, note };
}

/**
 * Internal: fraction (0..1+) of the entry→stop buffer ALREADY consumed against
 * the trade. Returns null when entry/stop/price are not usable. Used by the
 * classifier; the user-facing buffer-remaining lives in computeSlDistance.
 */
function riskBufferConsumed(p: OpenPositionInput): number | null {
  if (!isFiniteNum(p.entryPrice) || !isFiniteNum(p.stopLoss) || !isFiniteNum(p.currentPrice)) {
    return null;
  }
  const buffer = p.side === "BUY" ? p.entryPrice - p.stopLoss : p.stopLoss - p.entryPrice;
  if (!(buffer > 0)) return null;
  const consumed = p.side === "BUY" ? p.entryPrice - p.currentPrice : p.currentPrice - p.entryPrice;
  return consumed / buffer;
}

// ── Invalidation ─────────────────────────────────────────────────────────────

/**
 * True when the live price has broken the original thesis's structural
 * invalidation (only meaningful when the signal direction matches the position
 * side and an invalidation price + live price exist).
 */
function thesisInvalidated(p: OpenPositionInput, signal: OriginalSignalInput | null): boolean {
  if (!signal || !isFiniteNum(signal.invalidationPrice) || !isFiniteNum(p.currentPrice)) {
    return false;
  }
  if (signal.direction && signal.direction !== p.side) return false;
  return p.side === "BUY"
    ? p.currentPrice < signal.invalidationPrice
    : p.currentPrice > signal.invalidationPrice;
}

// ── Health classification ────────────────────────────────────────────────────

/**
 * Classify an open position into healthy / weakening / danger / invalidated from
 * the live price, the stop buffer consumed, the original thesis invalidation,
 * and (as a fallback when no stop is set) the floating P/L sign. Deterministic
 * and honest — when nothing can be read the state is the most cautious supported
 * by evidence, with a plain reason saying so.
 */
export function classifyTradeHealth(
  p: OpenPositionInput,
  signal: OriginalSignalInput | null,
): { state: TradeHealthState; headline: string; reasons: string[] } {
  const reasons: string[] = [];

  if (thesisInvalidated(p, signal)) {
    reasons.push(
      "Price has broken the level the original idea relied on, so the reason for the trade no longer holds.",
    );
    return {
      state: "invalidated",
      headline: "The original idea behind this trade has been invalidated.",
      reasons,
    };
  }

  const consumed = riskBufferConsumed(p);
  if (consumed != null) {
    if (consumed >= 1) {
      reasons.push("Price has reached the stop level — the protective buffer is used up.");
      return { state: "danger", headline: "This trade is at its stop level.", reasons };
    }
    if (consumed >= 0.66) {
      reasons.push("Most of the room to the stop has been given back.");
      return { state: "danger", headline: "This trade is under pressure near its stop.", reasons };
    }
    if (consumed >= 0.33) {
      reasons.push("Price has moved against the trade and eaten into the stop buffer.");
      return { state: "weakening", headline: "This trade is weakening.", reasons };
    }
    reasons.push("Price is holding with most of the stop buffer intact.");
    return { state: "healthy", headline: "This trade is healthy.", reasons };
  }

  // No usable stop buffer — fall back to floating P/L sign, said honestly.
  if (!isFiniteNum(p.stopLoss)) {
    reasons.push("No stop-loss is set, so health is based on floating profit/loss only.");
  } else {
    reasons.push("A live price isn't available yet, so health is based on floating profit/loss only.");
  }
  if (isFiniteNum(p.floatingPnl)) {
    if (p.floatingPnl < 0) {
      return { state: "weakening", headline: "This trade is underwater.", reasons };
    }
    return { state: "healthy", headline: "This trade is in profit.", reasons };
  }
  reasons.push("No floating profit/loss is available either, so the read is limited.");
  return { state: "weakening", headline: "Trade health can't be confirmed yet.", reasons };
}

// ── Break-even + partial guidance ────────────────────────────────────────────

const BREAK_EVEN_PROGRESS_PCT = 50; // lock to break-even once halfway to target
const PARTIAL_PROGRESS_PCT = 60; // bank partial profit past this progress

function inProfit(p: OpenPositionInput): boolean {
  if (isFiniteNum(p.floatingPnl)) return p.floatingPnl > 0;
  if (isFiniteNum(p.entryPrice) && isFiniteNum(p.currentPrice)) {
    return p.side === "BUY" ? p.currentPrice > p.entryPrice : p.currentPrice < p.entryPrice;
  }
  return false;
}

/**
 * Suggest moving the stop to entry ONLY when the trade is genuinely in profit
 * and has made real progress toward target. Guidance only — never auto-executed.
 */
export function deriveBreakEvenSuggestion(
  p: OpenPositionInput,
  tp: TpProgress,
): BreakEvenSuggestion {
  const profit = inProfit(p);
  const progressed = tp.known && (tp.progressPct ?? 0) >= BREAK_EVEN_PROGRESS_PCT;
  if (profit && progressed) {
    return {
      suggested: true,
      note: "You could move the stop to your entry to make this trade risk-free — this is guidance only, nothing is changed for you.",
    };
  }
  if (!profit) {
    return { suggested: false, note: "Moving to break-even isn't useful yet — the trade isn't in profit." };
  }
  return {
    suggested: false,
    note: "Let the trade develop further before moving to break-even.",
  };
}

/**
 * Suggest banking partial profit ONLY when the trade is in profit and well
 * advanced toward target, OR when it is in profit but now under pressure.
 * Guidance only — never auto-executed.
 */
export function derivePartialCloseSuggestion(
  p: OpenPositionInput,
  tp: TpProgress,
  state: TradeHealthState,
): PartialCloseSuggestion {
  const profit = inProfit(p);
  if (profit && tp.known && (tp.progressPct ?? 0) >= PARTIAL_PROGRESS_PCT) {
    return {
      suggested: true,
      note: "You're well into the move — taking partial profit here would lock in gains while leaving some on. Guidance only.",
    };
  }
  if (profit && (state === "weakening" || state === "danger")) {
    return {
      suggested: true,
      note: "The trade is in profit but losing momentum — consider banking part of it. Guidance only.",
    };
  }
  return { suggested: false, note: "No partial-close is called for right now." };
}

// ── Trade-style matching ─────────────────────────────────────────────────────

const SCALP_MAX_MS = 60 * 60 * 1000; // < 1h → scalp
const INTRADAY_MAX_MS = 24 * 60 * 60 * 1000; // < 24h → intraday

function holdingStyle(holdMs: number): TradeStyle {
  if (holdMs < SCALP_MAX_MS) return "scalp";
  if (holdMs < INTRADAY_MAX_MS) return "intraday";
  return "swing";
}

function styleLabel(style: TradeStyle): string {
  switch (style) {
    case "scalp":
      return "a scalp";
    case "intraday":
      return "an intraday trade";
    case "swing":
      return "a swing trade";
    case "unknown":
    default:
      return "an unknown style";
  }
}

/**
 * Detect the trade style from how long the position has been held. Honest:
 * `unknown` when the open time isn't known. Pure (caller passes nowMs).
 */
export function matchTradeStyle(p: OpenPositionInput, nowMs: number): TradeStyleMatch {
  if (!isFiniteNum(p.openedAtMs)) {
    return { detectedStyle: "unknown", note: "The open time isn't known, so a trade style can't be matched yet." };
  }
  const holdMs = Math.max(0, nowMs - p.openedAtMs);
  const style = holdingStyle(holdMs);
  const hours = holdMs / (60 * 60 * 1000);
  const heldText =
    hours < 1 ? `${Math.round(holdMs / (60 * 1000))} min` : `${hours.toFixed(1)} h`;
  return {
    detectedStyle: style,
    note: `Open about ${heldText}, which matches ${styleLabel(style)}.`,
  };
}

// ── Setup alternatives (from the original signal) ─────────────────────────────

function bandMid(b: { from: number; to: number } | null): number | null {
  if (!b || !isFiniteNum(b.from) || !isFiniteNum(b.to)) return null;
  return (b.from + b.to) / 2;
}

/**
 * Surface aggressive / better / safest entry alternatives from the original Ruby
 * signal's zones. Each is emitted ONLY when its zone is real — a missing zone
 * yields fewer alternatives, never a fabricated price. Returns [] when there is
 * no signal.
 */
export function buildSetupAlternatives(signal: OriginalSignalInput | null): SetupAlternative[] {
  if (!signal) return [];
  const out: SetupAlternative[] = [];
  const aggressive = bandMid(signal.entryZone);
  if (aggressive != null) {
    out.push({
      kind: "aggressive",
      label: "Aggressive — enter now",
      price: aggressive,
      note: "Takes the trade at the live zone — best reward but the lowest-confidence entry.",
    });
  }
  const better = bandMid(signal.retestZone);
  if (better != null) {
    out.push({
      kind: "better",
      label: "Better — wait for the retest",
      price: better,
      note: "Waits for price to come back to the level for a stronger entry.",
    });
  }
  const safest = bandMid(signal.watchZone);
  if (safest != null) {
    out.push({
      kind: "safest",
      label: "Safest — deeper level",
      price: safest,
      note: "Only engages at the deeper level — fewest trades, highest confidence.",
    });
  }
  return out;
}

// ── Conflict detection (across the user's open positions) ─────────────────────

const OVER_EXPOSURE_COUNT = 3; // 3+ positions on one symbol → concentration

/**
 * Detect opposite (hedged), duplicate (stacked same-side), and over-exposure
 * (concentration) conflicts across a user's own open positions. Pure.
 */
export function detectConflicts(positions: readonly OpenPositionInput[]): ConflictWarning[] {
  const bySymbol = new Map<string, OpenPositionInput[]>();
  for (const p of positions) {
    const key = normalizeSymbol(p.symbol);
    const arr = bySymbol.get(key) ?? [];
    arr.push(p);
    bySymbol.set(key, arr);
  }
  const out: ConflictWarning[] = [];
  for (const [symbol, arr] of bySymbol) {
    if (arr.length < 2) continue;
    const buys = arr.filter((p) => p.side === "BUY");
    const sells = arr.filter((p) => p.side === "SELL");
    if (buys.length > 0 && sells.length > 0) {
      out.push({
        kind: "opposite",
        symbol,
        tickets: arr.map((p) => p.ticket),
        note: `You hold both a buy and a sell on ${symbol} — the two work against each other and mostly cancel out (minus costs).`,
      });
    } else if (arr.length >= 2) {
      out.push({
        kind: "duplicate",
        symbol,
        tickets: arr.map((p) => p.ticket),
        note: `You hold ${arr.length} positions the same way on ${symbol} — that stacks your risk on a single idea.`,
      });
    }
    if (arr.length >= OVER_EXPOSURE_COUNT) {
      out.push({
        kind: "over_exposure",
        symbol,
        tickets: arr.map((p) => p.ticket),
        note: `${arr.length} open positions on ${symbol} is heavy concentration — a single move hits all of them at once.`,
      });
    }
  }
  return out;
}

// ── Correlation / portfolio risk ─────────────────────────────────────────────

/** Extract the two 3-letter currency legs from a forex pair symbol, else null. */
function forexLegs(symbol: string): [string, string] | null {
  const s = normalizeSymbol(symbol).replace(/[^A-Z]/g, "");
  if (s.length !== 6) return null;
  return [s.slice(0, 3), s.slice(3, 6)];
}

// Well-established, static market relationships (deterministic domain knowledge,
// NOT fabricated market data): safe-haven legs strengthen when risk sentiment
// sours; higher-beta "risk" currencies strengthen when sentiment improves.
const SAFE_HAVEN_LEGS = new Set(["JPY", "CHF", "USD", "XAU", "XAG"]);
const RISK_LEGS = new Set(["AUD", "NZD", "CAD"]);

type RiskPosture = "risk_on" | "risk_off";

/**
 * Net risk posture of an open position from well-known FX relationships, honest
 * about ambiguity. Going long a pair is long the base / short the quote. A
 * safe-haven leg scores -1, a higher-beta risk leg +1, everything else 0. A
 * net-positive pair profits when sentiment improves (risk-on when long); a
 * net-negative pair when it sours. Returns null for non-FX, unknown, or
 * net-neutral (e.g. two havens) symbols — those carry no clear posture, so they
 * are never clustered. Pure.
 */
function riskPosture(p: OpenPositionInput): RiskPosture | null {
  const legs = forexLegs(p.symbol);
  if (!legs) return null;
  const legScore = (leg: string): number =>
    SAFE_HAVEN_LEGS.has(leg) ? -1 : RISK_LEGS.has(leg) ? 1 : 0;
  const pairScore = legScore(legs[0]) - legScore(legs[1]);
  if (pairScore === 0) return null;
  const longIsRiskOn = pairScore > 0;
  const riskOn = p.side === "BUY" ? longIsRiskOn : !longIsRiskOn;
  return riskOn ? "risk_on" : "risk_off";
}

/**
 * Detect correlated exposure across the user's own open positions:
 *  - currency_cluster: two or more forex positions that share a currency leg
 *    (e.g. EURUSD + GBPUSD both carry USD) move together.
 *  - risk_cluster: two or more positions that profit in the SAME market mood
 *    (all risk-on, or all risk-off) — connected risk even when they share no
 *    currency leg (e.g. long AUDUSD + long NZDJPY). Pure.
 */
export function detectCorrelation(positions: readonly OpenPositionInput[]): CorrelationWarning[] {
  const out: CorrelationWarning[] = [];

  const byCurrency = new Map<string, Set<string>>();
  for (const p of positions) {
    const legs = forexLegs(p.symbol);
    if (!legs) continue;
    for (const leg of legs) {
      const set = byCurrency.get(leg) ?? new Set<string>();
      set.add(normalizeSymbol(p.symbol));
      byCurrency.set(leg, set);
    }
  }
  for (const [driver, symbolsSet] of byCurrency) {
    if (symbolsSet.size < 2) continue;
    const symbols = [...symbolsSet].sort();
    out.push({
      kind: "currency_cluster",
      driver,
      symbols,
      note: `${symbols.join(", ")} all move with ${driver} — they're correlated, so your real exposure to ${driver} is bigger than any one trade.`,
    });
  }

  const byPosture = new Map<RiskPosture, Set<string>>();
  for (const p of positions) {
    const posture = riskPosture(p);
    if (!posture) continue;
    const set = byPosture.get(posture) ?? new Set<string>();
    set.add(normalizeSymbol(p.symbol));
    byPosture.set(posture, set);
  }
  for (const [posture, symbolsSet] of byPosture) {
    if (symbolsSet.size < 2) continue;
    const symbols = [...symbolsSet].sort();
    const mood = posture === "risk_on" ? "risk-on" : "risk-off";
    out.push({
      kind: "risk_cluster",
      driver: `${mood} sentiment`,
      symbols,
      note: `${symbols.join(", ")} all profit in the same ${mood} mood — they tend to rise and fall together, so a single shift in sentiment moves them all at once.`,
    });
  }

  return out;
}

// ── Overtrading / behavior protection ────────────────────────────────────────

const RAPID_REENTRY_COUNT = 5; // 5+ trades in the window → rapid re-entry
const REVENGE_LOT_MULTIPLE = 1.5; // 1.5x baseline after a loss → revenge sizing

/**
 * Surface behavior-protection warnings from REAL history the caller supplies.
 * Each warning fires only when its inputs are present and cross the threshold —
 * a null input emits no warning (honest; never fabricated). Guidance only; this
 * never hard-blocks a trade. Pure.
 */
export function detectOvertrading(input: OvertradingInput): OvertradingWarning[] {
  const out: OvertradingWarning[] = [];
  if (
    isFiniteNum(input.recentTradeCount) &&
    isFiniteNum(input.windowMinutes) &&
    input.recentTradeCount >= RAPID_REENTRY_COUNT
  ) {
    out.push({
      kind: "rapid_reentry",
      note: `You've opened ${input.recentTradeCount} trades in about ${input.windowMinutes} min — that pace often means chasing rather than waiting for setups.`,
    });
  }
  if (input.recentLosses === true && isFiniteNum(input.lotVsBaseline) && input.lotVsBaseline >= REVENGE_LOT_MULTIPLE) {
    out.push({
      kind: "revenge_sizing",
      note: "Your size is well above your usual right after a loss — sizing up to win it back is how small losses become big ones.",
    });
  }
  if (input.tradingThroughNews === true) {
    out.push({
      kind: "news_trading",
      note: "A high-impact news window is open on one of your symbols — spreads and slippage spike, so treat new entries with extra caution.",
    });
  }
  return out;
}

// ── Live Trade Health Handshake (per position) ───────────────────────────────

function rollUpHandshake(checks: readonly TradeHealthCheck[]): HandshakeOverallStatus {
  const fundamentalFail = checks.some(
    (c) => (c.key === "positionInSync" || c.key === "currentPriceFresh") && c.status === "FAIL",
  );
  if (fundamentalFail) return "BLOCK";
  const anyDegraded = checks.some((c) => c.status === "WARN" || c.status === "FAIL");
  if (anyDegraded) return "WARN";
  const anyPass = checks.some((c) => c.status === "PASS");
  return anyPass ? "PASS" : "UNKNOWN";
}

function handshakeMessage(status: HandshakeOverallStatus): string {
  switch (status) {
    case "PASS":
      return "This trade is being monitored from fresh, matching data.";
    case "WARN":
      return "This trade is monitored, but some inputs are limited — read the guidance with that in mind.";
    case "BLOCK":
      return "Monitoring data for this trade isn't ready — the read may not reflect the live position.";
    case "UNKNOWN":
    default:
      return "Trade-monitoring readiness is still being determined.";
  }
}

/**
 * Build the Live Trade Health Handshake for one position: is it in sync, fresh,
 * does the chart symbol match, are TP/SL known, is the current price fresh, is
 * the original signal available, and were the broker fill + slippage stored.
 * Advisory only — never a gate. Honest NOT_AVAILABLE when a fact is unknown.
 */
export function buildTradeHealthHandshake(input: {
  p: OpenPositionInput;
  signal: OriginalSignalInput | null;
  chartSymbol: string | null;
}): TradeHealthHandshake {
  const { p, signal, chartSymbol } = input;
  const checks: TradeHealthCheck[] = [];

  checks.push({
    key: "positionInSync",
    status: isFiniteNum(p.entryPrice) ? "PASS" : "FAIL",
    detail: isFiniteNum(p.entryPrice)
      ? "The position is present in the latest sync."
      : "The position has no synced entry price yet.",
  });

  if (p.priceAgeMs == null) {
    checks.push({ key: "freshness", status: "NOT_AVAILABLE", detail: "The sync age is unknown." });
  } else if (p.priceAgeMs <= PRICE_FRESH_MS) {
    checks.push({ key: "freshness", status: "PASS", detail: "The position data is fresh." });
  } else if (p.priceAgeMs <= PRICE_STALE_MS) {
    checks.push({ key: "freshness", status: "WARN", detail: "The position data is a little old." });
  } else {
    checks.push({ key: "freshness", status: "FAIL", detail: "The position data is stale." });
  }

  const cs = chartSymbol ? normalizeSymbol(chartSymbol) : null;
  const ps = normalizeSymbol(p.symbol);
  if (!cs) {
    checks.push({ key: "symbolMatch", status: "NOT_AVAILABLE", detail: "No chart symbol to compare against." });
  } else if (cs === ps) {
    checks.push({ key: "symbolMatch", status: "PASS", detail: `The chart matches this position (${ps}).` });
  } else {
    checks.push({
      key: "symbolMatch",
      status: "WARN",
      detail: `The chart shows ${cs} but this position is on ${ps}.`,
    });
  }

  const tpKnown = isFiniteNum(p.takeProfit);
  const slKnown = isFiniteNum(p.stopLoss);
  if (tpKnown && slKnown) {
    checks.push({ key: "tpSlKnown", status: "PASS", detail: "Both a take-profit and a stop-loss are set." });
  } else if (tpKnown || slKnown) {
    checks.push({
      key: "tpSlKnown",
      status: "WARN",
      detail: slKnown ? "A stop is set but no take-profit." : "A take-profit is set but no stop.",
    });
  } else {
    checks.push({ key: "tpSlKnown", status: "FAIL", detail: "Neither a take-profit nor a stop is set." });
  }

  if (!isFiniteNum(p.currentPrice)) {
    checks.push({ key: "currentPriceFresh", status: "FAIL", detail: "No live price is available for this position." });
  } else if (p.priceAgeMs == null) {
    checks.push({ key: "currentPriceFresh", status: "WARN", detail: "A live price is present but its age is unknown." });
  } else if (p.priceAgeMs <= PRICE_FRESH_MS) {
    checks.push({ key: "currentPriceFresh", status: "PASS", detail: "The live price is fresh." });
  } else {
    checks.push({ key: "currentPriceFresh", status: "WARN", detail: "The live price is older than ideal." });
  }

  if (!signal) {
    checks.push({
      key: "originalSignalAvailable",
      status: "NOT_AVAILABLE",
      detail: "No original idea is linked, so invalidation and alternatives are limited.",
    });
  } else if (signal.hasSufficientData) {
    checks.push({ key: "originalSignalAvailable", status: "PASS", detail: "The original idea is available for context." });
  } else {
    checks.push({
      key: "originalSignalAvailable",
      status: "WARN",
      detail: "The original idea is a limited, technicals-only read.",
    });
  }

  if (p.fillRecorded === true) {
    checks.push({ key: "fillSlippageStored", status: "PASS", detail: "The broker fill price and slippage were recorded." });
  } else if (p.fillRecorded === false) {
    checks.push({ key: "fillSlippageStored", status: "WARN", detail: "The broker fill price and slippage weren't recorded." });
  } else {
    checks.push({ key: "fillSlippageStored", status: "NOT_AVAILABLE", detail: "Fill detail isn't available for this position." });
  }

  const overallStatus = rollUpHandshake(checks);
  const warnings = checks
    .filter((c) => c.status === "WARN" || c.status === "FAIL")
    .map((c) => c.detail);
  return { overallStatus, checks, userFacingMessage: handshakeMessage(overallStatus), warnings };
}

// ── Per-position assessment ──────────────────────────────────────────────────

/**
 * Compose the full health assessment for one open position from the live price,
 * the original signal, and the current time. Pure (caller passes nowMs).
 */
export function assessOpenPosition(input: {
  p: OpenPositionInput;
  signal: OriginalSignalInput | null;
  chartSymbol: string | null;
  nowMs: number;
}): TradeHealthAssessment {
  const { p, signal, chartSymbol } = input;
  const { state, headline, reasons } = classifyTradeHealth(p, signal);
  const tpProgress = computeTpProgress(p);
  const slDistance = computeSlDistance(p);
  const breakEven = deriveBreakEvenSuggestion(p, tpProgress);
  const partialClose = derivePartialCloseSuggestion(p, tpProgress, state);
  const styleMatch = matchTradeStyle(p, input.nowMs);
  const alternatives = buildSetupAlternatives(signal);
  const handshake = buildTradeHealthHandshake({ p, signal, chartSymbol });
  const alert = state !== "healthy";
  // Server-authoritative symbol-split decision: identical comparison to the
  // `symbolMatch` handshake check above, so the panel can separate "this symbol"
  // from account-wide exposure without re-implementing symbol matching.
  const csNorm = chartSymbol ? normalizeSymbol(chartSymbol) : null;
  const matchesChartSymbol = csNorm != null && csNorm === normalizeSymbol(p.symbol);
  return {
    ticket: p.ticket,
    symbol: p.symbol,
    side: p.side,
    accountMode: p.accountMode,
    matchesChartSymbol,
    entryPrice: isFiniteNum(p.entryPrice) ? p.entryPrice : null,
    state,
    headline,
    reasons,
    alert,
    tpProgress,
    slDistance,
    breakEven,
    partialClose,
    styleMatch,
    alternatives,
    handshake,
  };
}

// ── Active chart overlays (fills the Phase 4 trade-health overlay slot) ───────

function stateSeverity(state: TradeHealthState): SmartChartSeverity {
  switch (state) {
    case "healthy":
      return "success";
    case "weakening":
      return "warning";
    case "danger":
    case "invalidated":
      return "danger";
    default:
      return "neutral";
  }
}

function stateWord(state: TradeHealthState): string {
  switch (state) {
    case "healthy":
      return "healthy";
    case "weakening":
      return "weakening";
    case "danger":
      return "in danger";
    case "invalidated":
      return "invalidated";
    default:
      return "monitoring";
  }
}

/**
 * Build ACTIVE (non-reserved) trade-health overlays for the positions on the
 * chart's symbol: a marker at each position's entry labeled with its live health
 * state. Emitted only when the entry price is real — never a fabricated value.
 * This replaces the reserved Phase-4 placeholder slot with a live read.
 */
export function buildTradeHealthOverlayLayers(
  assessments: readonly TradeHealthAssessment[],
  requestedSymbol: string,
): SmartChartLayer[] {
  const want = normalizeSymbol(requestedSymbol);
  const layers: SmartChartLayer[] = [];
  for (const a of assessments) {
    if (normalizeSymbol(a.symbol) !== want) continue;
    if (!isFiniteNum(a.entryPrice)) continue;
    layers.push({
      id: `trade-health-${a.ticket}`,
      group: "trade_health",
      kind: "marker",
      price: a.entryPrice,
      label: `Trade health: ${stateWord(a.state)}`,
      severity: stateSeverity(a.state),
      source: "position",
    });
  }
  return layers;
}

// ── Report composer ──────────────────────────────────────────────────────────

function summarize(
  assessments: readonly TradeHealthAssessment[],
  conflicts: readonly ConflictWarning[],
  correlations: readonly CorrelationWarning[],
  overtrading: readonly OvertradingWarning[],
): string {
  if (assessments.length === 0) {
    return "You have no open positions to monitor right now.";
  }
  const danger = assessments.filter((a) => a.state === "danger" || a.state === "invalidated").length;
  const weak = assessments.filter((a) => a.state === "weakening").length;
  const healthy = assessments.filter((a) => a.state === "healthy").length;
  const parts: string[] = [];
  parts.push(
    `Monitoring ${assessments.length} open ${assessments.length === 1 ? "position" : "positions"}: ${healthy} healthy, ${weak} weakening, ${danger} needing attention.`,
  );
  if (conflicts.length > 0) parts.push(`${conflicts.length} exposure conflict${conflicts.length === 1 ? "" : "s"} flagged.`);
  if (correlations.length > 0) parts.push(`${correlations.length} correlated cluster${correlations.length === 1 ? "" : "s"} flagged.`);
  if (overtrading.length > 0) parts.push(`${overtrading.length} behavior note${overtrading.length === 1 ? "" : "s"}.`);
  return parts.join(" ");
}

/**
 * Compose the full trade-health report for a user's open positions. `signals` is
 * a per-symbol map of the original Ruby reads (best-effort; null entries are
 * fine). `overtrading` carries real behavioral inputs (all-null → no behavior
 * warnings). Pure (caller passes nowMs + evaluatedAtIso + chartSymbol).
 */
export function buildTradeHealthReport(input: {
  positions: readonly OpenPositionInput[];
  signalsBySymbol: Readonly<Record<string, OriginalSignalInput | null>>;
  overtrading: OvertradingInput;
  chartSymbol: string | null;
  nowMs: number;
  evaluatedAtIso: string;
}): TradeHealthReport {
  const assessments = input.positions.map((p) =>
    assessOpenPosition({
      p,
      signal: input.signalsBySymbol[normalizeSymbol(p.symbol)] ?? null,
      chartSymbol: input.chartSymbol,
      nowMs: input.nowMs,
    }),
  );
  const conflicts = detectConflicts(input.positions);
  const correlations = detectCorrelation(input.positions);
  const overtrading = detectOvertrading(input.overtrading);
  const overlays = input.chartSymbol
    ? buildTradeHealthOverlayLayers(assessments, input.chartSymbol)
    : [];
  return {
    evaluatedAt: input.evaluatedAtIso,
    assessments,
    conflicts,
    correlations,
    overtrading,
    overlays,
    summary: summarize(assessments, conflicts, correlations, overtrading),
  };
}
