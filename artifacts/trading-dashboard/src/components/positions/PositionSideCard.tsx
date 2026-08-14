import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Sparkles, RefreshCw, BarChart3, Settings, X, ShieldAlert, Loader2 } from "lucide-react";
import { PositionMiniChart, type Candle } from "./PositionMiniChart";
import { setChartSymbol } from "@/lib/use-chart-symbol";
import {
  type FeedStatus,
  type ChartDisplayStatus,
  resolveDisplayStatus,
} from "@/lib/chart-display-status";
import { useAssistantName } from "@/lib/assistant-name";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const u = (p: string) => `${BASE}${p}`;

export type UnifiedPosition = {
  scope: "demo" | "live";
  brokerTicket: string | null;
  symbol: string | null;
  side: "BUY" | "SELL" | null;
  lotSize: number | null;
  entryPrice: number | null;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  floatingPnl: number | null;
  openedAt: string | null;
  sourceCommandId: string | null;
  accountMode: "DEMO" | "LIVE";
  source: string;
};

interface Props {
  position: UnifiedPosition;
  onClose?: () => void;
  onModifySLTP?: (pos: UnifiedPosition) => void;
  onCloseTrade?: (pos: UnifiedPosition) => void;
}

// REFRESH_THROTTLE_MS — refresh-analysis button is throttled to one click per
// REFRESH_THROTTLE_MS so the user can't spam the AI/backend.
const REFRESH_THROTTLE_MS = 8000;

function formatMoney(v: number | null): string {
  if (v == null) return "—";
  return (v >= 0 ? "+" : "") + v.toFixed(2);
}

function calcRR(side: "BUY" | "SELL" | null, entry: number | null, sl: number | null, tp: number | null): string {
  if (!side || entry == null || sl == null || tp == null) return "—";
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  if (risk <= 0) return "—";
  return `1 : ${(reward / risk).toFixed(2)}`;
}

export function PositionSideCard({ position: p, onClose, onModifySLTP, onCloseTrade }: Props) {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [feedStatus, setFeedStatus] = useState<FeedStatus | null>(null);
  const [candleError, setCandleError] = useState<string | null>(null);
  const [analysisAt, setAnalysisAt] = useState<Date | null>(null);
  const [rubyBusy, setRubyBusy] = useState(false);
  const [rubyReply, setRubyReply] = useState<string | null>(null);
  const lastRefreshRef = useRef<number>(0);
  const { toast } = useToast();
  const { name } = useAssistantName();

  // Fetch candles for the position's symbol. Re-pointed at /api/chart/candles
  // (Task #349) so the mini chart gets the SAME honest { candles, feedStatus }
  // truth contract the Scanner uses — never a bare array that hides feed state.
  useEffect(() => {
    if (!p.symbol) return;
    let cancelled = false;
    setCandleError(null);
    setFeedStatus(null);
    fetch(u(`/api/chart/candles?symbol=${encodeURIComponent(p.symbol)}&timeframe=M15&limit=100`), { credentials: "include" })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data: unknown) => {
        if (cancelled) return;
        const obj = data as Record<string, unknown> | null;
        const arr = Array.isArray(data) ? data : (obj?.candles as unknown[] | undefined) ?? [];
        const mapped: Candle[] = (arr as Array<Record<string, unknown>>).map((c) => ({
          time: typeof c.time === "number" ? c.time : new Date(String(c.time ?? c.timestamp ?? "")).getTime(),
          open: Number(c.open ?? 0), high: Number(c.high ?? 0),
          low: Number(c.low ?? 0), close: Number(c.close ?? 0),
        })).filter((c) => Number.isFinite(c.time) && c.open > 0);
        setCandles(mapped);
        // Capture feedStatus from the rich response; null on a bare-array
        // fallback (resolveDisplayStatus degrades null to a safe non-LIVE state).
        setFeedStatus((obj?.feedStatus as FeedStatus | undefined) ?? null);
      })
      .catch((e: Error) => { if (!cancelled) { setCandleError(e.message); setFeedStatus(null); } });
    return () => { cancelled = true; };
  }, [p.symbol, analysisAt]);

  // Resolve the honest display status identically to the Scanner.
  const displayStatus: ChartDisplayStatus = resolveDisplayStatus(feedStatus, candles.length > 0);

  const risk = useMemo(() => {
    if (p.entryPrice == null || p.stopLoss == null || p.lotSize == null) return null;
    return Math.abs(p.entryPrice - p.stopLoss) * p.lotSize * 100000;
  }, [p.entryPrice, p.stopLoss, p.lotSize]);

  const rr = useMemo(() => calcRR(p.side, p.entryPrice, p.stopLoss, p.takeProfit), [p.side, p.entryPrice, p.stopLoss, p.takeProfit]);

  const openedAtLabel = p.openedAt ? new Date(p.openedAt).toLocaleString() : "—";
  const isLive = p.accountMode === "LIVE";

  const handleRefreshAnalysis = () => {
    const now = Date.now();
    if (now - lastRefreshRef.current < REFRESH_THROTTLE_MS) {
      toast({ title: "Please wait", description: `Refresh is throttled to once every ${Math.round(REFRESH_THROTTLE_MS / 1000)}s.` });
      return;
    }
    lastRefreshRef.current = now;
    setAnalysisAt(new Date());
    toast({ title: "Analysis refreshed", description: "Pulled fresh candles and re-rendered the chart preview." });
  };

  // Ask Ruby — creates a paper-only assistant conversation seeded with the
  // trade context, posts one user message, and renders the assistant reply
  // inline. No navigation. The server-side meAssistant pipeline already
  // enforces {safetyMode:"paper_only", readOnlyMode:true, allowOrderExecution:false}
  // on every response, so Ruby cannot place / modify any trade.
  const handleAskRuby = async () => {
    if (rubyBusy) return;
    setRubyBusy(true);
    setRubyReply(null);
    try {
      const seedText = `I have an open ${p.accountMode.toLowerCase()} ${p.side ?? ""} position on ${p.symbol ?? ""} (ticket ${p.brokerTicket ?? "?"}). Entry ${p.entryPrice}, current ${p.currentPrice}, SL ${p.stopLoss}, TP ${p.takeProfit}, lot ${p.lotSize}, floating P/L ${p.floatingPnl}. Please explain in plain English how this trade is behaving right now and whether it still matches the original setup. Do NOT place or modify any trade — explanation only.`;
      const conv = await fetch(u("/api/me/assistant/conversations"), {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `${p.symbol} ${p.side} #${p.brokerTicket ?? ""}`.trim() }),
      }).then((r) => r.json());
      const convId = conv?.conversation?.id ?? conv?.id;
      if (!convId) throw new Error(`Couldn't open a ${name} conversation`);
      const msg = await fetch(u(`/api/me/assistant/conversations/${convId}/messages`), {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: seedText }),
      }).then((r) => r.json());
      const reply = msg?.assistantMessage?.content ?? msg?.reply ?? msg?.message?.content ?? msg?.content ?? null;
      setRubyReply(typeof reply === "string" && reply.trim() ? reply : `${name} received the context but didn't return a reply this time. Try Refresh analysis.`);
    } catch (e) {
      toast({ title: `Couldn't reach ${name}`, description: (e as Error).message, variant: "destructive" });
    } finally {
      setRubyBusy(false);
    }
  };

  const handleViewFullChart = () => {
    if (!p.symbol) return;
    const tvSymbol = p.symbol.length === 6 && /^[A-Z]{6}$/.test(p.symbol) ? `FX:${p.symbol}` : p.symbol;
    setChartSymbol(tvSymbol);
    toast({ title: "Chart symbol updated", description: `Main chart switched to ${tvSymbol}.` });
  };

  return (
    <Card data-testid="position-side-card" className="border-zinc-800 bg-zinc-950/50">
      <CardHeader className="py-3">
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span data-testid="text-position-symbol" className="text-base font-semibold text-zinc-100">{p.symbol ?? "—"}</span>
            <Badge variant={p.side === "BUY" ? "default" : "destructive"} data-testid="badge-position-side">{p.side ?? "—"}</Badge>
            <Badge variant="outline" data-testid="badge-account-mode" className={isLive ? "border-rose-500/40 text-rose-200" : "border-emerald-500/40 text-emerald-200"}>
              {p.accountMode}
            </Badge>
            <Badge variant="outline" className="text-[10px]" data-testid="badge-position-source">{p.source}</Badge>
          </div>
          {onClose && (
            <Button size="sm" variant="ghost" onClick={onClose} data-testid="btn-close-side-card">
              <X className="h-4 w-4" />
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <PositionMiniChart
          symbol={p.symbol ?? ""}
          side={p.side ?? "BUY"}
          entryPrice={p.entryPrice ?? 0}
          currentPrice={p.currentPrice}
          stopLoss={p.stopLoss}
          takeProfit={p.takeProfit}
          candles={candles}
          displayStatus={displayStatus}
          height={220}
        />
        {candleError && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-200">
            Chart preview couldn't load: {candleError}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 text-xs">
          <Field label="Ticket" testid="text-position-ticket" value={p.brokerTicket ?? "—"} />
          <Field label="Lot size" testid="text-position-lot" value={p.lotSize?.toString() ?? "—"} />
          <Field label="Entry" testid="text-position-entry" value={p.entryPrice?.toString() ?? "—"} />
          <Field label="Current" testid="text-position-current" value={p.currentPrice?.toString() ?? "—"} />
          <Field label="Stop loss" testid="text-position-sl" value={p.stopLoss?.toString() ?? "—"} />
          <Field label="Take profit" testid="text-position-tp" value={p.takeProfit?.toString() ?? "—"} />
          <Field label="Floating P/L" testid="text-position-pnl" value={formatMoney(p.floatingPnl)}
            valueClass={(p.floatingPnl ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300"} />
          <Field label="Risk est." testid="text-position-risk" value={risk != null ? `$${risk.toFixed(2)}` : "—"} />
          <Field label="R : R" testid="text-position-rr" value={rr} />
          <Field label="Order type" testid="text-position-ordertype" value={p.side ? `MARKET_${p.side}` : "—"} />
          <Field label="Open time" testid="text-position-opentime" value={openedAtLabel} />
          <Field label="Status" testid="text-position-status" value="OPEN" />
        </div>

        {isLive && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-200">
            <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />
            <span>Live position. Every close or SL/TP edit goes through the full Phase B safety pipeline — nothing fires automatically.</span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Button size="sm" variant="default" onClick={handleAskRuby} disabled={rubyBusy} data-testid="btn-ask-ruby">
            {rubyBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Sparkles className="mr-1 h-3 w-3" />} Ask {name}
          </Button>
          <Button size="sm" variant="secondary" onClick={handleRefreshAnalysis} data-testid="btn-refresh-analysis">
            <RefreshCw className="mr-1 h-3 w-3" /> Refresh analysis
          </Button>
          <Button size="sm" variant="outline" onClick={handleViewFullChart} data-testid="btn-view-full-chart">
            <BarChart3 className="mr-1 h-3 w-3" /> View full chart
          </Button>
          <Button size="sm" variant="outline" onClick={() => onModifySLTP?.(p)}
            disabled={!isLive || !onModifySLTP} data-testid="btn-modify-sltp"
            title={!isLive ? "SL/TP editing is available for live positions only" : ""}>
            <Settings className="mr-1 h-3 w-3" /> Edit SL/TP
          </Button>
          <Button size="sm" variant="destructive" onClick={() => onCloseTrade?.(p)}
            disabled={!isLive || !onCloseTrade} data-testid="btn-close-position"
            title={!isLive ? "Close action runs through the live safety pipeline; demo positions are managed in MT5" : ""}>
            <X className="mr-1 h-3 w-3" /> Close position
          </Button>
        </div>

        {rubyReply && (
          <div data-testid="ruby-reply" className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3 text-xs leading-relaxed text-blue-100 whitespace-pre-wrap">
            <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-blue-300">
              <Sparkles className="h-3 w-3" /> {name} (demo-only, read-only)
            </div>
            {rubyReply}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Field({ label, value, testid, valueClass }: { label: string; value: string; testid: string; valueClass?: string }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-2">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div data-testid={testid} className={`text-xs font-mono ${valueClass ?? "text-zinc-100"}`}>{value}</div>
    </div>
  );
}

export default PositionSideCard;
