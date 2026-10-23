// Phase C (T005) — Frontend API helpers for the Phase B live shared-account
// trade endpoints. These wrap /api/trades/live-shared/* with:
//   - credentials:"include" (session cookie only — NO bearer tokens,
//     NO MT5 login/password/server fields anywhere in this file)
//   - explicit handling of 401/403/409/500 responses (returned, not thrown)
//   - no automatic retry on /execute (would risk double-submit)
//   - no client-supplied idempotency key. The server is the sole owner of
//     idempotency: it derives a SHA-256 of
//     (userId|symbol|side|lot|sl|tp|minuteBucket) on /execute and refuses
//     duplicates with DUPLICATE_LIVE_IDEMPOTENCY_KEY. UI guards against
//     double-tap purely by disabling submit while a request is in flight.
//
// SECURITY: every response is passed through verbatim. Callers must check
// `result.ok` and surface `result.reason`/`result.primaryReason` to the
// user — never auto-retry a refusal.

import type { ExecutionPreview } from "@workspace/domain/execution-preview";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const u = (p: string) => `${BASE}${p}`;

// ── Shared response envelope. Every endpoint returns these flags so the
//    caller can render mode chips honestly without guessing.
export type LiveSharedEnvelope = {
  safetyMode: "phase_b_live_runtime_gated";
  liveBrokerExecutionEnabled: boolean;
  liveDispatchEvaluator: "evaluateLivePhaseBDispatchGate";
  liveExecutionDefaultDeny: true;
};

export type LiveSharedValidateResult = LiveSharedEnvelope & {
  ok: boolean;
  stage?: "preflight" | "preflight_passed" | "validate_cancel_failed";
  commandId?: string;
  cancelled?: boolean;
  reason?: string | null;
  detail?: string | null;
  primaryReason?: string | null;
  blockReasons?: string[];
  note?: string | null;
  // Routing precondition (409) and input validation (400) envelopes use
  // `error` instead of `reason`. The clean-copy mapper reads this too so
  // those refusals don't fall through to the generic sentence.
  error?: string | null;
};

export type LiveSharedExecuteResult = LiveSharedEnvelope & {
  ok: boolean;
  stage?: "preflight" | "confirm" | "attribution_pre_dispatch_failed";
  commandId?: string;
  attributionId?: number | null;
  reason?: string | null;
  detail?: string | null;
  primaryReason?: string | null;
  blockReasons?: string[];
  // Task #737 follow-up — the SPECIFIC execution-readiness blocker (e.g.
  // LIVE_CONFIRMATION_REQUIRED) the backend threads alongside the generic
  // canonical reason so the ticket can show distinct copy per cause.
  blockingReasonCode?: string | null;
  commandRenderedTerminal?: boolean;
};

export type LiveSharedAccessStatus = {
  canTrade: boolean;
  status: string | null;
  blockReason: string | null;
  message: string | null;
};

export type LiveSharedCommandRow = {
  commandId: string;
  status: string;
  symbol: string | null;
  side: string | null;
  requestedVolume: string | number | null;
  stopLoss: string | number | null;
  takeProfit: string | number | null;
  sourcePage: string | null;
  rejectionReason: string | null;
  // Broker-truth fields captured from the EA command result (Phase 8). Present
  // on terminal rows the broker actually answered; null until then. The server
  // projects these in USER_COMMAND_KEYS (tradesLiveShared.ts).
  mt5Retcode?: number | string | null;
  brokerMessage?: string | null;
  confirmedAt: string | null;
  sentToMt5At: string | null;
  filledAt: string | null;
  brokerTicket: string | null;
  fillPrice: string | number | null;
  payload?: Record<string, unknown> | null;
};

export type LiveSharedTradeIntent = {
  symbol: string;
  // Exact broker symbol resolved from the backend symbol directory. When
  // present the server uses this for execution; `symbol` stays the friendly
  // label for UI/audit. Optional so existing callers keep compiling.
  brokerSymbol?: string | null;
  side: "BUY" | "SELL";
  volume: number;
  // Optional for owner/admin manual live trades. When blank in the UI we
  // send null; the server enforces the stop-loss requirement per profile
  // (16-gate evaluator gate 16 still runs — owner-unrestricted waives it).
  stopLoss: number | null;
  takeProfit?: number | null;
  rubyExplanationSummary?: string | null;
};

async function postJson<T>(path: string, body: unknown): Promise<T & { __httpStatus: number }> {
  const r = await fetch(u(path), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  let parsed: unknown = null;
  try { parsed = await r.json(); } catch { parsed = { ok: false, reason: `HTTP_${r.status}` }; }
  return { ...(parsed as object), __httpStatus: r.status } as T & { __httpStatus: number };
}

async function getJson<T>(path: string): Promise<T & { __httpStatus: number }> {
  const r = await fetch(u(path), { credentials: "include" });
  let parsed: unknown = null;
  try { parsed = await r.json(); } catch { parsed = { ok: false, reason: `HTTP_${r.status}` }; }
  return { ...(parsed as object), __httpStatus: r.status } as T & { __httpStatus: number };
}

export const LIVE_SHARED_EXECUTE_PHRASE = "EXECUTE LIVE SHARED" as const;

// ── /validate — dry-run; never queues for the EA. Safe to call repeatedly.
export function validateLiveSharedTrade(intent: LiveSharedTradeIntent) {
  return postJson<LiveSharedValidateResult>("/api/trades/live-shared/validate", {
    symbol: intent.symbol, side: intent.side, volume: intent.volume,
    stopLoss: intent.stopLoss ?? null, takeProfit: intent.takeProfit ?? null,
  });
}

// ── /execute — typed-phrase gated; only call AFTER an explicit user
// confirmation. Caller MUST disable the submit button while awaiting.
export function executeLiveSharedTrade(intent: LiveSharedTradeIntent) {
  return postJson<LiveSharedExecuteResult>("/api/trades/live-shared/execute", {
    confirmationIntent: LIVE_SHARED_EXECUTE_PHRASE,
    symbol: intent.symbol, brokerSymbol: intent.brokerSymbol ?? null,
    side: intent.side, volume: intent.volume,
    stopLoss: intent.stopLoss ?? null, takeProfit: intent.takeProfit ?? null,
    rubyExplanationSummary: intent.rubyExplanationSummary ?? null,
  });
}

// ── /positions/:ticket/modify — SL/TP change. Goes through validation
// (Phase B 16-gate) and requires user confirmation in the UI before call.
export function modifyLiveSharedTrade(args: {
  ticket: string; stopLoss?: number | null; takeProfit?: number | null;
}) {
  return postJson<LiveSharedExecuteResult>(
    `/api/trades/live-shared/positions/${encodeURIComponent(args.ticket)}/modify`,
    { stopLoss: args.stopLoss ?? null, takeProfit: args.takeProfit ?? null },
  );
}

// ── /positions/:ticket/close — emergency close. Also gate-checked.
export function closeLiveSharedTrade(ticket: string) {
  return postJson<LiveSharedExecuteResult>(
    `/api/trades/live-shared/positions/${encodeURIComponent(ticket)}/close`,
    {},
  );
}

// ── /cancel — abort an in-flight draft/confirmation. Idempotent on the
// server (a no-op if the command is already terminal).
export function cancelLiveSharedPendingOrder(commandId: string) {
  return postJson<LiveSharedExecuteResult>(
    "/api/trades/live-shared/cancel",
    { commandId, reason: "USER_CANCELLED_FROM_UI" },
  );
}

// ── Read-only listings. Scoped server-side to the calling user via
// uid(req); a regular user never sees another user's rows.
export function getMyLiveSharedCommands(limit = 50) {
  return getJson<LiveSharedEnvelope & { commands: LiveSharedCommandRow[] }>(
    `/api/trades/live-shared/commands?limit=${encodeURIComponent(String(limit))}`,
  );
}

export function getMyLiveSharedTrades(limit = 50) {
  // Attribution rows are the per-user trade journal (one row per shared
  // execute). pending → open → closed/rejected mirrors the lifecycle.
  return getJson<LiveSharedEnvelope & { attributions: Array<{
    id: number; symbol: string; side: string; lotSize: string | number;
    stopLoss: string | number | null; takeProfit: string | number | null;
    status: string; rejectionReason: string | null;
    createdAt: string | null; updatedAt: string | null;
  }> }>(
    `/api/trades/live-shared/attributions?limit=${encodeURIComponent(String(limit))}`,
  );
}

// ── Access status used by every gating component. Pure UI convenience —
// the server re-checks the master-live-access gate on every dispatch.
export function getMyLiveSharedAccessStatus() {
  return getJson<LiveSharedAccessStatus>("/api/me/master-live/access");
}

// ── Advisory SL/TP suggestion (READ-ONLY). Derives a suggested stop-loss
// and take-profit from the market's recent volatility (ATR-based). Places
// no order and touches no safety surface — the UI prefills the editable
// SL/TP fields with these values; the user can change/clear them and the
// full 16-gate evaluator still runs on /execute.
export type LiveSltpSuggestion =
  | (LiveSharedEnvelope & {
      ok: true;
      symbol: string;
      side: "BUY" | "SELL";
      entry: number;
      entrySource: "provided" | "last_close";
      atr: number;
      atrPct: number;
      volatilityState: string;
      riskReward: number;
      suggestedStopLoss: number;
      suggestedTakeProfit: number;
      method: string;
      note: string;
    })
  | (LiveSharedEnvelope & {
      ok: false;
      reason?: string | null;
      error?: string | null;
      userMessage?: string | null;
    });

export function suggestLiveSharedSltp(args: {
  symbol: string; side: "BUY" | "SELL"; entry?: number | null;
}) {
  const q = new URLSearchParams({ symbol: args.symbol, side: args.side });
  if (args.entry != null && Number.isFinite(args.entry) && args.entry > 0) {
    q.set("entry", String(args.entry));
  }
  return getJson<LiveSltpSuggestion>(`/api/trades/live-shared/suggest-sltp?${q.toString()}`);
}

// ── Execution Cost & Survivability preview (READ-ONLY, Task #196).
// Returns the honest pre-trade execution economics for the configured order
// (spread cost, lot-scaled slippage, expected fill range, starting drawdown,
// break-even, after-cost TP/SL & R:R, survivability, account impact, order-type
// recommendation, multi-entry exposure, broker-condition verdict). Places no
// order and touches no safety surface — purely advisory; the full 16-gate
// evaluator still runs on /execute. The `preview` shape is the domain
// `ExecutionPreview` (single source of truth — no frontend drift).
export type LiveExecutionPreviewResult =
  | (LiveSharedEnvelope & { ok: true; preview: ExecutionPreview })
  | (LiveSharedEnvelope & {
      ok: false;
      reason?: string | null;
      error?: string | null;
      userMessage?: string | null;
    });

export function getLiveSharedExecutionPreview(args: {
  symbol: string;
  side: "BUY" | "SELL";
  orderType?: "MARKET" | "LIMIT" | "STOP";
  lots?: number | null;
  entry?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  maxSpreadPoints?: number | null;
}) {
  const q = new URLSearchParams({ symbol: args.symbol, side: args.side });
  if (args.orderType) q.set("orderType", args.orderType);
  const numArg = (key: string, v: number | null | undefined) => {
    if (v != null && Number.isFinite(v)) q.set(key, String(v));
  };
  numArg("lots", args.lots);
  numArg("entry", args.entry);
  numArg("stopLoss", args.stopLoss);
  numArg("takeProfit", args.takeProfit);
  numArg("maxSpreadPoints", args.maxSpreadPoints);
  return getJson<LiveExecutionPreviewResult>(
    `/api/trades/live-shared/execution-preview?${q.toString()}`,
  );
}
