// ── Compliance copy — single source of truth ───────────────────────────────
// Every disclaimer surfaced to the user lives here so legal language stays
// consistent across pages, modals, and footers.

export const COMPLIANCE = {
  // 1) App-wide footer
  footer: {
    title: "Trading risk disclosure",
    body:
      "Trading involves substantial risk. This platform provides analysis, automation tools, and educational insights only. " +
      "No signal, AI output, or strategy guarantees profit. Decision support only — confirm live readiness and risk before trading.",
  },

  // 2) Live trading unlock confirmation
  liveUnlock: {
    title: "Enable LIVE trading?",
    body:
      "You are about to enable live trading. This can place real trades through MT5 and may result in financial loss. " +
      "Confirm that you understand the risk, have tested in demo mode, and accept responsibility for all trades.",
    confirmLabel: "I accept — enable live",
    cancelLabel: "Stay in demo",
  },

  // 3) AI assistant / brain warning
  aiAssistant: {
    title: "AI analysis is probabilistic",
    body:
      "AI analysis is probabilistic, not certain. The assistant may be wrong. " +
      "Risk controls should always override trade ideas.",
  },

  // 4) Backtest warning
  backtest: {
    title: "Hypothetical results",
    body:
      "Backtest results are hypothetical and do not guarantee future performance. " +
      "Slippage, spreads, liquidity, execution speed, and market conditions can change results.",
  },

  // 5) Entry Sniper warning
  entrySniper: {
    title: "Highest-probability windows, not perfect entries",
    body:
      "Entry Sniper identifies high-probability entry windows, not perfect entries. " +
      "Missed trades should not be chased.",
  },

  // 6) Risk center reminder (uses footer copy + extra emphasis)
  riskCenter: {
    title: "The risk manager has final authority",
    body:
      "Risk limits below are enforced by the platform's risk manager and override every signal, AI suggestion, and manual order. " +
      "Loosening these limits increases the chance of significant losses.",
  },

  // 7) MT5 bridge reminder
  mt5Bridge: {
    title: "Bridge controls real trade execution",
    body:
      "When connected and unlocked, this bridge can place real orders through your MT5 account. " +
      "Keep DEMO mode enabled until your strategy has been tested and your risk limits are configured.",
  },

  // 8) Onboarding (used when an onboarding screen ships)
  onboarding: {
    title: "Welcome to ARX AI — Analyze. Risk. eXecute.",
    body:
      "This platform is for market research, journaling, analysis, automation, and education. " +
      "It does not promise profit, perfect prediction, or risk-free trading. " +
      "By continuing, you acknowledge that all trading involves substantial risk and that you are responsible for every trade placed through your account.",
  },
} as const;

export type ComplianceKey = keyof typeof COMPLIANCE;
