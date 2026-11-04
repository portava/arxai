// OrderTicketOverlay — the MT5 "New Order" window as a small overlay, usable
// from every chart and trade surface. Mirrors the MT5 order dialog:
//
//   Type:    Buy by Market / Sell by Market · Buy Limit · Sell Limit ·
//            Buy Stop · Sell Stop · Buy Stop Limit · Sell Stop Limit
//   Volume:  lot with − / + steps (one-click default + cap honoured)
//   Price:   pending trigger price (Limit/Stop); Stop Limit adds the limit leg
//   SL / TP: optional, side-checked (Buy: SL below, TP above; Sell: reverse)
//   Expiry:  GTC · Today · Specified
//   Button:  MT5 wording — "Buy by Market", "Sell by Market", "Place" for pending
//
// Rules (orderTicketRules.ts) mirror MT5 and the server's pendingOrderRules.ts,
// so a wrong-side price is caught before the click; the server re-checks all
// of it. The live Bid/Ask shown is /api/data/quote (feed-scoped, with its
// freshness). Market orders are disabled while the quote is stale or missing;
// pending orders only need the quote for the side check, and when there is no
// quote the broker enforces the side on its own (the ticket says so).
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ListOrdered, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useOneClickMode } from "@/hooks/useOneClickMode";
import { humanizeReason } from "@/lib/humanize";
import { normalizeLot, stepLot } from "@/lib/oneClickMode";
import { useSymbolLotSpec } from "@/hooks/useSymbolLotSpec";
import { BROKER_CLOCK_UNKNOWN_HINT, useBrokerClockOffset } from "@/hooks/useBrokerClockOffset";
import {
  ORDER_TYPE_INFO, isPendingType, orderTypeInfo, parseNum, validateTicket,
  type ExpirationChoice, type OrderTypeId, type TicketDraft,
} from "@/lib/orderTicketRules";
import { DEMO_PENDING_UNSUPPORTED_NOTE, placeOrder } from "@/lib/tradeActions";
import type { InstantTradeSource } from "@/lib/instantTradeRouter";
import { cn } from "@/lib/utils";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

type Quote = { bid?: number | null; ask?: number | null; last?: number | null; available?: boolean; stale?: boolean; ageMs?: number | null; source?: string | null };

function fmt(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  return v.toFixed(abs >= 1000 ? 2 : abs >= 10 ? 3 : 5);
}

export interface OrderTicketPrefill {
  orderType?: OrderTypeId;
  lot?: number | null;
  price?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
}

export interface OrderTicketOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  symbol: string;
  source: InstantTradeSource;
  prefill?: OrderTicketPrefill | null;
  /** Called after an accepted order so the surface can reload positions / pending orders. */
  onPlaced?: () => void;
}

export function OrderTicketOverlay({ open, onOpenChange, symbol, source, prefill, onPlaced }: OrderTicketOverlayProps) {
  const oc = useOneClickMode();
  const scope = oc.mode.scope; // "live" | "demo" | null (null = this account mode cannot trade)
  const { toast } = useToast();

  const [orderType, setOrderType] = useState<OrderTypeId>(prefill?.orderType ?? "MARKET_BUY");
  const [lotText, setLotText] = useState<string>(prefill?.lot != null ? String(prefill.lot) : "");
  const [priceText, setPriceText] = useState<string>(prefill?.price != null ? String(prefill.price) : "");
  const [stopLimitText, setStopLimitText] = useState<string>("");
  const [slText, setSlText] = useState<string>(prefill?.stopLoss != null ? String(prefill.stopLoss) : "");
  const [tpText, setTpText] = useState<string>(prefill?.takeProfit != null ? String(prefill.takeProfit) : "");
  const [expiration, setExpiration] = useState<ExpirationChoice>("GTC");
  const [expiresAt, setExpiresAt] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  // Re-seed from the prefill each time the ticket opens.
  useEffect(() => {
    if (!open) return;
    setOrderType(prefill?.orderType ?? "MARKET_BUY");
    setLotText(prefill?.lot != null ? String(prefill.lot) : oc.mode.defaultVolume > 0 ? String(oc.mode.defaultVolume) : "");
    setPriceText(prefill?.price != null ? String(prefill.price) : "");
    setStopLimitText("");
    setSlText(prefill?.stopLoss != null ? String(prefill.stopLoss) : "");
    setTpText(prefill?.takeProfit != null ? String(prefill.takeProfit) : "");
    setExpiration("GTC");
    setExpiresAt("");
    setLastError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefill?.orderType, prefill?.lot, prefill?.price, prefill?.stopLoss, prefill?.takeProfit]);

  const quoteQ = useQuery<Quote>({
    queryKey: ["order-ticket-quote", symbol],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/data/quote?symbol=${encodeURIComponent(symbol)}`, { credentials: "include" });
      if (!r.ok) throw new Error(`quote ${r.status}`);
      return (await r.json()) as Quote;
    },
    enabled: open && !!symbol,
    refetchInterval: 2_000,
    staleTime: 1_000,
  });
  const q = quoteQ.data ?? null;
  // Bid and Ask only — a last-trade-only quote is not two-sided, so it is never
  // shown as Bid = Ask = last. Market orders need both; pending orders can still
  // be placed (the broker enforces the price side).
  const bid = q?.available === false ? null : (q?.bid ?? null);
  const ask = q?.available === false ? null : (q?.ask ?? null);
  const quoteUsable = bid != null && ask != null && !q?.stale;
  const lastOnly = (bid == null || ask == null) && q?.available !== false && q?.last != null;
  const spec = useSymbolLotSpec(symbol);
  // "Today" ends at the end of the broker's day (own bridge's measured offset).
  const brokerClock = useBrokerClockOffset(open);

  const info = orderTypeInfo(orderType);
  const pending = isPendingType(orderType);
  const lot = normalizeLot(lotText, oc.mode.maxLotPerClick, spec);
  const draft: TicketDraft = useMemo(() => ({
    orderType, lot,
    price: parseNum(priceText), stopLimitPrice: parseNum(stopLimitText),
    stopLoss: parseNum(slText), takeProfit: parseNum(tpText),
    expiration, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    brokerClockOffsetMs: brokerClock.offsetMs,
  }), [orderType, lot, priceText, stopLimitText, slText, tpText, expiration, expiresAt, brokerClock.offsetMs]);
  // Side checks use the live quote only while it is usable; otherwise the broker decides.
  const v = validateTicket(draft, quoteUsable ? { bid, ask } : { bid: null, ask: null }, spec);

  // Demo pending orders are not refused here: the server knows the bridge
  // EA's version (pending needs v1.32) and its refusal is shown after the click.
  const marketNeedsQuote = !pending && !quoteUsable;
  const disabledWhy = scope == null
    ? "Trading is not available in this account mode."
    : marketNeedsQuote ? (q?.stale ? "Price is stale. Waiting for a fresh tick." : lastOnly ? "Only a last-trade price is available, no Bid/Ask — a market order needs both. Pending orders can still be placed." : "No Bid/Ask yet — a market order needs a live price.")
    : v.errors[0] ?? null;
  const canPlace = !busy && disabledWhy == null;

  const buttonLabel = info.kind === "MARKET" ? info.label : `Place ${info.label}`;

  const place = async () => {
    if (!scope || !canPlace) return;
    setBusy(true);
    setLastError(null);
    try {
      const r = await placeOrder({ scope, symbol, draft, source, oneClickOn: oc.mode.on });
      if (r.ok) {
        toast({
          title: `${info.label} ${symbol} ${lot}`,
          description: scope === "live"
            ? (r.via === "instant" ? "Sent to your broker through the live router. The terminal confirms the fill." : "Confirmed and dispatched to your broker. The terminal confirms the fill.")
            : r.status === "PLACED_DEMO" ? "Pending order placed on demo. It waits at the broker for its price." : "Filled on demo.",
        });
        onPlaced?.();
        onOpenChange(false);
      } else {
        // The server's demo EA-version refusal is already plain words.
        const text = r.reason === DEMO_PENDING_UNSUPPORTED_NOTE
          ? r.reason
          : (humanizeReason(r.reason ?? r.status).description || r.reason || r.status);
        setLastError(text);
        toast({ title: `${info.label} refused`, description: text, variant: "destructive" });
      }
    } catch (e) {
      setLastError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sideClass = info.side === "BUY" ? "bg-emerald-600 hover:bg-emerald-500" : "bg-rose-600 hover:bg-rose-500";
  const field = "h-9 font-mono text-sm";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="order-ticket">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <ListOrdered className="h-4 w-4 text-amber-400" />
            New order · <span className="font-mono">{symbol}</span>
            {scope && <span className="ml-auto rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] uppercase text-txt-secondary" data-testid="order-ticket-scope">{scope}</span>}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Same order types and rules as the MT5 order window. Every order still runs through the server's gates and your broker.
          </DialogDescription>
        </DialogHeader>

        {/* Bid / Ask */}
        <div className="grid grid-cols-2 gap-2 rounded-md border border-zinc-800 bg-zinc-950/60 p-2 text-center" data-testid="order-ticket-quote">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-rose-300">Bid (Sell)</div>
            <div className="font-mono text-lg" data-testid="order-ticket-bid">{fmt(bid)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-emerald-300">Ask (Buy)</div>
            <div className="font-mono text-lg" data-testid="order-ticket-ask">{fmt(ask)}</div>
          </div>
          <div className="col-span-2 text-[10px] text-txt-secondary">
            {q?.stale ? "stale — " : ""}{q?.ageMs != null ? `${Math.round(q.ageMs / 1000)} s ago` : "no quote yet"}{q?.source ? ` · ${q.source}` : ""}
            {pending && !quoteUsable && " · no live quote: the broker will enforce the price side"}
          </div>
        </div>

        {/* Order type */}
        <div>
          <div className="mb-1 text-[11px] font-semibold text-txt-secondary">Type</div>
          <div className="grid grid-cols-2 gap-1" role="radiogroup" aria-label="Order type">
            {ORDER_TYPE_INFO.map((o) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={orderType === o.id}
                onClick={() => setOrderType(o.id)}
                className={cn(
                  "h-8 rounded border px-2 text-left text-xs transition-colors",
                  orderType === o.id
                    ? (o.side === "BUY" ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-200" : "border-rose-500/60 bg-rose-500/10 text-rose-200")
                    : "border-zinc-800 text-txt-secondary hover:bg-zinc-800/60",
                )}
                data-testid={`order-type-${o.id}`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-txt-secondary" data-testid="order-type-hint">{info.hint}</p>
        </div>

        {/* Volume */}
        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <label className="block">
            <span className="text-[11px] font-semibold text-txt-secondary">Volume (lots)</span>
            <div className="mt-1 flex items-center gap-1">
              <Button type="button" size="icon" variant="outline" className="h-9 w-9" aria-label="Decrease lot" disabled={busy}
                onClick={() => setLotText(String(stepLot(lot ?? oc.mode.defaultVolume, -1, oc.mode.maxLotPerClick, spec)))} data-testid="order-ticket-lot-minus">−</Button>
              <Input value={lotText} onChange={(e) => setLotText(e.target.value)} inputMode="decimal" aria-label="Lot size" className={cn(field, "text-center")} data-testid="order-ticket-lot" />
              <Button type="button" size="icon" variant="outline" className="h-9 w-9" aria-label="Increase lot" disabled={busy}
                onClick={() => setLotText(String(stepLot(lot ?? oc.mode.defaultVolume, 1, oc.mode.maxLotPerClick, spec)))} data-testid="order-ticket-lot-plus">+</Button>
            </div>
          </label>
          {oc.mode.maxLotPerClick != null && <span className="pb-2 text-[10px] text-txt-secondary">max {oc.mode.maxLotPerClick}</span>}
        </div>

        {/* Pending price(s) */}
        {pending && (
          <div className={cn("grid gap-2", info.kind === "STOP_LIMIT" ? "grid-cols-2" : "grid-cols-1")}>
            <label className="block">
              <span className="text-[11px] font-semibold text-txt-secondary">{info.kind === "STOP_LIMIT" ? "Stop price" : "Price"}</span>
              <Input value={priceText} onChange={(e) => setPriceText(e.target.value)} inputMode="decimal" placeholder={fmt(info.side === "BUY" ? ask : bid)} aria-label="Order price" className={cn(field, "mt-1")} data-testid="order-ticket-price" />
            </label>
            {info.kind === "STOP_LIMIT" && (
              <label className="block">
                <span className="text-[11px] font-semibold text-txt-secondary">Stop Limit price</span>
                <Input value={stopLimitText} onChange={(e) => setStopLimitText(e.target.value)} inputMode="decimal" aria-label="Stop limit price" className={cn(field, "mt-1")} data-testid="order-ticket-stop-limit" />
              </label>
            )}
          </div>
        )}

        {/* SL / TP */}
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[11px] font-semibold text-rose-300">Stop Loss</span>
            <Input value={slText} onChange={(e) => setSlText(e.target.value)} inputMode="decimal" placeholder="none" aria-label="Stop loss" className={cn(field, "mt-1")} data-testid="order-ticket-sl" />
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold text-emerald-300">Take Profit</span>
            <Input value={tpText} onChange={(e) => setTpText(e.target.value)} inputMode="decimal" placeholder="none" aria-label="Take profit" className={cn(field, "mt-1")} data-testid="order-ticket-tp" />
          </label>
        </div>
        {v.riskReward != null && (
          <p className="text-[11px] text-txt-secondary" data-testid="order-ticket-rr">Risk : reward ≈ 1 : {v.riskReward}{v.reference != null ? ` (from ${fmt(v.reference)})` : ""}</p>
        )}

        {/* Expiration (pending only) */}
        {pending && (
          <div className="grid grid-cols-[auto_1fr] items-center gap-2">
            <span className="text-[11px] font-semibold text-txt-secondary">Expiration</span>
            <div className="flex flex-wrap items-center gap-1">
              {(["GTC", "TODAY", "SPECIFIED"] as ExpirationChoice[]).map((c) => (
                <button key={c} type="button" onClick={() => setExpiration(c)} aria-pressed={expiration === c}
                  className={cn("h-7 rounded border px-2 text-xs", expiration === c ? "border-amber-500/60 bg-amber-500/10 text-amber-200" : "border-zinc-800 text-txt-secondary")}
                  data-testid={`order-ticket-exp-${c}`}>
                  {c === "GTC" ? "GTC" : c === "TODAY" ? "Today" : "Specified"}
                </button>
              ))}
              {expiration === "SPECIFIED" && (
                <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} aria-label="Expiry date and time"
                  className="h-7 rounded border border-zinc-800 bg-transparent px-1 text-xs" data-testid="order-ticket-exp-at" />
              )}
            </div>
            {expiration === "TODAY" && brokerClock.offsetMs == null && !brokerClock.loading && (
              <p className="col-span-2 text-[10px] text-txt-secondary" data-testid="order-ticket-exp-broker-clock-hint">{BROKER_CLOCK_UNKNOWN_HINT}</p>
            )}
          </div>
        )}

        <Button type="button" className={cn("h-11 w-full text-sm font-semibold text-white disabled:opacity-50", sideClass)} disabled={!canPlace} onClick={() => void place()}
          title={disabledWhy ?? undefined} data-testid="order-ticket-submit">
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {buttonLabel}{lot ? ` · ${lot}` : ""}
        </Button>
        {(disabledWhy || lastError) && (
          <p className="text-[11px] text-rose-300" data-testid="order-ticket-error">{lastError ?? disabledWhy}</p>
        )}
        <p className="text-[10px] text-txt-secondary">
          {scope === "live"
            ? oc.mode.on
              ? "One-click is on: this button sends the order straight through the live router."
              : "One-click is off: this button confirms and dispatches the order (draft → confirm → dispatch)."
            : scope === "demo" ? "Demo: filled on your demo terminal through the governed queue." : ""}
        </p>
      </DialogContent>
    </Dialog>
  );
}

/** Small trigger button for any surface: opens the MT5-style order ticket. */
export function OrderTicketButton({ symbol, source, prefill, onPlaced, className, label = "Order types", size = "sm" }: {
  symbol: string; source: InstantTradeSource; prefill?: OrderTicketPrefill | null; onPlaced?: () => void; className?: string; label?: string; size?: "sm" | "default" | "icon";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size={size} variant="outline" className={cn("h-8 text-xs", className)} onClick={() => setOpen(true)} data-testid="order-ticket-open" title="Buy/Sell Limit, Buy/Sell Stop, Stop Limit, SL/TP, expiry">
        <ListOrdered className="mr-1 h-3.5 w-3.5" /> {label}
      </Button>
      {open && <OrderTicketOverlay open={open} onOpenChange={setOpen} symbol={symbol} source={source} prefill={prefill} onPlaced={onPlaced} />}
    </>
  );
}
