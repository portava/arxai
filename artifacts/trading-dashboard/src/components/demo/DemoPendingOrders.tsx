import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Clock, Loader2, X } from "lucide-react";
import { cancelDemoPendingOrder } from "@/lib/tradeActions";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export type DemoPendingOrder = {
  commandId: string;
  orderTicket: string | null;
  symbol: string | null;
  side: string | null;
  orderType: string | null;
  lotSize: number | null;
  price: number | null;
  stopLimitPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  expirationEpoch: number | null;
  placedAt: string | null;
};

/** "Buy Stop Limit" from BUY_STOP_LIMIT. */
export function pendingTypeLabel(t: string | null): string {
  if (!t) return "—";
  return t.split("_").map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(" ");
}

/** Rows the server returned, or [] for any other body (never invents a row). */
export function pendingOrderRows(body: unknown): DemoPendingOrder[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.filter((i): i is DemoPendingOrder =>
    !!i && typeof i === "object" && typeof (i as DemoPendingOrder).commandId === "string");
}

/**
 * Demo pending orders resting at the broker (PLACED_DEMO, demo EA v1.32).
 * Cancel queues a governed CANCEL_PENDING_ORDER (draft → confirm → dispatch)
 * and waits for the broker's answer. Renders nothing while there are none.
 */
export function DemoPendingOrders({ onChanged }: { onChanged?: () => void }) {
  const [rows, setRows] = useState<DemoPendingOrder[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const { toast } = useToast();

  async function load() {
    try {
      const r = await fetch(`${BASE}/api/me/demo-pending-orders`, { credentials: "include" });
      if (!r.ok) return;
      setRows(pendingOrderRows(await r.json()));
    } catch { /* keep the last list */ }
  }

  useEffect(() => {
    void load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  async function cancel(o: DemoPendingOrder) {
    if (!o.orderTicket || !o.symbol) return;
    setBusy(o.commandId);
    try {
      const r = await cancelDemoPendingOrder({ orderTicket: o.orderTicket, symbol: o.symbol });
      if (r.ok) {
        toast({ title: "Pending order cancelled", description: `${pendingTypeLabel(o.orderType)} ${o.symbol} (ticket ${o.orderTicket}) removed on demo.` });
      } else {
        toast({ title: "Cancel did not complete", description: `${r.status}: ${r.reason ?? "no reason returned"}`, variant: "destructive" });
      }
      await load();
      onChanged?.();
    } finally {
      setBusy(null);
    }
  }

  if (rows.length === 0) return null;
  return (
    <Card data-testid="demo-pending-orders">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-1.5">
          <Clock className="h-4 w-4 text-muted-foreground" />
          Pending orders
          <span className="text-[10px] font-normal text-muted-foreground">· {rows.length} waiting at the demo broker</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead className="text-muted-foreground border-b border-slate-700/60">
              <tr>
                <th className="text-left font-medium px-2 py-1.5">Symbol</th>
                <th className="text-left font-medium px-2 py-1.5">Type</th>
                <th className="text-right font-medium px-2 py-1.5">Lot</th>
                <th className="text-right font-medium px-2 py-1.5">Price</th>
                <th className="text-right font-medium px-2 py-1.5">SL</th>
                <th className="text-right font-medium px-2 py-1.5">TP</th>
                <th className="text-left font-medium px-2 py-1.5">Expires</th>
                <th className="text-left font-medium px-2 py-1.5">Ticket</th>
                <th className="text-right font-medium px-2 py-1.5">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.commandId} className="border-b border-slate-800/60 last:border-0">
                  <td className="px-2 py-1 font-mono font-semibold">{o.symbol ?? "—"}</td>
                  <td className={`px-2 py-1 ${o.side === "BUY" ? "text-emerald-300" : o.side === "SELL" ? "text-rose-300" : ""}`}>
                    {pendingTypeLabel(o.orderType)}
                  </td>
                  <td className="px-2 py-1 font-mono text-right">{o.lotSize ?? "—"}</td>
                  <td className="px-2 py-1 font-mono text-right">
                    {o.price ?? "—"}{o.stopLimitPrice != null ? ` → ${o.stopLimitPrice}` : ""}
                  </td>
                  <td className="px-2 py-1 font-mono text-right text-[10px]">{o.stopLoss ?? "—"}</td>
                  <td className="px-2 py-1 font-mono text-right text-[10px]">{o.takeProfit ?? "—"}</td>
                  <td className="px-2 py-1 text-[10px]">
                    {o.expirationEpoch ? new Date(o.expirationEpoch * 1000).toLocaleString() : "GTC"}
                  </td>
                  <td className="px-2 py-1 font-mono text-[10px]">{o.orderTicket ?? "—"}</td>
                  <td className="px-2 py-1 text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[10px]"
                      disabled={!o.orderTicket || busy != null}
                      onClick={() => void cancel(o)}
                      data-testid="cancel-pending-order"
                    >
                      {busy === o.commandId ? <Loader2 className="h-3 w-3 mr-0.5 animate-spin" /> : <X className="h-3 w-3 mr-0.5" />}
                      Cancel
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
