import { z } from "zod/v4";

export const TradeDirectionSchema = z.enum(["BUY", "SELL"]);
export type TradeDirection = z.infer<typeof TradeDirectionSchema>;

export const TradeStatusSchema = z.enum([
  "PENDING",     // plan created, awaiting trigger
  "OPEN",        // filled, in market
  "MANAGING",    // open + active management (BE/trail/partial)
  "CLOSED_WIN",
  "CLOSED_LOSS",
  "CLOSED_BREAKEVEN",
  "CANCELLED",
  "EXPIRED",
]);
export type TradeStatus = z.infer<typeof TradeStatusSchema>;

export const TradeSchema = z.object({
  id: z.union([z.string(), z.number()]),
  symbol: z.string(),
  direction: TradeDirectionSchema,
  status: TradeStatusSchema,
  entryPrice: z.number(),
  stopLoss: z.number(),
  takeProfit: z.number().nullable().optional(),
  lotSize: z.number().positive(),
  openedAt: z.union([z.date(), z.string()]),
  closedAt: z.union([z.date(), z.string()]).nullable().optional(),
  pnl: z.number().nullable().optional(),
  rMultiple: z.number().nullable().optional(),
});
export type Trade = z.infer<typeof TradeSchema>;

export interface TradeSnapshot {
  trade: Trade;
  currentPrice: number;
  highSinceOpen: number;
  lowSinceOpen: number;
  // seconds since trade.openedAt
  ageSeconds: number;
}

// Outcome of a single management decision applied to an open trade.
export interface TradeManagementAction {
  kind: "MOVE_SL" | "MOVE_TP" | "PARTIAL_CLOSE" | "FULL_CLOSE" | "TRAIL" | "HOLD";
  newStopLoss?: number;
  newTakeProfit?: number;
  closeFraction?: number; // 0..1
  reason: string;
}
