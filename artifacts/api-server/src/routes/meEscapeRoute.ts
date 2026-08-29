// Capability #46 — the broker-native escape route (/api/me/escape-route).
//
// Read-only, per-user. Composes REAL connection identity (mt5_connections) and
// the last-confirmed positions (arx_live_positions) into direct-broker access
// instructions and an emergency walkthrough. Deliberately NOT behind the
// broker-hub feature flag: a safety surface must not disappear with a feature
// toggle. A failed read degrades to an honest page section with a typed
// reason — the procedure text still renders, because knowing how to reach the
// broker matters most exactly when ARX's own reads are failing.

import { Router } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db, mt5ConnectionTable, arxLivePositionsTable } from "@workspace/db";
import { requireUser } from "../lib/auth/middleware.js";
import {
  buildEscapeRoutePage,
  type EscapeRouteConnectionInput,
  type EscapeRoutePositionInput,
} from "../lib/brokerHub/escapeRoute.js";

const router = Router();

router.get("/me/escape-route", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const now = new Date();

  let connections: EscapeRouteConnectionInput[] = [];
  let connectionsUnavailableReason: string | null = null;
  try {
    const rows = await db
      .select()
      .from(mt5ConnectionTable)
      .where(eq(mt5ConnectionTable.userId, userId));
    connections = rows.map((c) => ({
      connectionId: c.id,
      connectionName: c.connectionName ?? null,
      brokerName: c.brokerName ?? null,
      serverName: c.serverName ?? null,
      accountNumber: c.accountNumber ?? null,
      accountCurrency: c.accountCurrency ?? null,
      mode: c.mode ?? null,
      accountType: c.accountType ?? null,
      lastHeartbeat: c.lastHeartbeat ?? null,
      lastPositionsSnapshotAt: c.lastPositionsSnapshotAt ?? null,
    }));
  } catch {
    connectionsUnavailableReason =
      "Connection metadata could not be read — the emergency procedure below still applies; find your broker and server name in your broker's account-opening email.";
  }

  // Last-confirmed open positions. The arx_live_positions store is per-user
  // (not per-connection); with a single MT5 connection per user today they are
  // attributed to that connection. A failed read leaves the honest
  // unavailableReason on each connection instead of an empty confident list.
  const positionsByConnection = new Map<number, EscapeRoutePositionInput[]>();
  if (connections.length > 0) {
    try {
      const posRows = await db
        .select()
        .from(arxLivePositionsTable)
        .where(and(eq(arxLivePositionsTable.userId, userId), isNull(arxLivePositionsTable.closedAt)));
      const mapped: EscapeRoutePositionInput[] = posRows.map((p) => ({
        brokerTicket: p.brokerTicket,
        symbol: p.symbol,
        side: p.side,
        volume: p.volume,
        entryPrice: p.entryPrice,
        currentPrice: p.currentPrice ?? null,
        stopLoss: p.stopLoss ?? null,
        takeProfit: p.takeProfit ?? null,
        floatingPl: p.floatingPl ?? null,
        lastSyncedAt: p.lastSyncedAt ?? null,
      }));
      // Attribute by account login when the position reports one that matches
      // a connection's account number; otherwise to the first connection.
      for (const p of posRows) {
        const match =
          connections.find((c) => c.accountNumber != null && p.accountLogin === c.accountNumber) ??
          connections[0]!;
        const list = positionsByConnection.get(match.connectionId) ?? [];
        list.push(mapped[posRows.indexOf(p)]!);
        positionsByConnection.set(match.connectionId, list);
      }
    } catch {
      // positionsByConnection stays empty → each connection reports the honest
      // "no snapshot confirmed" reason from the pure builder.
    }
  }

  const page = buildEscapeRoutePage({
    connections,
    positionsByConnection,
    now,
    connectionsUnavailableReason,
  });
  res.json(page);
});

export default router;
