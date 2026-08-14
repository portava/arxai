import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Brain, ThumbsUp, ThumbsDown, ShieldAlert, Loader2, WifiOff } from "lucide-react";
import TradingViewLiveChart from "@/components/charts/TradingViewLiveChart";
import { useViewMode } from "@/hooks/useViewMode";
import { useChartSymbol, bareSymbol, setChartSymbol } from "@/lib/use-chart-symbol";
import { LiveSharedTradeTicket } from "@/components/live/LiveSharedTradeTicket";
import { useMasterLiveAccess } from "@/components/live/MasterLiveAccessGuard";
import { useAssistantName } from "@/lib/assistant-name";

type TradeCard = {
  symbol: string; direction: "BUY" | "SELL"; setup: string;
  entry: number; stopLoss: number; takeProfit: number;
  confidenceScore: number; riskScore: number; riskRewardRatio: number;
  reasonForTrade: string; invalidationReason: string;
  marketCondition: string;
};

// Display label → real symbol the Market Data Router understands.
const SYMBOLS: { label: string; value: string; tv: string }[] = [
  { label: "EURUSD", value: "EURUSD", tv: "FX:EURUSD" },
  { label: "GBPUSD", value: "GBPUSD", tv: "FX:GBPUSD" },
  { label: "USDJPY", value: "USDJPY", tv: "FX:USDJPY" },
  { label: "XAUUSD", value: "XAUUSD", tv: "FX:XAUUSD" },
  { label: "BTCUSD", value: "BTCUSD", tv: "BINANCE:BTCUSDT" },
];

type FeedState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "card"; card: TradeCard }
  | { kind: "neutral"; reason: string }       // real feed, but no directional edge
  | { kind: "nodata"; reason: string };        // feed unavailable / not enough data

async function jget(url: string, init?: RequestInit) {
  const r = await fetch(url, { credentials: "include", headers: { ...(init?.headers ?? {}) }, ...init });
  const text = await r.text(); let body: any; try { body = JSON.parse(text); } catch { body = text; }
  return { ok: r.ok, status: r.status, body };
}

// Map the real selected-market snapshot → trade card. Returns a FeedState so
// NEUTRAL/WAIT and unavailable feeds produce honest states, never a fake setup.
function snapshotToState(snap: any): FeedState {
  if (!snap || snap.ok !== true) {
    const reason = snap?.reason === "SYMBOL_NOT_SUPPORTED"
      ? "This symbol isn't available on the live feed yet."
      : snap?.reason === "NO_MARKET_DATA"
      ? "Not enough market data to analyze this symbol right now."
      : snap?.message || "Awaiting live feed for this market.";
    return { kind: "nodata", reason };
  }
  const h = snap.highlights ?? {};
  const bias = h.bias as "BUY" | "SELL" | "NEUTRAL" | "WAIT";
  if (bias !== "BUY" && bias !== "SELL") {
    return {
      kind: "neutral",
      reason: snap.explanation?.why || "No clear directional edge right now — wait for confirmation.",
    };
  }
  const entry = (h.entryZone?.low != null && h.entryZone?.high != null)
    ? Number(((h.entryZone.low + h.entryZone.high) / 2).toFixed(5))
    : 0;
  return {
    kind: "card",
    card: {
      symbol: snap.symbol,
      direction: bias,
      setup: h.trendState ? `Trend: ${h.trendState}` : "Live setup",
      entry,
      stopLoss: Number(h.suggestedStop ?? 0),
      takeProfit: Number(h.suggestedTakeProfit ?? 0),
      confidenceScore: Number(h.confidenceScore ?? 0),
      riskScore: 0,
      riskRewardRatio: Number(h.riskRewardRatio ?? 0),
      reasonForTrade: snap.explanation?.why || "",
      invalidationReason: snap.explanation?.invalidation || "",
      marketCondition: h.volatilityLabel || h.trendState || "—",
    },
  };
}

export default function LiveAiAssistPage() {
  const { effectiveIsAdmin } = useViewMode();
  // Single source of truth — the shared chart-symbol bus. Picking a
  // symbol here updates the chart, the trade ticket, scanner focus
  // panel, ruby explanation and every other consumer in the same paint.
  const [chartSymbol] = useChartSymbol();
  const symbol = (() => {
    const bare = bareSymbol(chartSymbol);
    return SYMBOLS.some((s) => s.value === bare) ? bare : SYMBOLS[0].value;
  })();
  const [feed, setFeed] = useState<FeedState>({ kind: "idle" });
  const [perm, setPerm] = useState<any>(null);
  const [resp, setResp] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [liveTicketOpen, setLiveTicketOpen] = useState(false);
  const liveAccess = useMasterLiveAccess();
  const { name } = useAssistantName();

  // Monotonic request id used to invalidate in-flight loadCard() results
  // when the shared symbol flips. Without this, a slow XAUUSD response
  // could land AFTER the user picked EURUSD and repopulate the card
  // with the previous symbol's setup.
  const loadReqIdRef = useRef(0);

  // Whenever the shared symbol changes, drop any stale AI card / response
  // and invalidate any in-flight loadCard() so a late response from the
  // previous symbol cannot overwrite the cleared state.
  useEffect(() => {
    loadReqIdRef.current += 1;
    setFeed({ kind: "idle" });
    setResp(null);
  }, [symbol]);

  useEffect(() => { void jget("/api/permission/status").then(r => setPerm(r.body)); }, []);

  // Fetch the REAL selected-market snapshot — same endpoint scanner/chart use.
  // Bumps the monotonic request id and only commits the result if the id
  // still matches when the response arrives. Any symbol change mid-flight
  // bumps the id and the stale response is discarded.
  async function loadCard() {
    const reqId = ++loadReqIdRef.current;
    const symbolAtRequest = symbol;
    setFeed({ kind: "loading" }); setResp(null);
    const r = await jget(`/api/market-scanner/selected-market?symbol=${encodeURIComponent(symbolAtRequest)}&timeframe=M15`);
    if (loadReqIdRef.current !== reqId) return; // stale — symbol changed
    setFeed(snapshotToState(r.body));
  }

  const card = feed.kind === "card" ? feed.card : null;
  const tvSymbol = SYMBOLS.find(s => s.value === symbol)?.tv ?? "FX:EURUSD";

  async function approve() {
    if (!card) return;
    // LIVE_SHARED users: open the real shared-account ticket pre-filled
    // from the AI card. The ticket runs /validate → /execute through the
    // 16-gate evaluator and dispatches a real broker order.
    // Paper / tester users keep the legacy live-intent capture path,
    // which only writes to the tester audit table and never trades.
    if (liveAccess.loaded && liveAccess.canTrade) {
      setLiveTicketOpen(true);
      return;
    }
    setBusy(true); setResp(null);
    const r = await jget("/api/live-intent/submit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "AI_ASSIST", symbol: card.symbol, direction: card.direction, orderType: "MARKET",
        lotSize: 0.01, entryPrice: card.entry, stopLoss: card.stopLoss, takeProfit: card.takeProfit,
        confidenceScore: card.confidenceScore, riskScore: card.riskScore,
        riskRewardRatio: card.riskRewardRatio,
        reasonForTrade: card.reasonForTrade, invalidationReason: card.invalidationReason,
        marketCondition: card.marketCondition,
      }),
    });
    setResp(r.body); setBusy(false);
  }

  return (
    <div className="container mx-auto py-4 px-3 md:px-6 space-y-4 max-w-[1600px]">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Brain className="w-6 h-6" /> Live AI Assist</h1>
        <p className="text-sm text-muted-foreground">{name} analyzes the selected market on the live feed. Review the setup, then approve to submit a live-intent. Your risk caps apply.</p>
      </div>

      <div className="grid lg:grid-cols-[440px_1fr] gap-4">
        <div className="space-y-3">
          <Card>
            <CardHeader>
              <CardTitle className="flex justify-between items-center text-sm">
                <span>AI Trade Card</span>
                <select
                  className="text-xs bg-background border border-border rounded px-2 py-1"
                  value={symbol}
                  data-testid="ai-symbol-select"
                  onChange={(e) => {
                    // Push through the shared bus so the chart, trade
                    // ticket and every other symbol consumer flip in the
                    // same paint. Card/resp cleanup happens via the
                    // useEffect that watches `symbol`.
                    const next = SYMBOLS.find((s) => s.value === e.target.value);
                    setChartSymbol(next?.tv ?? e.target.value);
                  }}
                >
                  {SYMBOLS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </CardTitle>
              <CardDescription>Reads the live market feed. No setup is shown unless the data supports one.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={loadCard} className="w-full" data-testid="generate-card" disabled={feed.kind === "loading"}>
                {feed.kind === "loading" ? <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Reading feed…</> : "Analyze live market"}
              </Button>
            </CardContent>
          </Card>

          {/* Honest empty states — never a fabricated setup */}
          {feed.kind === "nodata" && (
            <Card className="border-amber-500/30" data-testid="ai-nodata">
              <CardContent className="pt-4 text-xs flex items-start gap-2 text-amber-200">
                <WifiOff className="w-4 h-4 mt-0.5 shrink-0" />
                <div>
                  <p className="font-semibold">Awaiting feed</p>
                  <p className="text-amber-200/80">{feed.reason}</p>
                </div>
              </CardContent>
            </Card>
          )}
          {feed.kind === "neutral" && (
            <Card className="border-border" data-testid="ai-neutral">
              <CardContent className="pt-4 text-xs space-y-1">
                <p className="font-semibold">No setup right now</p>
                <p className="text-muted-foreground">{feed.reason}</p>
              </CardContent>
            </Card>
          )}

          {card && (
            <Card className="border-blue-500/30">
              <CardHeader><CardTitle className="text-sm flex justify-between">{card.symbol} <Badge>{card.direction}</Badge></CardTitle><CardDescription>{card.setup}</CardDescription></CardHeader>
              <CardContent className="space-y-2 text-xs">
                <div className="grid grid-cols-3 gap-1 font-mono">
                  <div className="rounded border border-border p-1.5"><div className="text-muted-foreground">Entry</div>{card.entry || "—"}</div>
                  <div className="rounded border border-red-500/30 p-1.5"><div className="text-muted-foreground">SL</div>{card.stopLoss || "—"}</div>
                  <div className="rounded border border-emerald-500/30 p-1.5"><div className="text-muted-foreground">TP</div>{card.takeProfit || "—"}</div>
                </div>
                <div className="grid grid-cols-2 gap-1">
                  <div className="rounded border border-border p-1.5"><div className="text-muted-foreground">Confidence</div>{card.confidenceScore}</div>
                  <div className="rounded border border-border p-1.5"><div className="text-muted-foreground">R:R</div>{card.riskRewardRatio || "—"}</div>
                </div>
                {card.reasonForTrade && <p><span className="text-muted-foreground">Reason:</span> {card.reasonForTrade}</p>}
                {card.invalidationReason && <p><span className="text-muted-foreground">Invalidation:</span> {card.invalidationReason}</p>}
                <p><span className="text-muted-foreground">Market:</span> {card.marketCondition}</p>
                <div className="flex gap-2 pt-2">
                  <Button size="sm" variant="outline" onClick={() => setFeed({ kind: "idle" })} data-testid="reject-card"><ThumbsDown className="w-3.5 h-3.5 mr-1" /> Reject</Button>
                  <Button size="sm" onClick={approve} disabled={busy || !liveAccess.loaded} data-testid="approve-card">
                    <ThumbsUp className="w-3.5 h-3.5 mr-1" />
                    {!liveAccess.loaded
                      ? "Checking access…"
                      : liveAccess.canTrade
                        ? "Approve → Live ticket"
                        : "Approve → live-intent"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {resp && (
            <Card className={resp.accepted ? "border-emerald-500/40 bg-emerald-500/5" : "border-red-500/40 bg-red-500/5"}>
              <CardContent className="pt-4 text-xs space-y-1" data-testid="ai-assist-response">
                <p className="font-semibold flex items-center gap-2"><ShieldAlert className="w-4 h-4" />status: {resp.status}</p>
                <p className="text-muted-foreground">{resp.reason}</p>
                <p className="font-mono text-[10px]">intentId: {resp.intentId}</p>
                {effectiveIsAdmin && <p className="text-[11px]">MT5 connected at submit: {String(resp.mt5Connected)} · broker execution: {String(resp.brokerExecution)}</p>}
              </CardContent>
            </Card>
          )}

          {effectiveIsAdmin && (
            <Card className="border border-border">
              <CardContent className="pt-3 text-xs">
                <p className="font-semibold mb-1">Permission state (admin diagnostics)</p>
                <div className="font-mono text-[11px]">canExecuteRealBrokerOrder: <span className="text-red-400">{String(perm?.testerAccess?.canExecuteRealBrokerOrder ?? false)}</span></div>
                <div className="font-mono text-[11px]">canSubmitLiveIntent: <span className="text-emerald-400">{String(perm?.testerAccess?.canSubmitLiveIntent ?? true)}</span></div>
                <div className="font-mono text-[11px]">mt5Connected: {String(perm?.testerAccess?.mt5Connected ?? false)}</div>
              </CardContent>
            </Card>
          )}
        </div>
        <TradingViewLiveChart defaultSymbol={tvSymbol} height={620} compact />
      </div>
      {card && (
        <LiveSharedTradeTicket
          open={liveTicketOpen}
          onOpenChange={setLiveTicketOpen}
          defaultSymbol={card.symbol}
          defaultSide={card.direction}
          rubyExplanationSummary={card.reasonForTrade ?? null}
        />
      )}
    </div>
  );
}
