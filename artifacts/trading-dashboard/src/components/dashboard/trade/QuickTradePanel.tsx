// QuickTradePanel — the centerpiece of the redesigned Trade Command Room.
//
// UI ONLY. No execution logic lives here. Buy/Sell route into the existing
// /live-manual ticket flow (symbol already synced via useChartSymbol upstream),
// honouring "use existing order placement flow — do not create a new execution
// path." Symbol/timeframe/lot/SL/TP are controlled inputs driven by props from
// the page, which owns the existing state + quote feed.

import type { ReactNode } from "react";
import { useLocation } from "wouter";
import { Zap, TrendingUp, TrendingDown, ShieldCheck, Bot, ShieldQuestion } from "lucide-react";
import { CockpitCard } from "@/components/dashboard/cockpit/primitives";
import { ChartFeedConfidence } from "@/components/charts/ChartFeedConfidence";
import { cn } from "@/lib/utils";

export type Quote = { bid: number; ask: number; spread: number; mid: number } | null;

const ORDER_TYPES = [
  "Market", "Buy Limit", "Sell Limit", "Buy Stop", "Sell Stop", "Buy Stop Limit", "Sell Stop Limit",
];
const TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"];
const LOT_PRESETS = ["0.01", "0.02", "0.05", "0.10", "0.20", "MAX"];

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
  const [, navigate] = useLocation();

  const sell = quote ? quote.bid : null;
  const buy = quote ? quote.ask : null;
  const spread = quote ? quote.spread : null;

  // Buy/Sell → existing manual ticket. Symbol is already synced globally
  // (useChartSymbol) by the page, so the ticket opens prefilled. No new path.
  const goTicket = () => navigate("/live-manual");

  return (
    <CockpitCard
      title="Quick Trade"
      subtitle="Execute a trade in seconds."
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
            className="h-10 w-full rounded-md border border-input bg-transparent px-3 font-mono text-sm shadow-xs outline-none focus:border-ring focus:ring-2 focus:ring-ring/25"
            data-testid="trade-symbol-input"
          />
        </Field>
        <Field label="Timeframe">
          <select
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value)}
            className="h-10 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus:border-ring focus:ring-2 focus:ring-ring/25"
            data-testid="trade-tf-input"
          >
            {TIMEFRAMES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Order type">
          <select
            value={orderType}
            onChange={(e) => setOrderType(e.target.value)}
            className="h-10 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus:border-ring focus:ring-2 focus:ring-ring/25"
            data-testid="trade-order-type"
          >
            {ORDER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
      </div>

      {/* Price strip — SELL | spread | BUY */}
      <div className="mt-3 grid grid-cols-3 items-center rounded-lg bg-muted/40 px-4 py-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-danger">Sell</div>
          <div className="font-mono text-lg font-bold tabular-nums text-danger">{sell ?? "—"}</div>
        </div>
        <div className="text-center">
          <div className="text-[11px] uppercase tracking-wide text-txt-muted">Spread</div>
          <div className="font-mono text-sm tabular-nums">{spread ?? "—"}</div>
        </div>
        <div className="text-right">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-success">Buy</div>
          <div className="font-mono text-lg font-bold tabular-nums text-success">{buy ?? "—"}</div>
        </div>
      </div>

      {/* Lot sizing */}
      <div className="mt-3 flex items-end gap-3">
        <Field label="Lot size" className="w-28">
          <input
            value={lot}
            onChange={(e) => setLot(e.target.value)}
            className="h-10 w-full rounded-md border border-input bg-transparent px-3 font-mono text-sm shadow-xs outline-none focus:border-ring focus:ring-2 focus:ring-ring/25"
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
          <div className="font-mono text-sm font-semibold tabular-nums">{riskApprox}</div>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
        {LOT_PRESETS.map((p) => (
          <button
            key={p}
            onClick={() => setLot(p)}
            className={cn(
              "h-9 rounded-md border text-sm font-medium transition-colors",
              lot === p ? "border-primary bg-primary/15 text-primary" : "border-border text-txt-secondary hover:bg-secondary/50",
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
              className="h-10 w-full rounded-md border border-input bg-transparent px-3 font-mono text-sm shadow-xs outline-none focus:border-ring focus:ring-2 focus:ring-ring/25" data-testid="trade-sl-input" />
          </Field>
          <Field label="Take Profit (optional)">
            <input value={takeProfit} onChange={(e) => setTakeProfit(e.target.value)} placeholder="—"
              className="h-10 w-full rounded-md border border-input bg-transparent px-3 font-mono text-sm shadow-xs outline-none focus:border-ring focus:ring-2 focus:ring-ring/25" data-testid="trade-tp-input" />
          </Field>
        </div>
      )}

      {/* Actions */}
      {canTrade ? (
        <div className="mt-4 grid grid-cols-[1fr_auto_1fr] gap-2">
          <button onClick={goTicket} data-testid="trade-action-sell"
            className="flex h-12 items-center justify-center gap-2 rounded-md bg-danger font-semibold text-white shadow-xs hover:bg-danger/90">
            <TrendingDown className="h-4 w-4" /> SELL {sell ?? ""}
          </button>
          <button onClick={goTicket} data-testid="trade-action-cancel"
            className="flex h-12 items-center justify-center rounded-md border border-border px-5 font-medium text-txt-secondary hover:bg-secondary/50">
            Cancel
          </button>
          <button onClick={goTicket} data-testid="trade-action-buy"
            className="flex h-12 items-center justify-center gap-2 rounded-md bg-success font-semibold text-white shadow-xs hover:bg-success/90">
            <TrendingUp className="h-4 w-4" /> BUY {buy ?? ""}
          </button>
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-warning/25 bg-warning/10 p-3 text-center text-sm font-medium text-warning" data-testid="trade-action-blocked">
          {blockedLabel}
        </div>
      )}
    </CockpitCard>
  );
}

function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
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
