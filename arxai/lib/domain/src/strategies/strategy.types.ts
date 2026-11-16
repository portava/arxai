import { z } from "zod/v4";
import type { Candle, RegimeReport } from "../market/marketRegime.engine";
import type { VolatilityReport } from "../market/volatility.engine";
import type { SessionReport } from "../market/session.engine";
import type { LiquidityReport } from "../market/liquidity.engine";
import type { NewsWindow } from "../risk/riskGates.types";
import type { TradeDirection } from "../trade/trade.types";
import type { SignalAction } from "../state/appState.types";

// ── Inputs every strategy receives ──────────────────────────────────────────
// Built once per scan tick by the scanner. Pure data — no callbacks.
export interface StrategyInput {
  symbol: string;
  candles: Candle[];           // ordered oldest → newest
  pipSize: number;
  now: Date;

  // Pre-computed market context — strategies must NOT recompute these.
  regime: RegimeReport;
  volatility: VolatilityReport;
  session: SessionReport;
  liquidity: LiquidityReport;
  newsWindows: NewsWindow[];
}

// ── What a strategy emits ───────────────────────────────────────────────────
export interface StrategyProposedSignal {
  action: SignalAction;            // BUY | SELL | WAIT | AVOID
  direction: TradeDirection | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  confidence: number;              // 0..100
  reasons: string[];
}

export interface StrategyResult {
  strategyName: string;
  emitted: boolean;                // false = strategy ran but produced nothing
  signal: StrategyProposedSignal | null;
  rejectedReasons: string[];       // why no signal (for the explainability panel)
}

// ── Strategy contract ───────────────────────────────────────────────────────
export interface Strategy {
  name: string;                    // stable id used in signals.strategy column
  label: string;                   // human-readable
  version: string;                 // bump on logic change
  evaluate(input: StrategyInput): StrategyResult;
}

// ── Schema for serialization (audit log, signal storage) ───────────────────
export const StrategyProposedSignalSchema = z.object({
  action: z.enum(["BUY", "SELL", "WAIT", "AVOID"]),
  direction: z.enum(["BUY", "SELL"]).nullable(),
  entry: z.number().nullable(),
  stopLoss: z.number().nullable(),
  takeProfit: z.number().nullable(),
  confidence: z.number().min(0).max(100),
  reasons: z.array(z.string()),
});

// Helper for strategies that decide not to emit.
export function noSignal(strategyName: string, ...reasons: string[]): StrategyResult {
  return { strategyName, emitted: false, signal: null, rejectedReasons: reasons };
}
