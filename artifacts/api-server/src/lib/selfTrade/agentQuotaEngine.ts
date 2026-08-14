// Self-Trade AI — Agent Quota Engine (Task #211, Foundation).
//
// Pure computation of an agent's daily trade quota: daily minimum (default 3),
// base maximum (default 5), and an opt-in extension. Returns how many trades
// remain for the day given a count already taken. It DOES NOT execute, queue,
// or schedule anything — later phases consume this verdict; the foundation only
// computes it so the control room can display it.

import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db, selfTradeAgentExecutionsTable, type SelfTradeAgentSettings } from "@workspace/db";

export interface QuotaInput {
  dailyMinTrades: number;
  baseMaxTrades: number;
  extensionEnabled: boolean;
  extensionMaxTrades: number;
  tradesTakenToday: number;
}

export interface QuotaVerdict {
  dailyMinTrades: number;
  baseMaxTrades: number;
  effectiveMaxTrades: number;
  tradesTakenToday: number;
  remainingToBase: number;
  remainingToMax: number;
  belowDailyMinimum: boolean;
  baseReached: boolean;
  extensionActive: boolean;
  hardCapReached: boolean;
}

export function computeQuota(input: QuotaInput): QuotaVerdict {
  const dailyMinTrades = Math.max(0, Math.floor(input.dailyMinTrades));
  const baseMaxTrades = Math.max(0, Math.floor(input.baseMaxTrades));
  const extensionMax = input.extensionEnabled
    ? Math.max(0, Math.floor(input.extensionMaxTrades))
    : 0;
  const effectiveMaxTrades = baseMaxTrades + extensionMax;
  const taken = Math.max(0, Math.floor(input.tradesTakenToday));

  const remainingToBase = Math.max(0, baseMaxTrades - taken);
  const remainingToMax = Math.max(0, effectiveMaxTrades - taken);

  return {
    dailyMinTrades,
    baseMaxTrades,
    effectiveMaxTrades,
    tradesTakenToday: taken,
    remainingToBase,
    remainingToMax,
    belowDailyMinimum: taken < dailyMinTrades,
    baseReached: taken >= baseMaxTrades,
    extensionActive: input.extensionEnabled && taken >= baseMaxTrades && remainingToMax > 0,
    hardCapReached: taken >= effectiveMaxTrades,
  };
}

// Convenience over a settings row.
export function computeQuotaFromSettings(
  settings: Pick<
    SelfTradeAgentSettings,
    "dailyMinTrades" | "baseMaxTrades" | "extensionEnabled" | "extensionMaxTrades"
  >,
  tradesTakenToday: number,
): QuotaVerdict {
  return computeQuota({
    dailyMinTrades: settings.dailyMinTrades,
    baseMaxTrades: settings.baseMaxTrades,
    extensionEnabled: settings.extensionEnabled,
    extensionMaxTrades: settings.extensionMaxTrades,
    tradesTakenToday,
  });
}

// Start of the current UTC day. Quota is a per-UTC-day budget so it is stable
// regardless of server locale.
export function startOfUtcDay(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Count an agent's REAL trades taken today, from actual fills only — executions
 * that reached FILLED or CLOSED with a fill stamped today. Intents, blocked
 * attempts, and prepared-but-undispatched drafts are NEVER counted. This is the
 * authoritative quota-consumed number (Task #213).
 */
export async function countAgentFilledTradesToday(
  agentId: number,
  now: Date = new Date(),
): Promise<number> {
  const start = startOfUtcDay(now);
  const rows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(selfTradeAgentExecutionsTable)
    .where(
      and(
        eq(selfTradeAgentExecutionsTable.agentId, agentId),
        inArray(selfTradeAgentExecutionsTable.status, ["FILLED", "CLOSED"]),
        gte(selfTradeAgentExecutionsTable.filledAt, start),
      ),
    );
  return rows[0]?.c ?? 0;
}
