import { z } from "zod/v4";
import { TradeDirectionSchema, TradeStatusSchema } from "../trade/trade.types";
import { SignalActionSchema } from "../state/appState.types";

// ── Event kind enum (discriminator) ─────────────────────────────────────────
export const DomainEventKindSchema = z.enum([
  "TRADE_OPENED",
  "TRADE_UPDATED",
  "TRADE_CLOSED",
  "SIGNAL_CREATED",
  "RISK_LIMIT_HIT",
  "MT5_DISCONNECTED",
  "MARKET_REGIME_CHANGED",
  "AI_WARNING_CREATED",
  "BOT_PAUSED",
  "BOT_RESUMED",
]);
export type DomainEventKind = z.infer<typeof DomainEventKindSchema>;

// ── Common envelope fields, added to every payload by `domainEvent()` ──────
const baseEnvelope = {
  eventId: z.string(),               // ULID/UUID
  occurredAt: z.string(),            // ISO timestamp
  source: z.string(),                // "api-server" | "scanner" | "mt5-bridge" | …
  correlationId: z.string().nullable().optional(),
};

// ── Per-event payload schemas ───────────────────────────────────────────────
export const TradeOpenedEventSchema = z.object({
  ...baseEnvelope,
  kind: z.literal("TRADE_OPENED"),
  tradeId: z.union([z.string(), z.number()]),
  symbol: z.string(),
  direction: TradeDirectionSchema,
  entryPrice: z.number(),
  stopLoss: z.number(),
  takeProfit: z.number().nullable(),
  lotSize: z.number().positive(),
  strategy: z.string().nullable(),
  signalId: z.union([z.string(), z.number()]).nullable(),
});
export type TradeOpenedEvent = z.infer<typeof TradeOpenedEventSchema>;

export const TradeUpdatedEventSchema = z.object({
  ...baseEnvelope,
  kind: z.literal("TRADE_UPDATED"),
  tradeId: z.union([z.string(), z.number()]),
  changes: z.object({
    stopLoss: z.number().nullable().optional(),
    takeProfit: z.number().nullable().optional(),
    lotSize: z.number().positive().optional(),
    status: TradeStatusSchema.optional(),
  }),
  reason: z.string(),
});
export type TradeUpdatedEvent = z.infer<typeof TradeUpdatedEventSchema>;

export const TradeClosedEventSchema = z.object({
  ...baseEnvelope,
  kind: z.literal("TRADE_CLOSED"),
  tradeId: z.union([z.string(), z.number()]),
  exitPrice: z.number(),
  pnl: z.number(),
  rMultiple: z.number(),
  outcome: z.enum(["CLOSED_WIN", "CLOSED_LOSS", "CLOSED_BREAKEVEN"]),
  closedBy: z.enum(["USER", "TP", "SL", "TRAIL", "MANUAL", "EMERGENCY", "SYSTEM"]),
});
export type TradeClosedEvent = z.infer<typeof TradeClosedEventSchema>;

export const SignalCreatedEventSchema = z.object({
  ...baseEnvelope,
  kind: z.literal("SIGNAL_CREATED"),
  signalId: z.union([z.string(), z.number()]),
  symbol: z.string(),
  action: SignalActionSchema,
  strategy: z.string(),
  confidence: z.number().min(0).max(100),
  entry: z.number().nullable(),
  stopLoss: z.number().nullable(),
  takeProfit: z.number().nullable(),
});
export type SignalCreatedEvent = z.infer<typeof SignalCreatedEventSchema>;

export const RiskLimitKindSchema = z.enum([
  "DAILY_LOSS",
  "WEEKLY_LOSS",
  "LOSING_STREAK",
  "MAX_OPEN_TRADES",
  "MAX_TRADES_PER_DAY",
  "EXPOSURE_PER_SYMBOL",
  "EXPOSURE_PER_CURRENCY",
  "MIN_CONFIDENCE",
]);
export type RiskLimitKind = z.infer<typeof RiskLimitKindSchema>;

export const RiskLimitHitEventSchema = z.object({
  ...baseEnvelope,
  kind: z.literal("RISK_LIMIT_HIT"),
  limit: RiskLimitKindSchema,
  value: z.number(),
  threshold: z.number(),
  blocked: z.boolean(),               // true = action prevented; false = caution only
  message: z.string(),
});
export type RiskLimitHitEvent = z.infer<typeof RiskLimitHitEventSchema>;

export const Mt5DisconnectedEventSchema = z.object({
  ...baseEnvelope,
  kind: z.literal("MT5_DISCONNECTED"),
  lastHeartbeatAt: z.string().nullable(),
  ageSeconds: z.number().nullable(),
  reason: z.string(),
});
export type Mt5DisconnectedEvent = z.infer<typeof Mt5DisconnectedEventSchema>;

export const MarketRegimeChangedEventSchema = z.object({
  ...baseEnvelope,
  kind: z.literal("MARKET_REGIME_CHANGED"),
  symbol: z.string(),
  from: z.string(),                   // previous MarketRegime label
  to: z.string(),                     // new MarketRegime label
  confidence: z.number().min(0).max(100),
});
export type MarketRegimeChangedEvent = z.infer<typeof MarketRegimeChangedEventSchema>;

export const AiWarningSeveritySchema = z.enum(["INFO", "WARN", "CRITICAL"]);
export type AiWarningSeverity = z.infer<typeof AiWarningSeveritySchema>;

export const AiWarningCreatedEventSchema = z.object({
  ...baseEnvelope,
  kind: z.literal("AI_WARNING_CREATED"),
  severity: AiWarningSeveritySchema,
  message: z.string(),
  symbol: z.string().nullable(),
  factors: z.array(z.string()),
});
export type AiWarningCreatedEvent = z.infer<typeof AiWarningCreatedEventSchema>;

export const BotActorSchema = z.enum(["USER", "SYSTEM", "RISK_GUARD", "KILL_SWITCH"]);
export type BotActor = z.infer<typeof BotActorSchema>;

export const BotPausedEventSchema = z.object({
  ...baseEnvelope,
  kind: z.literal("BOT_PAUSED"),
  by: BotActorSchema,
  reason: z.string(),
});
export type BotPausedEvent = z.infer<typeof BotPausedEventSchema>;

export const BotResumedEventSchema = z.object({
  ...baseEnvelope,
  kind: z.literal("BOT_RESUMED"),
  by: BotActorSchema,
  reason: z.string(),
});
export type BotResumedEvent = z.infer<typeof BotResumedEventSchema>;

// ── Discriminated union — the canonical DomainEvent type ────────────────────
export const DomainEventSchema = z.discriminatedUnion("kind", [
  TradeOpenedEventSchema,
  TradeUpdatedEventSchema,
  TradeClosedEventSchema,
  SignalCreatedEventSchema,
  RiskLimitHitEventSchema,
  Mt5DisconnectedEventSchema,
  MarketRegimeChangedEventSchema,
  AiWarningCreatedEventSchema,
  BotPausedEventSchema,
  BotResumedEventSchema,
]);
export type DomainEvent = z.infer<typeof DomainEventSchema>;

// Map from kind → payload type, for typed handlers/dispatchers.
export type DomainEventByKind = {
  TRADE_OPENED: TradeOpenedEvent;
  TRADE_UPDATED: TradeUpdatedEvent;
  TRADE_CLOSED: TradeClosedEvent;
  SIGNAL_CREATED: SignalCreatedEvent;
  RISK_LIMIT_HIT: RiskLimitHitEvent;
  MT5_DISCONNECTED: Mt5DisconnectedEvent;
  MARKET_REGIME_CHANGED: MarketRegimeChangedEvent;
  AI_WARNING_CREATED: AiWarningCreatedEvent;
  BOT_PAUSED: BotPausedEvent;
  BOT_RESUMED: BotResumedEvent;
};
