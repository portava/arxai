// Phase 3 — Broker Placement Layer (SIMULATED only).
//
// Callable ONLY from placeOrder() in ./placeOrder.ts, after runOrderGuards()
// returns APPROVED. Order guard gate 8 ("bridge_token") already refuses every
// DEMO and LIVE order structurally: LIVE goes through liveCommandPipeline,
// DEMO through demoCommandQueue. This layer used to keep a dormant writer
// into the legacy mt5_commands mailbox for DEMO/LIVE; it is gone (Tier 1
// Trade Engine: one pipeline), and a DEMO/LIVE call that ever got here is
// refused rather than queued.

import { createHash } from "node:crypto";
import type { RoutingDecision } from "./routingResolver.js";

export type PlacementMode = "SIMULATED" | "DEMO" | "LIVE";

export interface BrokerPlacementArgs {
  userId: number;
  mode: PlacementMode;
  symbol: string;
  side: "BUY" | "SELL";
  lotSize: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  auditLogId: number;            // row in trade_command_audit_log (status='APPROVED')
  requestedBy: "user" | "ai-assistant" | "system";
  ttlSeconds?: number;
  // Phase 3.5 — pre-resolved routing decision from the guard chain.
  // When provided, we honor it; otherwise we fall back to the user's own
  // MT5 connection (legacy USER_OWNED_MT5 behavior).
  routing?: RoutingDecision;
}

export interface BrokerPlacementResult {
  ok: boolean;
  mode: PlacementMode;
  commandId: number | null;
  status: "QUEUED" | "SIMULATED_FILL" | "DUPLICATE_BLOCKED" | "NO_CONNECTION" | "ERROR";
  idempotencyKey: string;
  expiresAt: string | null;
  detail?: string;
}

// Phase 3 sentinel — broker placement layer is now LIVE in code. The
// per-user envelope and runtime singleton (`global_trading_settings`)
// still govern whether it is actually exercised. Default platform mode
// is OFF; the singleton stays fail-closed unless an admin explicitly acts.
export const BROKER_PLACEMENT_LAYER_ENABLED = true as const;

function buildIdempotencyKey(args: BrokerPlacementArgs): string {
  const bucket = Math.floor(Date.now() / 60_000); // 1-minute window
  const raw = `${args.userId}|${args.mode}|${args.symbol}|${args.side}|${args.lotSize}|${bucket}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

export async function dispatchToBroker(args: BrokerPlacementArgs): Promise<BrokerPlacementResult> {
  const idempotencyKey = buildIdempotencyKey(args);

  // ── SIMULATED mode — never touches MT5, fills instantly internally. ────
  if (args.mode === "SIMULATED") {
    return {
      ok: true,
      mode: "SIMULATED",
      commandId: null,
      status: "SIMULATED_FILL",
      idempotencyKey,
      expiresAt: null,
      detail: "Simulator fill — no broker routing.",
    };
  }

  // ── DEMO / LIVE — never from here; the venue queues own them. ───────────
  return {
    ok: false, mode: args.mode, commandId: null, status: "ERROR", idempotencyKey, expiresAt: null,
    detail: args.mode === "LIVE" ? "LIVE_DISPATCH_DISABLED_USE_PHASE_B" : "DEMO_DISPATCH_DISABLED_USE_DEMO_QUEUE",
  };
}
