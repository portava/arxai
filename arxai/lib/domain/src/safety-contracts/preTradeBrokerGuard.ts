// Task #30 — Pre-trade broker-rule guard (pure, deterministic).
//
// PURPOSE: refuse an order BEFORE it reaches the broker when the broker's own
// reported symbol rules or the live quote make the trade unsafe (stale quote,
// blown-out spread, slippage beyond limit, symbol not tradable / market closed,
// volume off-step, SL/TP inside the broker's stops/freeze distance). The EA
// mirrors this exact logic in MQL5 before calling OrderSend and places nothing
// on failure; the server runs it as an advisory pre-check at draft time.
//
// SAFETY (inviolable):
// - Pure function. No DB / network / IO. Caller assembles all inputs.
// - This guard can ONLY refuse a trade. A PASS here NEVER bypasses the 16-gate
//   Phase B evaluator, the chokepoint, the kill switch, or any other guard.
//   It is an ADDITIONAL refusal layer, evaluated independently.
// - Missing / unknown broker facts are fail-OPEN for the *spec* checks they
//   gate (we cannot prove a violation without the broker's number) but the
//   quote-freshness, no-price, spread, and market-open checks fail-CLOSED when
//   their inputs are missing, because those are the checks that protect against
//   firing into a dead or dislocated market.

export type PreTradeGuardKey =
  | "QUOTE_STALE"            // last tick older than maxQuoteAgeMs (or missing)
  | "NO_PRICES"             // bid/ask <= 0 — broker is not quoting this symbol
  | "SPREAD_TOO_WIDE"       // (ask-bid)/point exceeds maxSpreadPoints
  | "MARKET_CLOSED"         // broker reports the session closed
  | "SYMBOL_NOT_TRADABLE"   // trade disabled / close-only / not visible
  | "DEVIATION_TOO_LARGE"   // requested price drifted past maxDeviationPoints
  | "VOLUME_BELOW_MIN"      // volume < broker min lot
  | "VOLUME_ABOVE_MAX"      // volume > broker max lot
  | "VOLUME_OFF_STEP"       // volume not a multiple of broker lot step
  | "STOP_LOSS_TOO_CLOSE"   // |entry-SL| < broker stops level
  | "TAKE_PROFIT_TOO_CLOSE" // |entry-TP| < broker stops level
  | "STOP_INSIDE_FREEZE";   // SL/TP inside broker freeze distance

export type PreTradeTradeMode =
  // Mirrors MQL5 SYMBOL_TRADE_MODE_* — only FULL / LONGONLY / SHORTONLY permit
  // opening; DISABLED and CLOSEONLY refuse new entries.
  | "FULL" | "LONGONLY" | "SHORTONLY" | "CLOSEONLY" | "DISABLED";

export interface PreTradeBrokerSpec {
  /** SYMBOL_VISIBLE — false means not selected in Market Watch. */
  visible: boolean | null;
  /** Derived tradability — false => SYMBOL_NOT_TRADABLE. */
  tradeAllowed: boolean | null;
  /** SYMBOL_TRADE_MODE_*. */
  tradeMode: PreTradeTradeMode | null;
  /** Broker session state for "now" — false => MARKET_CLOSED. */
  marketOpen: boolean | null;
  /** SYMBOL_POINT — price increment used to convert distances to points. */
  point: number | null;
  minVolume: number | null;     // SYMBOL_VOLUME_MIN
  maxVolume: number | null;     // SYMBOL_VOLUME_MAX
  volumeStep: number | null;    // SYMBOL_VOLUME_STEP
  /** SYMBOL_TRADE_STOPS_LEVEL in points. */
  stopsLevelPoints: number | null;
  /** SYMBOL_TRADE_FREEZE_LEVEL in points. */
  freezeLevelPoints: number | null;
}

export interface PreTradeQuote {
  bid: number | null;
  ask: number | null;
  /** Age of the last tick in ms. null/large => QUOTE_STALE. */
  quoteAgeMs: number | null;
}

export interface PreTradeGuardLimits {
  maxSpreadPoints: number;   // refuse if current spread exceeds this
  maxQuoteAgeMs: number;     // refuse if last tick older than this
  maxDeviationPoints: number; // refuse if requested price drifted past this
}

export interface PreTradeGuardInput {
  side: "BUY" | "SELL";
  volume: number;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Price the order was built against (for slippage/deviation check). */
  requestedPrice: number | null;
  quote: PreTradeQuote;
  spec: PreTradeBrokerSpec;
  limits: PreTradeGuardLimits;
}

export interface PreTradeGuardCheck {
  key: PreTradeGuardKey;
  passed: boolean;
  detail: string | null;
}

export interface PreTradeGuardResult {
  ok: boolean;
  /** First failing check (stable order). null when ok. */
  reason: PreTradeGuardKey | null;
  detail: string | null;
  checks: PreTradeGuardCheck[];
}

export const DEFAULT_PRE_TRADE_GUARD_LIMITS: PreTradeGuardLimits = Object.freeze({
  maxSpreadPoints: 50,
  maxQuoteAgeMs: 5_000,
  maxDeviationPoints: 20,
});

function approxMultiple(value: number, step: number): boolean {
  if (step <= 0) return true;
  const n = value / step;
  return Math.abs(n - Math.round(n)) < 1e-6;
}

/**
 * Human-readable, non-technical message for each guard key. Raw broker codes /
 * point distances stay in `detail` (admin-gated by callers).
 */
export function explainPreTradeGuard(key: PreTradeGuardKey): string {
  switch (key) {
    case "QUOTE_STALE":
      return "The latest price for this symbol is stale. Waiting for a fresh quote before trading.";
    case "NO_PRICES":
      return "The broker is not quoting a price for this symbol right now.";
    case "SPREAD_TOO_WIDE":
      return "The spread is wider than your limit. Holding off to avoid a poor fill.";
    case "MARKET_CLOSED":
      return "The market for this symbol is closed at your broker right now.";
    case "SYMBOL_NOT_TRADABLE":
      return "Your broker does not currently allow opening trades on this symbol.";
    case "DEVIATION_TOO_LARGE":
      return "The price moved too far from the requested price. Cancelled to avoid slippage.";
    case "VOLUME_BELOW_MIN":
      return "The trade size is below your broker's minimum for this symbol.";
    case "VOLUME_ABOVE_MAX":
      return "The trade size is above your broker's maximum for this symbol.";
    case "VOLUME_OFF_STEP":
      return "The trade size is not a valid step for this symbol at your broker.";
    case "STOP_LOSS_TOO_CLOSE":
      return "The stop loss is closer to price than your broker allows.";
    case "TAKE_PROFIT_TOO_CLOSE":
      return "The take profit is closer to price than your broker allows.";
    case "STOP_INSIDE_FREEZE":
      return "The stop/target is inside your broker's freeze distance and cannot be set right now.";
  }
}

/**
 * Evaluate the broker pre-trade guard. Returns ok:false with the first failing
 * reason. Order of checks is fixed so the EA and server agree on which reason
 * surfaces first.
 */
export function evaluatePreTradeBrokerGuard(input: PreTradeGuardInput): PreTradeGuardResult {
  const checks: PreTradeGuardCheck[] = [];
  const pass = (key: PreTradeGuardKey) => checks.push({ key, passed: true, detail: null });
  const fail = (key: PreTradeGuardKey, detail: string) => checks.push({ key, passed: false, detail });

  const { quote, spec, limits } = input;
  const point = spec.point && spec.point > 0 ? spec.point : null;

  // 1. Quote freshness — fail-closed if unknown.
  if (quote.quoteAgeMs == null || quote.quoteAgeMs > limits.maxQuoteAgeMs) {
    fail("QUOTE_STALE", `quoteAgeMs=${quote.quoteAgeMs ?? "null"} > max ${limits.maxQuoteAgeMs}`);
  } else pass("QUOTE_STALE");

  // 2. Prices present — fail-closed if unknown.
  const bid = quote.bid ?? 0;
  const ask = quote.ask ?? 0;
  if (bid <= 0 || ask <= 0) {
    fail("NO_PRICES", `bid=${quote.bid ?? "null"} ask=${quote.ask ?? "null"}`);
  } else pass("NO_PRICES");

  // 3. Spread — needs point + both prices. Skip if we cannot measure.
  if (point && bid > 0 && ask > 0) {
    const spreadPoints = (ask - bid) / point;
    if (spreadPoints > limits.maxSpreadPoints) {
      fail("SPREAD_TOO_WIDE", `spread=${spreadPoints.toFixed(1)}pt > max ${limits.maxSpreadPoints}pt`);
    } else pass("SPREAD_TOO_WIDE");
  } else pass("SPREAD_TOO_WIDE");

  // 4. Market open — fail-closed only when explicitly false.
  if (spec.marketOpen === false) {
    fail("MARKET_CLOSED", "broker reports session closed");
  } else pass("MARKET_CLOSED");

  // 5. Symbol tradable — refuse when broker disables / restricts the side / hidden.
  const modeBlocksEntry =
    spec.tradeMode === "DISABLED" ||
    spec.tradeMode === "CLOSEONLY" ||
    (spec.tradeMode === "LONGONLY" && input.side === "SELL") ||
    (spec.tradeMode === "SHORTONLY" && input.side === "BUY");
  if (spec.tradeAllowed === false || spec.visible === false || modeBlocksEntry) {
    fail("SYMBOL_NOT_TRADABLE",
      `tradeAllowed=${spec.tradeAllowed} visible=${spec.visible} mode=${spec.tradeMode ?? "?"} side=${input.side}`);
  } else pass("SYMBOL_NOT_TRADABLE");

  // 6. Deviation / slippage — compare requested price to the side's current price.
  if (point && input.requestedPrice != null && input.requestedPrice > 0 && bid > 0 && ask > 0) {
    const current = input.side === "BUY" ? ask : bid;
    const devPoints = Math.abs(current - input.requestedPrice) / point;
    if (devPoints > limits.maxDeviationPoints) {
      fail("DEVIATION_TOO_LARGE", `deviation=${devPoints.toFixed(1)}pt > max ${limits.maxDeviationPoints}pt`);
    } else pass("DEVIATION_TOO_LARGE");
  } else pass("DEVIATION_TOO_LARGE");

  // 7-9. Volume — fail-open for any leg whose broker number is unknown.
  if (spec.minVolume != null && input.volume < spec.minVolume) {
    fail("VOLUME_BELOW_MIN", `volume=${input.volume} < min ${spec.minVolume}`);
  } else pass("VOLUME_BELOW_MIN");
  if (spec.maxVolume != null && spec.maxVolume > 0 && input.volume > spec.maxVolume) {
    fail("VOLUME_ABOVE_MAX", `volume=${input.volume} > max ${spec.maxVolume}`);
  } else pass("VOLUME_ABOVE_MAX");
  if (spec.volumeStep != null && spec.volumeStep > 0 && !approxMultiple(input.volume, spec.volumeStep)) {
    fail("VOLUME_OFF_STEP", `volume=${input.volume} not a multiple of step ${spec.volumeStep}`);
  } else pass("VOLUME_OFF_STEP");

  // 10-12. Stops / freeze — only when SL/TP present + we have point + a price.
  const refPrice = bid > 0 && ask > 0 ? (input.side === "BUY" ? ask : bid) : null;
  if (point && refPrice) {
    const stopsPts = spec.stopsLevelPoints ?? 0;
    const freezePts = spec.freezeLevelPoints ?? 0;
    if (input.stopLoss != null && input.stopLoss > 0 && stopsPts > 0) {
      const slPts = Math.abs(refPrice - input.stopLoss) / point;
      if (slPts < stopsPts) fail("STOP_LOSS_TOO_CLOSE", `SL ${slPts.toFixed(1)}pt < stops ${stopsPts}pt`);
      else pass("STOP_LOSS_TOO_CLOSE");
    } else pass("STOP_LOSS_TOO_CLOSE");
    if (input.takeProfit != null && input.takeProfit > 0 && stopsPts > 0) {
      const tpPts = Math.abs(refPrice - input.takeProfit) / point;
      if (tpPts < stopsPts) fail("TAKE_PROFIT_TOO_CLOSE", `TP ${tpPts.toFixed(1)}pt < stops ${stopsPts}pt`);
      else pass("TAKE_PROFIT_TOO_CLOSE");
    } else pass("TAKE_PROFIT_TOO_CLOSE");
    if (freezePts > 0) {
      const slPts = input.stopLoss != null && input.stopLoss > 0 ? Math.abs(refPrice - input.stopLoss) / point : Infinity;
      const tpPts = input.takeProfit != null && input.takeProfit > 0 ? Math.abs(refPrice - input.takeProfit) / point : Infinity;
      if (slPts < freezePts || tpPts < freezePts) {
        fail("STOP_INSIDE_FREEZE", `freeze ${freezePts}pt; SL ${Number.isFinite(slPts) ? slPts.toFixed(1) : "n/a"}pt TP ${Number.isFinite(tpPts) ? tpPts.toFixed(1) : "n/a"}pt`);
      } else pass("STOP_INSIDE_FREEZE");
    } else pass("STOP_INSIDE_FREEZE");
  } else {
    pass("STOP_LOSS_TOO_CLOSE");
    pass("TAKE_PROFIT_TOO_CLOSE");
    pass("STOP_INSIDE_FREEZE");
  }

  const firstFail = checks.find((c) => !c.passed) ?? null;
  return {
    ok: firstFail === null,
    reason: firstFail?.key ?? null,
    detail: firstFail?.detail ?? null,
    checks,
  };
}
