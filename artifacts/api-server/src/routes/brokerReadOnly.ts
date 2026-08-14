// Build KK — Broker Read-Only routes (BROKER_READ_ONLY mode).
//
// SAFETY: All endpoints are READ-ONLY. They NEVER place orders, NEVER modify
// positions, NEVER set canPlaceTrades, NEVER expose secrets.

import { Router } from "express";
import { buildSnapshot, listSnapshots, listLogs, checkBrokerSafety, brokerStatusForGovernance } from "../lib/brokerReadOnly/service.js";

const router = Router();
const TAG = "Build KK — Broker Read-Only Connector. READ_ONLY only. Never places trades, never calls MT5 execution, never modifies canPlaceTrades, never exposes secrets.";

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

router.get("/broker-readonly/status", async (_req, res) => {
  try {
    const s = await brokerStatusForGovernance();
    res.json(envelope({ status: s }));
  } catch (err) {
    res.status(500).json(envelope({ error: "status failed", detail: String(err).slice(0, 200) }));
  }
});

router.post("/broker-readonly/health-check", async (_req, res) => {
  try {
    const safety = checkBrokerSafety();
    res.json(envelope({ healthCheck: safety }));
  } catch (err) {
    res.status(500).json(envelope({ error: "health-check failed", detail: String(err).slice(0, 200) }));
  }
});

router.get("/broker-readonly/account", async (req, res) => {
  try {
    const provider = req.query.provider ? String(req.query.provider) : undefined;
    const { snapshot, safety, rejected } = await buildSnapshot({ provider });
    if (rejected) { res.status(400).json(envelope({ error: safety.reason, account: null })); return; }
    res.json(envelope({ provider: snapshot.provider, account: snapshot.account, dataQuality: snapshot.dataQuality }));
  } catch (err) {
    res.status(500).json(envelope({ error: "account failed", detail: String(err).slice(0, 200) }));
  }
});

router.get("/broker-readonly/symbols", async (req, res) => {
  try {
    const provider = req.query.provider ? String(req.query.provider) : undefined;
    const { snapshot, safety, rejected } = await buildSnapshot({ provider });
    if (rejected) { res.status(400).json(envelope({ error: safety.reason, symbols: [] })); return; }
    res.json(envelope({ provider: snapshot.provider, symbols: snapshot.symbols }));
  } catch (err) {
    res.status(500).json(envelope({ error: "symbols failed", detail: String(err).slice(0, 200) }));
  }
});

router.get("/broker-readonly/positions", async (req, res) => {
  try {
    const provider = req.query.provider ? String(req.query.provider) : undefined;
    const { snapshot, safety, rejected } = await buildSnapshot({ provider });
    if (rejected) { res.status(400).json(envelope({ error: safety.reason, openPositions: [] })); return; }
    res.json(envelope({ provider: snapshot.provider, openPositions: snapshot.openPositions, note: "READ_ONLY view. Cannot be closed/modified from this endpoint." }));
  } catch (err) {
    res.status(500).json(envelope({ error: "positions failed", detail: String(err).slice(0, 200) }));
  }
});

router.get("/broker-readonly/quotes", async (req, res) => {
  try {
    const provider = req.query.provider ? String(req.query.provider) : undefined;
    const { snapshot, safety, rejected } = await buildSnapshot({ provider });
    if (rejected) { res.status(400).json(envelope({ error: safety.reason, latestQuotes: [] })); return; }
    let quotes = snapshot.latestQuotes;
    if (req.query.symbols) {
      const wanted = new Set(String(req.query.symbols).split(",").map(s => s.trim().toLowerCase()));
      quotes = quotes.filter(q => wanted.has(q.symbol.toLowerCase()));
    }
    res.json(envelope({ provider: snapshot.provider, latestQuotes: quotes }));
  } catch (err) {
    res.status(500).json(envelope({ error: "quotes failed", detail: String(err).slice(0, 200) }));
  }
});

router.post("/broker-readonly/snapshot", async (req, res) => {
  try {
    const provider = req.body?.provider ? String(req.body.provider) : undefined;
    const { snapshot, safety, rejected } = await buildSnapshot({ provider, persist: true });
    if (rejected) { res.status(400).json(envelope({ error: safety.reason, snapshot })); return; }
    res.json(envelope({ snapshot }));
  } catch (err) {
    res.status(500).json(envelope({ error: "snapshot failed", detail: String(err).slice(0, 200) }));
  }
});

router.get("/broker-readonly/snapshots", async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10) || 20, 100);
    const rows = await listSnapshots(limit);
    res.json(envelope({ count: rows.length, snapshots: rows.map(r => ({ ...r, liveTradingAllowed: false, canPlaceLiveTrade: false })) }));
  } catch (err) {
    res.status(500).json(envelope({ error: "snapshots failed", detail: String(err).slice(0, 200) }));
  }
});

router.get("/broker-readonly/logs", async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 500);
    const rows = await listLogs(limit);
    res.json(envelope({ count: rows.length, logs: rows }));
  } catch (err) {
    res.status(500).json(envelope({ error: "logs failed", detail: String(err).slice(0, 200) }));
  }
});

router.post("/broker-readonly/demo", async (_req, res) => {
  try {
    const { snapshot, safety, rejected } = await buildSnapshot({ provider: "demo", persist: true });
    if (rejected) { res.status(400).json(envelope({ demo: true, error: safety.reason, snapshot })); return; }
    res.json(envelope({ demo: true, snapshot }));
  } catch (err) {
    res.status(500).json(envelope({ error: "demo failed", detail: String(err).slice(0, 200) }));
  }
});

export default router;
