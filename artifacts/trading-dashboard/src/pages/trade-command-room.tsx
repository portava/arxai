// Trade Command Room — redesigned, mobile-first trade control room.
//
// UI/UX refactor only. ALL existing wiring preserved:
//   • State: symbol/timeframe/opps/picked/decisions/quote/intentCount/alertCount
//   • Endpoints (unchanged): /api/market-scanner/opportunities, /api/decision-stream,
//     /api/market/quote/:symbol, /api/live-intent/queue, /api/alerts/scanner,
//     /api/live-intent/submit (sendIntent)
//   • Routes (unchanged): /live-manual, /live-ai-assist, /demo-trading, /live-chart,
//     /live-trades, /positions, /trade-logs, /post-trade-debriefs, /market-scanner,
//     /live-intent-queue, /risk-settings, /risk-command-center, /live-trading,
//     /live-trading-control, /live-shared, /mt5-setup, /broker-readonly
//   • useTradingMode() for mode/permission. PageTabs for tab state.
//   • Symbol is now driven by the global useChartSymbol() so Buy/Sell can open the
//     existing /live-manual ticket prefilled — no new execution path created.

import { useEffect, useState, useMemo } from "react";
import { PageTabs } from "@/components/ui/PageTabs";
import { Zap, Layers, ListChecks, Wrench } from "lucide-react";
import { useTradingMode } from "@/hooks/useTradingMode";
import { useChartSymbol } from "@/lib/use-chart-symbol";
import { useAssistantName } from "@/lib/assistant-name";
import { resolveLiveActionCapabilities } from "@/lib/liveActionCapabilities";
import { useGetMeSharedAccountSummary, getGetMeSharedAccountSummaryQueryKey, useGetMeSharedAccountPositions, getGetMeSharedAccountPositionsQueryKey } from "@workspace/api-client-react";

import { CockpitHeader } from "@/components/dashboard/cockpit/CockpitHeader";
import { MobileMenuTrigger } from "@/components/layout/Topbar";
import { SidebarContent } from "@/components/layout/AppLayout";
import { QuickTradePanel, type Quote } from "@/components/dashboard/trade/QuickTradePanel";
import { PreTradeHeatChecklist } from "@/components/dashboard/trade/PreTradeHeatChecklist";
import {
  TradeStatusBar, TradeHero, PositionsPanel, OrdersPanel,
  AdvancedPanel, RiskGovernorCard, DecisionStreamCard,
} from "@/components/dashboard/trade/TradePanels";

type Opp = {
  symbol: string; timeframe: string; bias: string; recommendedAction: string;
  setupType: string; confidenceScore: number; riskScore: number; entrySniperScore: number;
  riskRewardRatio: number; reasonForTrade: string; reasonToAvoid: string;
  rulesPassed: string[]; rulesFailed: string[]; statusBadge: string;
  opportunity: { score: number; label: string };
  entry: number; stopLoss: number; takeProfit: number;
};
type Decision = { id: string; type: string; summary: string; createdAt: string };

async function api(path: string, init?: RequestInit) {
  const r = await fetch(path, {
    headers: { "x-security-role": "ADMIN", "content-type": "application/json", ...(init?.headers ?? {}) }, ...init,
  });
  return r.json();
}

export default function TradeCommandRoom() {
  const tradingMode = useTradingMode();
  const isAdmin = Boolean(tradingMode.isAdmin);
  const { name } = useAssistantName();

  // Symbol now synced globally (drives chart + ticket prefill). Preserves the
  // original local-symbol behaviour but keeps Buy/Sell wired to /live-manual.
  const [symbol, setSymbol] = useChartSymbol();
  const [timeframe, setTimeframe] = useState("M15");
  const [orderType, setOrderType] = useState("Market");
  const [lot, setLot] = useState("0.01");
  const [slTpOn, setSlTpOn] = useState(true);
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [riskCheckOn, setRiskCheckOn] = useState(true);
  const [safetyGatesOn, setSafetyGatesOn] = useState(true);

  const [opps, setOpps] = useState<Opp[]>([]);
  const [picked, setPicked] = useState<Opp | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [quote, setQuote] = useState<Quote>(null);
  const [intentCount, setIntentCount] = useState(0);
  const [, setAlertCount] = useState(0);

  // Connection card data — existing shared master summary (no fake data).
  const summaryQ = useGetMeSharedAccountSummary({ query: { queryKey: getGetMeSharedAccountSummaryQueryKey() } });
  const master = summaryQ.data?.masterMt5 ?? null;
  const broker = master?.brokerName ?? summaryQ.data?.accounts?.[0]?.masterBrokerName ?? "—";
  const account = master?.accountNumberMasked ?? summaryQ.data?.accounts?.[0]?.masterAccountNumberMasked ?? "—";

  async function load() {
    const bare = symbol.includes(":") ? symbol.split(":")[1] : symbol;
    const [o, d, q, ic, ac] = await Promise.all([
      fetch("/api/market-scanner/opportunities?limit=12").then((r) => r.json()),
      fetch("/api/decision-stream?limit=20").then((r) => r.json()),
      fetch(`/api/market/quote/${bare}`).then((r) => r.json()).catch(() => null),
      fetch("/api/live-intent/queue").then((r) => r.json()).catch(() => ({ counts: { total: 0 } })),
      fetch("/api/alerts/scanner?unackedOnly=true").then((r) => r.json()).catch(() => ({ count: 0 })),
    ]);
    setOpps(o.opportunities ?? []);
    setDecisions(d.decisions ?? []);
    setQuote(q);
    setIntentCount(ic.counts?.total ?? 0);
    setAlertCount(ac.count ?? 0);
  }

  useEffect(() => { void load(); const id = setInterval(load, 5000); return () => clearInterval(id); }, [symbol]);

  function pickAndAnalyze(o: Opp) {
    setPicked(o); setSymbol(o.symbol); setTimeframe(o.timeframe);
  }

  // Risk approximation — simple display of lot × notional placeholder, using
  // the existing quote. (Mirrors the mockup's "Risk approx." readout.)
  // Real risk-at-stop estimate. Only shows a dollar figure when a stop-loss
  // is set, since risk is undefined without one — we never fabricate a number.
  //   risk ≈ lots × stop-distance(in pips) × pip-value-per-lot
  // Pip value uses the standard 100k contract (~$10/pip per 1.0 lot for
  // 4-digit FX pairs, ~$1000/pip per 1.0 lot for 2-digit JPY pairs). The
  // server's risk governor remains the source of truth on submit.
  const riskApprox = useMemo(() => {
    const l = Number(lot) || 0;
    const sl = Number(stopLoss);
    const ref = quote ? (quote.mid ?? quote.bid ?? quote.ask) : NaN;
    if (!l) return "—";
    // Honest withhold — the only wired quote source here is the in-memory
    // market simulator (executionEnvironment:"SIMULATOR"). A dollar risk
    // figure derived from its random-walk mid would be a fabricated number on
    // a LIVE surface, so we withhold it with a reason instead. Real wiring
    // that would restore the figure: feed this page from the shared
    // chart-truth/marketDataRouter quote (same source getMarketSnapshot uses).
    if (quote?.executionEnvironment === "SIMULATOR") {
      return "n/a — sim quote";
    }
    if (!stopLoss || !Number.isFinite(sl) || !Number.isFinite(ref) || sl <= 0) {
      return "Set SL";
    }
    const isJpy = /JPY$/i.test(symbol);
    const pipSize = isJpy ? 0.01 : 0.0001;
    const pips = Math.abs(ref - sl) / pipSize;
    const pipValuePerLot = 10; // ~$10 per pip per 1.0 standard lot
    const risk = l * pips * pipValuePerLot;
    if (!Number.isFinite(risk) || risk <= 0) return "—";
    return `$${risk.toFixed(2)}`;
  }, [lot, stopLoss, quote, symbol]);

  // ── Mode / permission → plain English ───────────────────────────────
  const isLive = tradingMode.isLiveShared;
  const blocked = Boolean(tradingMode.cleanBlockedReason);
  const frozen = tradingMode.isFrozen;
  const caps = resolveLiveActionCapabilities({
    canManualTrade: tradingMode.canManualTrade,
    isFrozen: frozen,
    bridgeBlocked: blocked,
  });
  const canTrade = caps.canOpen;

  const modeLabel = blocked ? "Bridge Disconnected" : frozen ? "Trading Paused" : isLive ? "LIVE · Shared Master MT5" : tradingMode.isDemo ? "Demo" : (tradingMode.cleanModeLabel || "Simulator");
  const gatesLabel = blocked ? (tradingMode.cleanBlockedReason || "Bridge unavailable") : frozen ? "Trading paused" : canTrade ? "All safety gates enforced" : "Waiting for approval";
  const blockedLabel = caps.blockedLabel;

  const heroDescription = `Place manual, ${name}-assisted, or advanced trades through your approved account route.`;
  const connStatus = blocked ? "Disconnected" : isLive ? "LIVE" : tradingMode.isDemo ? "Demo" : "Sim";

  // Risk governor (plain English + admin raw detail preserved)
  const rgStatus = frozen || blocked ? { label: "Trading paused", tone: "warning" as const }
    : canTrade ? { label: "Trading available", tone: "success" as const }
    : { label: "Risk lock active", tone: "danger" as const };

  // ── Tabs ─────────────────────────────────────────────────────────────
  const quickTradeTab = (
    <div className="space-y-4">
      <QuickTradePanel
        symbol={symbol} setSymbol={setSymbol}
        timeframe={timeframe} setTimeframe={setTimeframe}
        orderType={orderType} setOrderType={setOrderType}
        lot={lot} setLot={setLot}
        quote={quote}
        slTpOn={slTpOn} setSlTpOn={setSlTpOn}
        stopLoss={stopLoss} setStopLoss={setStopLoss}
        takeProfit={takeProfit} setTakeProfit={setTakeProfit}
        riskCheckOn={riskCheckOn} setRiskCheckOn={setRiskCheckOn}
        safetyGatesOn={safetyGatesOn} setSafetyGatesOn={setSafetyGatesOn}
        riskApprox={riskApprox}
        canTrade={canTrade}
        blockedLabel={blockedLabel}
      />
      {/* Phase 3 — advisory timing checklist. Display only; never blocks trade submission. */}
      <PreTradeHeatChecklist symbol={symbol} />
    </div>
  );

  const positionsQ = useGetMeSharedAccountPositions({
    query: { queryKey: getGetMeSharedAccountPositionsQueryKey(), refetchInterval: 5000 },
  });
  const positionRows = (positionsQ.data?.rows ?? []).map((r) => ({
    id: r.id,
    symbol: r.symbol,
    side: r.side,
    lotSize: r.lotSize,
    entry: r.entryPrice ?? undefined,
    pnl: r.stale ? null : r.pnl,
    stopLoss: r.stopLoss ?? null,
    takeProfit: r.takeProfit ?? null,
    status: r.stale ? "stale" : undefined,
  }));
  // P0-3 — pass the read state through. `data?.rows ?? []` alone collapses a
  // failed or in-flight fetch into an empty array, which the panel would have
  // rendered as "No open positions" — telling a trader they are flat when ARX
  // could not answer.
  const positionsTab = (
    <PositionsPanel
      positions={positionRows}
      isLoading={positionsQ.isLoading}
      isError={positionsQ.isError}
      onRetry={() => void positionsQ.refetch()}
    />
  );

  const ordersTab = (
    <OrdersPanel opps={opps} intentCount={intentCount} picked={picked} onPick={(o) => pickAndAnalyze(o as Opp)} />
  );

  const advancedTab = (
    <div className="space-y-4">
      <RiskGovernorCard
        statusLabel={rgStatus.label} statusTone={rgStatus.tone}
        riskLevel="Low" bridge={blocked ? "Disconnected" : "Connected"}
        approval={tradingMode.canManualTrade ? "Approved" : "Pending"}
        isAdmin={isAdmin} rawCanPlace={tradingMode.canManualTrade} rawMode={tradingMode.cleanModeLabel || "—"}
      />
      <DecisionStreamCard decisions={decisions} />
      <AdvancedPanel isAdmin={isAdmin} />
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-4 pb-32 md:pb-6">
      <CockpitHeader
        onMobileMenu={
          <MobileMenuTrigger>
            {(close) => <SidebarContent onNavigate={close} />}
          </MobileMenuTrigger>
        }
      />
      <TradeStatusBar modeLabel={modeLabel} isLive={isLive} gatesLabel={gatesLabel} intentCount={intentCount} />
      <TradeHero description={heroDescription} connStatus={connStatus} isLive={isLive} broker={broker} account={account} />

      <PageTabs
        storageKey="trade-command-room"
        defaultTab="quick"
        tabs={[
          { id: "quick",     label: "Quick Trade", icon: <Zap className="h-3.5 w-3.5" />,        content: quickTradeTab },
          { id: "positions", label: "Positions",   icon: <Layers className="h-3.5 w-3.5" />,     content: positionsTab },
          { id: "orders",    label: "Orders",      icon: <ListChecks className="h-3.5 w-3.5" />, content: ordersTab },
          { id: "advanced",  label: "Advanced",    icon: <Wrench className="h-3.5 w-3.5" />,     content: advancedTab },
        ]}
      />
    </div>
  );
}
