import {
  type AgentCascadeInput, type HardBlockVerdict, type Level1Result,
  AGENT_CASCADE_THRESHOLDS,
} from "./agentCascade.types";

// ── Level 1 — Hard Block Agents ──────────────────────────────────────────
//
// Each agent independently decides whether to veto the trade. Any single
// veto kills the trade — no appeals, no overrides at this level. The
// orchestrator runs all four anyway (not short-circuit at Level 1) so the
// caller sees EVERY reason a trade was blocked, not just the first one.

// ── Risk Agent ────────────────────────────────────────────────────────────
//
// Vetoes when account-level risk constraints would be breached.
//   • current drawdown ≥ policy ceiling
//   • open trades count at ceiling
//   • daily PnL has hit the daily loss limit
//   • this trade's proposed risk pct > per-trade ceiling
export function evaluateRiskAgent(input: AgentCascadeInput): HardBlockVerdict {
  const reasons: string[] = [];
  const a = input.account;
  let vetoReason: string | null = null;

  if (a.drawdownPct >= a.maxDrawdownPct) {
    vetoReason = `drawdown ${a.drawdownPct.toFixed(2)}% ≥ ceiling ${a.maxDrawdownPct.toFixed(2)}%`;
  } else if (a.openTradesCount >= a.maxConcurrentTrades) {
    vetoReason = `open trades ${a.openTradesCount} at concurrency ceiling ${a.maxConcurrentTrades}`;
  } else if (a.dailyPnLPct <= a.dailyLossLimitPct) {
    vetoReason = `daily PnL ${a.dailyPnLPct.toFixed(2)}% past daily loss limit ${a.dailyLossLimitPct.toFixed(2)}%`;
  } else if (input.setup.proposedRiskPct > a.maxSingleTradeRiskPct) {
    vetoReason = `proposed risk ${input.setup.proposedRiskPct.toFixed(2)}% > per-trade ceiling ${a.maxSingleTradeRiskPct.toFixed(2)}%`;
  }

  if (vetoReason) reasons.push(`VETO: ${vetoReason}`);
  else reasons.push(`risk envelope OK (dd ${a.drawdownPct.toFixed(2)}%, open ${a.openTradesCount}/${a.maxConcurrentTrades}, daily ${a.dailyPnLPct.toFixed(2)}%, trade risk ${input.setup.proposedRiskPct.toFixed(2)}%)`);

  return { agentId: "L1.RISK", agentName: "Risk Agent", vetoed: vetoReason !== null, vetoReason, reasons };
}

// ── Execution Agent ───────────────────────────────────────────────────────
//
// Vetoes when the broker / market wouldn't actually execute cleanly.
//   • broker not connected
//   • market closed
//   • spread inflated beyond policy multiplier
//   • liquidity score below floor
export function evaluateExecutionAgent(input: AgentCascadeInput): HardBlockVerdict {
  const T = AGENT_CASCADE_THRESHOLDS.level1;
  const reasons: string[] = [];
  const m = input.market;
  let vetoReason: string | null = null;

  if (!m.brokerConnected) {
    vetoReason = "broker not connected";
  } else if (!m.marketOpen) {
    vetoReason = "market closed";
  } else if (m.liquidityScore01 < T.minLiquidity01) {
    vetoReason = `liquidity ${m.liquidityScore01.toFixed(2)} < floor ${T.minLiquidity01}`;
  } else {
    // Spread veto — pip-baseline is per-symbol but unknown here, so use a
    // soft proxy: a spread > 3× of "what the EA last quoted as normal" would
    // be vetoed by upstream code; here we use absolute pip thresholds tuned
    // for the synthetic-index family (already wide).
    if (m.spreadPips >= 25) vetoReason = `spread ${m.spreadPips.toFixed(1)} pips is execution-prohibitive`;
  }

  if (vetoReason) reasons.push(`VETO: ${vetoReason}`);
  else reasons.push(`execution channel OK (spread ${m.spreadPips.toFixed(1)}p, liquidity ${m.liquidityScore01.toFixed(2)})`);

  return { agentId: "L1.EXEC", agentName: "Execution Agent", vetoed: vetoReason !== null, vetoReason, reasons };
}

// ── News Agent ────────────────────────────────────────────────────────────
//
// Vetoes when a HIGH-severity news event affects this symbol within the
// blackout window before or after release.
export function evaluateNewsAgent(input: AgentCascadeInput): HardBlockVerdict {
  const reasons: string[] = [];
  let vetoReason: string | null = null;

  for (const ev of input.news.upcomingEvents) {
    if (!ev.affectsSymbol || ev.severity !== "HIGH") continue;
    if (ev.minutesUntil >= 0 && ev.minutesUntil <= input.news.blackoutMinutesBeforeHigh) {
      vetoReason = `HIGH-impact news "${ev.title}" in ${ev.minutesUntil}m (blackout: ${input.news.blackoutMinutesBeforeHigh}m before)`;
      break;
    }
    if (ev.minutesUntil < 0 && Math.abs(ev.minutesUntil) <= input.news.blackoutMinutesAfterHigh) {
      vetoReason = `HIGH-impact news "${ev.title}" was ${Math.abs(ev.minutesUntil)}m ago (blackout: ${input.news.blackoutMinutesAfterHigh}m after)`;
      break;
    }
  }

  if (vetoReason) reasons.push(`VETO: ${vetoReason}`);
  else reasons.push(`no high-impact news within blackout windows`);

  return { agentId: "L1.NEWS", agentName: "News Agent", vetoed: vetoReason !== null, vetoReason, reasons };
}

// ── Trader DNA Agent ──────────────────────────────────────────────────────
//
// Vetoes the trader from themselves — guards against revenge trading, tilt,
// and cooldown violations. Reads from the operator's behavioral state, not
// the market.
export function evaluateTraderDnaAgent(input: AgentCascadeInput): HardBlockVerdict {
  const reasons: string[] = [];
  const dna = input.traderDna;
  let vetoReason: string | null = null;

  if (dna.emotionalState === "TILT") {
    vetoReason = "operator state is TILT — emotional override blocks all entries";
  } else if (dna.consecutiveLosses >= dna.maxConsecutiveLossesBeforeBlock) {
    vetoReason = `${dna.consecutiveLosses} consecutive losses ≥ block threshold ${dna.maxConsecutiveLossesBeforeBlock} — revenge-trade guard`;
  } else if (dna.minutesSinceLastTrade !== null
             && dna.consecutiveLosses > 0
             && dna.minutesSinceLastTrade < dna.cooldownMinutesAfterLoss) {
    vetoReason = `cooldown active — ${dna.minutesSinceLastTrade}m since last trade < ${dna.cooldownMinutesAfterLoss}m required after loss`;
  }

  if (vetoReason) reasons.push(`VETO: ${vetoReason}`);
  else reasons.push(`operator state ${dna.emotionalState}, ${dna.consecutiveLosses} recent losses, cooldown clear`);

  return { agentId: "L1.DNA", agentName: "Trader DNA Agent", vetoed: vetoReason !== null, vetoReason, reasons };
}

// ── Level runner ──────────────────────────────────────────────────────────
//
// Runs all four hard-block agents and aggregates. Does NOT short-circuit on
// the first veto — surfaces every reason the trade is blocked at once so
// the operator sees the full picture.
export function runLevel1(input: AgentCascadeInput): Level1Result {
  const verdicts = [
    evaluateRiskAgent(input),
    evaluateExecutionAgent(input),
    evaluateNewsAgent(input),
    evaluateTraderDnaAgent(input),
  ];
  const vetoed = verdicts.filter((v) => v.vetoed);
  return {
    verdicts,
    anyVeto: vetoed.length > 0,
    vetoers: vetoed.map((v) => v.agentName),
  };
}
