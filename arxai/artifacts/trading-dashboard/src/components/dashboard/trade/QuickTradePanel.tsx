// QuickTradePanel — the centerpiece of the redesigned Trade Command Room.
//
// UI ONLY. No execution logic lives here. Buy/Sell follow the app-wide
// one-click mode (useOneClickMode), like the chart's trade entry:
//   one-click ON  → a market order on the first click through the hook
//                   (live: instant router; demo: governed demo queue), with the
//                   panel's lot and SL/TP;
//   one-click OFF → the MT5 order window opens pre-filled with that side, lot
//                   and SL/TP, and its button is the confirmation.
// No new execution path. Symbol/timeframe/lot/SL/TP are controlled inputs
// driven by props from the page, which owns the existing state + quote feed.

import { useState, type ReactNode } from "react";
import { Zap, TrendingUp, TrendingDown, ShieldCheck, Bot, ShieldQuestion } from "lucide-react";
import { CockpitCard } from "@/components/dashboard/cockpit/primitives";
import { ChartFeedConfidence } from "@/components/charts/ChartFeedConfidence";
import { cn } from "@/lib/utils";
import { OrderTicketButton, OrderTicketOverlay, type OrderTicketPrefill } from "@/components/trade/OrderTicketOverlay";
import { useOneClickMode } from "@/hooks/useOneClickMode";
import { useSymbolLotSpec } from "@/hooks/useSymbolLotSpec";
import { useToast } from "@/hooks/use-toast";
import { humanizeReason } from "@/lib/humanize";
import type { OrderTypeId } from "@/lib/orderTicketRules";

/** Map the panel's MT5 order-type label to the ticket's id ("Market" → the side is picked on the ticket). */
export function quickTradeOrderTypeId(label: string, side: "BUY" | "SELL" = "BUY"): OrderTypeId {
  const key = label.trim().toUpperCase().replace(/\s+/g, "_");
  const known: Record<string, OrderTypeId> = {
    BUY_LIMIT: "BUY_LIMIT", SELL_LIMIT: "SELL_LIMIT", BUY_STOP: "BUY_STOP", SELL_STOP: "SELL_STOP",
    BUY_STOP_LIMIT: "BUY_STOP_LIMIT", SELL_STOP_LIMIT: "SELL_STOP_LIMIT",
  };
  return known[key] ?? (side === "SELL" ? "MARKET_SELL" : "MARKET_BUY");
}

export type Quote = { bid: number; ask: number; spread: number; mid: number } | null;

const ORDER_TYPES = [
  "Market", "Buy Limit", "Sell Limit", "Buy Stop", "Sell Stop", "Buy Stop Limit", "Sell Stop Limit",
];
const TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"];
const LOT_PRESETS = ["0.01", "0.02", "0.05", "0.10", "0.20"];

/**
 * The MAX preset's lot: the lowest of the one-click cap and the broker's
 * maximum for this symbol. null (no MAX preset) when neither is known — a
 * literal "MAX" lot is not a number and used to reach the ticket as NaN.
 */
export function quickTradeMaxLot(maxLotPerClick: number | null | undefined, volumeMax: number | null | undefined): string | null {
  const caps = [maxLotPerClick, volumeMax].filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
  return caps.length ? String(Math.min(...caps)) : null;
}

export function QuickTradePanel({
  symbol, setSymbol,
  timeframe, setTimeframe,
  orderType, setOrderType,
  lot, setLot,
  quote,
  slTpOn, setSlTpOn,
  stopLoss, setStopLoss,
  takeProfit, setTakeProfit,
  riskCheckOn, setRiskCheckOn,
  safetyGatesOn, setSafetyGatesOn,
  riskApprox,
  canTrade,
  blockedLabel,
}: {
  symbol: string; setSymbol: (v: string) => void;
  timeframe: string; setTimeframe: (v: string) => void;
  orderType: string; setOrderType: (v: string) => void;
  lot: string; setLot: (v: string) => void;
  quote: Quote;
  slTpOn: boolean; setSlTpOn: (v: boolean) => void;
  stopLoss: string; setStopLoss: (v: string) => void;
  takeProfit: string; setTakeProfit: (v: string) => void;
  riskCheckOn: boolean; setRiskCheckOn: (v: boolean) => void;
  safetyGatesOn: boolean; setSafetyGatesOn: (v: boolean) => void;
  riskApprox: string;
  canTrade: boolean;
  blockedLabel: string;
}) {
  const oc = useOneClickMode();
  const spec = useSymbolLotSpec(symbol);
  const { toast } = useToast();
  const [ticketPrefill, setTicketPrefill] = useState<OrderTicketPrefill | null>(null);
  const maxLot = quickTradeMaxLot(oc.mode.maxLotPerClick, spec.volumeMax);
  const presets = maxLot ? [...LOT_PRESETS, "MAX"] : LOT_PRESETS;

  const sell = quote ? quote.bid : null;
  const buy = quote ? quote.ask : null;
  const spread = quote ? quote.spread : null;

  const lotNum = Number(lot) > 0 ? Number(lot) : null;
  const sl = slTpOn && Number(stopLoss) > 0 ? Number(stopLoss) : null;
  const tp = slTpOn && Number(takeProfit) > 0 ? Number(takeProfit) : null;
  const busy = oc.busyKey === `BUY-${symbol}` || oc.busyKey === `SELL-${symbol}`;

  // Buy/Sell honour one-click mode (see header). OFF → the order window, pre-set
  // to this side's market order with the panel's lot and SL/TP.
  const onSide = async (side: "BUY" | "SELL") => {
    if (!oc.mode.on) {
      setTicketPrefill({ orderType: side === "BUY" ? "MARKET_BUY" : "MARKET_SELL", lot: lotNum, stopLoss: sl, takeProfit: tp });
      return;
    }
    if (lotNum == null) {
      toast({ title: "Lot size needed", description: "Type a lot size above 0 first.", variant: "destructive" });
      return;
    }
    const r = await oc.execute({ side, symbol, volume: lotNum, stopLoss: sl, takeProfit: tp, source: "trade_panel" });
    if (r.ok) {
      toast({ title: `${side} ${symbol} ${lotNum}`, description: oc.mode.scope === "live" ? "Sent to your broker through the live router." : "Filled on demo." });
    } else {
      const h = humanizeReason(r.reason ?? r.status);
      toast({ title: `${side} blocked`, description: h.description || r.reason || r.status, variant: "destructive" });
    }
  };

  return (
    <CockpitCard
      title="Quick Trade"
      subtitle="Pick a market, then Buy or Sell (one-click) or place the order from the order window."
      icon={<Zap className="h-[18px] w-[18px]" />}
      accent="blue"
      data-testid="quick-trade-tab"
    >
      {/* Data-source chip — names the real feed (MT5 broker vs third-party /
          synthetic fallback) for the selected symbol/timeframe before acting.
          Informational only; never gates the trade. */}
      <div className="mb-3 flex items-center justify-end" data-testid="quick-trade-feed-confidence">
        <ChartFeedConfidence symbol={symbol} timeframe={timeframe} />
      </div>

      {/* Row 1 — symbol / timeframe / order type */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Symbol">
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            className="h-10 w-full rounded-lg border border-border bg-background/40 px-3 font-mono text-sm outline-none focus:border-primary"
            data-testid="trade-symbol-input"
          />
        </Field>
        <Field label="Timeframe">
          <select
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value)}
            className="h-10 w-full rounded-lg border border-border bg-background/40 px-3 text-sm outline-none focus:border-primary"
            data-testid="trade-tf-input"
          >
            {TIMEFRAMES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Order type">
          <select
            value={orderType}
            onChange={(e) => setOrderType(e.target.value)}
            className="h-10 w-full rounded-lg border border-border bg-background/40 px-3 text-sm outline-none focus:border-primary"
            data-testid="trade-order-type"
          >
            {ORDER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
      </div>

      {/* Price strip — SELL | spread | BUY */}
      <div className="mt-3 grid grid-cols-3 items-center rounded-xl border border-border bg-background/40 px-4 py-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-danger">Sell</div>
          <div className="font-mono text-lg font-bold text-danger">{sell ?? "—"}</div>
        </div>
        <div className="text-center">
          <div className="text-[11px] uppercase tracking-wide text-txt-muted">Spread</div>
          <div className="font-mono text-sm">{spread ?? "—"}</div>
        </div>
        <div className="text-right">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-success">Buy</div>
          <div className="font-mono text-lg font-bold text-success">{buy ?? "—"}</div>
        </div>
      </div>

      {/* Lot sizing */}
      <div className="mt-3 flex items-end gap-3">
        <Field label="Lot size" className="w-28">
          <input
            value={lot}
            onChange={(e) => setLot(e.target.value)}
            className="h-10 w-full rounded-lg border border-border bg-background/40 px-3 font-mono text-sm outline-none focus:border-primary"
            data-testid="trade-lot-input"
          />
        </Field>
        <div className="flex-1">
          <input
            type="range" min={0.01} max={1} step={0.01}
            value={Number(lot) || 0.01}
            onChange={(e) => setLot(Number(e.target.value).toFixed(2))}
            className="w-full accent-[hsl(var(--primary))]"
            aria-label="Lot size slider"
          />
        </div>
        <div className="text-right">
          <div className="text-[11px] uppercase tracking-wide text-txt-muted">Risk approx.</div>
          <div className="font-mono text-sm font-semibold">{riskApprox}</div>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
        {presets.map((p) => (
          <button
            key={p}
            onClick={() => setLot(p === "MAX" ? maxLot! : p)}
            title={p === "MAX" ? `Largest lot allowed here: ${maxLot}` : undefined}
            className={cn(
              "h-9 rounded-lg border text-sm font-medium transition-colors",
              lot === (p === "MAX" ? maxLot : p) ? "border-primary bg-primary/15 text-primary" : "border-border text-txt-secondary hover:bg-secondary/50",
            )}
            data-testid={`trade-lot-preset-${p}`}
          >
            {p}
          </button>
        ))}
      </div>

      {/* Toggles */}
      <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-border/60 pt-3 text-sm">
        <Toggle icon={<ShieldQuestion className="h-4 w-4" />} label="SL / TP" on={slTpOn} set={setSlTpOn} testid="trade-sltp-toggle" />
        <Toggle icon={<Bot className="h-4 w-4" />} label="Risk check" on={riskCheckOn} set={setRiskCheckOn} testid="trade-riskcheck-toggle" />
        <Toggle icon={<ShieldCheck className="h-4 w-4" />} label="Safety gates" on={safetyGatesOn} set={setSafetyGatesOn} testid="trade-safety-toggle" />
      </div>

      {/* SL/TP expandable */}
      {slTpOn && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label="Stop Loss (optional)">
            <input value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} placeholder="—"
              className="h-10 w-full rounded-lg border border-border bg-background/40 px-3 font-mono text-sm outline-none focus:border-primary" data-testid="trade-sl-input" />
          </Field>
          <Field label="Take Profit (optional)">
            <input value={takeProfit} onChange={(e) => setTakeProfit(e.target.value)} placeholder="—"
              className="h-10 w-full rounded-lg border border-border bg-background/40 px-3 font-mono text-sm outline-none focus:border-primary" data-testid="trade-tp-input" />
          </Field>
        </div>
      )}

      {/* Actions */}
      {canTrade ? (
        <>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button onClick={() => void onSide("SELL")} disabled={busy} data-testid="trade-action-sell"
            className="flex h-12 items-center justify-center gap-2 rounded-xl bg-danger font-semibold text-white hover:bg-danger/90 disabled:opacity-50">
            <TrendingDown className="h-4 w-4" /> SELL {sell ?? ""}
          </button>
          <button onClick={() => void onSide("BUY")} disabled={busy} data-testid="trade-action-buy"
            className="flex h-12 items-center justify-center gap-2 rounded-xl bg-success font-semibold text-white hover:bg-success/90 disabled:opacity-50">
            <TrendingUp className="h-4 w-4" /> BUY {buy ?? ""}
          </button>
        </div>
        {/* MT5 order window, pre-filled from this panel (order type, lot, SL/TP).
            Its button places the order through the gated router / demo queue. */}
        <div className="mt-2">
          <OrderTicketButton
            symbol={symbol}
            source="trade_panel"
            label={`Open order window (${orderType})`}
            className="w-full"
            prefill={{
              orderType: quickTradeOrderTypeId(orderType),
              lot: Number(lot) > 0 ? Number(lot) : null,
              stopLoss: slTpOn && Number(stopLoss) > 0 ? Number(stopLoss) : null,
              takeProfit: slTpOn && Number(takeProfit) > 0 ? Number(takeProfit) : null,
            }}
          />
        </div>
        <p className="mt-2 text-xs text-txt-muted" data-testid="trade-ticket-handoff-note">
          {oc.mode.on
            ? `One-click is on: SELL and BUY send a market order for ${symbol} on the first click, with the lot size and stop loss / take profit set here.`
            : `SELL and BUY open the order window for ${symbol} with the side, lot size, stop loss and take profit set here; its button sends the order.`}
        </p>
        {ticketPrefill && (
          <OrderTicketOverlay open={!!ticketPrefill} onOpenChange={(o) => { if (!o) setTicketPrefill(null); }}
            symbol={symbol} source="trade_panel" prefill={ticketPrefill} />
        )}
        </>
      ) : (
        <div className="mt-4 rounded-xl border border-warning/30 bg-warning/10 p-3 text-center text-sm font-medium text-warning" data-testid="trade-action-blocked">
          {blockedLabel}
        </div>
      )}
    </CockpitCard>
  );
}

function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1 block text-[11px] uppercase tracking-wide text-txt-muted">{label}</span>
      {children}
    </label>
  );
}

function Toggle({ icon, label, on, set, testid }: { icon: ReactNode; label: string; on: boolean; set: (v: boolean) => void; testid: string }) {
  return (
    <button onClick={() => set(!on)} className="flex items-center gap-2" data-testid={testid}>
      <span className="text-txt-secondary">{icon}</span>
      <span className="text-txt-secondary">{label}</span>
      <span className={cn("relative h-5 w-9 rounded-full transition-colors", on ? "bg-primary" : "bg-secondary")}>
        <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all", on ? "left-4" : "left-0.5")} />
      </span>
    </button>
  );
}
