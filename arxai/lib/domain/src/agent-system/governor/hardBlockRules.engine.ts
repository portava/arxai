import {
  type AgentSystemSnapshot, type HardBlockRule,
  AGENT_SYSTEM_THRESHOLDS,
} from "../agentSystem.types";

// Hard Block Rules — INVIOLABLE rules the governor evaluates independently
// of the agents. These are policy, not analysis: even if every agent
// approves, a fired hard-block rule rejects the trade.
//
// Each rule is a pure predicate over the snapshot. The governor runs all
// rules and surfaces all that fired — operator sees the complete picture.
export function getHardBlockRules(): HardBlockRule[] {
  return [
    {
      ruleId: "DRAWDOWN_CAP",
      description: "Account drawdown must remain below the policy ceiling",
      evaluate: (s) => s.account.drawdownPct >= s.policy.maxDrawdownPct
        ? { fired: true, reason: `drawdown ${s.account.drawdownPct.toFixed(2)}% ≥ ceiling ${s.policy.maxDrawdownPct.toFixed(2)}%` }
        : { fired: false, reason: null },
    },
    {
      ruleId: "DAILY_LOSS_LIMIT",
      description: "Daily P&L must remain above the daily loss floor",
      evaluate: (s) => s.account.dailyPnLPct <= s.policy.dailyLossLimitPct
        ? { fired: true, reason: `daily PnL ${s.account.dailyPnLPct.toFixed(2)}% past limit ${s.policy.dailyLossLimitPct.toFixed(2)}%` }
        : { fired: false, reason: null },
    },
    {
      ruleId: "OPEN_TRADES_CAP",
      description: "Concurrent open trades must not exceed the policy ceiling",
      evaluate: (s) => s.account.openTradesCount >= s.policy.maxConcurrentTrades
        ? { fired: true, reason: `${s.account.openTradesCount} open trades at ceiling ${s.policy.maxConcurrentTrades}` }
        : { fired: false, reason: null },
    },
    {
      ruleId: "PER_TRADE_RISK_CAP",
      description: "Per-trade risk must not exceed policy ceiling",
      evaluate: (s) => s.setup.proposedRiskPct > s.policy.maxSingleTradeRiskPct
        ? { fired: true, reason: `risk ${s.setup.proposedRiskPct.toFixed(2)}% > ceiling ${s.policy.maxSingleTradeRiskPct.toFixed(2)}%` }
        : { fired: false, reason: null },
    },
    {
      ruleId: "TILT_LOCKOUT",
      description: "Operator must not be in TILT state",
      evaluate: (s) => s.behavior.emotionalState === "TILT"
        ? { fired: true, reason: "operator state is TILT" }
        : { fired: false, reason: null },
    },
    {
      ruleId: "COOLDOWN_VIOLATION",
      description: "Cooldown after recent loss must elapse",
      evaluate: (s) => {
        if (s.behavior.minutesSinceLastTrade !== null
            && s.behavior.consecutiveLosses > 0
            && s.behavior.minutesSinceLastTrade < s.policy.cooldownMinutesAfterLoss) {
          return { fired: true,
            reason: `cooldown — ${s.behavior.minutesSinceLastTrade}m < required ${s.policy.cooldownMinutesAfterLoss}m` };
        }
        return { fired: false, reason: null };
      },
    },
    {
      ruleId: "BROKER_DISCONNECTED",
      description: "Broker connection must be live",
      evaluate: (s) => !s.execution.brokerConnected
        ? { fired: true, reason: "broker not connected" }
        : { fired: false, reason: null },
    },
    {
      ruleId: "MARKET_CLOSED",
      description: "Market must be open",
      evaluate: (s) => !s.market.marketOpen
        ? { fired: true, reason: "market closed" }
        : { fired: false, reason: null },
    },
    {
      ruleId: "SPREAD_PROHIBITIVE",
      description: "Spread must not be execution-prohibitive",
      evaluate: (s) => s.market.spreadPips >= AGENT_SYSTEM_THRESHOLDS.execution.spreadProhibitivePips
        ? { fired: true, reason: `spread ${s.market.spreadPips.toFixed(1)}p ≥ ${AGENT_SYSTEM_THRESHOLDS.execution.spreadProhibitivePips}p` }
        : { fired: false, reason: null },
    },
    {
      ruleId: "NEWS_BLACKOUT",
      description: "No HIGH-impact news inside the symbol blackout window",
      evaluate: (s) => {
        for (const ev of s.news.upcomingEvents) {
          if (!ev.affectsSymbol || ev.severity !== "HIGH") continue;
          if (ev.minutesUntil >= 0 && ev.minutesUntil <= s.news.blackoutMinutesBeforeHigh) {
            return { fired: true, reason: `HIGH news "${ev.title}" in ${ev.minutesUntil}m` };
          }
          if (ev.minutesUntil < 0 && Math.abs(ev.minutesUntil) <= s.news.blackoutMinutesAfterHigh) {
            return { fired: true, reason: `HIGH news "${ev.title}" was ${Math.abs(ev.minutesUntil)}m ago` };
          }
        }
        return { fired: false, reason: null };
      },
    },
  ];
}
