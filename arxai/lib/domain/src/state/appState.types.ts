import { z } from "zod/v4";

// Re-use canonical types from sibling subdomains so the state shape is the
// single source of truth — no parallel definitions to drift.
import {
  TradeSchema,
  TradeStatusSchema,
  TradeDirectionSchema,
} from "../trade/trade.types";
import type { TradeHealthReport } from "../trade/tradeHealth.engine";
import type { TradeRiskBreakdown } from "../trade/tradeRisk.engine";

import type { MarketRegime, RegimeReport } from "../market/marketRegime.engine";
import type { VolatilityReport } from "../market/volatility.engine";
import type { Session, SessionReport } from "../market/session.engine";
import type { LiquidityReport } from "../market/liquidity.engine";

import { AiDecisionSchema, AiInsightSchema } from "../ai/aiInsight.types";
import type { MemorySummary } from "../ai/aiMemory.engine";

import {
  Mt5ModeSchema,
  Mt5StatusSchema,
  Mt5AccountSchema,
  Mt5ConnectionStateSchema,
} from "../broker/mt5.types";
import type { BrokerHealthReport } from "../broker/brokerStatus.engine";
import type { ExecutionQualityReport } from "../broker/executionQuality.engine";

import { RiskProfileSchema } from "../risk/riskProfile.types";
import type { DrawdownReport } from "../risk/drawdownGuard.engine";
import type { ExposureReport } from "../risk/exposure.engine";

// ── 1. Session (bot operational state) ──────────────────────────────────────
export const BotRunStateSchema = z.enum(["STOPPED", "RUNNING", "PAUSED", "KILL_SWITCHED"]);
export type BotRunState = z.infer<typeof BotRunStateSchema>;

export const TradingSessionStateSchema = z.object({
  runState: BotRunStateSchema,
  mode: Mt5ModeSchema,           // MOCK | DEMO | LIVE_LOCKED | LIVE
  startedAt: z.string().nullable(),     // ISO string or null when stopped
  lastScanAt: z.string().nullable(),
  scansThisSession: z.number().int().nonnegative(),
  uptimeSeconds: z.number().nonnegative(),
  killSwitchEngagedAt: z.string().nullable(),
});
export type TradingSessionState = z.infer<typeof TradingSessionStateSchema>;

// ── 2. Broker connection ────────────────────────────────────────────────────
// Re-export the canonical MT5 connection schema as the broker slice, plus a
// derived health report computed by `evaluateBrokerHealth`.
export const BrokerConnectionStateSchema = z.object({
  connection: Mt5ConnectionStateSchema,
  health: z.object({
    status: Mt5StatusSchema,
    isHealthy: z.boolean(),
    isStale: z.boolean(),
    ageSeconds: z.number().nullable(),
    reasons: z.array(z.string()),
  }),
  execution: z.object({
    sampleCount: z.number().int().nonnegative(),
    avgSlippagePips: z.number().nullable(),
    avgLatencyMs: z.number().nonnegative(),
    qualityScore: z.number().min(0).max(100),
  }).nullable(),
});
export type BrokerConnectionState = z.infer<typeof BrokerConnectionStateSchema>;

// ── 3. Market (per-symbol snapshot + global session) ────────────────────────
export interface SymbolMarketSnapshot {
  symbol: string;
  lastPrice: number;
  regime: RegimeReport;
  volatility: VolatilityReport;
  liquidity: LiquidityReport;
  updatedAt: string;             // ISO
}

export interface MarketState {
  fxSession: SessionReport;      // current FX session (LONDON/NY/etc)
  watchlist: SymbolMarketSnapshot[];
  // Optional global regime if the app blends signals across symbols.
  blendedRegime?: MarketRegime;
}

// ── 4. Account ──────────────────────────────────────────────────────────────
export const AccountStateSchema = z.object({
  account: Mt5AccountSchema.nullable(),
  startingDailyBalance: z.number(),
  startingWeeklyBalance: z.number(),
  realizedPnLToday: z.number(),
  realizedPnLWeek: z.number(),
  unrealizedPnL: z.number(),
  openTradeCount: z.number().int().nonnegative(),
});
export type AccountState = z.infer<typeof AccountStateSchema>;

// ── 5. Trades ───────────────────────────────────────────────────────────────
// A `TradeState` is a Trade enriched with engine-computed health/risk views.
// The trade itself comes from the DB; health/risk are computed at read time.
export interface TradeState {
  trade: z.infer<typeof TradeSchema>;
  health: TradeHealthReport | null;
  risk: TradeRiskBreakdown | null;
}

// ── 6. Signals ──────────────────────────────────────────────────────────────
export const SignalActionSchema = z.enum(["BUY", "SELL", "WAIT", "AVOID"]);
export type SignalAction = z.infer<typeof SignalActionSchema>;

export const SignalStateSchema = z.object({
  id: z.union([z.string(), z.number()]),
  symbol: z.string(),
  action: SignalActionSchema,
  direction: TradeDirectionSchema.nullable(),
  strategy: z.string(),
  confidence: z.number().min(0).max(100),
  entry: z.number().nullable(),
  stopLoss: z.number().nullable(),
  takeProfit: z.number().nullable(),
  reasons: z.array(z.string()),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  consumedByTradeId: z.union([z.string(), z.number()]).nullable(),
});
export type SignalState = z.infer<typeof SignalStateSchema>;

// ── 7. AI ───────────────────────────────────────────────────────────────────
export interface AIState {
  lastDecision: z.infer<typeof AiDecisionSchema> | null;
  recentInsights: z.infer<typeof AiInsightSchema>[];
  memory: MemorySummary | null;
}

// ── 8. Risk ─────────────────────────────────────────────────────────────────
export interface RiskState {
  profile: z.infer<typeof RiskProfileSchema>;
  drawdown: DrawdownReport | null;
  exposure: ExposureReport | null;
}

// ── Unified app state ───────────────────────────────────────────────────────
export interface TradingAppState {
  session: TradingSessionState;
  broker: BrokerConnectionState;
  market: MarketState;
  account: AccountState;
  trades: TradeState[];
  signals: SignalState[];
  ai: AIState;
  risk: RiskState;
}

// Re-export the helper report types so consumers can `import type` everything
// state-related from a single entry point.
export type {
  TradeHealthReport,
  TradeRiskBreakdown,
  RegimeReport,
  VolatilityReport,
  SessionReport,
  LiquidityReport,
  BrokerHealthReport,
  ExecutionQualityReport,
  DrawdownReport,
  ExposureReport,
  MemorySummary,
  Session,
  MarketRegime,
};
