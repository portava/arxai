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

router.get("/me/broker-hub/connections/:connectionId", requireUser, async (req, res) => {
  const adapter = withAdapter(req, res, mt5ProjectionReader);
  if (!adapter) return;
  try {
    const health = await adapter.readHealth();
    if (health.reason === "CONNECTION_NOT_FOUND") {
      notFound(res);
      return;
    }
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