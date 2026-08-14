// ─────────────────────────────────────────────────────────────────────────────
// ARX AI — DEMO-ONLY MT5 Execution Layer (Phase: Demo Exec)
//
// Hard safety contract:
//   * Live execution stays impossible. liveExecutionEnabled / liveBrokerExecution-
//     Available / brokerPlacementImplemented all remain false everywhere else.
//   * This layer queues commands ONLY with action="DEMO_MARKET_ORDER" and
//     volume <= 0.01. The EA refuses anything else and refuses ALL orders on
//     a non-DEMO MT5 account.
//   * Server-side enable: requires env ARX_ALLOW_DEMO_EXECUTION=true. Default
//     OFF. If unset, every demo queue/test endpoint returns
//     BLOCKED_DEMO_SAFETY_GUARD.
//   * Real (live) account detected via mt5_state.liveAllowed → returns
//     BLOCKED_READ_ONLY_MODE with the documented reason string.
//   * No martingale / no auto-repeat. The /test endpoint queues exactly one
//     order per call and never loops.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import { db } from "@workspace/db";
import { mt5StateTable, mt5CommandsTable } from "@workspace/db";
import { denyInvestorExecution } from "../lib/auth/productRole.js";

const router = Router();
// Task #71 — investor accounts cannot reach demo execution either.
router.use(denyInvestorExecution);

const MAX_DEMO_LOT = 0.01;
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
  const rows = await db.select().from(mt5StateTable).limit(1);
  const s = rows[0] ?? null;
  // mt5_state.liveAllowed is set by the EA heartbeat: 1 when ACCOUNT_TRADE_MODE
  // == ACCOUNT_TRADE_MODE_REAL. Anything else (0/null) is treated as DEMO/UNKNOWN.
  let accountType: "DEMO" | "REAL" | "UNKNOWN";
  if (!s || s.lastHeartbeatAt === null) accountType = "UNKNOWN";
  else if (s.liveAllowed === 1) accountType = "REAL";
  else accountType = "DEMO";
  const ageMs = s?.lastHeartbeatAt ? Date.now() - new Date(s.lastHeartbeatAt).getTime() : null;
  const isFresh = ageMs !== null && ageMs < 15_000;
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
    allowedAction: "DEMO_MARKET_ORDER",
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

async function validateAndQueueDemo(input: z.infer<typeof demoBody>, source: string) {
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

  // 4. Insert directly into mt5_commands with action="DEMO_MARKET_ORDER".
  //    NOTE: we deliberately do NOT route through queueMt5CommandWithGate /
  //    queueCommand — those are typed for OPEN/CLOSE/MODIFY/CLOSE_ALL and
  //    apply the LIVE-armed gate. This is a parallel, demo-only insert.
  //    The EA enforces ALL of: ACCOUNT_TRADE_MODE==DEMO, DemoExecutionMode,
  //    AllowDemoOrderExecution, RequireDemoAccount, demoOnly==true,
  //    volume<=MaxDemoLot, action=="DEMO_MARKET_ORDER".
  const detail = JSON.stringify({
    demoOnly: true,
    executionMode: input.executionMode,
    reason: input.reason ?? `ARX AI demo execution (${source})`,
    queuedAt: new Date().toISOString(),
    source,
  });
  const inserted = await db
    .insert(mt5CommandsTable)
    .values({
      action: "DEMO_MARKET_ORDER",
      symbol: input.symbol,
      side: input.side,
      lot: input.volume,
      sl: input.stopLoss ?? null,
      tp: input.takeProfit ?? null,
      ticket: null,
      status: "PENDING",
      detail,
    })
    .returning();

  return {
    ok: true as const,
    http: 200,
    body: {
      queued: true,
      commandId: inserted[0]?.id,
      action: "DEMO_MARKET_ORDER" as const,
      demoOnly: true,
      maxDemoLot: MAX_DEMO_LOT,
      // Echo canonical safety so the dashboard never misreads this success
      // as "live execution available".
      executionMode: "READ_ONLY",
      placementLayer: "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED",
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
  const result = await validateAndQueueDemo(parsed.data, "api:queue");
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
    "api:test"
  );
  res.status(result.http).json(result.body);
});

export default router;
