// My Trades DEMO / LIVE opens (owner decision 15, 2026-10-25).
//
// DEMO: a confirmed My Trades DEMO open goes through the existing governed
// pipeline, the same one a Trade Action Center DEMO open uses. It is
// recorded as a Trade Action (trade_action_requests, source user_initiated,
// sourcePage ME_TRADES_DEMO_OPEN) and confirmed through confirmAction:
//   1. explicit confirmation (confirmedByUser) and the explicit mode DEMO;
//   2. the trader's own trading mode must permit DEMO (the same envelope
//      ladder the My Trades order guard used: DISABLED / SIMULATED refuse);
//   3. runActionGuards: ownership, both platform stops, the platform DEMO
//      venue switch, suspension, routing, account type (never a live
//      account), the platform lot cap, the Risk Governor (venue DEMO, the
//      trader's, operator's and platform's limits: sizing), duplicate,
//      expiry, a resolved MT5 connection;
//   4. submitTrade mode DEMO → demoCommandQueue: per-user demo arming,
//      VERIFIED_DEMO readiness, a fresh demo bridge the trader owns (or the
//      routed master), master exposure, and the Risk Governor again at
//      dispatch.
// Every refusal is returned as-is; nothing here relaxes a gate. The legacy
// adminTrading placement chain (placeOrder) still refuses DEMO structurally
// (bridge_token) and is not used for a My Trades DEMO open.
//
// LIVE: refused here with MY_TRADES_LIVE_OPEN_NOT_ENABLED. My Trades live
// opens stay off until broker validation passes and the owner separately
// authorizes this surface. Nothing is drafted, audited as approved or sent.

import { getEnvelope } from "../adminTrading/safetyEnvelope.js";
import { createActionDraft } from "./create.js";
import { confirmAction } from "./confirm.js";
import type { ActionSummary } from "./types.js";

export const MY_TRADES_DEMO_SOURCE = "ME_TRADES_DEMO_OPEN";
export const MY_TRADES_LIVE_NOT_ENABLED = "MY_TRADES_LIVE_OPEN_NOT_ENABLED" as const;
export const MY_TRADES_LIVE_NOT_ENABLED_MESSAGE =
  "Live opens from My Trades are not enabled. They stay off until broker validation passes and the owner separately authorizes this surface. Nothing was sent.";

export interface MyTradesDemoOpenInput {
  userId: number;
  symbol: string;
  side: "BUY" | "SELL";
  lotSize: number;
  stopLoss: number | null;
  takeProfit: number | null;
  confirmedByUser: boolean;
}

export interface MyTradesDemoReceipt {
  mode: "DEMO";
  venue: "DEMO";
  actionId: number;
  status: string;
  commandId: string | null;
  sent: boolean;
}

export type MyTradesDemoResult =
  | { ok: true; demo: MyTradesDemoReceipt; action: ActionSummary }
  | { ok: false; mode: "DEMO"; venue: "DEMO"; error: string; message: string; action?: ActionSummary };

const refuse = (error: string, message: string, action?: ActionSummary): MyTradesDemoResult =>
  ({ ok: false, mode: "DEMO", venue: "DEMO", error, message, ...(action ? { action } : {}) });

/** Open a confirmed My Trades DEMO order through the governed DEMO pipeline. */
export async function openMyTradesDemo(input: MyTradesDemoOpenInput): Promise<MyTradesDemoResult> {
  if (!input.confirmedByUser) return refuse("CONFIRMATION_REQUIRED", "Confirm the demo order before it is sent.");
  if (!(input.userId > 0)) return refuse("NOT_AUTHENTICATED", "Sign in to place a demo order.");

  // The trader's own mode must permit DEMO (LIVE ⊇ DEMO ⊇ SIMULATED).
  const env = await getEnvelope(input.userId);
  if (env.tradingMode === "DISABLED") return refuse("USER_TRADING_DISABLED", "Trading is disabled for your account.");
  if (env.tradingMode === "SIMULATED") {
    return refuse("MODE_NOT_PERMITTED_FOR_USER:DEMO", "Demo trading is not enabled for your account right now.");
  }

  const draft = await createActionDraft({
    userId: input.userId, actionType: "OPEN", tradeKey: null, requestedMode: "DEMO",
    symbol: input.symbol, side: input.side, lotSize: input.lotSize,
    stopLoss: input.stopLoss, takeProfit: input.takeProfit,
    reason: "My Trades demo order", source: "user_initiated",
  });
  if (!draft.ok) return refuse(draft.error, `The demo order could not be recorded (${draft.error}).`);

  const r = await confirmAction({ userId: input.userId, actionId: draft.action.id, sourcePage: MY_TRADES_DEMO_SOURCE });
  if (!r.ok) {
    return refuse(r.error, r.action?.rejectionReason ?? `The demo order was refused (${r.error}).`, r.action);
  }
  const a = r.action;
  return {
    ok: true, action: a,
    demo: { mode: "DEMO", venue: "DEMO", actionId: a.id, status: a.status, commandId: a.venueCommandId, sent: a.status === "sent_to_mt5" },
  };
}
