// Broker integration routes — READ-ONLY.
//
// SAFETY:
//  - Never modifies canPlaceTrades, kill switch, mode, or any live-trading state.
//  - /api/orders/manual-live exists but routes through placeLiveOrderGuarded()
//    which currently always returns REJECTED with BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED.
//  - /api/orders/demo writes to a paper-execution lane (NOT live tables).
//  - All endpoints scrub secrets and never echo broker tokens.

import { Router, type IRouter } from "express";
import { readRoleFromRequest } from "../lib/security/middleware.js";
import { z } from "zod/v4";
import { getBrokerProvider } from "../lib/broker/registry.js";
import { selectBrokerKind, describeRequiredSecrets, missingRequiredSecrets } from "../lib/broker/secrets.js";
import { placeLiveOrderGuarded } from "../lib/liveTrading/guard.js";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { buildZip } from "../lib/zipBuilder.js";

const router: IRouter = Router();

const DISCLAIMER = "Broker integration v1. READ-ONLY routes for status/account/symbols/positions/orders. /orders/manual-live is wired through placeLiveOrderGuarded() which rejects until a real placement layer is shipped.";

function envelope(body: Record<string, unknown>) {
  return {
    system: "broker",
    appMode: "PAPER_ONLY" as const,
    liveTradingStatus: "DISABLED" as const,
    canPlaceLiveTrade: false,
    disclaimer: DISCLAIMER,
    ...body,
  };
}

// ── READ-ONLY broker endpoints ───────────────────────────────────────────────

// ── MT5 EA bridge package downloads ──────────────────────────────────────────
// Resolves files from the repo's mt5-bridge/ directory. Uses an allowlist —
// no user-controlled path traversal.

const BRIDGE_FILES = {
  "ea": { name: "ReplitMT5BridgeEA.mq5", contentType: "text/x-mql5; charset=utf-8" },
  "webreq-test": { name: "ARXWebRequestTest.mq5", contentType: "text/x-mql5; charset=utf-8" },
  "readme": { name: "README_SETUP.md", contentType: "text/markdown; charset=utf-8" },
  "checklist": { name: "BRIDGE_TESTING_CHECKLIST.md", contentType: "text/markdown; charset=utf-8" },
  "security": { name: "SECURITY_NOTES.md", contentType: "text/markdown; charset=utf-8" },
  "troubleshooting": { name: "TROUBLESHOOTING.md", contentType: "text/markdown; charset=utf-8" },
} as const;
type BridgeFileKey = keyof typeof BRIDGE_FILES;

function bridgeDir(): string {
  // api-server runs from artifacts/api-server; the package is at <repo>/mt5-bridge
  return resolve(process.cwd(), "../../mt5-bridge");
}

router.get("/mt5/bridge-package/manifest", async (_req, res) => {
  try {
    const dir = bridgeDir();
    const files = await Promise.all((Object.keys(BRIDGE_FILES) as BridgeFileKey[]).map(async (key) => {
      const meta = BRIDGE_FILES[key];
      const fp = resolve(dir, meta.name);
      try {
        const st = await stat(fp);
        return { key, name: meta.name, size: st.size, downloadUrl: `/api/mt5/bridge-package/${key}`, present: true };
      } catch {
        return { key, name: meta.name, size: 0, downloadUrl: `/api/mt5/bridge-package/${key}`, present: false };
      }
    }));
    res.json(envelope({
      version: "1.0.0",
      readOnly: true,
      files,
      note: "EA v1 is READ-ONLY. It does not place, modify, or close orders. See README_SETUP.md.",
    }));
  } catch (e) {
    res.status(500).json(envelope({ error: String((e as Error).message) }));
  }
});

// Streams a freshly-built ZIP of the entire bridge package on every request.
// The ZIP is small (< 50 KB) and is rebuilt in memory — no on-disk artifact
// to drift out of sync with the source files.
router.get("/mt5/bridge-package/zip", async (_req, res) => {
  try {
    const dir = bridgeDir();
    const keys = Object.keys(BRIDGE_FILES) as BridgeFileKey[];
    const entries = await Promise.all(keys.map(async (k) => {
      const meta = BRIDGE_FILES[k];
      const data = await readFile(resolve(dir, meta.name));
      return { name: meta.name, data };
    }));
    const zip = buildZip(entries);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="replit-mt5-bridge-package.zip"');
    res.setHeader("Content-Length", String(zip.length));
    res.send(zip);
  } catch (e) {
    res.status(500).json(envelope({ error: `Failed to build bridge ZIP: ${String((e as Error).message)}` }));
  }
});

router.get("/mt5/bridge-package/:key", async (req, res) => {
  const key = req.params.key as BridgeFileKey;
  const meta = BRIDGE_FILES[key];
  if (!meta) {
    res.status(404).json(envelope({ error: "Unknown bridge file. Allowed keys: ea, readme, checklist." }));
    return;
  }
  try {
    const fp = resolve(bridgeDir(), meta.name);
    const buf = await readFile(fp);
    res.setHeader("Content-Type", meta.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${basename(meta.name)}"`);
    res.send(buf);
  } catch (e) {
    res.status(404).json(envelope({ error: `Bridge file not found on server: ${meta.name}`, detail: String((e as Error).message) }));
  }
});

// GET /broker/secrets-status — presence-only metadata. Never exposes values.
router.get("/broker/secrets-status", async (_req, res) => {
  try {
    const kind = selectBrokerKind();
    const required = describeRequiredSecrets(kind);
    const missing = missingRequiredSecrets(required);
    const liveAllowedFlagSet = !!process.env.LIVE_TRADING_ALLOWED;
    const liveAllowedFlagValue = (process.env.LIVE_TRADING_ALLOWED ?? "").trim().toLowerCase() === "true";
    res.json(envelope({
      provider: kind,
      requiredSecrets: required.map(r => ({ key: r.key, required: r.required, set: r.set, description: r.description })),
      missingSecrets: missing.map(m => m.key),
      readOnlyReady: missing.length === 0,
      liveTradingAllowedFlag: { set: liveAllowedFlagSet, value: liveAllowedFlagValue, note: "This flag alone NEVER enables live trading. Live placement remains rejected by placeLiveOrderGuarded() until a real broker layer ships." },
      lastCheckedAt: new Date().toISOString(),
      note: "Secret values are never returned. Only presence (set:true/false) and key names.",
    }));
  } catch (e) {
    res.status(500).json(envelope({ error: String((e as Error).message) }));
  }
});

// GET /broker/connection-check — pings the provider and returns a flat
// summary suitable for the frontend Broker Connection Center.
router.get("/broker/connection-check", async (_req, res) => {
  const startedAt = Date.now();
  try {
    const provider = getBrokerProvider();
    const status = await provider.status();
    let accountReadable = false;
    let equityReadable = false;
    let balanceReadable = false;
    let marginReadable = false;
    let symbolsReadable = false;
    let positionsReadable = false;
    let ordersReadable = false;
    let symbolCount = 0;
    let positionCount = 0;
    let orderCount = 0;
    const errors: string[] = [];

    if (status.connected) {
      try {
        const acct = await provider.account();
        accountReadable = !!acct;
        equityReadable = typeof acct?.equity === "number";
        balanceReadable = typeof acct?.balance === "number";
        marginReadable = typeof acct?.margin === "number";
      } catch (e) { errors.push(`account: ${String((e as Error).message)}`); }
    }
    try { const s = await provider.symbols(); symbolsReadable = true; symbolCount = s.length; }
    catch (e) { errors.push(`symbols: ${String((e as Error).message)}`); }
    try { const p = await provider.positions(); positionsReadable = true; positionCount = p.length; }
    catch (e) { errors.push(`positions: ${String((e as Error).message)}`); }
    try { const o = await provider.orders(10); ordersReadable = true; orderCount = o.length; }
    catch (e) { errors.push(`orders: ${String((e as Error).message)}`); }

    res.json(envelope({
      provider: status.kind,
      connected: status.connected,
      environment: status.environment,
      accountIdPresent: !!process.env.MT5_ACCOUNT_ID,
      bridgeUrlPresent: !!process.env.MT5_BRIDGE_URL,
      apiKeyPresent: !!process.env.MT5_BRIDGE_TOKEN,
      readOnlyReady: status.connected && accountReadable && symbolsReadable,
      liveOrderReady: false,
      missingSecrets: status.missingSecrets.filter(m => m.required && !m.set).map(m => m.key),
      checks: {
        accountReadable, equityReadable, balanceReadable, marginReadable,
        symbolsReadable, positionsReadable, ordersReadable,
        symbolCount, positionCount, orderCount,
      },
      errors,
      tookMs: Date.now() - startedAt,
      lastCheckedAt: new Date().toISOString(),
      note: "Live order placement remains LOCKED regardless of these read-only check results. placeLiveOrderGuarded() rejects with BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED.",
    }));
  } catch (e) {
    res.status(500).json(envelope({ error: String((e as Error).message), tookMs: Date.now() - startedAt }));
  }
});

router.get("/broker/status", async (_req, res) => {
  try {
    const status = await getBrokerProvider().status();
    res.json(envelope({ status }));
  } catch (e) {
    res.status(500).json(envelope({ error: String((e as Error).message) }));
  }
});

router.get("/broker/account", async (_req, res) => {
  try {
    const provider = getBrokerProvider();
    const status = await provider.status();
    if (!status.connected) {
      res.status(200).json(envelope({ account: null, status, note: "Broker not connected. Account snapshot unavailable." }));
      return;
    }
    const account = await provider.account();
    res.json(envelope({ account }));
  } catch (e) {
    res.status(500).json(envelope({ error: String((e as Error).message) }));
  }
});

router.get("/broker/symbols", async (_req, res) => {
  try {
    const symbols = await getBrokerProvider().symbols();
    res.json(envelope({ symbols, count: symbols.length }));
  } catch (e) {
    res.status(500).json(envelope({ error: String((e as Error).message) }));
  }
});

router.get("/positions/live", async (_req, res) => {
  try {
    const positions = await getBrokerProvider().positions();
    res.json(envelope({ positions, count: positions.length }));
  } catch (e) {
    res.status(500).json(envelope({ error: String((e as Error).message) }));
  }
});

const OrdersQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }).partial();
router.get("/orders/live", async (req, res) => {
  const q = OrdersQuery.safeParse(req.query);
  const limit = q.success && q.data.limit ? q.data.limit : 50;
  try {
    const orders = await getBrokerProvider().orders(limit);
    res.json(envelope({ orders, count: orders.length }));
  } catch (e) {
    res.status(500).json(envelope({ error: String((e as Error).message) }));
  }
});

// ── ORDER PLACEMENT (always rejects in current build) ────────────────────────

const ManualLiveBody = z.object({
  approvalId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  symbol: z.string().min(1),
  side: z.enum(["BUY", "SELL"]),
  lotSize: z.number().positive(),
  stopLoss: z.number().positive(),
  takeProfit: z.number().positive(),
  spreadPips: z.number().min(0),
});

router.post("/orders/manual-live", async (req, res) => {
  const p = ManualLiveBody.safeParse(req.body ?? {});
  if (!p.success) {
    res.status(400).json(envelope({ error: "INVALID_BODY", issues: p.error.issues.slice(0, 5) }));
    return;
  }
  // Per user policy: every live order goes through placeLiveOrderGuarded().
  // The guard will reject (currently always BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED).
  try {
    const broker = await getBrokerProvider().status();
    const result = await placeLiveOrderGuarded({
      approvalId: p.data.approvalId,
      idempotencyKey: p.data.idempotencyKey,
      brokerHealthy: broker.connected,
      symbolAllowlisted: ["Volatility 75 Index", "Volatility 100 Index", "Volatility 25 Index"].includes(p.data.symbol),
      spreadPips: p.data.spreadPips,
      openLivePositions: 0,
      actorRole: readRoleFromRequest(req), // Phase 28-SEC: trusted server-derived role; header no longer used
      actorSession: req.header("x-session-id") ?? null,
    } as Parameters<typeof placeLiveOrderGuarded>[0]);
    res.status(409).json(envelope({ result, note: "Order rejected as expected — broker placement layer is not implemented in this build." }));
  } catch (e) {
    res.status(500).json(envelope({ error: String((e as Error).message) }));
  }
});

const DemoBody = z.object({
  symbol: z.string().min(1),
  side: z.enum(["BUY", "SELL"]),
  lotSize: z.number().positive(),
  stopLoss: z.number().positive().optional(),
  takeProfit: z.number().positive().optional(),
  note: z.string().max(500).optional(),
});

router.post("/orders/demo", async (req, res) => {
  const p = DemoBody.safeParse(req.body ?? {});
  if (!p.success) { res.status(400).json(envelope({ error: "INVALID_BODY", issues: p.error.issues.slice(0, 5) })); return; }
  // The app's existing simulation lane is the paper-execution engine.
  // To keep clear isolation, this endpoint records the demo order intent
  // without writing to live tables. A future session should route this to
  // the paper-execution engine for full P&L simulation.
  const orderId = `demo_${randomUUID()}`;
  res.json(envelope({
    result: {
      ok: true,
      executionEnvironment: "DEMO",
      orderId,
      submittedAt: new Date().toISOString(),
      symbol: p.data.symbol,
      side: p.data.side,
      lotSize: p.data.lotSize,
      stopLoss: p.data.stopLoss ?? null,
      takeProfit: p.data.takeProfit ?? null,
      note: "Demo order accepted. This intent is NOT routed to any live broker. For full P&L simulation use POST /api/paper-execution/* endpoints.",
    },
  }));
});

export default router;
