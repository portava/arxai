// Frontend wrapper for the global Instant Trade Router.
//
// Every trade-capable surface (trade page, scanner, chart, watchlist,
// position card, dashboard, alert click-through, Ruby AI panel) calls
// `executeInstantTrade()` with a properly-tagged `source` so the
// backend can audit-attribute the click and Ruby commands flow through
// the same gated path as one-click button presses.
export type InstantTradeSource =
  | "trade_panel" | "scanner" | "chart" | "chart_drag" | "watchlist"
  | "position_card" | "dashboard" | "alert"
  | "ruby_text" | "ruby_voice";

export type InstantTradeAction = "BUY" | "SELL" | "CLOSE" | "CLOSE_ALL" | "MODIFY_SL_TP";

export type InstantTradeIntent = {
  source: InstantTradeSource;
  action: InstantTradeAction;
  accountMode: "live" | "demo" | "paper";
  symbol?: string;
  volume?: number;
  orderType?: string;
  /** Pending orders (MT5): the trigger price. Buy Limit below Ask, Sell Limit above Bid, Buy Stop above Ask, Sell Stop below Bid. */
  price?: number | null;
  /** Stop-limit orders: the limit leg placed once the stop price is reached. */
  stopLimitPrice?: number | null;
  /** ISO datetime; null/absent = Good Till Cancelled. */
  expiration?: string | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  positionId?: string;
  newStopLoss?: number | null;
  newTakeProfit?: number | null;
  oneClick?: boolean;
  aiCommand?: boolean;
  rawUserCommand?: string | null;
};

export type InstantTradeResponse = {
  ok: boolean;
  action?: InstantTradeAction;
  commandId?: string;
  error?: string;
  primaryReason?: string | null;
  detail?: unknown;
};

async function post(path: string, body: unknown): Promise<InstantTradeResponse> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  let json: InstantTradeResponse;
  try { json = (await r.json()) as InstantTradeResponse; }
  catch { json = { ok: false, error: `HTTP_${r.status}` }; }
  return json;
}

export async function executeInstantTrade(intent: InstantTradeIntent): Promise<InstantTradeResponse> {
  if (intent.action === "CLOSE") return post("/api/trades/instant/close", intent);
  if (intent.action === "CLOSE_ALL") return post("/api/trades/instant/close-all", intent);
  return post("/api/trades/instant/execute", intent);
}

export async function validateInstantTrade(intent: InstantTradeIntent): Promise<InstantTradeResponse> {
  return post("/api/trades/instant/validate", intent);
}

export type RubyCommandResponse = {
  ok: boolean;
  classification?: string;
  message?: string;
  action?: string;
  commandId?: string;
  watchId?: number;
  error?: string;
  primaryReason?: string | null;
  confirmationRequired?: boolean;
  pendingAction?: { kind: string; action: string; symbol: string | null; volume: number | null };
  deferred?: boolean;
  reason?: string;
  retryAfterSeconds?: number;
};

// Ruby's gated command path (2026-11-04: now called by the chat panel for
// direct commands). The server parses, checks AI-Assisted authority and
// per-action permissions, asks for confirmation (confirm:true on the resend)
// and runs the full instant-trade gate chain. Nothing here bypasses a gate.
export async function sendRubyTradeCommand(args: {
  text: string;
  source?: "ruby_text" | "ruby_voice";
  accountMode?: "live" | "demo";
  confirm?: boolean;
}): Promise<RubyCommandResponse> {
  const r = await fetch("/api/me/assistant/instant-trade-command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      text: args.text,
      source: args.source ?? "ruby_text",
      accountMode: args.accountMode ?? "live",
      ...(args.confirm === true ? { confirm: true } : {}),
    }),
  });
  try { return (await r.json()) as RubyCommandResponse; }
  catch { return { ok: false, error: `HTTP_${r.status}` }; }
}

export type RubyWatchView = {
  id: number;
  kind: string;
  status: string;
  symbol: string | null;
  side: string | null;
  lot: number | null;
  positionTicket: string | null;
  trigger: { op: string; price: number } | null;
  expiresAt: string | null;
  createdAt: string;
  monitor: {
    alertsSinceAck: number;
    maxAlerts: number;
    lastAlertAt: string | null;
    acknowledgedAt: string | null;
    keepCount: number;
    awaitingAnswer: boolean;
    lastAlert: { at: string; price: number | null; reversalRiskScore: number | null; health: string; reason: string } | null;
    /** Per-monitor: the trader let Ruby shift SL/TP on a fakeout (bounded, audited). */
    fakeoutAuthority?: boolean;
    /** Count of fakeout shifts Ruby has sent for this monitor. */
    fakeoutAdjustments?: number;
    lastFakeoutAdjustment?: { at: string; toStopLoss: number | null; toTakeProfit: number | null; reason: string; ok: boolean; blocked: string | null } | null;
  } | null;
};

/** Grant or revoke the assistant's authority to shift this monitor's SL/TP on a fakeout. Server audits both ways. */
export async function setRubyWatchFakeoutAuthority(watchId: number, enabled: boolean): Promise<{ ok: boolean; message?: string; error?: string }> {
  const r = await fetch(`/api/me/assistant/watches/${encodeURIComponent(String(watchId))}/fakeout-authority`, {
    method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
    body: JSON.stringify({ enabled }),
  });
  try { return (await r.json()) as { ok: boolean; message?: string; error?: string }; }
  catch { return { ok: false, error: `HTTP_${r.status}` }; }
}

export async function fetchRubyWatches(): Promise<{ ok: boolean; watches: RubyWatchView[]; sweeper?: { enabled: boolean; running: boolean; intervalMs: number } }> {
  const r = await fetch("/api/me/assistant/watches", { credentials: "include" });
  try { return (await r.json()) as { ok: boolean; watches: RubyWatchView[] }; }
  catch { return { ok: false, watches: [] }; }
}

export async function ackRubyWatch(watchId: number, decision: "keep" | "close"): Promise<{ ok: boolean; message?: string; error?: string }> {
  const r = await fetch(`/api/me/assistant/watches/${watchId}/ack`, {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  try { return (await r.json()) as { ok: boolean; message?: string; error?: string }; }
  catch { return { ok: false, error: `HTTP_${r.status}` }; }
}
