import { z } from "zod/v4";

export const Mt5ModeSchema = z.enum(["MOCK", "DEMO", "LIVE_LOCKED", "LIVE"]);
export type Mt5Mode = z.infer<typeof Mt5ModeSchema>;

export const Mt5StatusSchema = z.enum(["CONNECTED", "DISCONNECTED", "DELAYED", "ERROR"]);
export type Mt5Status = z.infer<typeof Mt5StatusSchema>;

export const Mt5AccountSchema = z.object({
  accountNumber: z.string(),
  brokerName: z.string().nullable().optional(),
  currency: z.string().default("USD"),
  balance: z.number(),
  equity: z.number(),
  margin: z.number(),
  freeMargin: z.number(),
  leverage: z.number().int().positive().nullable().optional(),
});
export type Mt5Account = z.infer<typeof Mt5AccountSchema>;

export const Mt5PositionSchema = z.object({
  ticket: z.union([z.string(), z.number()]),
  symbol: z.string(),
  direction: z.enum(["BUY", "SELL"]),
  lotSize: z.number().positive(),
  openPrice: z.number(),
  currentPrice: z.number(),
  stopLoss: z.number().nullable().optional(),
  takeProfit: z.number().nullable().optional(),
  pnl: z.number(),
  swap: z.number().default(0),
  commission: z.number().default(0),
});
export type Mt5Position = z.infer<typeof Mt5PositionSchema>;

export const Mt5ConnectionStateSchema = z.object({
  status: Mt5StatusSchema,
  mode: Mt5ModeSchema,
  lastHeartbeatMs: z.number().nullable(),
  account: Mt5AccountSchema.nullable(),
});
export type Mt5ConnectionState = z.infer<typeof Mt5ConnectionStateSchema>;
