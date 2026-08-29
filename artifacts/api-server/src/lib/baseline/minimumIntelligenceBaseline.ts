// ── #59 Minimum-Intelligence Baseline — the pure decision path ───────────────
//
// The blueprint's control group: trustworthy data + ONE edge + hard risk +
// deterministic execution, and NOTHING else — no agents, no learning, no
// regime model, no meta-controller. The full stack must beat this after costs
// or the intelligence layers are decoration (Capital Constitution Article I:
// more intelligence does not automatically earn more authority).
//
// Until this module, the requirement lived only as a boolean attestation in
// the edge-promotion evidence package ("ablationAndBaseline"). This is the
// RUNNING comparator's brain: a deterministic function from trusted candles
// to a decision, evaluated in shadow by baselineComparatorWorker and paired
// against the live champion's journaled outcomes by the EXISTING
// champion-challenger machinery (compose, don't duplicate — Ruling 4).
//
// THE ONE EDGE: a Donchian-style N-bar breakout. Close above the highest high
// of the prior N closed bars → BUY; below the lowest low → SELL; else WAIT.
// Chosen because it is the canonical minimum edge: decades-old public
// knowledge, zero fitted parameters beyond N, and computable from OHLC alone.
//
// HARD RISK: the stop is the opposite N-bar extreme; the target is exactly
// 1R. A setup whose stop distance is zero, negative, or wider than
// MAX_STOP_FRACTION of price is REFUSED — hard risk means some trades do not
// exist.
//
// DETERMINISTIC EXECUTION MODEL: entry at the breakout close, debited HALF
// the spread on entry and half on exit (a full spread round-trip per trade).
// Costs are charged in R so a thin edge cannot hide behind gross outcomes.
//
// HONESTY: refusals are typed. Insufficient bars, an untrusted source, or
// malformed bars produce a refusal with a reason — never a guessed decision.
// PURE + SHADOW-ONLY: no I/O, no clock, no randomness; nothing here touches
// dispatch, and the worker that calls it writes only shadow evidence.

export interface BaselineCandle {
  /** Bar OPEN time, epoch ms. Bars must be CLOSED and ascending. */
  openTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface BaselineConfig {
  /** Breakout lookback (prior closed bars). */
  lookback: number;
  /** Refuse setups whose stop distance exceeds this fraction of price. */
  maxStopFraction: number;
  /** Full spread, in PRICE units, charged one half per side. */
  spread: number;
}

export const DEFAULT_BASELINE_CONFIG: BaselineConfig = {
  lookback: 20,
  maxStopFraction: 0.05,
  spread: 0,
};

/** Sources whose candles count as trustworthy market evidence. Broker-native
 *  MT5 bars and Deriv venue bars only — never synthetic, never simulator,
 *  never "assistant" reconstructions. Additions here are a reviewed act. */
export const BASELINE_TRUSTED_CANDLE_SOURCES = ["mt5_broker", "deriv"] as const;

export function isTrustedBaselineSource(source: string): boolean {
  return (BASELINE_TRUSTED_CANDLE_SOURCES as readonly string[]).includes(source);
}

export type BaselineRefusalReason =
  | "DATA_SOURCE_UNTRUSTED"
  | "DATA_INSUFFICIENT"
  | "DATA_MALFORMED"
  | "DATA_NOT_ASCENDING"
  | "STOP_DISTANCE_INVALID"
  | "STOP_TOO_WIDE"
  | "NO_BREAKOUT";

export interface BaselineDecisionTrade {
  kind: "TRADE";
  action: "BUY" | "SELL";
  /** The breakout bar's close (the entry model's fill basis, pre-cost). */
  entry: number;
  stop: number;
  target: number;
  /** |entry - stop| in price units — the R denominator. */
  riskPerUnit: number;
  /** The bar that triggered, for idempotent shadow ids. */
  decisionBarOpenTimeMs: number;
  reason: string;
}

export interface BaselineDecisionRefusal {
  kind: "REFUSAL";
  reason: BaselineRefusalReason;
  detail: string;
}

export type BaselineDecision = BaselineDecisionTrade | BaselineDecisionRefusal;

function refuse(reason: BaselineRefusalReason, detail: string): BaselineDecisionRefusal {
  return { kind: "REFUSAL", reason, detail };
}

function candleValid(c: BaselineCandle): boolean {
  return (
    Number.isFinite(c.openTimeMs) &&
    Number.isFinite(c.open) && Number.isFinite(c.high) &&
    Number.isFinite(c.low) && Number.isFinite(c.close) &&
    c.high >= c.low && c.high > 0 && c.low > 0
  );
}

/**
 * PURE — decide the baseline's action from closed candles. The LAST candle is
 * the decision bar; the `lookback` bars before it form the breakout channel.
 */
export function decideBaseline(
  candles: readonly BaselineCandle[],
  source: string,
  config: BaselineConfig = DEFAULT_BASELINE_CONFIG,
): BaselineDecision {
  if (!isTrustedBaselineSource(source)) {
    return refuse("DATA_SOURCE_UNTRUSTED", `source ${JSON.stringify(source)} is not in the trusted allow-list — the baseline's first pillar is trustworthy data`);
  }
  if (candles.length < config.lookback + 1) {
    return refuse("DATA_INSUFFICIENT", `${candles.length} closed bars < required ${config.lookback + 1}`);
  }
  for (const c of candles) {
    if (!candleValid(c)) {
      return refuse("DATA_MALFORMED", `bar at ${String(c.openTimeMs)} has non-finite or inverted OHLC`);
    }
  }
  for (let i = 1; i < candles.length; i++) {
    if (candles[i]!.openTimeMs <= candles[i - 1]!.openTimeMs) {
      return refuse("DATA_NOT_ASCENDING", `bar order breaks at index ${i}`);
    }
  }

  const decisionBar = candles[candles.length - 1]!;
  const channel = candles.slice(candles.length - 1 - config.lookback, candles.length - 1);
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of channel) {
    if (c.high > hi) hi = c.high;
    if (c.low < lo) lo = c.low;
  }

  let action: "BUY" | "SELL";
  let stop: number;
  if (decisionBar.close > hi) {
    action = "BUY";
    stop = lo;
  } else if (decisionBar.close < lo) {
    action = "SELL";
    stop = hi;
  } else {
    return refuse("NO_BREAKOUT", `close ${decisionBar.close} inside ${config.lookback}-bar channel [${lo}, ${hi}]`);
  }

  const entry = decisionBar.close;
  const riskPerUnit = Math.abs(entry - stop);
  if (!(riskPerUnit > 0)) {
    return refuse("STOP_DISTANCE_INVALID", `stop ${stop} coincides with entry ${entry} — a trade with no stop distance does not exist`);
  }
  if (riskPerUnit > config.maxStopFraction * entry) {
    return refuse("STOP_TOO_WIDE", `stop distance ${riskPerUnit} > ${config.maxStopFraction} of price ${entry} — hard risk refuses it`);
  }
  const target = action === "BUY" ? entry + riskPerUnit : entry - riskPerUnit;
  return {
    kind: "TRADE",
    action, entry, stop, target, riskPerUnit,
    decisionBarOpenTimeMs: decisionBar.openTimeMs,
    reason: `${config.lookback}-bar ${action === "BUY" ? "high" : "low"} breakout: close ${entry} ${action === "BUY" ? ">" : "<"} channel ${action === "BUY" ? hi : lo}`,
  };
}

// ── Outcome resolution (deterministic, cost-adjusted) ───────────────────────

export type BaselineOutcomeStatus = "WIN" | "LOSS" | "OPEN" | "AMBIGUOUS_BAR";

export interface BaselineOutcome {
  status: BaselineOutcomeStatus;
  /** Cost-adjusted R (full spread round-trip charged). null while OPEN. */
  pnlR: number | null;
  /** Bar that resolved it, when resolved. */
  resolvedAtBarMs: number | null;
  detail: string;
}

/**
 * PURE — resolve a baseline trade against SUBSEQUENT closed bars (bars whose
 * openTimeMs is strictly after the decision bar's).
 *
 * Deterministic rules, honest about intra-bar ambiguity: a bar that touches
 * BOTH stop and target cannot be ordered from OHLC alone, so it resolves
 * AMBIGUOUS_BAR and is settled as a LOSS-equivalent (-1R minus costs) — the
 * baseline never awards itself the benefit of the doubt.
 */
export function resolveBaselineOutcome(
  trade: BaselineDecisionTrade,
  subsequentBars: readonly BaselineCandle[],
  config: BaselineConfig = DEFAULT_BASELINE_CONFIG,
): BaselineOutcome {
  // Full-spread round trip expressed in R.
  const costR = trade.riskPerUnit > 0 ? config.spread / trade.riskPerUnit : 0;

  for (const bar of subsequentBars) {
    if (bar.openTimeMs <= trade.decisionBarOpenTimeMs) continue;
    if (!candleValid(bar)) continue; // an unreadable bar resolves nothing
    const hitStop = trade.action === "BUY" ? bar.low <= trade.stop : bar.high >= trade.stop;
    const hitTarget = trade.action === "BUY" ? bar.high >= trade.target : bar.low <= trade.target;
    if (hitStop && hitTarget) {
      return {
        status: "AMBIGUOUS_BAR",
        pnlR: -1 - costR,
        resolvedAtBarMs: bar.openTimeMs,
        detail: "bar touched both stop and target — settled as loss (no benefit of the doubt)",
      };
    }
    if (hitStop) {
      return { status: "LOSS", pnlR: -1 - costR, resolvedAtBarMs: bar.openTimeMs, detail: "stop hit" };
    }
    if (hitTarget) {
      return { status: "WIN", pnlR: 1 - costR, resolvedAtBarMs: bar.openTimeMs, detail: "target hit" };
    }
  }
  return { status: "OPEN", pnlR: null, resolvedAtBarMs: null, detail: "neither stop nor target touched yet" };
}
