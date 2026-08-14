// MT5BridgeProvider — reads from the existing mt5_state, live_positions, and
// mt5_commands tables that the EA bridge populates via /api/mt5/* endpoints.
//
// SAFETY: This provider is READ-ONLY. It does not write to any of those
// tables. Order placement is centralized in placeLiveOrderGuarded(), which
// still rejects with BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED.

import { db, mt5StateTable, livePositionsTable, mt5CommandsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import type {
  BrokerProvider, BrokerStatus, BrokerAccount, BrokerSymbol, BrokerPosition, BrokerOrder,
} from "./types.js";
import { describeRequiredSecrets, missingRequiredSecrets } from "./secrets.js";

const STALE_AFTER_SECONDS = 60;

function maskAccount(id: string | null | undefined): string {
  if (!id) return "•••";
  if (id.length <= 4) return "•".repeat(id.length);
  return `${id.slice(0, 2)}${"•".repeat(Math.max(3, id.length - 4))}${id.slice(-2)}`;
}

export class MT5BridgeProvider implements BrokerProvider {
  readonly kind = "mt5" as const;

  private async loadState() {
    const rows = await db.select().from(mt5StateTable).limit(1);
    return rows[0] ?? null;
  }

  async status(): Promise<BrokerStatus> {
    const reqs = describeRequiredSecrets("mt5");
    const missing = missingRequiredSecrets(reqs);
    if (missing.length > 0) {
      return {
        kind: this.kind,
        connected: false,
        health: { connected: false, lastHeartbeatAt: null, staleSeconds: null, reason: `Missing required secret(s): ${missing.map(m => m.key).join(", ")}` },
        environment: "NOT_CONFIGURED",
        liveTradingAllowed: false,
        canPlaceLiveTrade: false,
        missingSecrets: reqs,
        notes: [
          "MT5 bridge is not configured. Add the missing secret(s) via Replit Secrets.",
          "Until configured, /api/mt5/* bridge endpoints fail-closed with HTTP 503.",
        ],
      };
    }

    const state = await this.loadState();
    const lastHb = state?.lastHeartbeatAt ?? null;
    const staleSeconds = lastHb ? Math.floor((Date.now() - new Date(lastHb).getTime()) / 1000) : null;
    const connected = !!lastHb && staleSeconds !== null && staleSeconds <= STALE_AFTER_SECONDS;
    const env = process.env.MT5_ENVIRONMENT?.toLowerCase() === "live" ? "LIVE" as const
              : process.env.MT5_ENVIRONMENT?.toLowerCase() === "demo" ? "DEMO" as const
              : ((state?.liveAllowed ?? 0) === 1 ? "LIVE" as const : "DEMO" as const);

    return {
      kind: this.kind,
      connected,
      health: {
        connected,
        lastHeartbeatAt: lastHb ? new Date(lastHb).toISOString() : null,
        staleSeconds,
        reason: connected ? "MT5 EA is sending heartbeats." : (lastHb ? `MT5 EA heartbeat is stale (${staleSeconds}s old).` : "MT5 EA has never sent a heartbeat to this server."),
      },
      environment: env,
      liveTradingAllowed: false,
      canPlaceLiveTrade: false,
      missingSecrets: reqs,
      notes: [
        "Even when connected, live order placement remains disabled at the guard layer (BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED).",
        "This provider exposes READ-ONLY state from the EA bridge.",
      ],
    };
  }

  async account(): Promise<BrokerAccount | null> {
    const state = await this.loadState();
    if (!state) return null;
    const env = (state.liveAllowed ?? 0) === 1 ? "LIVE" as const : "DEMO" as const;
    return {
      accountIdMasked: maskAccount(state.account),
      broker: state.broker ?? null,
      server: state.server ?? null,
      currency: state.currency ?? "USD",
      balance: state.balance ?? 0,
      equity: state.equity ?? 0,
      margin: state.margin ?? 0,
      freeMargin: state.freeMargin ?? 0,
      marginLevel: state.marginLevel ?? null,
      leverage: null,
      environment: env,
      serverTime: state.lastSyncAt ? new Date(state.lastSyncAt).toISOString() : new Date().toISOString(),
    };
  }

  async symbols(): Promise<BrokerSymbol[]> {
    // The current EA contract does not push the symbol catalogue. Return a
    // conservative allowlist matching the app's synthetic-index focus until
    // the EA starts pushing /api/mt5/symbols (future work).
    return [
      { symbol: "Volatility 75 Index", description: "Synthetic V75 (MT5)", digits: 4, pipSize: 0.0001, minLot: 0.01, maxLot: 100 },
      { symbol: "Volatility 100 Index", description: "Synthetic V100 (MT5)", digits: 4, pipSize: 0.0001, minLot: 0.01, maxLot: 100 },
      { symbol: "Volatility 25 Index", description: "Synthetic V25 (MT5)", digits: 4, pipSize: 0.0001, minLot: 0.01, maxLot: 100 },
    ];
  }

  async positions(): Promise<BrokerPosition[]> {
    const rows = await db.select().from(livePositionsTable).where(undefined as never).limit(200).catch(() => [] as Array<typeof livePositionsTable.$inferSelect>);
    // Drizzle .where(undefined) doesn't filter; safer:
    const all = rows.length ? rows : await db.select().from(livePositionsTable).limit(200);
    return all
      .filter(r => r.status !== "CLOSED")
      .map(r => ({
        ticket: r.brokerPositionId ?? String(r.id),
        symbol: r.symbol,
        side: (r.direction === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL",
        volume: r.lotSize,
        openPrice: r.entryPrice,
        currentPrice: r.currentPrice ?? r.entryPrice,
        stopLoss: r.stopLoss ?? null,
        takeProfit: r.takeProfit ?? null,
        unrealizedPnl: r.unrealizedProfitLoss ?? 0,
        openedAt: r.openedAt ? new Date(r.openedAt).toISOString() : new Date(r.createdAt).toISOString(),
      }));
  }

  async orders(limit = 50): Promise<BrokerOrder[]> {
    const rows = await db.select().from(mt5CommandsTable).orderBy(desc(mt5CommandsTable.createdAt)).limit(limit);
    return rows.map(r => ({
      id: String(r.id),
      status: r.status,
      symbol: r.symbol ?? null,
      side: (r.side === "BUY" || r.side === "SELL") ? r.side : null,
      lot: r.lot ?? null,
      stopLoss: r.sl ?? null,
      takeProfit: r.tp ?? null,
      ticket: r.ticket ?? null,
      detail: r.detail ?? null,
      createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : new Date().toISOString(),
      deliveredAt: r.deliveredAt ? new Date(r.deliveredAt).toISOString() : null,
      completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
    }));
  }
}
