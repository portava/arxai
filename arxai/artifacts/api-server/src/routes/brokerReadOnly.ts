// Build KK — Broker Read-Only routes (BROKER_READ_ONLY mode).
//
// SAFETY: All endpoints are READ-ONLY. They NEVER place orders, NEVER modify
// positions, NEVER set canPlaceTrades, NEVER expose secrets.

import { Router, type NextFunction, type Request, type Response } from "express";
import { buildSnapshot, listSnapshots, listLogs, checkBrokerSafety, brokerStatusForUser } from "../lib/brokerReadOnly/service.js";
import { requireUser } from "../lib/auth/middleware.js";
import { isAdminProductRole, normalizeProductRole } from "../lib/auth/productRole.js";
import { scrub } from "../lib/security/redact.js";

const router = Router();
const TAG = "Build KK — Broker Read-Only Connector. READ_ONLY only. Never places trades, never calls MT5 execution, never modifies canPlaceTrades, never exposes secrets.";

function userId(req: { authUser?: { id?: number } }): number {
  return req.authUser?.id ?? 0;
}

function safeFailure(label: string) {
  return envelope({ error: `${label} failed` });
}

function publicSnapshotRow(row: Awaited<ReturnType<typeof listSnapshots>>[number]) {
  const { userId: _ownerId, ...publicRow } = row;
  return scrub({ ...publicRow, liveTradingAllowed: false, canPlaceLiveTrade: false });
}

function publicLogRow(row: Awaited<ReturnType<typeof listLogs>>[number]) {
  const { userId: _ownerId, ...publicRow } = row;
  return scrub(publicRow);
}

function requireEffectiveOperator(req: Request, res: Response, next: NextFunction): void {
  // Deliberately use the effective role on authUser.role. resolveProductRole()
  // reads realRole and would leak diagnostics while an admin previews as user.
  if (!isAdminProductRole(normalizeProductRole(req.authUser?.role))) {
    res.status(403).json(envelope({ error: "Operator access required" }));
    return;
  }
  next();
}

// Existing providers are global diagnostic adapters, not owner-bound broker
// connections. The whole namespace is therefore operator-only as well as
// authenticated; future endpoints inherit the same fail-closed boundary.
router.use("/broker-readonly", requireUser, requireEffectiveOperator);

function envelope(body: Record<string, unknown>) {
  return {
    system: "brokerReadOnly",
    liveTradingStatus: "DISABLED" as const,
    mode: "BROKER_READ_ONLY" as const,
    liveTradingAllowed: false as const,
    canPlaceLiveTrade: false as const,
    disclaimer: TAG,
    ...body,
  };
}

router.get("/broker-readonly/status", async (req, res) => {
  try {
    const s = await brokerStatusForUser(userId(req));
    res.json(envelope({ status: s }));
  } catch {
    res.status(500).json(safeFailure("status"));
  }
});

router.post("/broker-readonly/health-check", async (_req, res) => {
  try {
    const safety = checkBrokerSafety();
    res.json(envelope({ healthCheck: safety }));
  } catch {
    res.status(500).json(safeFailure("health-check"));
  }
});

router.get("/broker-readonly/account", async (req, res) => {
  try {
    const provider = req.query.provider ? String(req.query.provider) : undefined;
    const { snapshot, safety, rejected } = await buildSnapshot({ userId: userId(req), provider });
    if (rejected) { res.status(400).json(envelope({ error: safety.reason, account: null })); return; }
    res.json(envelope({ provider: snapshot.provider, account: scrub(snapshot.account), dataQuality: scrub(snapshot.dataQuality) }));
  } catch {
    res.status(500).json(safeFailure("account"));
  }
});

router.get("/broker-readonly/symbols", async (req, res) => {
  try {
    const provider = req.query.provider ? String(req.query.provider) : undefined;
    const { snapshot, safety, rejected } = await buildSnapshot({ userId: userId(req), provider });
    if (rejected) { res.status(400).json(envelope({ error: safety.reason, symbols: [] })); return; }
    res.json(envelope({ provider: snapshot.provider, symbols: scrub(snapshot.symbols) }));
  } catch {
    res.status(500).json(safeFailure("symbols"));
  }
});

router.get("/broker-readonly/positions", async (req, res) => {
  try {
    const provider = req.query.provider ? String(req.query.provider) : undefined;
    const { snapshot, safety, rejected } = await buildSnapshot({ userId: userId(req), provider });
    if (rejected) { res.status(400).json(envelope({ error: safety.reason, openPositions: [] })); return; }
    res.json(envelope({ provider: snapshot.provider, openPositions: scrub(snapshot.openPositions), note: "READ_ONLY view. Cannot be closed/modified from this endpoint." }));
  } catch {
    res.status(500).json(safeFailure("positions"));
  }
});

router.get("/broker-readonly/quotes", async (req, res) => {
  try {
    const provider = req.query.provider ? String(req.query.provider) : undefined;
    const { snapshot, safety, rejected } = await buildSnapshot({ userId: userId(req), provider });
    if (rejected) { res.status(400).json(envelope({ error: safety.reason, latestQuotes: [] })); return; }
    let quotes = snapshot.latestQuotes;
    if (req.query.symbols) {
      const wanted = new Set(String(req.query.symbols).split(",").map(s => s.trim().toLowerCase()));
      quotes = quotes.filter(q => wanted.has(q.symbol.toLowerCase()));
    }
    res.json(envelope({ provider: snapshot.provider, latestQuotes: scrub(quotes) }));
  } catch {
    res.status(500).json(safeFailure("quotes"));
  }
});

router.post("/broker-readonly/snapshot", async (req, res) => {
  try {
    const provider = req.body?.provider ? String(req.body.provider) : undefined;
    const { snapshot, safety, rejected } = await buildSnapshot({ userId: userId(req), provider, persist: true });
    if (rejected) { res.status(400).json(envelope({ error: safety.reason, snapshot: scrub(snapshot) })); return; }
    res.json(envelope({ snapshot: scrub(snapshot) }));
  } catch {
    res.status(500).json(safeFailure("snapshot"));
  }
});

router.get("/broker-readonly/snapshots", async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10) || 20, 100);
    const rows = await listSnapshots(userId(req), limit);
    res.json(envelope({ count: rows.length, snapshots: rows.map(publicSnapshotRow) }));
  } catch {
    res.status(500).json(safeFailure("snapshots"));
  }
});

router.get("/broker-readonly/logs", async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 500);
    const rows = await listLogs(userId(req), limit);
    res.json(envelope({ count: rows.length, logs: rows.map(publicLogRow) }));
  } catch {
    res.status(500).json(safeFailure("logs"));
  }
});

router.post("/broker-readonly/demo", async (req, res) => {
  try {
    const { snapshot, safety, rejected } = await buildSnapshot({ userId: userId(req), provider: "demo", persist: true });
    if (rejected) { res.status(400).json(envelope({ demo: true, error: safety.reason, snapshot: scrub(snapshot) })); return; }
    res.json(envelope({ demo: true, snapshot: scrub(snapshot) }));
  } catch {
    res.status(500).json(safeFailure("demo"));
  }
});

export default router;
