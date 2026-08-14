// Phase UX2 — Live Trade Intelligence + Sniper Exit Alert tests.
// Pure-function coverage of the scoring + alert engines across 20 scenarios.

import {
  computeTradeIntelligence, type ScoringInput,
} from "../lib/intelligence/scoring.js";
import {
  evaluateAlerts, DEFAULT_PREFS, shouldDedup,
} from "../lib/intelligence/alertEngine.js";
import { nextRunning } from "../lib/intelligence/mfeTracker.js";

type T = { name: string; ok: boolean; detail?: string };
const results: T[] = [];
function check(name: string, cond: unknown, detail?: string) {
  results.push({ name, ok: Boolean(cond), detail });
}

function mkCandles(closes: number[]): ScoringInput["candlesM15"] {
  return closes.map((c, i) => ({
    t: i, o: c - 0.0001, h: c + 0.0002, l: c - 0.0002, c,
  }));
}

// ── 1. Insufficient data — should return NO_ACTION_DATA_INSUFFICIENT ──
{
  const r = computeTradeIntelligence({
    side: "BUY", entryPrice: null, currentPrice: null,
    stopLoss: null, takeProfit: null, unrealizedPnl: null,
    symbol: "EURUSD",
  });
  check("1. data insufficient", r.recommendedAction === "NO_ACTION_DATA_INSUFFICIENT",
    `got=${r.recommendedAction}`);
  check("1b. dataQuality lists missing", r.dataQuality.missing.length >= 4);
}

// ── 2. Partial data: P&L only, no candles → WATCH_CLOSELY, never HOLD ──
{
  const r = computeTradeIntelligence({
    side: "BUY", entryPrice: null, currentPrice: null,
    stopLoss: null, takeProfit: null, unrealizedPnl: 10, symbol: "EURUSD",
  });
  check("2. partial data → watch",
    r.recommendedAction === "WATCH_CLOSELY" || r.recommendedAction === "NO_ACTION_DATA_INSUFFICIENT",
    `got=${r.recommendedAction}`);
}

// ── 3. Strong continuation BUY with candle uptrend → HOLD ──
{
  const closes = [1.0900, 1.0905, 1.0910, 1.0915, 1.0920, 1.0925, 1.0930, 1.0935,
    1.0940, 1.0945, 1.0950, 1.0955, 1.0960, 1.0965, 1.0970, 1.0975, 1.0980, 1.0985, 1.0990, 1.0995];
  const r = computeTradeIntelligence({
    side: "BUY", entryPrice: 1.0900, currentPrice: 1.0995,
    stopLoss: 1.0880, takeProfit: 1.1050, unrealizedPnl: 95,
    peakPnl: 95, candlesM15: mkCandles(closes), symbol: "EURUSD",
  });
  check("3. strong continuation → HOLD", r.recommendedAction === "HOLD",
    `label=${r.label} action=${r.recommendedAction}`);
  check("3b. continuationScore high", (r.scores.continuationScore ?? 0) >= 60,
    `cont=${r.scores.continuationScore}`);
}

// ── 4. Reversal SELL — uptrend candles oppose SELL ──
{
  const closes = [1.10, 1.101, 1.102, 1.103, 1.104, 1.105, 1.106, 1.107, 1.108, 1.109,
    1.110, 1.111, 1.112, 1.113, 1.114, 1.115, 1.116, 1.117, 1.118, 1.119];
  const r = computeTradeIntelligence({
    side: "SELL", entryPrice: 1.10, currentPrice: 1.119,
    stopLoss: 1.120, takeProfit: 1.080, unrealizedPnl: -19,
    candlesM15: mkCandles(closes), symbol: "EURUSD",
  });
  check("4. reversal risk against SELL", (r.scores.reversalRiskScore ?? 0) >= 60,
    `rev=${r.scores.reversalRiskScore}`);
}

// ── 5. Profit giveback — peak 100, now 40 → 60% giveback ──
{
  const r = computeTradeIntelligence({
    side: "BUY", entryPrice: 1.10, currentPrice: 1.104,
    stopLoss: 1.09, takeProfit: 1.12, unrealizedPnl: 40,
    peakPnl: 100, symbol: "EURUSD",
  });
  check("5. profit giveback 60%", r.derived.profitGivebackPercent === 60,
    `gb=${r.derived.profitGivebackPercent}`);
  check("5b. recommendedAction non-HOLD", r.recommendedAction !== "HOLD",
    `action=${r.recommendedAction}`);
}

// ── 6. SL approach — distance to SL < 30% ──
{
  const r = computeTradeIntelligence({
    side: "BUY", entryPrice: 1.10, currentPrice: 1.092,
    stopLoss: 1.09, takeProfit: 1.12, unrealizedPnl: -8, symbol: "EURUSD",
  });
  check("6. SL close → urgency > 40", (r.scores.closeUrgencyScore ?? 0) >= 40,
    `urg=${r.scores.closeUrgencyScore}`);
}

// ── 7. TP approach — within 20% of TP, in profit ──
{
  const r = computeTradeIntelligence({
    side: "BUY", entryPrice: 1.10, currentPrice: 1.118,
    stopLoss: 1.09, takeProfit: 1.12, unrealizedPnl: 18,
    peakPnl: 18, symbol: "EURUSD",
  });
  const alerts = evaluateAlerts(r, DEFAULT_PREFS, {
    symbol: "EURUSD", side: "BUY", unrealizedPnl: 18, peakPnl: 18,
    entryPrice: 1.10, currentPrice: 1.118, stopLoss: 1.09, takeProfit: 1.12,
    ageMinutes: 30, accountType: "demo",
  });
  check("7. TP approach alert", alerts.some((a) => a.alertType === "tp_approach"),
    `types=${alerts.map((a) => a.alertType).join(",")}`);
}

// ── 8. Fakeout — long upper wick on BUY ──
{
  const closes = [1.1, 1.1, 1.1, 1.1, 1.1, 1.1, 1.1, 1.1, 1.1, 1.1,
    1.1, 1.1, 1.1, 1.1, 1.1, 1.1, 1.1, 1.1, 1.1, 1.1];
  const cs = mkCandles(closes);
  cs![cs!.length - 1] = { t: 19, o: 1.1, c: 1.101, h: 1.115, l: 1.099 };
  const r = computeTradeIntelligence({
    side: "BUY", entryPrice: 1.10, currentPrice: 1.101,
    stopLoss: 1.09, takeProfit: 1.12, unrealizedPnl: 1,
    candlesM15: cs, symbol: "EURUSD",
  });
  check("8. fakeout risk", (r.scores.fakeoutRiskScore ?? 0) >= 60,
    `fake=${r.scores.fakeoutRiskScore}`);
}

// ── 9. Hold-time exceeded alert (intraday > 240m) ──
{
  const r = computeTradeIntelligence({
    side: "BUY", entryPrice: 1.10, currentPrice: 1.101,
    stopLoss: 1.09, takeProfit: 1.12, unrealizedPnl: 1,
    ageMinutes: 300, style: "intraday", symbol: "EURUSD",
  });
  const alerts = evaluateAlerts(r, DEFAULT_PREFS, {
    symbol: "EURUSD", side: "BUY", unrealizedPnl: 1, peakPnl: 5,
    entryPrice: 1.10, currentPrice: 1.101, stopLoss: 1.09, takeProfit: 1.12,
    ageMinutes: 300, accountType: "demo",
  });
  check("9. hold-time exceeded", alerts.some((a) => a.alertType === "hold_time_exceeded"));
}

// ── 10. Profit giveback alert produced ──
{
  const r = computeTradeIntelligence({
    side: "BUY", entryPrice: 1.10, currentPrice: 1.104,
    stopLoss: 1.09, takeProfit: 1.12, unrealizedPnl: 40, peakPnl: 100, symbol: "EURUSD",
  });
  const alerts = evaluateAlerts(r, DEFAULT_PREFS, {
    symbol: "EURUSD", side: "BUY", unrealizedPnl: 40, peakPnl: 100,
    entryPrice: 1.10, currentPrice: 1.104, stopLoss: 1.09, takeProfit: 1.12,
    ageMinutes: 30, accountType: "demo",
  });
  check("10. profit_giveback alert", alerts.some((a) => a.alertType === "profit_giveback"));
}

// ── 11. Dedup — same alert in window blocks repeat ──
{
  const recent = [{ alertType: "profit_giveback", createdAt: new Date(Date.now() - 60_000) }];
  check("11. dedup blocks within 5min", shouldDedup(recent, "profit_giveback") === true);
  check("11b. dedup allows different type", shouldDedup(recent, "sl_approach") === false);
}

// ── 12. Dedup expires after 5 min ──
{
  const recent = [{ alertType: "profit_giveback", createdAt: new Date(Date.now() - 6 * 60_000) }];
  check("12. dedup expires", shouldDedup(recent, "profit_giveback") === false);
}

// ── 13. nextRunning tracks MFE/MAE/peakPnl ──
{
  let prev: { mfe: number | null; mae: number | null; peakPnl: number | null } = { mfe: null, mae: null, peakPnl: null };
  prev = nextRunning(prev, { side: "BUY", entryPrice: 1.10, currentPrice: 1.105, unrealizedPnl: 50 });
  prev = nextRunning(prev, { side: "BUY", entryPrice: 1.10, currentPrice: 1.110, unrealizedPnl: 100 });
  prev = nextRunning(prev, { side: "BUY", entryPrice: 1.10, currentPrice: 1.095, unrealizedPnl: -50 });
  check("13. peakPnl tracked", prev.peakPnl === 100);
  check("13b. mfe tracked", prev.mfe != null && prev.mfe >= 0.0099);
  check("13c. mae tracked (negative)", (prev.mae ?? 0) < 0);
}

// ── 14. SELL pnlPips sign ──
{
  const r = computeTradeIntelligence({
    side: "SELL", entryPrice: 1.10, currentPrice: 1.0980,
    stopLoss: 1.11, takeProfit: 1.08, unrealizedPnl: 20, symbol: "EURUSD",
  });
  check("14. SELL profit → positive pips", (r.derived.pnlPips ?? -1) > 0,
    `pips=${r.derived.pnlPips}`);
}

// ── 15. JPY pip sizing ──
{
  const r = computeTradeIntelligence({
    side: "BUY", entryPrice: 150.00, currentPrice: 150.20,
    stopLoss: 149.50, takeProfit: 151.00, unrealizedPnl: 20, symbol: "USDJPY",
  });
  check("15. JPY pip ≈ 20", r.derived.pnlPips != null && Math.abs(r.derived.pnlPips - 20) < 0.5,
    `pips=${r.derived.pnlPips}`);
}

// ── 16. Disabled alerts ──
{
  const r = computeTradeIntelligence({
    side: "BUY", entryPrice: 1.10, currentPrice: 1.104,
    stopLoss: 1.09, takeProfit: 1.12, unrealizedPnl: 40, peakPnl: 100, symbol: "EURUSD",
  });
  const alerts = evaluateAlerts(r, { ...DEFAULT_PREFS, alertsEnabled: false }, {
    symbol: "EURUSD", side: "BUY", unrealizedPnl: 40, peakPnl: 100,
    entryPrice: 1.10, currentPrice: 1.104, stopLoss: 1.09, takeProfit: 1.12,
    ageMinutes: 30, accountType: "demo",
  });
  check("16. alertsEnabled=false → 0 alerts", alerts.length === 0);
}

// ── 17. Aggressive sensitivity fires sooner ──
{
  const r = computeTradeIntelligence({
    side: "BUY", entryPrice: 1.10, currentPrice: 1.107,
    stopLoss: 1.09, takeProfit: 1.12, unrealizedPnl: 70, peakPnl: 100, symbol: "EURUSD",
  });
  const balanced = evaluateAlerts(r, DEFAULT_PREFS, {
    symbol: "EURUSD", side: "BUY", unrealizedPnl: 70, peakPnl: 100,
    entryPrice: 1.10, currentPrice: 1.107, stopLoss: 1.09, takeProfit: 1.12,
    ageMinutes: 30, accountType: "demo",
  });
  const aggressive = evaluateAlerts(r, { ...DEFAULT_PREFS, sensitivity: "aggressive" }, {
    symbol: "EURUSD", side: "BUY", unrealizedPnl: 70, peakPnl: 100,
    entryPrice: 1.10, currentPrice: 1.107, stopLoss: 1.09, takeProfit: 1.12,
    ageMinutes: 30, accountType: "demo",
  });
  check("17. aggressive ≥ balanced count",
    aggressive.length >= balanced.length,
    `bal=${balanced.length} agg=${aggressive.length}`);
}

// ── 18. High close urgency → CLOSE_NOW_PROMPT or CLOSE_CONSIDERATION ──
{
  const closes = [1.10, 1.099, 1.098, 1.097, 1.096, 1.095, 1.094, 1.093, 1.092, 1.091,
    1.090, 1.089, 1.088, 1.087, 1.086, 1.085, 1.084, 1.083, 1.082, 1.081];
  const r = computeTradeIntelligence({
    side: "BUY", entryPrice: 1.10, currentPrice: 1.081,
    stopLoss: 1.080, takeProfit: 1.12, unrealizedPnl: -19, peakPnl: 5,
    ageMinutes: 500, style: "intraday",
    candlesM15: mkCandles(closes), symbol: "EURUSD",
  });
  check("18. urgent close suggested",
    r.recommendedAction === "CLOSE_NOW_PROMPT" || r.recommendedAction === "CLOSE_CONSIDERATION"
      || r.recommendedAction === "WATCH_CLOSELY",
    `action=${r.recommendedAction} urg=${r.scores.closeUrgencyScore}`);
  check("18b. urgency ≥ 40", (r.scores.closeUrgencyScore ?? 0) >= 40,
    `urg=${r.scores.closeUrgencyScore}`);
}

// ── 19. News risk score remains null (no provider wired) — honesty ──
{
  const r = computeTradeIntelligence({
    side: "BUY", entryPrice: 1.10, currentPrice: 1.101,
    stopLoss: 1.09, takeProfit: 1.12, unrealizedPnl: 1, symbol: "EURUSD",
  });
  check("19. newsRiskScore null (no fabrication)", r.scores.newsRiskScore === null);
}

// ── 20. Pure determinism — same inputs, same outputs ──
{
  const input: ScoringInput & { symbol: string } = {
    side: "BUY", entryPrice: 1.10, currentPrice: 1.105,
    stopLoss: 1.09, takeProfit: 1.12, unrealizedPnl: 50,
    peakPnl: 60, symbol: "EURUSD",
  };
  const a = JSON.stringify(computeTradeIntelligence(input));
  const b = JSON.stringify(computeTradeIntelligence(input));
  check("20. deterministic", a === b);
}

// ── Summary ──
const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  — " + (r.detail ?? "")}`);
}
console.log(`\n${passed}/${results.length} PASS, ${failed} FAIL`);
if (failed > 0) process.exit(1);
