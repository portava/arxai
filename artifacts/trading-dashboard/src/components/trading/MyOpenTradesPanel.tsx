import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, X as XIcon, TrendingUp, TrendingDown, AlertTriangle, Sparkles, BellRing } from "lucide-react";
import { ConfirmCloseModal } from "./ConfirmCloseModal";
import { Link } from "wouter";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const u = (p: string) => `${BASE}${p}`;

export type OpenCard = {
  id: string;
  source: "user_owned_mt5" | "shared_master_attribution";
  routingMode: "USER_OWNED_MT5" | "SHARED_MASTER_MT5";
  accountType: "demo" | "live" | "unknown";
  symbol: string;
  side: "BUY" | "SELL";
  lotSize: number;
  entryPrice: number | null;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  unrealizedPnl: number | null;
  pnlIsEstimate: boolean;
  pnlPercent: number | null;
  status: string;
  openedAt: string | null;
  brokerLabelMasked: string | null;
  waitingForSync: boolean;
};

type OpenResponse = {
  ok: boolean;
  routingMode: "USER_OWNED_MT5" | "SHARED_MASTER_MT5";
  accountType: "demo" | "live" | "unknown";
  tradingMode: "DISABLED" | "DEMO" | "LIVE" | "SIMULATED";
  bannerLabel: string;
  cards: OpenCard[];
};

type IntelResponse = {
  ok: boolean;
  snapshot?: {
    label: string | null;
    recommendedAction: string | null;
    explanation: string | null;
    closeUrgencyScore: number | null;
    peakPnl: number | null;
    profitGivebackPercent: number | null;
    pnlPips: number | null;
  };
};

type MarketCtxBadge = {
  classificationLabel: string | null;
  tradeLabel: string | null;
  trendAlignment: "ALIGNED" | "FIGHTING" | "NEUTRAL" | "UNKNOWN" | null;
  primaryTimeframe: string | null;
  dataQuality: "good" | "partial" | "insufficient" | null;
};

function actionBadgeVariant(action: string | null | undefined): "default" | "destructive" | "secondary" | "outline" {
  if (!action) return "outline";
  if (action.startsWith("CLOSE")) return "destructive";
  if (action === "HOLD") return "default";
  return "secondary";
}

function urgencyColor(score: number | null | undefined): string {
  if (score == null) return "text-zinc-400";
  if (score >= 80) return "text-rose-400";
  if (score >= 60) return "text-amber-400";
  if (score >= 40) return "text-yellow-400";
  return "text-emerald-400";
}

function alignVariant(a: MarketCtxBadge["trendAlignment"]): "default" | "destructive" | "secondary" | "outline" {
  if (a === "ALIGNED") return "default";
  if (a === "FIGHTING") return "destructive";
  if (a === "NEUTRAL") return "secondary";
  return "outline";
}

function TradeMarketContextBadge({ card }: { card: OpenCard }) {
  const [ctx, setCtx] = useState<MarketCtxBadge | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await fetch(u(`/api/me/trades/${card.id}/market-context`), { credentials: "include" });
        if (!r.ok) return;
        const j = await r.json() as {
          ok?: boolean;
          classification?: { label?: string | null; primaryTimeframe?: string | null };
          tradeContext?: { trendAlignment?: string | null; tradeLabel?: string | null };
          context?: { dataQuality?: { quality?: string | null } | null };
        };
        if (!alive) return;
        const q = j.context?.dataQuality?.quality ?? null;
        if (q === "insufficient" || !j.classification?.label) { setUnavailable(true); return; }
        setUnavailable(false);
        setCtx({
          classificationLabel: j.classification.label ?? null,
          tradeLabel: j.tradeContext?.tradeLabel ?? null,
          trendAlignment: (j.tradeContext?.trendAlignment as MarketCtxBadge["trendAlignment"]) ?? null,
          primaryTimeframe: j.classification.primaryTimeframe ?? null,
          dataQuality: (q as MarketCtxBadge["dataQuality"]) ?? null,
        });
      } catch { /* honest: just don't show */ }
    }
    void load();
    const id = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, [card.id]);
  if (unavailable) {
    return (
      <div className="rounded border border-zinc-800 bg-zinc-900/30 px-2 py-1 text-[11px] text-zinc-500"
           data-testid={`market-ctx-${card.id}`}>
        Live market context unavailable for this symbol.
      </div>
    );
  }
  if (!ctx) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 text-[10px]" data-testid={`market-ctx-${card.id}`}>
      <Badge variant="outline" className="border-zinc-700">
        {ctx.primaryTimeframe ?? "TF?"} · {ctx.classificationLabel ?? "—"}
      </Badge>
      {ctx.tradeLabel && (
        <Badge variant={alignVariant(ctx.trendAlignment)} className="text-[10px]">
          {ctx.tradeLabel}
        </Badge>
      )}
      {ctx.dataQuality && ctx.dataQuality !== "good" && (
        <Badge variant="outline" className="border-amber-700/50 text-amber-300">
          data: {ctx.dataQuality}
        </Badge>
      )}
    </div>
  );
}

type DecisionResponse = {
  ok: boolean;
  decision?: {
    decisionLabel: string;
    decisionAction: string;
    confidenceScore: number | null;
    urgencyScore: number | null;
    riskScore: number | null;
    reasonSummary: string;
    suggestedButton: string;
    dataQuality: { marketContextQuality?: string; missing?: string[] };
  };
};

function decisionTone(label: string): { variant: "default" | "secondary" | "destructive" | "outline"; cls: string } {
  if (/invalidated/i.test(label)) return { variant: "destructive", cls: "border-rose-700/60" };
  if (/exit risk|review full close|invalidation near/i.test(label)) return { variant: "destructive", cls: "border-rose-700/40" };
  if (/protect profit|review partial close|move stop|trail stop|hold but monitor/i.test(label)) return { variant: "secondary", cls: "border-amber-700/50 text-amber-200" };
  if (/^hold$|healthy pullback|continuation still valid/i.test(label)) return { variant: "default", cls: "border-emerald-700/40 text-emerald-200" };
  if (/data insufficient/i.test(label)) return { variant: "outline", cls: "border-zinc-700 text-zinc-400" };
  return { variant: "outline", cls: "border-zinc-700" };
}

function urgencyBadgeColor(u: number | null): string {
  if (u == null) return "text-zinc-400";
  if (u >= 80) return "text-rose-300";
  if (u >= 60) return "text-amber-300";
  return "text-zinc-300";
}

function DecisionOverlay({ card, onReviewClose }: { card: OpenCard; onReviewClose: () => void }) {
  const [dec, setDec] = useState<DecisionResponse["decision"] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let alive = true;
    async function fetchDecision() {
      try {
        const r = await fetch(u(`/api/me/trades/${encodeURIComponent(card.id)}/decision`), { credentials: "include" });
        if (!r.ok) { if (alive) setUnavailable(true); return; }
        const body = (await r.json()) as DecisionResponse;
        if (!alive) return;
        setUnavailable(false);
        setDec(body.decision ?? null);
      } catch { /* honest: just don't show */ }
    }
    void fetchDecision();
    const id = setInterval(fetchDecision, 15_000);
    return () => { alive = false; clearInterval(id); };
  }, [card.id]);

  if (unavailable) return null;
  if (!dec) {
    return (
      <div className="rounded border border-zinc-800 bg-zinc-900/30 px-2 py-1 text-[11px] text-zinc-500"
           data-testid={`decision-loading-${card.id}`}>
        Loading decision…
      </div>
    );
  }
  const tone = decisionTone(dec.decisionLabel);
  const reviewIsClose = /^REVIEW_CLOSE$/i.test(dec.suggestedButton);
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-2 text-xs space-y-1.5"
         data-testid={`decision-overlay-${card.id}`}>
      <div className="flex items-center justify-between gap-2">
        <Badge variant={tone.variant} className={`text-[10px] ${tone.cls}`}>
          {dec.decisionLabel}
        </Badge>
        <span className="text-[10px] text-zinc-500">
          urg <span className={urgencyBadgeColor(dec.urgencyScore)}>{dec.urgencyScore ?? "—"}</span>
          {" · "}conf <span className="text-zinc-300">{dec.confidenceScore ?? "—"}</span>
        </span>
      </div>
      <p className="text-zinc-400 leading-snug">{dec.reasonSummary}</p>
      {reviewIsClose && (
        <Button
          size="sm" variant="destructive" className="h-7 w-full text-[11px]"
          onClick={onReviewClose}
          data-testid={`decision-review-close-${card.id}`}>
          Suggested: Review Close
        </Button>
      )}
    </div>
  );
}

function TradeIntelOverlay({ card }: { card: OpenCard }) {
  const [intel, setIntel] = useState<IntelResponse["snapshot"] | null>(null);
  useEffect(() => {
    let alive = true;
    async function fetchIntel() {
      try {
        const r = await fetch(u(`/api/me/trades/${card.id}/intelligence`), { credentials: "include" });
        if (!r.ok) return;
        const body = (await r.json()) as IntelResponse;
        if (alive) setIntel(body.snapshot ?? null);
      } catch { /* honesty: just don't show intel */ }
    }
    void fetchIntel();
    const id = setInterval(fetchIntel, 15_000);
    return () => { alive = false; clearInterval(id); };
  }, [card.id]);

  if (!intel) {
    return (
      <div className="rounded border border-zinc-800 bg-zinc-900/30 p-2 text-xs text-zinc-500">
        <Sparkles className="mr-1 inline h-3 w-3" /> Loading AI insight…
      </div>
    );
  }
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-2 text-xs space-y-1">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 text-zinc-300">
          <Sparkles className="h-3 w-3 text-violet-400" /> {intel.label ?? "—"}
        </span>
        <Badge variant={actionBadgeVariant(intel.recommendedAction)} className="text-[10px]">
          {intel.recommendedAction ?? "—"}
        </Badge>
      </div>
      <div className="flex items-center gap-3 text-zinc-400">
        <span>Urgency: <span className={urgencyColor(intel.closeUrgencyScore)}>
          {intel.closeUrgencyScore ?? "—"}
        </span></span>
        {intel.peakPnl != null && (
          <span>Peak: <span className="text-zinc-200">{intel.peakPnl.toFixed(2)}</span></span>
        )}
        {intel.profitGivebackPercent != null && (
          <span>Giveback: <span className="text-zinc-200">{intel.profitGivebackPercent}%</span></span>
        )}
      </div>
      {intel.explanation && (
        <p className="text-zinc-500 leading-snug">{intel.explanation}</p>
      )}
    </div>
  );
}

export function MyOpenTradesPanel() {
  const [data, setData] = useState<OpenResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [closing, setClosing] = useState<OpenCard | null>(null);

  async function load() {
    try {
      const r = await fetch(u("/api/me/trades/open"), { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as OpenResponse;
      setData(body);
      setErr(null);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-6 text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading open trades…
        </CardContent>
      </Card>
    );
  }

  if (err) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-6 text-rose-400">
          <AlertTriangle className="h-4 w-4" /> Could not load open trades: {err}
        </CardContent>
      </Card>
    );
  }

  const cards = data?.cards ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Badge variant="outline" className="border-zinc-700">
            {data?.routingMode === "SHARED_MASTER_MT5" ? "Shared master" : "Your broker"}
          </Badge>
          <Badge variant="outline" className="border-zinc-700 uppercase">
            {data?.accountType ?? "unknown"}
          </Badge>
          <Badge variant="outline" className="border-zinc-700">
            {data?.tradingMode ?? "—"}
          </Badge>
          {data?.bannerLabel && (
            <span className="text-xs text-zinc-500">{data.bannerLabel}</span>
          )}
        </div>
      </div>

      {cards.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-zinc-400">
            No open trades right now.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {cards.map((c) => (
            <Card key={c.id} className="border-zinc-800">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-base">
                  <span className="flex items-center gap-2">
                    {c.side === "BUY" ? (
                      <TrendingUp className="h-4 w-4 text-emerald-400" />
                    ) : (
                      <TrendingDown className="h-4 w-4 text-rose-400" />
                    )}
                    {c.symbol}
                    <Badge variant="outline" className="ml-1 text-xs">
                      {c.side} · {c.lotSize}
                    </Badge>
                  </span>
                  <Badge variant="outline" className="text-[10px] uppercase">
                    {c.routingMode === "SHARED_MASTER_MT5" ? "shared" : "user"}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="grid grid-cols-2 gap-2 text-zinc-400">
                  <div>Entry: <span className="text-zinc-200">{c.entryPrice ?? "—"}</span></div>
                  <div>Now: <span className="text-zinc-200">{c.currentPrice ?? "—"}</span></div>
                  <div>SL: <span className="text-zinc-200">{c.stopLoss ?? "—"}</span></div>
                  <div>TP: <span className="text-zinc-200">{c.takeProfit ?? "—"}</span></div>
                </div>
                {c.waitingForSync ? (
                  <div className="flex items-center gap-2 rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-300">
                    <Loader2 className="h-3 w-3 animate-spin" /> Confirmed at broker — awaiting first MT5 price sync; live P&L not yet available.
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className={`text-lg font-semibold ${
                      (c.unrealizedPnl ?? 0) > 0 ? "text-emerald-400"
                        : (c.unrealizedPnl ?? 0) < 0 ? "text-rose-400" : "text-zinc-300"
                    }`} data-testid={`pnl-${c.id}`}>
                      {(c.unrealizedPnl ?? 0) >= 0 ? "+" : ""}
                      {(c.unrealizedPnl ?? 0).toFixed(2)}
                    </span>
                    {c.pnlPercent !== null && (
                      <span className="text-xs text-zinc-400">({c.pnlPercent}%)</span>
                    )}
                    {c.pnlIsEstimate && (
                      <Badge variant="outline" className="text-[10px]">est.</Badge>
                    )}
                  </div>
                )}
                {c.brokerLabelMasked && (
                  <div className="text-xs text-zinc-500">via {c.brokerLabelMasked}</div>
                )}
                {!c.waitingForSync && <TradeMarketContextBadge card={c} />}
                <div className="text-[10px]">
                  <Link href="/action-center" className="text-primary hover:underline" data-testid={`open-action-center-${c.id}`}>
                    Open Trade Action Center →
                  </Link>
                </div>
                {!c.waitingForSync && <DecisionOverlay card={c} onReviewClose={() => setClosing(c)} />}
                {!c.waitingForSync && <TradeIntelOverlay card={c} />}
                <div className="grid grid-cols-3 gap-1">
                  <Link href={`/my-trades/${encodeURIComponent(c.id)}`}>
                    <Button variant="outline" size="sm" className="w-full"
                      data-testid={`ask-ai-${c.id}`}>
                      <Sparkles className="mr-1 h-3 w-3" /> Ask AI
                    </Button>
                  </Link>
                  <Link href={`/my-trades/${encodeURIComponent(c.id)}#alerts`}>
                    <Button variant="outline" size="sm" className="w-full"
                      data-testid={`set-alert-${c.id}`}>
                      <BellRing className="mr-1 h-3 w-3" /> Set Alert
                    </Button>
                  </Link>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="w-full"
                    onClick={() => setClosing(c)}
                    data-testid={`close-trade-${c.id}`}
                  >
                    <XIcon className="mr-1 h-3 w-3" /> Review Close
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {closing && (
        <ConfirmCloseModal
          card={closing}
          accountType={data?.accountType ?? "unknown"}
          tradingMode={data?.tradingMode ?? "SIMULATED"}
          onClose={() => setClosing(null)}
          onClosed={() => { setClosing(null); void load(); }}
        />
      )}
    </div>
  );
}
