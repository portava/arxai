// Build FF — Safe Paper Autopilot types.
//
// SAFETY: paper-only. No live execution surfaces referenced.

export type AutopilotCycleStatus = "RUNNING" | "COMPLETED" | "SKIPPED" | "FAILED" | "STOPPED";
export type SniperStatus = "PASS" | "WAIT" | "REJECT";
export type LoopState = "IDLE" | "RUNNING" | "STOPPING";

export interface AutopilotSettings {
  enabled: boolean;
  mode: "PAPER_ONLY";
  symbols: string[];
  timeframes: string[];
  intervalSeconds: number;
  maxCyclesPerStart: number;
  maxOpenPaperTrades: number;
  maxSameSymbolTrades: number;
  maxDailyPaperLoss: number;
  minConfidence: number;
  maxRiskScore: number;
  minSniperEntryScore: number;
  cooldownMinutesAfterTrade: number;
  cooldownMinutesAfterLoss: number;
  paperOnly: true;
  liveTradingAllowed: false;
}

export interface SniperResult {
  sniperEntryScore: number;
  status: SniperStatus;
  reasons: string[];
  blockers: string[];
  warnings: string[];
  components: Record<string, number>;
}

export interface AutopilotCycleSummary {
  autopilot_cycle_id: string;
  mode: "PAPER_ONLY";
  status: AutopilotCycleStatus;
  started_at: string;
  finished_at: string | null;
  symbols_checked: number;
  decisions_created: number;
  paper_trades_opened: number;
  paper_trades_rejected: number;
  paper_trades_monitored: number;
  paper_trades_closed: number;
  debriefs_triggered: number;
  learning_events_triggered: number;
  warnings: string[];
  errors: string[];
  per_symbol: Array<{
    symbol: string;
    timeframe: string;
    aaAction: string;
    aaConfidence: number;
    aaRiskScore: number;
    sniper: SniperResult;
    eePaperResult: string | null;
    paperTradeId: number | null;
    decisionId: number | null;
    skippedReason: string | null;
  }>;
}
