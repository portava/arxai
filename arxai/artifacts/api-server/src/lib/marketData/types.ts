// Build DD — Market Data Types.
//
// SAFETY: read-only domain. None of these types describe order placement,
// broker writes, or live execution. Used by Build AA orchestrator to ground
// trade decisions in real (or clearly-labeled fallback) market data.

export type MarketDataSource = "REAL" | "FALLBACK" | "MOCK";

export type LiquidityLevel = "LOW" | "NORMAL" | "HIGH";
export type VolatilityLevel = "LOW" | "NORMAL" | "HIGH" | "EXTREME";
// "SYNTHETIC" — data was invented in-process (fallback generator). It is never
// GOOD: decision-capable consumers must treat it as blocked (computeBlockers
// emits a CRITICAL blocker for it); display-only consumers must label it.
export type DataQualityStatus = "GOOD" | "DEGRADED" | "MISSING" | "SYNTHETIC";
export type Timeframe = "M1" | "M5" | "M15" | "M30" | "H1" | "H4" | "D1";
export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface MarketCandle {
  time: string; // ISO8601
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SessionContext {
  sessionName: string;
  isMarketOpen: boolean;
  liquidityLevel: LiquidityLevel;
  volatilityLevel: VolatilityLevel;
}

export interface DataQuality {
  status: DataQualityStatus;
  latencyMs: number;
  candlesAvailable: number;
  warnings: string[];
}

export interface MarketDataSnapshot {
  symbol: string;
  source: MarketDataSource;
  provider: string;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  timestamp: string; // ISO8601 of quote
  timeframe: Timeframe;
  candles: MarketCandle[];
  sessionContext: SessionContext;
  dataQuality: DataQuality;
}

export interface MarketDataBlocker {
  blocked: boolean;
  reason: string;
  severity: Severity;
}

export interface MarketDataRequest {
  symbol: string;
  timeframe?: Timeframe;
  limit?: number;
}

export interface MarketDataProvider {
  readonly name: string;
  readonly source: MarketDataSource;
  isConfigured(): boolean;
  fetch(req: Required<Pick<MarketDataRequest, "symbol" | "timeframe" | "limit">>): Promise<MarketDataSnapshot>;
  health(): Promise<{ ok: boolean; detail: string; latencyMs: number }>;
}
