import { z } from "zod/v4";

// ── 10 sensors ────────────────────────────────────────────────────────────
export const SensorNameSchema = z.enum([
  "price",
  "candles",
  "spread",
  "volume",
  "session",
  "news",
  "mt5Latency",
  "accountRisk",
  "openTrades",
  "userBehavior",
]);
export type SensorName = z.infer<typeof SensorNameSchema>;

export const ALL_SENSORS: ReadonlyArray<SensorName> = [
  "price", "candles", "spread", "volume", "session",
  "news", "mt5Latency", "accountRisk", "openTrades", "userBehavior",
];

// ── Common reading shape ──────────────────────────────────────────────────
export interface SensorHealth {
  isHealthy: boolean;
  isStale: boolean;
  ageSeconds: number | null;     // null = no timestamp available
  reasons: string[];
}

export interface SensorReading<T> {
  sensor: SensorName;
  value: T | null;               // null = no data available
  health: SensorHealth;
  warnings: string[];
  blockers: string[];
  capturedAt: string;            // ISO of when this reading was produced
}

// ── Per-sensor value schemas (Type = z.infer<typeof Schema>) ──────────────

export const PriceTickSchema = z.object({
  symbol: z.string(),
  bid: z.number(),
  ask: z.number(),
  mid: z.number(),
  timestamp: z.string(),
});
export type PriceTick = z.infer<typeof PriceTickSchema>;

export const CandleSchema = z.object({
  timestamp: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});
export type Candle = z.infer<typeof CandleSchema>;

export const CandleStreamHealthSchema = z.object({
  symbol: z.string(),
  timeframe: z.string(),
  count: z.number(),
  latest: CandleSchema.nullable(),
  gapsDetected: z.number(),
  ohlcViolations: z.number(),
});
export type CandleStreamHealth = z.infer<typeof CandleStreamHealthSchema>;

export const SpreadReadingSchema = z.object({
  symbol: z.string(),
  currentPips: z.number(),
  averagePips: z.number(),
  ratio: z.number(),             // currentPips / averagePips
});
export type SpreadReading = z.infer<typeof SpreadReadingSchema>;

export const VolumeReadingSchema = z.object({
  symbol: z.string(),
  ticksPerSecondNow: z.number(),
  ticksPerSecondAvg: z.number(),
  windowSeconds: z.number(),
  isDeadMarket: z.boolean(),
});
export type VolumeReading = z.infer<typeof VolumeReadingSchema>;

export const SessionKindSchema = z.enum([
  "ASIA", "LONDON", "NEW_YORK", "OVERLAP_LONDON_NY", "OFF_HOURS",
]);
export type SessionKind = z.infer<typeof SessionKindSchema>;

export const SessionReadingSchema = z.object({
  kind: SessionKindSchema,
  utcHour: z.number(),
  minutesSinceOpen: z.number(),
  minutesUntilClose: z.number(),
});
export type SessionReading = z.infer<typeof SessionReadingSchema>;

export const NewsImpactSchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type NewsImpact = z.infer<typeof NewsImpactSchema>;

export const NewsEventSchema = z.object({
  id: z.string(),
  title: z.string(),
  currency: z.string(),
  impact: NewsImpactSchema,
  scheduledAt: z.string(),
});
export type NewsEvent = z.infer<typeof NewsEventSchema>;

export const NewsReadingSchema = z.object({
  upcoming: z.array(NewsEventSchema),
  inWindow: z.array(NewsEventSchema),    // events within blackout window
  blackoutMinutesBefore: z.number(),
  blackoutMinutesAfter: z.number(),
});
export type NewsReading = z.infer<typeof NewsReadingSchema>;

export const Mt5LatencyReadingSchema = z.object({
  samples: z.number(),
  p50Ms: z.number(),
  p95Ms: z.number(),
  avgMs: z.number(),
  lastRoundtripMs: z.number().nullable(),
  lastObservedAt: z.string().nullable(),
});
export type Mt5LatencyReading = z.infer<typeof Mt5LatencyReadingSchema>;

export const AccountRiskReadingSchema = z.object({
  balance: z.number(),
  equity: z.number(),
  marginUsed: z.number(),
  marginFree: z.number(),
  marginLevelPct: z.number().nullable(),     // null when marginUsed = 0
  drawdownPct: z.number(),                   // (peak-equity - equity) / peak-equity * 100
  freeMarginPct: z.number(),
});
export type AccountRiskReading = z.infer<typeof AccountRiskReadingSchema>;

export const OpenPositionSchema = z.object({
  ticket: z.string(),
  symbol: z.string(),
  direction: z.enum(["BUY", "SELL"]),
  volume: z.number(),
  unrealizedPnL: z.number(),
  openedAt: z.string(),
});
export type OpenPosition = z.infer<typeof OpenPositionSchema>;

export const OpenTradesReadingSchema = z.object({
  positions: z.array(OpenPositionSchema),
  totalCount: z.number(),
  totalVolume: z.number(),
  totalUnrealizedPnL: z.number(),
  symbolConcentration: z.record(z.string(), z.number()),  // symbol → count
  netDirectional: z.number(),                              // BUY - SELL volume
});
export type OpenTradesReading = z.infer<typeof OpenTradesReadingSchema>;

export const UserActionKindSchema = z.enum([
  "MANUAL_OPEN", "MANUAL_CLOSE", "OVERRIDE_BLOCK", "OVERRIDE_RISK",
  "PANIC_BUTTON", "STRATEGY_TOGGLE", "RISK_PARAM_CHANGE", "BOT_PAUSE", "BOT_RESUME",
]);
export type UserActionKind = z.infer<typeof UserActionKindSchema>;

export const UserActionSchema = z.object({
  kind: UserActionKindSchema,
  timestamp: z.string(),
  detail: z.string().optional(),
});
export type UserAction = z.infer<typeof UserActionSchema>;

export const UserBehaviorReadingSchema = z.object({
  windowMinutes: z.number(),
  actions: z.array(UserActionSchema),
  actionsPerMinute: z.number(),
  recentOverrides: z.number(),
  recentPanics: z.number(),
  rapidFire: z.boolean(),
});
export type UserBehaviorReading = z.infer<typeof UserBehaviorReadingSchema>;

// ── Ports — typed IO interfaces. Domain engines are pure; the API server
//    (or any caller) implements these to wire real data feeds.
export interface PriceSensorPort {
  getLatestTick(symbol: string): Promise<{ bid: number; ask: number; timestamp: string } | null>;
}
export interface CandleSensorPort {
  getRecentCandles(symbol: string, timeframe: string, count: number): Promise<Candle[]>;
}
export interface SpreadSensorPort {
  getCurrentSpread(symbol: string): Promise<{ pips: number; timestamp: string } | null>;
  getAverageSpreadPips(symbol: string): Promise<number | null>;
}
export interface VolumeSensorPort {
  getRecentTickCount(symbol: string, windowSeconds: number): Promise<{ ticks: number; observedAt: string } | null>;
  getAverageTicksPerSecond(symbol: string): Promise<number | null>;
}
export interface NewsSensorPort {
  getUpcomingEvents(currencies: string[], lookaheadMinutes: number): Promise<NewsEvent[]>;
}
export interface Mt5LatencySensorPort {
  getRecentSamples(windowSeconds: number): Promise<number[]>;     // ms samples
  getLastObservedAt(): Promise<string | null>;
}
export interface AccountRiskSensorPort {
  getAccountSnapshot(): Promise<{
    balance: number; equity: number;
    marginUsed: number; marginFree: number;
    peakEquity: number; observedAt: string;
  } | null>;
}
export interface OpenTradesSensorPort {
  getOpenPositions(): Promise<{ positions: OpenPosition[]; observedAt: string }>;
}
export interface UserBehaviorSensorPort {
  getRecentActions(windowMinutes: number): Promise<UserAction[]>;
}

// ── Aggregated snapshot — every reading in one place ──────────────────────
export interface LiveInputsSnapshot {
  capturedAt: string;
  readings: {
    price:        SensorReading<PriceTick>;
    candles:      SensorReading<CandleStreamHealth>;
    spread:       SensorReading<SpreadReading>;
    volume:       SensorReading<VolumeReading>;
    session:      SensorReading<SessionReading>;
    news:         SensorReading<NewsReading>;
    mt5Latency:   SensorReading<Mt5LatencyReading>;
    accountRisk:  SensorReading<AccountRiskReading>;
    openTrades:   SensorReading<OpenTradesReading>;
    userBehavior: SensorReading<UserBehaviorReading>;
  };
  allHealthy: boolean;
  blockers: string[];
  warnings: string[];
}

// ── Default staleness thresholds (seconds) ────────────────────────────────
export const DEFAULT_STALENESS_SECONDS: Record<SensorName, number> = {
  price:        2,
  candles:      120,    // depends on TF; caller can override
  spread:       5,
  volume:       10,
  session:      Number.POSITIVE_INFINITY,   // derived from clock, never stale
  news:         60,
  mt5Latency:   30,
  accountRisk:  10,
  openTrades:   5,
  userBehavior: 60,
};
