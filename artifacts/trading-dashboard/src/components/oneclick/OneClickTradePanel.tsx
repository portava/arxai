// OneClickTradePanel — the MT5-style one-click bar for the chart.
//
//   [ SELL 1.08412 ]  [ 0.10 − + ]  [ BUY 1.08425 ]   spread 1.3 · 2 s ago
//   EURUSD #123  BUY 0.10  +12.40   [×]
//
// When one-click mode is OFF the bar collapses to a single "Turn on one-click"
// button that opens the disclaimer. When ON, SELL/BUY place a market order on
// the first click and × closes a position on the first click.
//
// Prices come from /api/data/quote (the routed, feed-scoped quote with its
// observation evidence). Buttons are disabled when the quote is stale or has
// no price, so a click can never go out against a number the server does not
// stand behind. The server re-checks freshness again on execution.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Minus, Plus, X, Zap } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useOneClickMode } from "@/hooks/useOneClickMode";
import { OneClickModeDisclaimer } from "@/components/oneclick/OneClickModeDisclaimer";
import { humanizeReason } from "@/lib/humanize";
import { normalizeLot, stepLot } from "@/lib/oneClickMode";
import type { ChartPosition } from "@/hooks/useLivePositionOverlays";
import { cn } from "@/lib/utils";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export type OneClickQuote = {
  symbol?: string;
  bid?: number | null;
  ask?: number | null;
  last?: number | null;
  available?: boolean;
  stale?: boolean;
  ageMs?: number | null;
  observedAt?: string | null;
  source?: string | null;
  observationNote?: string | null;
};

export function quoteReady(q: OneClickQuote | null | undefined): { ok: boolean; why: string | null } {
  if (!q) return { ok: false, why: "No price yet." };
  if (q.available === false) return { ok: false, why: q.observationNote ?? "No price from the feed." };
  const bid = typeof q.bid === "number" ? q.bid : typeof q.last === "number" ? q.last : null;
  const ask = typeof q.ask === "number" ? q.ask : typeof q.last === "number" ? q.last : null;
  if (bid == null || ask == null) return { ok: false, why: "No bid/ask from the feed." };
  if (q.stale) return { ok: false, why: "Price is stale. Waiting for a fresh tick." };
  return { ok: true, why: null };
}

function fmtPrice(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 2 : abs >= 10 ? 3 : 5;
  return v.toFixed(digits);
}

function fmtAge(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  if (ms < 1000) return "<1 s";
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

export function OneClickTradePanel({
  symbol,
  positions,
  onPositionsChanged,
  className,
}: {
  symbol: string;
  /** This symbol's open positions (from useLivePositionOverlays). */
  positions: ChartPosition[];
  onPositionsChanged?: () => void;
  className?: string;
}) {
  const oc = useOneClickMode();
  const { mode, busyKey } = oc;
  const { toast } = useToast();
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);
  const [lotText, setLotText] = useState<string>("");

  // Seed the lot box from the saved default once it is known.
  useEffect(() => {
    if (lotText === "" && mode.defaultVolume > 0) setLotText(String(mode.defaultVolume));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode.defaultVolume]);

  const lot = useMemo(() => normalizeLot(lotText, mode.maxLotPerClick), [lotText, mode.maxLotPerClick]);

  const quoteQ = useQuery<OneClickQuote>({
    queryKey: ["one-click-quote", symbol],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/data/quote?symbol=${encodeURIComponent(symbol)}`, { credentials: "include" });
      if (!r.ok) throw new Error(`quote ${r.status}`);
      return (await r.json()) as OneClickQuote;
    },
    enabled: mode.on && !!symbol,
    refetchInterval: 2_000,
    staleTime: 1_000,
  });
  const quote = quoteQ.data ?? null;
  const ready = quoteReady(quote);
  const bid = quote?.bid ?? quote?.last ?? null;
  const ask = quote?.ask ?? quote?.last ?? null;
  const spread = typeof bid === "number" && typeof ask === "number" ? ask - bid : null;

  const scopePositions = useMemo(
    () => positions.filter((p) => !!p.brokerTicket && (mode.scope == null || p.scope === mode.scope)),
    [positions, mode.scope],
  );

  const fire = async (side: "BUY" | "SELL") => {
    if (!lot) {
      toast({ title: "Lot size needed", description: "Type a lot size above 0 first.", variant: "destructive" });
      return;
    }
    const r = await oc.execute({ side, symbol, volume: lot, source: "chart" });
    if (r.ok) {
      toast({
        title: `${side} ${symbol} ${lot}`,
        description: mode.scope === "live"
          ? "Sent to your broker through the live router. Fill confirmation follows from the terminal."
          : "Filled on demo.",
      });
      onPositionsChanged?.();
    } else {
      const h = humanizeReason(r.reason ?? r.status);
      toast({ title: `${side} blocked`, description: h.description || r.reason || r.status, variant: "destructive" });
    }
  };

  const close = async (p: ChartPosition) => {
    if (!p.brokerTicket) return;
    const r = await oc.closePosition({
      ticket: p.brokerTicket, symbol: p.symbol ?? symbol, side: p.side, volume: p.lotSize, source: "chart",
    });
    if (r.ok) {
      toast({ title: `Close #${p.brokerTicket}`, description: mode.scope === "live" ? "Close sent to your broker." : "Closed on demo." });
      onPositionsChanged?.();
    } else {
      const h = humanizeReason(r.reason ?? r.status);
      toast({ title: "Close blocked", description: h.description || r.reason || r.status, variant: "destructive" });
    }
  };

  const onAccept = async () => {
    const r = await oc.enable();
    if (r.ok) {
      setDisclaimerOpen(false);
      toast({ title: `One-click ON (${mode.scope?.toUpperCase()})`, description: "Buy, Sell and Close now execute on the first click, app-wide." });
    } else {
      toast({ title: "One-click not turned on", description: r.error ?? "", variant: "destructive" });
    }
  };

  if (!mode.scope && !mode.loading) return null;

  if (!mode.on) {
    return (
      <>
        <div className={cn("flex items-center gap-2 rounded-md border border-zinc-800/80 bg-zinc-950/70 px-2 py-1.5 text-xs", className)} data-testid="one-click-panel-off">
          <Zap className="h-3.5 w-3.5 text-amber-400" />
          <span className="text-txt-secondary">One-click trading is off.</span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-7 text-xs"
            disabled={mode.loading || !mode.canEnable}
            title={mode.canEnable ? undefined : mode.blockReason ?? undefined}
            onClick={() => setDisclaimerOpen(true)}
            data-testid="one-click-panel-turn-on"
          >
            Turn on one-click
          </Button>
        </div>
        <OneClickModeDisclaimer open={disclaimerOpen} onOpenChange={setDisclaimerOpen} mode={mode} busy={oc.switching} onAccept={() => void onAccept()} />
      </>
    );
  }

  const executing = busyKey != null;
  const tradeDisabled = executing || !ready.ok || !lot;

  return (
    <div className={cn("rounded-md border border-amber-500/30 bg-zinc-950/80 p-2", className)} data-testid="one-click-panel">
      <div className="flex flex-wrap items-stretch gap-2">
        <Button
          className="h-12 min-w-[120px] flex-1 flex-col gap-0 bg-rose-600 text-white hover:bg-rose-500 disabled:opacity-50"
          onClick={() => void fire("SELL")}
          disabled={tradeDisabled}
          title={ready.why ?? undefined}
          data-testid="one-click-sell"
        >
          <span className="text-[10px] font-semibold tracking-wide opacity-80">SELL</span>
          <span className="font-mono text-base leading-tight" data-testid="one-click-bid">{fmtPrice(bid)}</span>
        </Button>

        <div className="flex w-[132px] items-center gap-1">
          <Button size="icon" variant="outline" className="h-12 w-8" onClick={() => setLotText(String(stepLot(lot ?? mode.defaultVolume, -1, mode.maxLotPerClick)))} disabled={executing} aria-label="Decrease lot" data-testid="one-click-lot-minus">
            <Minus className="h-3.5 w-3.5" />
          </Button>
          <Input
            value={lotText}
            onChange={(e) => setLotText(e.target.value)}
            inputMode="decimal"
            className="h-12 px-1 text-center font-mono text-sm"
            aria-label="Lot size"
            data-testid="one-click-lot"
          />
          <Button size="icon" variant="outline" className="h-12 w-8" onClick={() => setLotText(String(stepLot(lot ?? mode.defaultVolume, 1, mode.maxLotPerClick)))} disabled={executing} aria-label="Increase lot" data-testid="one-click-lot-plus">
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>

        <Button
          className="h-12 min-w-[120px] flex-1 flex-col gap-0 bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50"
          onClick={() => void fire("BUY")}
          disabled={tradeDisabled}
          title={ready.why ?? undefined}
          data-testid="one-click-buy"
        >
          <span className="text-[10px] font-semibold tracking-wide opacity-80">BUY</span>
          <span className="font-mono text-base leading-tight" data-testid="one-click-ask">{fmtPrice(ask)}</span>
        </Button>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-txt-secondary" data-testid="one-click-meta">
        <span className="font-mono font-semibold text-amber-300">{symbol} · {mode.scope?.toUpperCase()} · 1-click</span>
        {spread != null && <span>spread {fmtPrice(spread)}</span>}
        {quote?.ageMs != null && <span>{fmtAge(quote.ageMs)} ago</span>}
        {quote?.source && <span>{quote.source}</span>}
        {!ready.ok && <span className="text-rose-300" data-testid="one-click-not-ready">{ready.why}</span>}
        {executing && <span className="flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> sending…</span>}
      </div>

      {scopePositions.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-zinc-800/80 pt-2" data-testid="one-click-positions">
          {scopePositions.map((p) => {
            const pnl = typeof p.floatingPnl === "number" ? p.floatingPnl : null;
            const busy = busyKey === p.brokerTicket;
            return (
              <li key={p.brokerTicket!} className="flex items-center gap-2 text-xs">
                <span className="font-mono text-txt-secondary">#{p.brokerTicket}</span>
                <span className={cn("font-semibold", p.side === "BUY" ? "text-emerald-400" : "text-rose-400")}>{p.side ?? "—"}</span>
                <span className="font-mono">{p.lotSize ?? "—"}</span>
                <span className="font-mono text-txt-secondary">@ {fmtPrice(p.entryPrice)}</span>
                {pnl != null && (
                  <span className={cn("ml-auto font-mono", pnl >= 0 ? "text-emerald-400" : "text-rose-400")}>{pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}</span>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  className={cn("h-6 w-6 text-rose-300 hover:bg-rose-500/10 hover:text-rose-200", pnl == null && "ml-auto")}
                  onClick={() => void close(p)}
                  disabled={executing}
                  aria-label={`Close position ${p.brokerTicket}`}
                  title="Close now (one-click)"
                  data-testid={`one-click-close-${p.brokerTicket}`}
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
