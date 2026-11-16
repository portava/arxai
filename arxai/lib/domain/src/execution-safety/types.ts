// Build F — Live Execution Safety Layer. Pure types.

export type ChecklistDirection = "BUY" | "SELL";
export type ChecklistEntryType = "MARKET" | "LIMIT" | "STOP";
export type ChecklistMarketCondition = "TRENDING" | "RANGING" | "NO_TRADE" | "UNKNOWN";
export type ChecklistPermissionStatus = "CLEAR" | "CAUTION" | "LOCKED" | "LIVE_TRADING_DISABLED";
export type ChecklistVerdict = "APPROVED" | "WARN" | "BLOCKED";

export interface ChecklistInputs {
  // Order intent
  symbol: string;
  direction: ChecklistDirection;
  lotSize: number;
  entryType: ChecklistEntryType;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;

  // Risk policy
  maxLotSize: number;
  maxRiskPerTradePct: number;     // e.g. 2 means 2% of balance
  accountBalance: number;         // dollars

  // Live state
  permissionStatus: ChecklistPermissionStatus;
  permissionBlockers: string[];   // bubbled up from Build D verdict
  brokerConnected: boolean;
  marketCondition: ChecklistMarketCondition;
  spreadPips: number | null;      // null => unknown
  maxAcceptableSpreadPips: number;
  practiceMode: boolean;          // true => replay/practice, MUST NOT execute live

  // AI metadata
  aiConfidence?: number | null;   // 0..100
  fitScore?: number | null;       // 0..100
  minConfidence?: number;         // e.g. 60
}

export interface ChecklistReason {
  code: string;
  severity: "BLOCK" | "WARN" | "INFO";
  message: string;
}

export interface ChecklistResult {
  verdict: ChecklistVerdict;
  estimatedRisk: number;          // dollars
  rewardToRisk: number;           // tp_distance / sl_distance
  pricedSlDistance: number;
  pricedTpDistance: number;
  reasons: ChecklistReason[];
  warnings: string[];
  blockers: string[];
}
