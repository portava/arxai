// Live pending orders — cancel / modify from ARX.
//
// POST /api/me/live/pending-orders/:commandId/cancel  {oneClick?, confirmedByUser?}
// POST /api/me/live/pending-orders/:commandId/modify  {price?, sl?, tp?, confirmedByUser}
//
// The server runs the governed live path (draft → confirm → every dispatch
// gate → the EA's CANCEL_PENDING / MODIFY_PENDING). With live one-click ON a
// cancel goes on the first press; with it OFF the caller must have shown its
// confirm dialog and sends `confirmedByUser: true`. A modify always comes from
// the dialog's explicit submit. "Sent" is not "done": the broker's answer
// arrives on the pending list (the order disappears, or shows its new levels).
import { humanizeReason } from "@/lib/humanize";
import { parseNum } from "@/lib/orderTicketRules";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export type LivePendingControlResult = { ok: boolean; commandId: string | null; reason: string | null; message: string };

function messageOf(body: Record<string, unknown>, fallback: string): string {
  const detail = typeof body.userMessage === "string" ? body.userMessage
    : typeof body.detail === "string" ? body.detail : null;
  if (detail) return detail;
  const code = (body.primaryReason ?? body.reason ?? body.error) as unknown;
  return code ? humanizeReason(code).description : fallback;
}

async function post(path: string, body: Record<string, unknown>, fetchImpl: typeof fetch): Promise<LivePendingControlResult> {
  let r: Response;
  try {
    r = await fetchImpl(`${BASE}${path}`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, commandId: null, reason: "NETWORK_ERROR", message: "Couldn't reach ARX. Nothing was sent; check MT5 before trying again." };
  }
  let j: Record<string, unknown> = {};
  try { j = (await r.json()) as Record<string, unknown>; } catch { /* non-JSON body */ }
  const ok = r.ok && j.ok === true;
  const reason = ok ? null : String(j.primaryReason ?? j.reason ?? j.error ?? `HTTP_${r.status}`);
  return {
    ok,
    commandId: typeof j.commandId === "string" ? j.commandId : null,
    reason,
    message: ok ? "Sent to MT5. The list updates when the broker answers." : messageOf(j, "The request was refused."),
  };
}

export function cancelLivePendingOrder(a: { commandId: string; oneClick: boolean; fetchImpl?: typeof fetch }) {
  return post(`/api/me/live/pending-orders/${encodeURIComponent(a.commandId)}/cancel`,
    a.oneClick ? { oneClick: true } : { confirmedByUser: true }, a.fetchImpl ?? fetch);
}

export function modifyLivePendingOrder(a: {
  commandId: string; price: number | null; stopLoss: number | null; takeProfit: number | null; fetchImpl?: typeof fetch;
}) {
  const body: Record<string, unknown> = { confirmedByUser: true };
  if (a.price != null) body.price = a.price;
  if (a.stopLoss != null) body.sl = a.stopLoss;
  if (a.takeProfit != null) body.tp = a.takeProfit;
  return post(`/api/me/live/pending-orders/${encodeURIComponent(a.commandId)}/modify`, body, a.fetchImpl ?? fetch);
}

/**
 * What a modify sends: a field left empty or equal to the current level is
 * not sent (the server keeps it). Removing a level is not offered (the live
 * terminal would remove it silently on 0; do that in MT5).
 */
export function pendingModifyChanges(a: {
  current: { price: number | null; stopLoss: number | null; takeProfit: number | null };
  priceText: string; slText: string; tpText: string;
}): { price: number | null; stopLoss: number | null; takeProfit: number | null; error: string | null } {
  const parse = (t: string, label: string): number | null | string => {
    if (t.trim() === "") return null;
    const n = parseNum(t);
    return n == null ? `${label} must be a price above 0.` : n;
  };
  const p = parse(a.priceText, "Price"), sl = parse(a.slText, "Stop Loss"), tp = parse(a.tpText, "Take Profit");
  for (const v of [p, sl, tp]) if (typeof v === "string") return { price: null, stopLoss: null, takeProfit: null, error: v };
  const changed = (v: number | null | string, cur: number | null) => (typeof v === "number" && (cur == null || Math.abs(v - cur) > 1e-12) ? v : null);
  const out = {
    price: changed(p, a.current.price),
    stopLoss: changed(sl, a.current.stopLoss),
    takeProfit: changed(tp, a.current.takeProfit),
  };
  if (out.price == null && out.stopLoss == null && out.takeProfit == null) {
    return { ...out, error: "Change the price, Stop Loss or Take Profit first." };
  }
  return { ...out, error: null };
}
