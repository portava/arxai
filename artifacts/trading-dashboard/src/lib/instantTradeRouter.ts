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

export async function sendRubyTradeCommand(args: {
  text: string;
  source?: "ruby_text" | "ruby_voice";
  accountMode?: "live" | "demo" | "paper";
}): Promise<{
  ok: boolean;
  classification?: string;
  message?: string;
  action?: string;
  commandId?: string;
  error?: string;
  primaryReason?: string | null;
}> {
  const r = await fetch("/api/me/assistant/instant-trade-command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      text: args.text,
      source: args.source ?? "ruby_text",
      accountMode: args.accountMode ?? "live",
    }),
  });
  try { return (await r.json()) as { ok: boolean }; }
  catch { return { ok: false, error: `HTTP_${r.status}` }; }
}
