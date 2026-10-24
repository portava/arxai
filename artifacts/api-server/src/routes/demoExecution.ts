// ─────────────────────────────────────────────────────────────────────────────
// ARX AI — DEMO-ONLY MT5 Execution Layer (Phase: Demo Exec)
//
// Hard safety contract:
//   * Live execution stays impossible. liveExecutionEnabled / liveBrokerExecution-
//     Available / brokerPlacementImplemented all remain false everywhere else.
//   * This layer queues demo market orders (volume <= 0.01) through the one
//     demo pipeline, demoCommandQueue, which refuses a non-DEMO bridge.
//   * Server-side enable: requires env ARX_ALLOW_DEMO_EXECUTION=true. Default
//     OFF. If unset, every demo queue/test endpoint returns
//     BLOCKED_DEMO_SAFETY_GUARD.
//   * Real (live) account detected via mt5_state.liveAllowed → returns
//     BLOCKED_READ_ONLY_MODE with the documented reason string.
//   * No martingale / no auto-repeat. The /test endpoint queues exactly one
//     order per call and never loops.
// ─────────────────────────────────────────────────────────────────────────────

import { EA_HEARTBEAT_FRESH_MS } from "../lib/brokerHub/freshness.js";
import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import { denyInvestorExecution } from "../lib/auth/productRole.js";
import { routeConfirmedAction } from "../lib/tradeAction/route.js";
import { readPlatformMt5State } from "../lib/brokerHub/mt5StateReader.js";

const router = Router();
// Task #71 — investor accounts cannot reach demo execution either.
router.use(denyInvestorExecution);

const MAX_DEMO_LOT = 0.01;
const DEMO_PANEL_SOURCE = "DEMO_EXECUTION_PANEL";
const DISCLAIMER = "Demo-only execution. Live broker placement remains disabled.";

const BLOCKED_LIVE = {
  status: "BLOCKED_READ_ONLY_MODE" as const,
  reason: "Live broker execution is disabled. ARX AI is currently demo/paper-only.",
};

function blockedDemo(reason: string) {
  return { status: "BLOCKED_DEMO_SAFETY_GUARD" as const, reason };
}

function isDemoExecutionAllowedOnServer(): boolean {
  return process.env["ARX_ALLOW_DEMO_EXECUTION"] === "true";
}

async function loadAccountTypeAndState() {
  const s = await readPlatformMt5State();
  // mt5_state.liveAllowed is set by the EA heartbeat: 1 when ACCOUNT_TRADE_MODE
  // == ACCOUNT_TRADE_MODE_REAL. Anything else (0/null) is treated as DEMO/UNKNOWN.
  let accountType: "DEMO" | "REAL" | "UNKNOWN";
  if (!s || s.lastHeartbeatAt === null) accountType = "UNKNOWN";
  else if (s.liveAllowed === 1) accountType = "REAL";
  else accountType = "DEMO";
  const ageMs = s?.lastHeartbeatAt ? Date.now() - new Date(s.lastHeartbeatAt).getTime() : null;
  const isFresh = ageMs !== null && ageMs < EA_HEARTBEAT_FRESH_MS;
  return { accountType, isFresh, state: s };
}

// ── GET /paper/demo-execution/status ─────────────────────────────────────────
router.get("/status", async (_req: Request, res: Response) => {
  const { accountType, isFresh } = await loadAccountTypeAndState();
  const serverEnabled = isDemoExecutionAllowedOnServer();
  res.json({
    serverDemoExecutionEnabled: serverEnabled,
    accountType,
    bridgeFresh: isFresh,
    maxDemoLot: MAX_DEMO_LOT,
    allowedAction: "PLACE_MARKET_ORDER",
    // Canonical safety vocabulary (UNCHANGED — live execution stays impossible)
    executionMode: "READ_ONLY",
    placementLayer: "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED",
    liveExecutionEnabled: false,
    liveBrokerExecutionAvailable: false,
    brokerPlacementImplemented: false,
    readOnlyGuardActive: true,
    paperTradingEnabled: true,
    demoOnly: true,
    disclaimer: DISCLAIMER,
  });
});

// ── Validation: every demo order must satisfy ALL of these ──────────────────
const demoBody = z.object({
  symbol: z.string().min(1).max(32),
  side: z.enum(["BUY", "SELL"]),
  volume: z.number().positive().max(MAX_DEMO_LOT),
  stopLoss: z.number().nonnegative().optional(),
  takeProfit: z.number().nonnegative().optional(),
  reason: z.string().max(500).optional(),
  demoOnly: z.literal(true),
  executionMode: z.enum(["DEMO_ONLY", "READ_ONLY_WITH_DEMO_EXECUTION"]),
});

async function validateAndQueueDemo(input: z.infer<typeof demoBody>, source: string, userId: number | null) {
  // 1. Server enablement. Default OFF — must be explicitly turned on per env.
  if (!isDemoExecutionAllowedOnServer()) {
    return {
      ok: false as const,
      http: 403,
      body: blockedDemo(
        "Demo execution disabled at server. Set ARX_ALLOW_DEMO_EXECUTION=true to enable for demo accounts."
      ),
    };
  }

  // 2. Account-type gate. REAL accounts ALWAYS get the live-block envelope.
  const { accountType, isFresh } = await loadAccountTypeAndState();
  if (accountType === "REAL") {
    return { ok: false as const, http: 403, body: BLOCKED_LIVE };
  }
  if (accountType === "UNKNOWN" || !isFresh) {
    return {
      ok: false as const,
      http: 409,
      body: blockedDemo(
        "MT5 bridge offline or account type unknown. Connect a DEMO account before queueing demo orders."
      ),
    };
  }

  // 3. Defence-in-depth re-checks (Zod has already passed but be explicit).
  if (input.demoOnly !== true) {
    return { ok: false as const, http: 400, body: blockedDemo("demoOnly must be literally true.") };
  }
  if (input.volume > MAX_DEMO_LOT) {
    return {
      ok: false as const,
      http: 400,
      body: blockedDemo(`Volume ${input.volume} exceeds MAX_DEMO_LOT ${MAX_DEMO_LOT}.`),
    };
  }
  if (input.executionMode !== "DEMO_ONLY" && input.executionMode !== "READ_ONLY_WITH_DEMO_EXECUTION") {
    return {
      ok: false as const,
      http: 400,
      body: blockedDemo("executionMode must be DEMO_ONLY or READ_ONLY_WITH_DEMO_EXECUTION."),
    };
  }
  if (input.side !== "BUY" && input.side !== "SELL") {
    return { ok: false as const, http: 400, body: blockedDemo("side must be BUY or SELL.") };
  }

  // 4. The one demo pipeline: demoCommandQueue (per-user arming, the routed
  //    bridge gate, the pre-trade Risk Governor in the consumer). This panel
  //    used to insert DEMO_MARKET_ORDER rows straight into the legacy
  //    mt5_commands mailbox, a parallel demo path (Tier 1 Trade Engine).
  if (userId == null) {
    return { ok: false as const, http: 401, body: blockedDemo("Sign in required to queue a demo order.") };
  }
  const routed = await routeConfirmedAction({
    userId, actionType: "OPEN", requestedMode: "DEMO", tradeKey: null,
    symbol: input.symbol, side: input.side, orderType: null, lotSize: input.volume, requestedPrice: null,
    stopLoss: input.stopLoss ? input.stopLoss : null, takeProfit: input.takeProfit ? input.takeProfit : null,
    source: null, sourcePage: DEMO_PANEL_SOURCE,
  });
  if (!routed.ok) {
    return {
      ok: false as const,
      http: 422,
      body: { ...blockedDemo(`The DEMO queue refused this order: ${routed.reason}.`), code: "DEMO_QUEUE_REFUSED", commandId: routed.commandId },
    };
  }

  return {
    ok: true as const,
    http: 200,
    body: {
      queued: true,
      commandId: routed.commandId,
      action: "PLACE_MARKET_ORDER" as const,
      demoOnly: true,
      maxDemoLot: MAX_DEMO_LOT,
      // Echo canonical safety so the dashboard never misreads this success
      // as "live execution available".
      executionMode: "READ_ONLY",
      liveExecutionEnabled: false,
      disclaimer: DISCLAIMER,
    },
  };
}

// ── POST /paper/demo-execution/queue ─────────────────────────────────────────
router.post("/queue", async (req: Request, res: Response) => {
  const parsed = demoBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json(
      blockedDemo(
        `Invalid demo order body: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
      )
    );
    return;
  }
  const result = await validateAndQueueDemo(parsed.data, "api:queue", req.authUser?.id ?? null);
  res.status(result.http).json(result.body);
});

// ── POST /paper/demo-execution/test  (single 0.01 lot, no looping) ──────────
//   Spec: "queue one 0.01 demo order only after validation passes." Hardcoded
//   side defaults to BUY, MAX_DEMO_LOT volume, no SL/TP. One call = one order.
const testBody = z.object({
  symbol: z.string().min(1).max(32).optional(),
  side: z.enum(["BUY", "SELL"]).optional(),
});
router.post("/test", async (req: Request, res: Response) => {
  const parsed = testBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json(blockedDemo("Invalid test body."));
    return;
  }
  const result = await validateAndQueueDemo(
    {
      symbol: parsed.data.symbol ?? "EURUSD",
      side: parsed.data.side ?? "BUY",
      volume: MAX_DEMO_LOT,
      reason: "ARX AI Demo Execution test order (single shot)",
      demoOnly: true,
      executionMode: "READ_ONLY_WITH_DEMO_EXECUTION",
    },
    "api:test",
    req.authUser?.id ?? null,
  );
  res.status(result.http).json(result.body);
});

export default router;
