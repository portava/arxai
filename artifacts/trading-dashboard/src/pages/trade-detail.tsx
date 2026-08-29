import { useEffect, useState } from "react";
import { useRoute, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, AlertTriangle, Loader2, Sparkles, X as XIcon, BellRing, Shield, Scissors, Eye, Clock, FileCheck, Activity, Target } from "lucide-react";
import { ConfirmCloseModal } from "@/components/trading/ConfirmCloseModal";
import type { OpenCard } from "@/components/trading/MyOpenTradesPanel";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const u = (p: string) => `${BASE}${p}`;

type IntelResponse = {
  ok: boolean;
  trade?: {
    tradeKey: string;
    routingMode: "USER_OWNED_MT5" | "SHARED_MASTER_MT5";
    symbol: string;
    side: "BUY" | "SELL";
    lotSize: number;
    entryPrice: number | null;
    currentPrice: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
    unrealizedPnl: number | null;
    pnlIsEstimate: boolean;
    brokerLabelMasked: string | null;
  };
  snapshot?: {
    label: string | null;
    recommendedAction: string | null;
    explanation: string | null;
    closeUrgencyScore: number | null;
    continuationScore: number | null;
    pullbackScore: number | null;
    reversalRiskScore: number | null;
    fakeoutRiskScore: number | null;
    profitProtectionScore: number | null;
    holdConfidenceScore: number | null;
    trendStrengthScore: number | null;
    volatilityRiskScore: number | null;
    peakPnl: number | null;
    profitGivebackPercent: number | null;
    pnlPips: number | null;
    mfe: number | null;
    mae: number | null;
    dataQuality: { missing?: string[] } | null;
  };
};

type Alert = {
  id: number;
  tradeKey: string;
  alertType: string;
  severity: "info" | "watch" | "warning" | "urgent";
  title: string;
  message: string;
  recommendedAction: string | null;
  acknowledgedAt: string | null;
  createdAt: string;
};

type TimelineEvent = {
  id: number;
  eventType: string;
  severity: string;
  title: string;
  message: string;
  source: string;
  createdAt: string;
};

type ExitPlan = {
  protectProfitLevel: number | null;
  invalidationLevel: number | null;
  continuationLevel: number | null;
  conservativeExitLevel: number | null;
  aggressiveExitLevel: number | null;
  partialCloseLevel: number | null;
  trailStopLevel: number | null;
  tradeEfficiencyScore: number | null;
  closeUrgencyScore: number | null;
  efficiencyLabel: string | null;
  timeWarning: string | null;
  recommendedAction: string | null;
  explanation: string | null;
  invalidationTrigger: string | null;
  continuationTrigger: string | null;
  ageMinutes: number | null;
  dataQuality: { canDeriveLevels?: boolean; canScoreEfficiency?: boolean; missing?: string[] } | null;
};

type ExitReview = {
  id: number;
  closeMethod: string;
  closeMethodNote: string | null;
  peakUnrealizedPnl: number | null;
  finalRealizedPnl: number | null;
  profitGivebackPercent: number | null;
  aiAlertsFiredCount: number | null;
  aiAlertsActedCount: number | null;
  labels: string[] | null;
  status: string;
  createdAt: string;
};

type TradeDecisionResponse = {
  ok: boolean;
  decision?: {
    decisionLabel: string;
    decisionAction: string;
    confidenceScore: number | null;
    urgencyScore: number | null;
    riskScore: number | null;
    reasonSummary: string;
    mainReason: string;
    supportingReasons: string[];
    invalidationLevel: number | null;
    protectProfitLevel: number | null;
    continuationLevel: number | null;
    suggestedButton: string;
    requiresConfirmation: boolean;
    whatWouldChange: string[];
    dataQuality: {
      hasIntelligence: boolean;
      hasExitPlan: boolean;
      hasMarketContext: boolean;
      marketContextQuality: string;
      freshnessMinutes: number | null;
      missing: string[];
    };
  };
};

type MarketContextResponse = {
  ok: boolean;
  classification?: {
    label: string | null;
    scores?: Record<string, number | null>;
    explanation?: string | null;
    primaryTimeframe?: string | null;
    htfTimeframe?: string | null;
  };
  tradeContext?: {
    trendAlignment?: "ALIGNED" | "FIGHTING" | "NEUTRAL" | "UNKNOWN" | null;
    tradeLabel?: string | null;
    bullishScenario?: string | null;
    bearishScenario?: string | null;
    exitHoldReview?: string | null;
    rationale?: string[];
  };
  keyLevels?: {
    invalidationLevel: number | null; continuationLevel: number | null;
    nearestSupport: number | null; nearestResistance: number | null;
    swingHigh: number | null; swingLow: number | null;
    breakoutLevel: number | null; keyLevelToWatch: number | null;
    available?: boolean; reason?: string;
  };
  context?: {
    source?: string; asOf?: string | null; freshness?: string;
    session?: string; currentPrice?: number | null; spread?: number | null;
    dataQuality?: { quality?: "good" | "partial" | "insufficient"; missing?: string[] } | null;
    timeframes?: Record<string, {
      timeframe: string; available: boolean; trendDirection: string;
      trendStrengthScore: number | null; atr: number | null;
      swingHigh: number | null; swingLow: number | null;
    }>;
  };
};

const severityColor: Record<string, string> = {
  info: "border-border text-txt-secondary",
  watch: "border-blue-700 text-blue-300",
  warning: "border-warning/40 text-warning",
  urgent: "border-danger/40 text-danger",
};

export default function TradeDetailPage() {
  const [, params] = useRoute("/my-trades/:tradeKey");
  const tradeKey = params?.tradeKey ?? "";
  const [intel, setIntel] = useState<IntelResponse | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [exitReview, setExitReview] = useState<ExitReview | null>(null);
  const [exitPlan, setExitPlan] = useState<ExitPlan | null>(null);
  const [marketCtx, setMarketCtx] = useState<MarketContextResponse | null>(null);
  const [decision, setDecision] = useState<TradeDecisionResponse | null>(null);
  const [recalcingDec, setRecalcingDec] = useState(false);
  const [decisionMsg, setDecisionMsg] = useState<string | null>(null);
  const [recalcingCtx, setRecalcingCtx] = useState(false);
  const [recalcMsg, setRecalcMsg] = useState<string | null>(null);
  const [planActionMsg, setPlanActionMsg] = useState<string | null>(null);
  const [planModal, setPlanModal] = useState<null | { kind: "move_stop" | "partial_close" | "recalc"; title: string; body: string }>(null);
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [closing, setClosing] = useState<OpenCard | null>(null);
  const [accountType, setAccountType] = useState<"demo" | "live" | "unknown">("unknown");
  const [tradingMode, setTradingMode] = useState<"DISABLED" | "DEMO" | "LIVE" | "SIMULATED">("SIMULATED");
  const [confirm, setConfirm] = useState<{ kind: string; title: string; body: string } | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  async function load() {
    try {
      const [i, a, m, tl, rv, ep, mc, dec] = await Promise.all([
        fetch(u(`/api/me/trades/${encodeURIComponent(tradeKey)}/intelligence`), { credentials: "include" }),
        fetch(u(`/api/me/trade-alerts?limit=20`), { credentials: "include" }),
        fetch(u(`/api/me/trades/open`), { credentials: "include" }),
        fetch(u(`/api/me/trades/${encodeURIComponent(tradeKey)}/timeline`), { credentials: "include" }),
        fetch(u(`/api/me/trades/${encodeURIComponent(tradeKey)}/exit-review`), { credentials: "include" }),
        fetch(u(`/api/me/trades/${encodeURIComponent(tradeKey)}/exit-plan`), { credentials: "include" }),
        fetch(u(`/api/me/trades/${encodeURIComponent(tradeKey)}/market-context`), { credentials: "include" }),
        fetch(u(`/api/me/trades/${encodeURIComponent(tradeKey)}/decision`), { credentials: "include" }),
      ]);
      if (dec.ok) {
        const db = (await dec.json()) as TradeDecisionResponse;
        setDecision(db);
      } else { setDecision(null); }
      if (mc.ok) {
        const mcb = (await mc.json()) as MarketContextResponse;
        setMarketCtx(mcb);
      } else {
        setMarketCtx(null);
      }
      if (ep.ok) {
        const epb = (await ep.json()) as { plan: ExitPlan | null };
        setExitPlan(epb.plan);
      }
      if (!i.ok) throw new Error(`Intelligence HTTP ${i.status}`);
      const intelBody = (await i.json()) as IntelResponse;
      setIntel(intelBody);
      if (a.ok) {
        const ab = (await a.json()) as { alerts: Alert[] };
        setAlerts((ab.alerts ?? []).filter((x) => x.tradeKey === tradeKey));
      }
      if (m.ok) {
        const mb = (await m.json()) as { accountType: typeof accountType; tradingMode: typeof tradingMode; cards?: Array<{ id: string; openedAt: string | null }> };
        setAccountType(mb.accountType);
        setTradingMode(mb.tradingMode);
        const myCard = (mb.cards ?? []).find((c) => c.id === tradeKey);
        setOpenedAt(myCard?.openedAt ?? null);
      }
      if (tl.ok) {
        const tlb = (await tl.json()) as { timeline: TimelineEvent[] };
        setTimeline(tlb.timeline ?? []);
      }
      if (rv.ok) {
        const rvb = (await rv.json()) as { review: ExitReview | null };
        setExitReview(rvb.review);
      }
      setErr(null);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }

  async function recordEvent(eventType: string, message: string) {
    try {
      const r = await fetch(u(`/api/me/trades/${encodeURIComponent(tradeKey)}/timeline`), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventType, message }),
      });
      if (r.ok) {
        setActionMsg("Recorded to timeline.");
        void load();
      } else {
        setActionMsg(`Failed (HTTP ${r.status}).`);
      }
    } catch (e) {
      setActionMsg(`Failed: ${String((e as Error).message ?? e)}`);
    }
    setTimeout(() => setActionMsg(null), 3000);
  }

  function ageStr(iso: string | null): string {
    if (!iso) return "—";
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
    return `${Math.floor(ms / 86_400_000)}d`;
  }

  function dataQualityScore(missing: string[]): { score: number; label: string; color: string } {
    const total = 4; // candles, M15/H1/H4, volume
    const have = Math.max(0, total - missing.length);
    const pct = Math.round((have / total) * 100);
    if (pct >= 75) return { score: pct, label: "Good", color: "text-success" };
    if (pct >= 40) return { score: pct, label: "Limited", color: "text-warning" };
    return { score: pct, label: "Insufficient", color: "text-danger" };
  }

  useEffect(() => {
    if (!tradeKey) return;
    void load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tradeKey]);

  if (loading) {
    return (
      <div className="p-6 text-txt-secondary flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading trade…
      </div>
    );
  }

  if (err || !intel?.ok || !intel.trade) {
    return (
      <div className="p-6 space-y-2">
        <Link href="/my-trades"><Button variant="ghost" size="sm"><ArrowLeft className="mr-1 h-3 w-3" /> Back</Button></Link>
        <Card>
          <CardContent className="flex items-center gap-2 p-6 text-danger">
            <AlertTriangle className="h-4 w-4" /> {err ?? "Trade not found."}
          </CardContent>
        </Card>
      </div>
    );
  }

  const t = intel.trade;
  const s = intel.snapshot;
  const card: OpenCard = {
    id: t.tradeKey,
    source: t.routingMode === "SHARED_MASTER_MT5" ? "shared_master_attribution" : "user_owned_mt5",
    routingMode: t.routingMode,
    accountType,
    symbol: t.symbol, side: t.side, lotSize: t.lotSize,
    entryPrice: t.entryPrice, currentPrice: t.currentPrice,
    stopLoss: t.stopLoss, takeProfit: t.takeProfit,
    unrealizedPnl: t.unrealizedPnl, pnlIsEstimate: t.pnlIsEstimate,
    pnlPercent: null, status: "OPEN", openedAt: null,
    brokerLabelMasked: t.brokerLabelMasked, waitingForSync: false,
  };

  const tradeAlerts = alerts.filter((a) => a.tradeKey === tradeKey);
  const missing = s?.dataQuality?.missing ?? [];
  const dq = dataQualityScore(missing);
  const age = ageStr(openedAt);

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <Link href="/my-trades">
          <Button variant="ghost" size="sm"><ArrowLeft className="mr-1 h-3 w-3" /> Back to trades</Button>
        </Link>
        <Button variant="destructive" size="sm" onClick={() => setClosing(card)} data-testid="review-close-button">
          <XIcon className="mr-1 h-3 w-3" /> Review Close
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {t.symbol} <Badge variant="outline">{t.side} · {t.lotSize}</Badge>
            <Badge variant="outline" className="text-[10px] uppercase">{t.routingMode}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-2 text-sm text-txt-secondary md:grid-cols-4">
          <div>Entry: <span className="text-foreground">{t.entryPrice ?? "—"}</span></div>
          <div>Now: <span className="text-foreground">{t.currentPrice ?? "—"}</span></div>
          <div>SL: <span className="text-foreground">{t.stopLoss ?? "—"}</span></div>
          <div>TP: <span className="text-foreground">{t.takeProfit ?? "—"}</span></div>
          <div>P&L: <span className={`${(t.unrealizedPnl ?? 0) > 0 ? "text-success"
            : (t.unrealizedPnl ?? 0) < 0 ? "text-danger" : "text-foreground"}`}>
            {t.unrealizedPnl?.toFixed(2) ?? "—"}
          </span>{t.pnlIsEstimate && <Badge variant="outline" className="ml-1 text-[10px]">est.</Badge>}</div>
          <div>Pips: <span className="text-foreground">{s?.pnlPips ?? "—"}</span></div>
          <div>Peak: <span className="text-foreground">{s?.peakPnl?.toFixed?.(2) ?? "—"}</span></div>
          <div>Giveback: <span className="text-foreground">{s?.profitGivebackPercent ?? "—"}%</span></div>
          <div className="flex items-center gap-1">Age: <Clock className="h-3 w-3 text-txt-muted" /><span className="text-foreground">{age}</span></div>
          <div>Data quality: <span className={dq.color}>{dq.score}% ({dq.label})</span></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Actions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" data-testid="action-set-alert"
            onClick={() => setConfirm({ kind: "set_alert", title: "Set custom alert?",
              body: "Record a 'watch this trade' marker on the timeline. The Sniper Exit engine still runs your global thresholds; this is your own note." })}>
            <BellRing className="mr-1 h-3 w-3" /> Set Alert
          </Button>
          <Button size="sm" variant="outline" data-testid="action-move-stop"
            onClick={() => setConfirm({ kind: "stop_review_opened", title: "Move stop review?",
              body: "Stop-loss adjustments must be done in MT5 (or your bridge). This records that you reviewed your stop placement so the AI can debrief later." })}>
            <Shield className="mr-1 h-3 w-3" /> Move Stop Review
          </Button>
          <Button size="sm" variant="outline" data-testid="action-partial-close"
            onClick={() => setConfirm({ kind: "partial_close_review_opened", title: "Partial close review?",
              body: "Partial closes must execute in MT5. This records a partial-close review on the timeline. ARX cannot place orders." })}>
            <Scissors className="mr-1 h-3 w-3" /> Partial Close Review
          </Button>
          <Button size="sm" variant="outline" data-testid="action-hold-monitor"
            onClick={() => setConfirm({ kind: "hold_decided", title: "Hold and monitor?",
              body: "Records 'user decided to hold' on the timeline. AI will keep watching and alert per your preferences." })}>
            <Eye className="mr-1 h-3 w-3" /> Hold and Monitor
          </Button>
          {actionMsg && <span className="ml-2 text-xs text-txt-secondary">{actionMsg}</span>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-premium" /> AI analysis
            {s?.recommendedAction && (
              <Badge variant={s.recommendedAction.startsWith("CLOSE") ? "destructive" : "secondary"}>
                {s.recommendedAction}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="text-foreground">{s?.label ?? "—"}</div>
          <p className="text-txt-secondary leading-snug">{s?.explanation ?? "—"}</p>
          {missing.length > 0 && (
            <div className="rounded border border-warning/40 bg-warning/5 p-2 text-xs text-warning">
              I don't have: {missing.join(", ")}. Some scores may be limited.
            </div>
          )}
          <div className="grid grid-cols-2 gap-2 text-xs text-txt-secondary md:grid-cols-4">
            {[
              ["Continuation", s?.continuationScore],
              ["Pullback", s?.pullbackScore],
              ["Reversal risk", s?.reversalRiskScore],
              ["Fakeout risk", s?.fakeoutRiskScore],
              ["Profit protection", s?.profitProtectionScore],
              ["Close urgency", s?.closeUrgencyScore],
              ["Hold confidence", s?.holdConfidenceScore],
              ["Trend strength", s?.trendStrengthScore],
              ["Volatility risk", s?.volatilityRiskScore],
              ["MFE", s?.mfe?.toFixed?.(4)],
              ["MAE", s?.mae?.toFixed?.(4)],
            ].map(([k, v]) => (
              <div key={k as string} className="rounded border border-border px-2 py-1">
                <div className="text-[10px] uppercase">{k}</div>
                <div className="text-foreground">{v ?? "—"}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card data-testid="ai-exit-plan-section">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4 text-success" /> AI Exit Plan
            {exitPlan?.tradeEfficiencyScore != null && (
              <Badge variant={exitPlan.tradeEfficiencyScore >= 65 ? "secondary" : exitPlan.tradeEfficiencyScore >= 35 ? "outline" : "destructive"}>
                Efficiency {exitPlan.tradeEfficiencyScore}/100
              </Badge>
            )}
            {exitPlan?.efficiencyLabel && (
              <Badge variant="outline" className="text-[10px]">{exitPlan.efficiencyLabel}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {!exitPlan ? (
            <div className="text-txt-muted">Exit plan not available yet.</div>
          ) : (
            <>
              <p className="text-txt-secondary leading-snug">{exitPlan.explanation ?? "—"}</p>
              {exitPlan.timeWarning && (
                <div className="rounded border border-warning/40 bg-warning/5 p-2 text-xs text-warning">
                  <Clock className="mr-1 inline h-3 w-3" /> {exitPlan.timeWarning}
                </div>
              )}
              {exitPlan.dataQuality?.canDeriveLevels === false && (
                <div className="rounded border border-warning/40 bg-warning/5 p-2 text-xs text-warning">
                  Some levels require entry, stop, and take-profit — partial plan only.
                </div>
              )}
              <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
                {[
                  ["Protect profit", exitPlan.protectProfitLevel],
                  ["Invalidation", exitPlan.invalidationLevel],
                  ["Continuation", exitPlan.continuationLevel],
                  ["Conservative exit", exitPlan.conservativeExitLevel],
                  ["Aggressive exit", exitPlan.aggressiveExitLevel],
                  ["Partial close", exitPlan.partialCloseLevel],
                  ["Trail stop", exitPlan.trailStopLevel],
                  ["Close urgency", exitPlan.closeUrgencyScore],
                ].map(([k, v]) => (
                  <div key={k as string} className="rounded border border-border px-2 py-1">
                    <div className="text-[10px] uppercase text-txt-muted">{k}</div>
                    <div className="text-foreground">{v == null ? "—" : v}</div>
                  </div>
                ))}
              </div>
              <div className="rounded border border-border p-2 text-xs text-txt-secondary">
                <div><span className="text-danger">Invalidation:</span> {exitPlan.invalidationTrigger ?? "—"}</div>
                <div className="mt-1"><span className="text-success">Continuation:</span> {exitPlan.continuationTrigger ?? "—"}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" data-testid="exit-plan-recalc"
                  onClick={() => setPlanModal({ kind: "recalc", title: "Recalculate exit plan?",
                    body: "Forces a fresh recompute using the latest price + your preferences. Decision support only — no orders are placed." })}>
                  Recalculate
                </Button>
                <Button size="sm" variant="outline" data-testid="exit-plan-review-move-stop"
                  onClick={() => setPlanModal({ kind: "move_stop", title: "Review move-stop suggestion?",
                    body: "Preview only. ARX never moves broker stops — you must apply the change yourself in MT5 or your broker." })}>
                  <Shield className="mr-1 h-3 w-3" /> Review Move Stop
                </Button>
                <Button size="sm" variant="outline" data-testid="exit-plan-review-partial-close"
                  onClick={() => setPlanModal({ kind: "partial_close", title: "Review partial close?",
                    body: "Preview only — ARX cannot place orders. You must execute the partial close yourself in MT5 or your broker." })}>
                  <Scissors className="mr-1 h-3 w-3" /> Review Partial Close
                </Button>
                {planActionMsg && <span className="ml-2 text-xs text-txt-secondary">{planActionMsg}</span>}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card data-testid="trade-decision-section">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Target className="h-4 w-4 text-premium" /> Trade Decision
            {decision?.decision?.decisionLabel && (
              <Badge
                variant={
                  /invalidated|exit risk|review full close|invalidation near/i.test(decision.decision.decisionLabel)
                    ? "destructive"
                    : /protect profit|review partial close|move stop|trail stop|hold but monitor/i.test(decision.decision.decisionLabel)
                    ? "secondary"
                    : /data insufficient/i.test(decision.decision.decisionLabel)
                    ? "outline"
                    : "default"
                }
                className="text-[10px]"
                data-testid="decision-label">
                {decision.decision.decisionLabel}
              </Badge>
            )}
            {decision?.decision?.dataQuality?.marketContextQuality && decision.decision.dataQuality.marketContextQuality !== "good" && (
              <Badge variant="outline" className="border-warning/50 text-warning text-[10px]">
                data: {decision.decision.dataQuality.marketContextQuality}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {!decision?.ok || !decision.decision ? (
            <div className="text-txt-muted">Decision unavailable right now.</div>
          ) : (
            <>
              <p className="text-txt-secondary" data-testid="decision-summary">{decision.decision.reasonSummary}</p>
              <p className="text-txt-secondary text-xs"><span className="text-txt-secondary font-medium">Why:</span> {decision.decision.mainReason}</p>

              <div className="grid grid-cols-3 gap-2 text-xs">
                {[
                  ["Confidence", decision.decision.confidenceScore],
                  ["Urgency", decision.decision.urgencyScore],
                  ["Risk", decision.decision.riskScore],
                ].map(([k, v]) => (
                  <div key={k as string} className="rounded border border-border px-2 py-1 text-center">
                    <div className="text-[10px] uppercase text-txt-muted">{k}</div>
                    <div className="text-foreground" data-testid={`decision-score-${(k as string).toLowerCase()}`}>{v == null ? "—" : v}</div>
                  </div>
                ))}
              </div>

              {decision.decision.supportingReasons.length > 0 && (
                <div className="rounded border border-border p-2 text-xs">
                  <div className="font-medium text-foreground mb-1">Supporting evidence</div>
                  <ul className="list-disc pl-4 space-y-1 text-txt-secondary">
                    {decision.decision.supportingReasons.slice(0, 5).map((r, idx) => (
                      <li key={idx}>{r}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="grid grid-cols-3 gap-2 text-xs">
                {[
                  ["Invalidation", decision.decision.invalidationLevel],
                  ["Protect profit", decision.decision.protectProfitLevel],
                  ["Continuation", decision.decision.continuationLevel],
                ].map(([k, v]) => (
                  <div key={k as string} className="rounded border border-border px-2 py-1">
                    <div className="text-[10px] uppercase text-txt-muted">{k}</div>
                    <div className="text-foreground">{v == null ? "—" : v}</div>
                  </div>
                ))}
              </div>

              {decision.decision.whatWouldChange.length > 0 && (
                <div className="rounded border border-border p-2 text-xs">
                  <div className="font-medium text-foreground mb-1">What would change this decision</div>
                  <ul className="list-disc pl-4 space-y-1 text-txt-secondary" data-testid="decision-what-would-change">
                    {decision.decision.whatWouldChange.map((r, idx) => (
                      <li key={idx}>{r}</li>
                    ))}
                  </ul>
                </div>
              )}

              {decision.decision.dataQuality.missing.length > 0 && (
                <div className="rounded border border-warning/40 bg-warning/5 p-2 text-xs text-warning">
                  Missing inputs: {decision.decision.dataQuality.missing.slice(0, 6).join(", ")}.
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button size="sm" variant="outline" data-testid="decision-recalc"
                  disabled={recalcingDec}
                  onClick={async () => {
                    setRecalcingDec(true); setDecisionMsg(null);
                    try {
                      const r = await fetch(u(`/api/me/trades/${encodeURIComponent(tradeKey)}/decision/recalculate`),
                        { method: "POST", credentials: "include" });
                      if (r.ok) { setDecisionMsg("Decision refreshed."); void load(); }
                      else setDecisionMsg(`Failed (HTTP ${r.status}).`);
                    } catch (e) { setDecisionMsg(`Failed: ${String((e as Error).message ?? e)}`); }
                    finally { setRecalcingDec(false); setTimeout(() => setDecisionMsg(null), 3000); }
                  }}>
                  {recalcingDec ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Activity className="mr-1 h-3 w-3" />} Recalculate
                </Button>
                {decision.decision.suggestedButton === "REVIEW_PARTIAL_CLOSE" && (
                  <Button size="sm" variant="outline" data-testid="decision-review-partial"
                    onClick={() => setPlanModal({ kind: "partial_close",
                      title: "Review partial close?",
                      body: "Preview only — ARX cannot place orders. You must execute the partial close yourself in MT5 or your broker." })}>
                    <Scissors className="mr-1 h-3 w-3" /> Review Partial Close
                  </Button>
                )}
                {(decision.decision.suggestedButton === "REVIEW_MOVE_STOP" || decision.decision.suggestedButton === "REVIEW_TRAIL_STOP") && (
                  <Button size="sm" variant="outline" data-testid="decision-review-move-stop"
                    onClick={() => setPlanModal({ kind: "move_stop",
                      title: "Review move-stop suggestion?",
                      body: "Preview only. ARX never moves broker stops — you must apply the change yourself in MT5 or your broker." })}>
                    <Shield className="mr-1 h-3 w-3" /> Review Stop
                  </Button>
                )}
                {decision.decision.suggestedButton === "SET_ALERT" && (
                  <Button size="sm" variant="outline" data-testid="decision-set-alert"
                    onClick={() => setConfirm({ kind: "set_alert",
                      title: "Review setting an alert?",
                      body: "ARX will scroll you to the alerts section for this trade. No alert is created until you explicitly configure and save it there. Decision support only — not guaranteed." })}>
                    <BellRing className="mr-1 h-3 w-3" /> Review Alert
                  </Button>
                )}
                {(decision.decision.suggestedButton === "REVIEW_CLOSE"
                  || decision.decision.suggestedButton === "REVIEW_PARTIAL_CLOSE"
                  || decision.decision.suggestedButton === "REVIEW_MOVE_STOP"
                  || decision.decision.suggestedButton === "REVIEW_TRAIL_STOP") && (
                  <Button size="sm" variant="default" data-testid="decision-send-to-action-center"
                    onClick={async () => {
                      setDecisionMsg(null);
                      try {
                        const r = await fetch(`/api/me/trade-actions/from-decision/${encodeURIComponent(tradeKey)}`, { method: "POST", credentials: "include" });
                        const data = await r.json().catch(() => ({}));
                        if (r.ok && data.ok) {
                          setDecisionMsg(`Draft #${data.action.id} created — review in Action Center.`);
                        } else {
                          setDecisionMsg(`Could not draft: ${data.error ?? r.status}`);
                        }
                      } catch (e) { setDecisionMsg(`Failed: ${String((e as Error).message ?? e)}`); }
                      finally { setTimeout(() => setDecisionMsg(null), 5000); }
                    }}>
                    <Shield className="mr-1 h-3 w-3" /> Send to Action Center
                  </Button>
                )}
                <span className="text-[10px] text-txt-muted">Decision support only — every action requires your explicit confirmation. Based on available data; not guaranteed.</span>
                {decisionMsg && <span className="text-xs text-txt-secondary">{decisionMsg}</span>}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card data-testid="market-context-section">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4 text-sky-400" /> Market Context
            {marketCtx?.classification?.label && (
              <Badge variant="outline" className="text-[10px]">{marketCtx.classification.label}</Badge>
            )}
            {marketCtx?.tradeContext?.trendAlignment && (
              <Badge
                variant={marketCtx.tradeContext.trendAlignment === "ALIGNED" ? "default"
                  : marketCtx.tradeContext.trendAlignment === "FIGHTING" ? "destructive"
                  : "secondary"}
                className="text-[10px] uppercase">
                {marketCtx.tradeContext.trendAlignment}
              </Badge>
            )}
            {marketCtx?.context?.dataQuality?.quality && marketCtx.context.dataQuality.quality !== "good" && (
              <Badge variant="outline" className="border-warning/50 text-warning text-[10px]">
                data: {marketCtx.context.dataQuality.quality}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {!marketCtx?.ok ? (
            <div className="text-txt-muted">Live market context is not available right now.</div>
          ) : marketCtx.context?.dataQuality?.quality === "insufficient" ? (
            <div className="rounded border border-warning/40 bg-warning/5 p-2 text-xs text-warning">
              Live candle data is not connected for this symbol — no price-action read is possible. Configure a market data provider with candle support to enable this section.
            </div>
          ) : (
            <>
              <p className="text-txt-secondary leading-snug">{marketCtx.classification?.explanation ?? "—"}</p>

              <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
                {[
                  ["Primary TF", marketCtx.classification?.primaryTimeframe ?? "—"],
                  ["HTF", marketCtx.classification?.htfTimeframe ?? "—"],
                  ["Trade label", marketCtx.tradeContext?.tradeLabel ?? "—"],
                  ["Source", marketCtx.context?.source ?? "—"],
                ].map(([k, v]) => (
                  <div key={k as string} className="rounded border border-border px-2 py-1">
                    <div className="text-[10px] uppercase text-txt-muted">{k}</div>
                    <div className="text-foreground">{v ?? "—"}</div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
                {[
                  ["Invalidation", marketCtx.keyLevels?.invalidationLevel],
                  ["Continuation", marketCtx.keyLevels?.continuationLevel],
                  ["Nearest support", marketCtx.keyLevels?.nearestSupport],
                  ["Nearest resistance", marketCtx.keyLevels?.nearestResistance],
                  ["Swing high", marketCtx.keyLevels?.swingHigh],
                  ["Swing low", marketCtx.keyLevels?.swingLow],
                  ["Breakout level", marketCtx.keyLevels?.breakoutLevel],
                  ["Key level to watch", marketCtx.keyLevels?.keyLevelToWatch],
                ].map(([k, v]) => (
                  <div key={k as string} className="rounded border border-border px-2 py-1">
                    <div className="text-[10px] uppercase text-txt-muted">{k}</div>
                    <div className="text-foreground">{v == null ? "—" : v}</div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-3">
                {[
                  ["Fakeout risk", marketCtx.classification?.scores?.fakeoutRiskScore],
                  ["Reversal risk", marketCtx.classification?.scores?.reversalRiskScore],
                  ["Liquidity sweep", marketCtx.classification?.scores?.liquiditySweepScore],
                  ["Chop risk", marketCtx.classification?.scores?.chopRiskScore],
                  ["Breakout strength", marketCtx.classification?.scores?.breakoutStrengthScore],
                  ["Trend strength", marketCtx.classification?.scores?.trendStrengthScore],
                ].map(([k, v]) => (
                  <div key={k as string} className="rounded border border-border px-2 py-1">
                    <div className="text-[10px] uppercase text-txt-muted">{k}</div>
                    <div className="text-foreground">{v == null ? "—" : v}</div>
                  </div>
                ))}
              </div>

              {marketCtx.context?.timeframes && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-txt-muted">
                      <tr><th className="text-left">TF</th><th className="text-left">Trend</th><th className="text-left">Strength</th><th className="text-left">ATR</th><th className="text-left">Swing H</th><th className="text-left">Swing L</th></tr>
                    </thead>
                    <tbody>
                      {Object.values(marketCtx.context.timeframes).filter((t) => t.available).map((t) => (
                        <tr key={t.timeframe} className="border-t border-border">
                          <td className="py-1 text-txt-secondary">{t.timeframe}</td>
                          <td>{t.trendDirection}</td>
                          <td>{t.trendStrengthScore ?? "—"}</td>
                          <td>{t.atr ?? "—"}</td>
                          <td>{t.swingHigh ?? "—"}</td>
                          <td>{t.swingLow ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <div className="rounded border border-success/30 bg-success/5 p-2 text-xs text-success">
                  <div className="font-medium">Bullish scenario</div>
                  <div className="mt-1 text-txt-secondary">{marketCtx.tradeContext?.bullishScenario ?? "—"}</div>
                </div>
                <div className="rounded border border-danger/30 bg-danger/5 p-2 text-xs text-danger">
                  <div className="font-medium">Bearish scenario</div>
                  <div className="mt-1 text-txt-secondary">{marketCtx.tradeContext?.bearishScenario ?? "—"}</div>
                </div>
              </div>

              <div className="rounded border border-border p-2 text-xs text-txt-secondary">
                <div className="font-medium text-foreground">Exit / hold review</div>
                <div className="mt-1 text-txt-secondary">{marketCtx.tradeContext?.exitHoldReview ?? "—"}</div>
              </div>

              <div className="text-[10px] text-txt-muted">
                Source: {marketCtx.context?.source ?? "—"} · freshness: {marketCtx.context?.freshness ?? "—"} · session: {marketCtx.context?.session ?? "—"}
                {marketCtx.context?.asOf && <> · as of {new Date(marketCtx.context.asOf).toLocaleString()}</>}
              </div>

              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" data-testid="market-context-recalc"
                  disabled={recalcingCtx}
                  onClick={async () => {
                    setRecalcingCtx(true); setRecalcMsg(null);
                    try {
                      const r = await fetch(u(`/api/me/trades/${encodeURIComponent(tradeKey)}/market-context/recalculate`),
                        { method: "POST", credentials: "include" });
                      if (r.ok) { setRecalcMsg("Market context refreshed."); void load(); }
                      else setRecalcMsg(`Failed (HTTP ${r.status}).`);
                    } catch (e) { setRecalcMsg(`Failed: ${String((e as Error).message ?? e)}`); }
                    finally { setRecalcingCtx(false); setTimeout(() => setRecalcMsg(null), 3000); }
                  }}>
                  {recalcingCtx ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Activity className="mr-1 h-3 w-3" />} Recalculate
                </Button>
                {recalcMsg && <span className="text-xs text-txt-secondary">{recalcMsg}</span>}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card id="alerts">
        <CardHeader>
          <CardTitle className="text-base">Recent alerts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {tradeAlerts.length === 0 ? (
            <div className="text-sm text-txt-muted">No alerts yet for your trades.</div>
          ) : tradeAlerts.slice(0, 10).map((a) => (
            <div key={a.id} className={`rounded border p-2 text-xs ${severityColor[a.severity] ?? severityColor.info}`}>
              <div className="flex items-center justify-between">
                <span className="font-medium">{a.title}</span>
                <span className="text-[10px] uppercase">{a.severity}</span>
              </div>
              <div className="mt-1 text-txt-secondary">{a.message}</div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Clock className="h-4 w-4 text-txt-secondary" /> Decision timeline</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {timeline.length === 0 ? (
            <div className="text-sm text-txt-muted">No events recorded yet. Alerts and your decisions will appear here.</div>
          ) : timeline.slice(0, 30).map((e) => (
            <div key={e.id} className="rounded border border-border p-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-medium text-foreground">{e.title || e.eventType}</span>
                <span className="text-[10px] uppercase text-txt-muted">{e.source} · {new Date(e.createdAt).toLocaleString()}</span>
              </div>
              {e.message && <div className="mt-1 text-txt-secondary">{e.message}</div>}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><FileCheck className="h-4 w-4 text-premium" /> Exit review</CardTitle>
        </CardHeader>
        <CardContent>
          {!exitReview ? (
            <div className="text-sm text-txt-muted">No exit review yet. One is created automatically when the trade is closed.</div>
          ) : (
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px] uppercase">{exitReview.status}</Badge>
                <Badge variant="outline" className="text-[10px]">close: {exitReview.closeMethod}</Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs text-txt-secondary md:grid-cols-4">
                <div>Peak P&L: <span className="text-foreground">{exitReview.peakUnrealizedPnl?.toFixed?.(2) ?? "—"}</span></div>
                <div>Final P&L: <span className="text-foreground">{exitReview.finalRealizedPnl?.toFixed?.(2) ?? "—"}</span></div>
                <div>Giveback: <span className="text-foreground">{exitReview.profitGivebackPercent ?? "—"}%</span></div>
                <div>Alerts fired/acted: <span className="text-foreground">{exitReview.aiAlertsFiredCount ?? 0}/{exitReview.aiAlertsActedCount ?? 0}</span></div>
              </div>
              {(exitReview.labels ?? []).length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {(exitReview.labels ?? []).map((l) => (
                    <Badge key={l} variant="secondary" className="text-[10px]">{l}</Badge>
                  ))}
                </div>
              )}
              {exitReview.closeMethodNote && <div className="text-xs text-txt-muted">{exitReview.closeMethodNote}</div>}
            </div>
          )}
        </CardContent>
      </Card>

      {planModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" data-testid="exit-plan-modal">
          <Card className="max-w-md">
            <CardHeader><CardTitle className="text-base">{planModal.title}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-txt-secondary">{planModal.body}</p>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setPlanModal(null)}>Cancel</Button>
                <Button size="sm" data-testid="exit-plan-confirm" onClick={async () => {
                  const k = planModal.kind;
                  setPlanModal(null);
                  try {
                    const path = k === "recalc"
                      ? `/api/me/trades/${encodeURIComponent(tradeKey)}/exit-plan/recalculate`
                      : k === "move_stop"
                      ? `/api/me/trades/${encodeURIComponent(tradeKey)}/review-move-stop`
                      : `/api/me/trades/${encodeURIComponent(tradeKey)}/review-partial-close`;
                    const body = k === "partial_close" ? JSON.stringify({ portion: 0.5 }) : "{}";
                    const r = await fetch(u(path), { method: "POST", credentials: "include",
                      headers: { "Content-Type": "application/json" }, body });
                    setPlanActionMsg(r.ok ? "Recorded to timeline (preview only)." : `Failed (HTTP ${r.status}).`);
                    void load();
                  } catch (e) {
                    setPlanActionMsg(`Failed: ${String((e as Error).message ?? e)}`);
                  }
                  setTimeout(() => setPlanActionMsg(null), 4000);
                }}>Confirm</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" data-testid="confirm-modal">
          <Card className="max-w-md">
            <CardHeader><CardTitle className="text-base">{confirm.title}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-txt-secondary">{confirm.body}</p>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
                <Button size="sm" data-testid="confirm-yes" onClick={() => { void recordEvent(confirm.kind, confirm.title); setConfirm(null); }}>Confirm</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {closing && (
        <ConfirmCloseModal
          card={closing}
          accountType={accountType}
          tradingMode={tradingMode}
          onClose={() => setClosing(null)}
          onClosed={() => setClosing(null)}
        />
      )}
    </div>
  );
}
