// Phase 0B — tenant-owned broker metadata, read-only.
//
// This surface is deliberately feature-flagged and projects only MT5 evidence
// already reported by the caller's EA. It does not read credentials and must
// never import an execution or mailbox writer.

import { Router, type Request, type Response } from "express";
import { requireUser } from "../lib/auth/middleware.js";
import {
  Mt5ReadOnlyAdapter,
  type Mt5ProjectionReader,
} from "../lib/brokerHub/mt5ReadOnlyAdapter.js";
import { mt5ProjectionReader } from "../lib/brokerHub/mt5ProjectionReader.js";
import { isBrokerHubReadOnlyEnabled } from "../lib/brokerHub/featureFlag.js";
import { buildConnectionCard } from "../lib/brokerHub/connectionCard.js";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  mt5ConnectionTable,
  userSlotAllocationTable,
  userMasterLiveAccessTable,
} from "@workspace/db";

const router = Router();
const NO_TRADE_FLAGS = {
  metadataEnabled: false as const,
  tradingEnabled: false as const,
  automationEnabled: false as const,
  canPlaceLiveTrade: false as const,
};

function connectionId(req: Request): number | null {
  const value = Number(req.params.connectionId);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function ownerId(req: Request): number | null {
  return req.authUser?.id ?? null;
}

function disabled(res: Response): void {
  res.status(404).json({ error: "NOT_FOUND" });
}

function notFound(res: Response): void {
  res.status(404).json({ error: "NOT_FOUND" });
}

function base(adapter: Mt5ReadOnlyAdapter) {
  return {
    venue: "MT5" as const,
    connectionId: Number(adapter.identity.nativeConnectionRef),
    ...NO_TRADE_FLAGS,
  };
}

router.use("/me/broker-hub", requireUser);

router.use("/me/broker-hub", (req, res, next) => {
  if (!isBrokerHubReadOnlyEnabled()) {
    disabled(res);
    return;
  }
  next();
});

function withAdapter(
  req: Request,
  res: Response,
  reader: Mt5ProjectionReader,
): Mt5ReadOnlyAdapter | null {
  const userId = ownerId(req);
  const id = connectionId(req);
  if (!userId || id === null) {
    notFound(res);
    return null;
  }
  return new Mt5ReadOnlyAdapter(reader, userId, id);
}

// Spec §3.1 — the Broker Connections card set for THIS user.
//
// Read-only and per-user scoped: every row is filtered by req.authUser.id, so
// one user can never see another's connection. Each card is built by the pure
// projection in lib/brokerHub/connectionCard.ts, which declares any field it
// cannot source rather than guessing one.
router.get("/me/broker-hub/connections", requireUser, async (req, res) => {
  const userId = ownerId(req);
  if (!userId) { notFound(res); return; }
  try {
    const now = new Date();

    const connections = await db.select().from(mt5ConnectionTable)
      .where(eq(mt5ConnectionTable.userId, userId));

    // Allocation and approval are per-USER (not per-connection), so they are
    // read once and applied to every card.
    const allocRows = await db.select({
      allocationStatus: userSlotAllocationTable.allocationStatus,
      tradingFrozen: userSlotAllocationTable.tradingFrozen,
      closeOnlyMode: userSlotAllocationTable.closeOnlyMode,
      allocatedFunds: userSlotAllocationTable.allocatedFunds,
    }).from(userSlotAllocationTable)
      .where(eq(userSlotAllocationTable.userId, userId)).limit(1);
    const alloc = allocRows[0] ?? null;

    const approvalRows = await db.select({
      approvedForMasterLive: userMasterLiveAccessTable.approvedForMasterLive,
      masterLiveStatus: userMasterLiveAccessTable.masterLiveStatus,
    }).from(userMasterLiveAccessTable)
      .where(eq(userMasterLiveAccessTable.userId, userId)).limit(1);
    const approval = approvalRows[0] ?? null;

    // Newest COMPLETED reconciliation run for this user. Raw SQL because the
    // table is young and written by the reconciler via raw SQL too; a failure
    // here degrades the field to null (and the card says so) rather than
    // failing the whole card set.
    let lastReconciledAt: Date | null = null;
    try {
      const runs = await db.execute(sql`
        select completed_at from reconciliation_runs
        where user_id = ${userId} and status = 'COMPLETED' and completed_at is not null
        order by completed_at desc limit 1
      `);
      const first = (runs as unknown as { rows?: Array<{ completed_at?: unknown }> }).rows?.[0];
      const raw = first?.completed_at;
      if (raw instanceof Date) lastReconciledAt = raw;
      else if (typeof raw === "string") {
        const parsed = new Date(raw);
        if (!Number.isNaN(parsed.getTime())) lastReconciledAt = parsed;
      }
    } catch { /* stays null; the card declares it unavailable */ }

    const cards = connections.map((c) => ({
      connectionId: c.id,
      ...buildConnectionCard({
        connectionName: c.connectionName ?? null,
        status: c.status ?? null,
        accountNumber: c.accountNumber ?? null,
        brokerName: c.brokerName ?? null,
        serverName: c.serverName ?? null,
        accountCurrency: c.accountCurrency ?? null,
        mode: c.mode ?? null,
        accountType: c.accountType ?? null,
        eaVersion: c.eaVersion ?? null,
        lastHeartbeat: c.lastHeartbeat ?? null,
        lastPositionsSnapshotAt: c.lastPositionsSnapshotAt ?? null,
        clockDriftSeconds: c.clockDriftSeconds ?? null,
        readOnlyMode: c.readOnlyMode ?? null,
        allowOrderExecution: c.allowOrderExecution ?? null,
        tokenRevokedAt: c.tokenRevokedAt ?? null,
        tokenRotatedAt: c.tokenRotatedAt ?? null,
        allocationStatus: alloc?.allocationStatus ?? null,
        tradingFrozen: alloc?.tradingFrozen ?? null,
        closeOnlyMode: alloc?.closeOnlyMode ?? null,
        allocatedFunds: alloc?.allocatedFunds ?? null,
        approvedForMasterLive: approval?.approvedForMasterLive ?? null,
        masterLiveStatus: approval?.masterLiveStatus ?? null,
        lastReconciledAt,
        now,
      }),
    }));

    res.json({ connections: cards, orderSubmissionAvailable: false });
  } catch {
    res.status(500).json({ error: "BROKER_METADATA_UNAVAILABLE" });
  }
});

router.get("/me/broker-hub/connections/:connectionId", requireUser, async (req, res) => {
  const adapter = withAdapter(req, res, mt5ProjectionReader);
  if (!adapter) return;
  try {
    const health = await adapter.readHealth();
    res.json({
      ...base(adapter),
      status: health.status,
      connected: health.connected,
      nativeStatus: health.nativeStatus,
      observedAt: health.observedAt,
      staleSeconds: health.staleSeconds,
      reason: health.reason,
    });
  } catch {
    res.status(500).json({ error: "BROKER_METADATA_UNAVAILABLE" });
  }
});

router.get("/me/broker-hub/connections/:connectionId/account", requireUser, async (req, res) => {
  const adapter = withAdapter(req, res, mt5ProjectionReader);
  if (!adapter) return;
  try {
    const account = await adapter.readAccount();
    if (!account) {
      notFound(res);
      return;
    }
    res.json({
      ...base(adapter),
      accountRefMasked: account.accountRefMasked,
      brokerName: account.brokerName,
      serverName: account.serverName,
      environment: account.environment,
      currency: account.currency,
      balance: account.balance,
      equity: account.equity,
      margin: account.margin,
      freeMargin: account.freeMargin,
      leverage: account.leverage,
      observedAt: account.observedAt,
      snapshotStatus: account.snapshotStatus,
    });
  } catch {
    res.status(500).json({ error: "BROKER_METADATA_UNAVAILABLE" });
  }
});

router.get("/me/broker-hub/connections/:connectionId/capabilities", requireUser, async (req, res) => {
  const adapter = withAdapter(req, res, mt5ProjectionReader);
  if (!adapter) return;
  try {
    const snapshot = await adapter.readCapabilities();
    if ((await adapter.readHealth()).reason === "CONNECTION_NOT_FOUND") {
      notFound(res);
      return;
    }
    res.json({
      ...base(adapter),
      observedAt: snapshot.observedAt,
      capabilities: snapshot.capabilities,
    });
  } catch {
    res.status(500).json({ error: "BROKER_METADATA_UNAVAILABLE" });
  }
});

router.get("/me/broker-hub/connections/:connectionId/instruments", requireUser, async (req, res) => {
  const adapter = withAdapter(req, res, mt5ProjectionReader);
  if (!adapter) return;
  try {
    const instruments = await adapter.readInstruments();
    if ((await adapter.readHealth()).reason === "CONNECTION_NOT_FOUND") {
      notFound(res);
      return;
    }
    const freshInstruments = instruments.filter(
      (instrument) => instrument.discoveryStatus === "FRESH",
    );
    res.json({
      ...base(adapter),
      discoveryStatus: freshInstruments.length > 0 ? "AVAILABLE" : "DISCOVERY_REQUIRED",
      instruments: freshInstruments.map((instrument) => ({
        symbol: instrument.symbol,
        displayName: instrument.displayName,
        exactBrokerSymbol: instrument.exactBrokerSymbol,
        brokerReportsTradeAllowed: instrument.brokerReportsTradeAllowed,
        discoveryStatus: instrument.discoveryStatus,
        digits: instrument.digits,
        point: instrument.point,
        minVolume: instrument.minVolume,
        maxVolume: instrument.maxVolume,
        volumeStep: instrument.volumeStep,
        evidence: instrument.evidence,
      })),
    });
  } catch {
    res.status(500).json({ error: "BROKER_METADATA_UNAVAILABLE" });
  }
});

export default router;