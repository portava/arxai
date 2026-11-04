// QuickTradePanel — the centerpiece of the redesigned Trade Command Room.
//
// UI ONLY. No execution logic lives here. Buy/Sell route into the existing
// /live-manual ticket flow (symbol already synced via useChartSymbol upstream),
// honouring "use existing order placement flow — do not create a new execution
// path." Symbol/timeframe/lot/SL/TP are controlled inputs driven by props from
// the page, which owns the existing state + quote feed.

import type { ReactNode } from "react";
import { useLocation } from "wouter";
import { Zap, TrendingUp, TrendingDown, ShieldCheck, ShieldQuestion } from "lucide-react";
import { CockpitCard } from "@/components/dashboard/cockpit/primitives";
import { ChartFeedConfidence } from "@/components/charts/ChartFeedConfidence";
import { cn } from "@/lib/utils";
import { OrderTicketButton } from "@/components/trade/OrderTicketOverlay";
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

export type Quote = {
  bid: number; ask: number; spread: number; mid: number;
  /** Where the quote came from. /api/market/quote always says "SIMULATOR". */
  executionEnvironment?: string | null;
} | null;

/**
 * Quote sources whose bid/ask may be shown as tradable prices. Fail closed:
 * a quote with no source, or from the ARX price simulator (a random walk off
 * fixed base prices), is not a market price and is never displayed as one.
 */
const MARKET_QUOTE_SOURCES: ReadonlySet<string> = new Set(["BROKER", "MT5"]);

/**
 * True when the value is a priced quote (finite bid and ask). The page stores
 * whatever JSON the quote route returned, so an error body such as
 * {error:"Unknown symbol"} reaches the panel as a non-null object: it is not a
 * quote of any kind.
 */
function isPricedQuote(q: Quote): q is NonNullable<Quote> {
  return q != null
    && typeof q === "object"
    && Number.isFinite(q.bid)
    && Number.isFinite(q.ask);
}

export function isMarketQuote(q: Quote): q is NonNullable<Quote> {
  return isPricedQuote(q)
    && typeof q.executionEnvironment === "string"
    && MARKET_QUOTE_SOURCES.has(q.executionEnvironment.toUpperCase());
}

/** One read of the quote route: failed = the read itself failed. */
export type QuoteRead = { quote: Quote; failed: boolean };

/**
 * Reads GET /api/market/quote/:symbol for the Trade Command Room. The route
 * answers 404 {error:"Unknown symbol"} when it has no quote for the symbol:
 * that is no quote, not a failure. Any other non-2xx answer (5xx, 401, a 404
 * without that body), a 2xx body that is not JSON, or a request that throws is
 * a failed read: "could not be loaded", never "no quote for this symbol".
 */
export async function readQuickTradeQuote(bareSymbol: string): Promise<QuoteRead> {
  try {
    const r = await fetch(`/api/market/quote/${bareSymbol}`);
    if (r.status === 404) {
      const body: unknown = await r.json().catch(() => null);
      const unknownSymbol = body != null && typeof body === "object" && (body as { error?: unknown }).error === "Unknown symbol";
      return { quote: null, failed: !unknownSymbol };
    }
    if (!r.ok) return { quote: null, failed: true };
    return { quote: (await r.json()) as Quote, failed: false };
  } catch {
    return { quote: null, failed: true };
  }
}

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
  quoteLoadFailed = false,
  quoteLoading = false,
  slTpOn, setSlTpOn,
  stopLoss, setStopLoss,
  takeProfit, setTakeProfit,
  riskApprox,
  canTrade,
  blockedLabel,
}: {
  symbol: string; setSymbol: (v: string) => void;
  timeframe: string; setTimeframe: (v: string) => void;
  orderType: string; setOrderType: (v: string) => void;
  lot: string; setLot: (v: string) => void;
  quote: Quote;
  /** True when the latest quote read failed (see readQuickTradeQuote). */
  quoteLoadFailed?: boolean;
  /**
   * True while no quote read for this symbol has answered yet. Nothing is
   * known about the symbol's quote then: it is not "no quote available".
   */
  quoteLoading?: boolean;
  slTpOn: boolean; setSlTpOn: (v: boolean) => void;
  stopLoss: string; setStopLoss: (v: string) => void;
  takeProfit: string; setTakeProfit: (v: string) => void;
  /**
   * Ignored. These switches never reached the server: the risk governor and
   * every safety gate run on submit regardless, so the panel no longer shows
   * them as protections the trader can turn on or off. Kept optional so
   * existing callers compile.
   */
  riskCheckOn?: boolean; setRiskCheckOn?: (v: boolean) => void;
  safetyGatesOn?: boolean; setSafetyGatesOn?: (v: boolean) => void;
  riskApprox: string;
  canTrade: boolean;
  blockedLabel: string;
}) {
  const [, navigate] = useLocation();

  // Only a market quote is shown as Sell / Buy. A simulator quote is withheld
  // (it is synthetic, not the market), and the strip says so.
  const marketQuote = isMarketQuote(quote) ? quote : null;
  // Withheld quotes are named by what actually came back: a simulator quote, a
  // priced quote with no stated (or an unrecognised) source — or no quote at
  // all (nothing, or an error body), which is never blamed on the simulator.
  const withheld = marketQuote == null && isPricedQuote(quote) ? quote : null;
  const withheldSource = typeof withheld?.executionEnvironment === "string" ? withheld.executionEnvironment.trim() : "";
  const simulatedOnly = withheld != null && withheldSource.toUpperCase() === "SIMULATOR";
  const sell = marketQuote ? marketQuote.bid : null;
  const buy = marketQuote ? marketQuote.ask : null;
  const spread = marketQuote ? marketQuote.spread : null;

  // Buy/Sell → existing manual ticket. Symbol is already synced globally
  // (useChartSymbol) by the page, so the ticket opens prefilled. No new path.
  const goTicket = () => navigate("/live-manual");

  return (
    <CockpitCard
      title="Quick Trade"
      subtitle="Pick a market, then open the manual ticket to place the order."
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
      <div className="mt-3 grid grid-cols-3 items-center rounded-xl border border-border bg-background/40 px-4 py-3" data-testid="quick-trade-price-strip">
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
      <p className="mt-1 text-xs text-txt-muted" data-testid="quick-trade-quote-source">
        {marketQuote
          ? `Quote source: ${marketQuote.executionEnvironment}.`
          : simulatedOnly
            ? "No market price on this panel. The only quote it can read comes from the ARX price simulator (synthetic, not the market or your broker), so it is not shown. Check the chart feed for the current price."
            : withheld != null
              ? withheldSource
                ? `A quote came back from "${withheldSource}", which is not a broker or MT5 price, so it is not shown. Check the chart feed for the current price.`
                : "A quote came back with no stated source, so it is not shown. Check the chart feed for the current price."
              : quoteLoading
                ? "Loading the quote…"
                : quoteLoadFailed
                  ? "The quote could not be loaded, so no price is shown. Check the chart feed for the current price."
                  : "No quote available for this symbol."}
      </p>

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
        {LOT_PRESETS.map((p) => (
          <button
            key={p}
            onClick={() => setLot(p)}
            className={cn(
              "h-9 rounded-lg border text-sm font-medium transition-colors",
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
      </div>
      {/* Not a switch: the server's risk check and safety gates run on every
          submit and cannot be turned off from this panel. */}
      <p className="mt-2 flex items-start gap-2 text-xs text-txt-muted" data-testid="trade-server-checks-note">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>Risk check and safety gates are not set here. The server runs them on every order you submit from the ticket, and they cannot be turned off from this panel.</span>
      </p>

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
          <button onClick={goTicket} data-testid="trade-action-sell"
            className="flex h-12 items-center justify-center gap-2 rounded-xl bg-danger font-semibold text-white hover:bg-danger/90">
            <TrendingDown className="h-4 w-4" /> SELL {sell ?? ""}
          </button>
          <button onClick={goTicket} data-testid="trade-action-buy"
            className="flex h-12 items-center justify-center gap-2 rounded-xl bg-success font-semibold text-white hover:bg-success/90">
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
        {/* The manual ticket only picks up the shared chart symbol; nothing else on
            this panel reaches it, and no order is sent from the SELL/BUY buttons. */}
        <p className="mt-2 text-xs text-txt-muted" data-testid="trade-ticket-handoff-note">
          SELL and BUY open the manual ticket with {symbol} selected; no order is sent from those buttons. The side, lot size, order type, stop loss and take profit set here are not carried over to the manual ticket, so set them again there before you submit. The order window above does carry them.
        </p>
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
