// LivePendingOrders — the user's working MT5 pending orders on live
// (Buy/Sell Limit, Stop, Stop Limit) from GET /api/me/live/pending-orders,
// with Cancel and Modify (price / SL / TP) from ARX.
//
// The list is built from the last terminal answer for each order (there is no
// terminal pending-order snapshot yet), and it says so. Cancel / Modify go
// through the governed live path (lib/livePendingControl.ts): with live
// one-click ON a cancel is sent on the first press; with it OFF a confirm
// dialog comes first. Modify always opens a dialog, checked with the MT5
// ticket rules (orderTicketRules.validateTicket) against the live Bid/Ask.
// "Sent" is not "done": the order leaves the list (or shows its new levels)
// when the broker answers.
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, ListOrdered, Loader2, SlidersHorizontal, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useOneClickMode } from "@/hooks/useOneClickMode";
import { validateTicket, type OrderTypeId } from "@/lib/orderTicketRules";
import { cancelLivePendingOrder, modifyLivePendingOrder, pendingModifyChanges } from "@/lib/livePendingControl";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export type LivePendingOrder = {
  commandId: string;
  orderTicket: string;
  symbol: string;
  side: "BUY" | "SELL";
  orderType: string;
  volume: number;
  price: number | null;
  stopLimitPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  expiration: string | null;
  placedAt: string | null;
  /** Server: ARX can cancel / modify it (absent on older servers = not offered). */
  controllable?: boolean;
  /** Server: a cancel or change is already on its way to MT5. */
  controlInFlight?: boolean;
};

type Resp = { ok?: boolean; items?: LivePendingOrder[]; note?: string };

export const LIVE_PENDING_CONTROL_NOTE =
  "Cancel and Modify go to MT5 through the same live safety checks as a close; the broker's answer updates this list.";
export const LIVE_PENDING_NOT_CONTROLLABLE =
  "This order's state is not confirmed as working at the broker. Manage it in MT5.";

const norm = (s: string | null | undefined) => (s ?? "").replace(/^.*:/, "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

function fmt(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  return v.toFixed(abs >= 1000 ? 2 : abs >= 10 ? 3 : 5);
}

const KNOWN_TYPES: readonly string[] = ["BUY_LIMIT", "SELL_LIMIT", "BUY_STOP", "SELL_STOP", "BUY_STOP_LIMIT", "SELL_STOP_LIMIT"];

type Quote = { bid?: number | null; ask?: number | null; stale?: boolean; available?: boolean };

function ModifyPendingDialog({ order, onClose, onSent }: { order: LivePendingOrder; onClose: () => void; onSent: () => void }) {
  const { toast } = useToast();
  const [priceText, setPriceText] = useState(order.price != null ? String(order.price) : "");
  const [slText, setSlText] = useState(order.stopLoss != null ? String(order.stopLoss) : "");
  const [tpText, setTpText] = useState(order.takeProfit != null ? String(order.takeProfit) : "");
  const [serverError, setServerError] = useState<string | null>(null);
  useEffect(() => { setServerError(null); }, [priceText, slText, tpText]);

  const quoteQ = useQuery<Quote>({
    queryKey: ["order-ticket-quote", order.symbol],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/data/quote?symbol=${encodeURIComponent(order.symbol)}`, { credentials: "include" });
      if (!r.ok) throw new Error(`quote ${r.status}`);
      return (await r.json()) as Quote;
    },
    refetchInterval: 2_000,
    staleTime: 1_000,
  });
  const q = quoteQ.data ?? null;
  const bid = q?.available === false ? null : (q?.bid ?? null);
  const ask = q?.available === false ? null : (q?.ask ?? null);
  const quoteUsable = bid != null && ask != null && !q?.stale;

  const changes = pendingModifyChanges({ current: order, priceText, slText, tpText });
  const typeOk = KNOWN_TYPES.includes(order.orderType);
  const validation = useMemo(() => {
    if (!typeOk) return { ok: true, errors: [] as string[] };
    const price = changes.price ?? order.price;
    // The trigger side is checked only when the price changes (an unchanged
    // order that drifted next to the market is still valid at the broker).
    return validateTicket({
      orderType: order.orderType as OrderTypeId, lot: order.volume,
      price, stopLimitPrice: order.stopLimitPrice,
      stopLoss: changes.stopLoss ?? order.stopLoss, takeProfit: changes.takeProfit ?? order.takeProfit,
      expiration: "GTC", expiresAt: null,
    }, quoteUsable && changes.price != null ? { bid, ask } : { bid: null, ask: null });
  }, [typeOk, changes.price, changes.stopLoss, changes.takeProfit, order, quoteUsable, bid, ask]);
  const error = changes.error ?? (validation.ok ? null : validation.errors[0] ?? "Check the levels.");

  // Synchronous guard: two clicks before a re-render must not send twice.
  const sending = useRef(false);
  const send = useMutation({
    onSettled: () => { sending.current = false; },
    mutationFn: () => modifyLivePendingOrder({
      commandId: order.commandId, price: changes.price, stopLoss: changes.stopLoss, takeProfit: changes.takeProfit,
    }),
    onSuccess: (r) => {
      if (r.ok) {
        toast({ title: "Change sent to MT5", description: `${order.symbol} #${order.orderTicket}: ${r.message}` });
        onSent();
        onClose();
      } else {
        setServerError(r.message);
        toast({ variant: "destructive", title: "Change not sent", description: r.message });
      }
    },
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !send.isPending) onClose(); }}>
      <DialogContent className="max-w-sm" data-testid="live-pending-modify-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5 text-sm"><SlidersHorizontal className="h-4 w-4" /> Modify {order.orderType.replace(/_/g, " ")} #{order.orderTicket}</DialogTitle>
          <DialogDescription className="text-xs">
            {order.symbol} · {order.volume} lot. Real money: the change is sent to your broker.
            {quoteUsable ? ` Bid ${fmt(bid)} · Ask ${fmt(ask)}.` : " No live quote: the broker will enforce the price side."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-2 text-[11px]">
          <label className="space-y-1">Price<Input value={priceText} onChange={(e) => setPriceText(e.target.value)} inputMode="decimal" data-testid="live-pending-modify-price" /></label>
          <label className="space-y-1">Stop Loss<Input value={slText} onChange={(e) => setSlText(e.target.value)} inputMode="decimal" data-testid="live-pending-modify-sl" /></label>
          <label className="space-y-1">Take Profit<Input value={tpText} onChange={(e) => setTpText(e.target.value)} inputMode="decimal" data-testid="live-pending-modify-tp" /></label>
        </div>
        {order.stopLimitPrice != null && <p className="text-[10px] text-txt-secondary">The stop-limit leg ({fmt(order.stopLimitPrice)}) and the expiry are kept.</p>}
        <p className="text-[10px] text-txt-secondary">An empty field keeps the current level. Removing a Stop Loss or Take Profit is done in MT5.</p>
        {(serverError ?? error) && <p className="text-[11px] text-amber-300" data-testid="live-pending-modify-error">{serverError ?? error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={send.isPending}>Close</Button>
          <Button size="sm" disabled={!!error || send.isPending} onClick={() => { if (sending.current || error) return; sending.current = true; send.mutate(); }} data-testid="live-pending-modify-submit">
            {send.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}Modify order
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function LivePendingOrders({ symbol, enabled = true, compact = false }: { symbol?: string; enabled?: boolean; compact?: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const oneClickOn = useOneClickMode().mode.on;
  const [confirmCancel, setConfirmCancel] = useState<LivePendingOrder | null>(null);
  const [modifying, setModifying] = useState<LivePendingOrder | null>(null);
  const q = useQuery<Resp>({
    queryKey: ["live", "pending-orders"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/me/live/pending-orders`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as Resp;
    },
    enabled,
    refetchInterval: 10_000,
  });
  // The pending list and every live query (positions share the ["live"] root).
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["live", "pending-orders"] });
    void qc.invalidateQueries({ queryKey: ["live"] });
  };
  // Synchronous guard: two clicks before a re-render must not send twice.
  const cancelling = useRef(false);
  const submitCancel = (o: LivePendingOrder) => {
    if (cancelling.current) return;
    cancelling.current = true;
    cancel.mutate(o);
  };
  const cancel = useMutation({
    onSettled: () => { cancelling.current = false; },
    mutationFn: (o: LivePendingOrder) => cancelLivePendingOrder({ commandId: o.commandId, oneClick: oneClickOn }),
    onSuccess: (r, o) => {
      if (r.ok) toast({ title: "Cancel sent to MT5", description: `${o.symbol} #${o.orderTicket}: ${r.message}` });
      else toast({ variant: "destructive", title: "Cancel not sent", description: r.message });
      refresh();
    },
  });

  if (!enabled) return null;
  const all = q.data?.items ?? [];
  const items = symbol ? all.filter((o) => norm(o.symbol) === norm(symbol)) : all;
  // On the chart, stay out of the way when there is nothing to show.
  if (compact && (q.isLoading || (!q.isError && items.length === 0))) return null;
  const busy = cancel.isPending;

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-2" data-testid="live-pending-orders">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-zinc-300">
        <ListOrdered className="h-3.5 w-3.5 text-amber-400" /> Live pending orders
        {!q.isLoading && !q.isError && <span className="font-normal text-txt-secondary">({items.length})</span>}
      </div>
      {q.isLoading ? (
        <p className="text-[11px] text-txt-secondary" data-testid="live-pending-loading">Loading pending orders…</p>
      ) : q.isError ? (
        <p className="text-[11px] text-amber-300" data-testid="live-pending-error">Couldn&apos;t load live pending orders. Check MT5 directly.</p>
      ) : items.length === 0 ? (
        <p className="text-[11px] text-txt-secondary" data-testid="live-pending-empty">No working pending orders placed from ARX.</p>
      ) : (
        <ul className="space-y-1">
          {items.map((o) => {
            const controllable = o.controllable === true;
            const rowBusy = busy && cancel.variables?.commandId === o.commandId;
            const disabled = !controllable || !!o.controlInFlight || busy;
            const title = !controllable ? LIVE_PENDING_NOT_CONTROLLABLE : o.controlInFlight ? "A cancel or change for this order is on its way to MT5." : undefined;
            return (
              <li key={o.orderTicket} className="flex flex-wrap items-center gap-2 text-[11px]" data-testid={`live-pending-${o.orderTicket}`}>
                <Badge variant="outline" className="border-amber-500/40 text-amber-300">{o.orderType.replace(/_/g, " ")}</Badge>
                <span className="font-mono text-zinc-300">{o.symbol}</span>
                <span className="font-mono text-zinc-400">{o.volume} @ {fmt(o.price)}{o.stopLimitPrice != null ? ` → ${fmt(o.stopLimitPrice)}` : ""}</span>
                <span className="font-mono text-[10px] text-txt-secondary">SL {fmt(o.stopLoss)} · TP {fmt(o.takeProfit)}</span>
                <span className="font-mono text-[10px] text-txt-secondary">#{o.orderTicket}</span>
                {o.expiration && (
                  <span className="flex items-center gap-0.5 text-[10px] text-txt-secondary"><Clock className="h-3 w-3" /> {new Date(o.expiration).toLocaleString()}</span>
                )}
                {o.controlInFlight && <span className="text-[10px] text-amber-300" data-testid={`live-pending-inflight-${o.orderTicket}`}>sent, waiting for MT5…</span>}
                <span className="ml-auto flex gap-1">
                  <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" disabled={disabled} title={title}
                    onClick={() => setModifying(o)} data-testid={`live-pending-modify-${o.orderTicket}`}>
                    <SlidersHorizontal className="mr-0.5 h-3 w-3" />Modify
                  </Button>
                  <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" disabled={disabled} title={title}
                    onClick={() => {
                      if (busy || cancelling.current) return;
                      if (oneClickOn) submitCancel(o);
                      else setConfirmCancel(o);
                    }}
                    data-testid={`live-pending-cancel-${o.orderTicket}`}>
                    {rowBusy ? <Loader2 className="mr-0.5 h-3 w-3 animate-spin" /> : <X className="mr-0.5 h-3 w-3" />}
                    {rowBusy ? "Cancelling…" : "Cancel"}
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-1 text-[10px] text-txt-secondary" data-testid="live-pending-note">
        {q.data?.note ?? "From the last terminal answer for each order."} {LIVE_PENDING_CONTROL_NOTE}
      </p>

      <Dialog open={!!confirmCancel} onOpenChange={(o) => { if (!o) setConfirmCancel(null); }}>
        <DialogContent className="max-w-sm" data-testid="live-pending-cancel-confirm">
          <DialogHeader>
            <DialogTitle className="text-sm">Cancel this live pending order?</DialogTitle>
            <DialogDescription className="text-xs">
              {confirmCancel && <>{confirmCancel.orderType.replace(/_/g, " ")} {confirmCancel.symbol} {confirmCancel.volume} lot @ {fmt(confirmCancel.price)}, ticket <span className="font-mono">#{confirmCancel.orderTicket}</span>. </>}
              The cancel is sent to your broker. Turn on one-click mode to cancel on the first click.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmCancel(null)} data-testid="live-pending-cancel-confirm-back">Keep order</Button>
            <Button size="sm" variant="destructive" disabled={busy}
              onClick={() => {
                const o = confirmCancel;
                setConfirmCancel(null);
                if (o) submitCancel(o);
              }}
              data-testid="live-pending-cancel-confirm-ok">
              Cancel order
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {modifying && <ModifyPendingDialog order={modifying} onClose={() => setModifying(null)} onSent={refresh} />}
    </div>
  );
}
