import React, { useState } from "react";
import {
  useGetTradeSnapshot, useMoveTradeToBreakeven, useTrailTradeStop, usePartialCloseTrade, useCloseTradeManually,
  useGetCoachExplanation, useGetMt5State,
  getGetTradeSnapshotQueryKey, getGetOpenTradesQueryKey, getGetCoachExplanationQueryKey, getGetMt5StateQueryKey,
  type Trade,
} from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TrendingUp, TrendingDown, Brain, X } from "lucide-react";
import { useGetAaciDecision, getGetAaciDecisionQueryKey } from "@workspace/api-client-react";
import { aaciCohesionTone, type AaciCohesionTone } from "@workspace/domain/aaci";

const PAC_BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "");

// Per-position AACI cohesion read — advisory/display only. Shows the plain-English
// cohesion verdict for this position's symbol and, when the systems disagree with
// the open position (RECONCILE_SYSTEM), a "Re-sync needed" flag. Read-only: never
// closes, modifies, or gates the position. Fail-open: renders nothing on error.
const AACI_SHELL: Record<AaciCohesionTone, string> = {
  ok: "border-success/40 text-success bg-success/10",
  muted: "border-border text-txt-secondary bg-muted/40",
  warn: "border-warning/40 text-warning bg-warning/10",
  danger: "border-danger/40 text-danger bg-danger/10",
};
function AaciTradeBadges({ symbol }: { symbol: string }) {
  const { data } = useGetAaciDecision(symbol, undefined, {
    query: {
      queryKey: getGetAaciDecisionQueryKey(symbol),
      enabled: symbol.length > 0,
      staleTime: 30_000,
      refetchInterval: 60_000,
      refetchIntervalInBackground: false,
      retry: false,
    },
  });
  if (!data) return null;
  const tone = aaciCohesionTone(data.recommendedAction);
  const reconcile = data.recommendedAction === "RECONCILE_SYSTEM";
  return (
    <>
      <Badge variant="outline" className={`text-[10px] ${AACI_SHELL[tone]}`} data-testid="badge-aaci-cohesion" title={data.userFacingExplanation}>
        Sync: {data.recommendedActionLabel}
      </Badge>
      {reconcile && (
        <Badge variant="outline" className={`text-[10px] ${AACI_SHELL.warn}`} data-testid="badge-aaci-resync">
          Re-sync needed
        </Badge>
      )}
    </>
  );
}

// Phase 24 — Trade Card Safety Badges. Pulls REAL backend state for the
// protective-auto-close gates + activity + provider connectivity, so the row
// can never show a false "live" or "auto-close ARMED" state.
interface SafetyState {
  ok?: boolean;
  settings?: { enabled?: boolean; killSwitchEngaged?: boolean; mode?: string };
  activity?: { status?: "ACTIVE" | "INACTIVE" | "UNKNOWN" };
}
interface MarketStatusState {
  features?: { news?: boolean; candles?: boolean };
  connected?: boolean;
  configured?: boolean;
}
// Cleanup phase C + D — extra backend-driven state for the new
// "Current Events Unavailable" and "Command Execution Disabled" badges.
// Sourced from GET /api/me/market-data/status (extended).
interface MarketDataExtState {
  currentEvents?: { connected?: boolean; reason?: string | null };
  commandExecution?: { allowed?: boolean; intentional?: boolean; reason?: string };
}
function SafetyBadgeRow({ trade, snap, snapTargetsUnavailable }: { trade: Trade; snap: unknown; snapTargetsUnavailable: boolean }) {
  const { data: safety } = useQuery<SafetyState>({
    queryKey: ["/me/protective-auto-close/settings"],
    queryFn: () => fetch(`${PAC_BASE}/api/me/protective-auto-close/settings`, { credentials: "include" }).then((r) => (r.ok ? r.json() : ({} as SafetyState))),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  const { data: market } = useQuery<MarketStatusState>({
    queryKey: ["/me/assistant/market-status"],
    queryFn: () => fetch(`${PAC_BASE}/api/me/assistant/market-status`, { credentials: "include" }).then((r) => (r.ok ? r.json() : ({} as MarketStatusState))),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  // Cleanup phase C + D — extended status payload for current-events +
  // command-execution discrete badges.
  const { data: marketExt } = useQuery<MarketDataExtState>({
    queryKey: ["/me/market-data/status"],
    queryFn: () => fetch(`${PAC_BASE}/api/me/market-data/status`, { credentials: "include" }).then((r) => (r.ok ? r.json() : ({} as MarketDataExtState))),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  // Real MT5 bridge / live-permission state — same backend source the
  // Live Trades page header uses. Drives the (previously unconditional)
  // "Live Trading Blocked" / "Bridge Offline" badges honestly.
  const { data: mt5State } = useGetMt5State({
    query: {
      queryKey: getGetMt5StateQueryKey(),
      refetchInterval: 30_000,
      staleTime: 15_000,
      retry: false,
    },
  });

  const pacEnabled = safety?.settings?.enabled === true;
  const killEngaged = safety?.settings?.killSwitchEngaged === true;
  const activity = safety?.activity?.status ?? "UNKNOWN";
  const isPaper = (trade.mode ?? "").toUpperCase() !== "LIVE";
  const newsConnected = market?.features?.news === true;
  const candlesConnected = market?.features?.candles === true;
  const dataInsufficient = !snap || !candlesConnected;

  type Tone = "muted" | "warn" | "danger" | "ok";
  const TONE: Record<Tone, string> = {
    muted: "border-border text-txt-secondary bg-muted/40",
    warn: "border-warning/40 text-warning bg-warning/10",
    danger: "border-danger/40 text-danger bg-danger/10",
    ok: "border-success/40 text-success bg-success/10",
  };
  const badges: Array<{ label: string; tone: Tone; testId: string }> = [];

  // Account / execution gates.
  // Feature Truth Audit: "Live Trading Blocked" and "Bridge Offline" used to be
  // pushed UNCONDITIONALLY — a false state whenever the bridge was actually
  // online or live execution enabled. They now derive from the real backend
  // MT5 state (same source as the page header) and are only asserted when the
  // status has loaded AND reports that state. Unknown status asserts nothing.
  if (isPaper) badges.push({ label: "Demo Only", tone: "muted", testId: "badge-paper-only" });
  if (mt5State && mt5State.liveAllowed !== true) {
    badges.push({ label: "Live Trading Blocked", tone: "warn", testId: "badge-live-blocked" });
  }
  if (mt5State && mt5State.connected !== true) {
    badges.push({ label: "Bridge Offline", tone: "warn", testId: "badge-bridge-offline" });
  }

  // Auto-close state — one of these is always shown.
  if (killEngaged) {
    badges.push({ label: "Auto-Close Killed", tone: "danger", testId: "badge-auto-close-killed" });
  } else if (!pacEnabled) {
    badges.push({ label: "Auto-Close OFF", tone: "muted", testId: "badge-auto-close-off" });
    badges.push({ label: "Auto-Close Opt-In Required", tone: "warn", testId: "badge-auto-close-optin" });
  } else {
    badges.push({ label: "ALERT_ONLY", tone: "warn", testId: "badge-alert-only" });
  }

  // Presence / data / news flags.
  if (activity === "UNKNOWN") badges.push({ label: "Activity Unknown", tone: "warn", testId: "badge-activity-unknown" });
  if (dataInsufficient) badges.push({ label: "Data Insufficient", tone: "warn", testId: "badge-data-insufficient" });
  if (!newsConnected) badges.push({ label: "News Unavailable", tone: "warn", testId: "badge-news-unavailable" });
  // Cleanup phase C — discrete current-events badge, only when the
  // dedicated current-events channel is connected:false. Does NOT
  // alias to market news; only shown when the new backend field
  // explicitly says the channel is unavailable.
  if (marketExt && marketExt.currentEvents && marketExt.currentEvents.connected === false) {
    badges.push({ label: "Current Events Unavailable", tone: "warn", testId: "badge-current-events-unavailable" });
  }
  // Cleanup phase D — discrete command-execution badge. Tone is `muted`
  // (informational) when execution is intentionally locked, so the user
  // is not misled into reading it as an error.
  if (marketExt && marketExt.commandExecution && marketExt.commandExecution.allowed === false) {
    const intentional = marketExt.commandExecution.intentional === true;
    badges.push({
      label: "Command Execution Disabled",
      tone: intentional ? "muted" : "warn",
      testId: "badge-command-execution-disabled",
    });
  }

  // Trade-card capabilities — these reflect what the card itself supports.
  if (snapTargetsUnavailable) {
    badges.push({ label: "TP Targets Unavailable", tone: "warn", testId: "badge-tp-unavailable" });
  } else {
    badges.push({ label: "TP Targets Available", tone: "ok", testId: "badge-tp-available" });
  }
  badges.push({ label: "SL/TP Editable", tone: "ok", testId: "badge-sltp-editable" });
  badges.push({ label: "Manual Close Available", tone: "ok", testId: "badge-manual-close" });

  return (
    <div className="flex flex-wrap gap-1" data-testid={`safety-badges-${trade.id}`}>
      {badges.map((b) => (
        <Badge key={b.label} variant="outline" className={`text-[10px] ${TONE[b.tone]}`} data-testid={b.testId}>{b.label}</Badge>
      ))}
    </div>
  );
}

// Phase 25 — per-trade free-form AI Q&A. Calls /api/me/trade-coach/ask which
// is per-user-scoped, read-only, and cannot execute trades. Suggested prompts
// match the Phase-25 brief.
const SUGGESTED_PROMPTS = [
  "Where do you think this trade is going?",
  "Should I close this trade now?",
  "Is this a pullback or a real reversal?",
  "Where should I place TP?",
  "Should I move my stop loss?",
];
function AskTradeAi({ tradeId }: { tradeId: number }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const ask = async (q: string) => {
    if (!q.trim() || loading) return;
    setLoading(true); setError(null); setAnswer(null);
    try {
      const r = await fetch(`${PAC_BASE}/api/me/trade-coach/ask`, {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tradeId, question: q }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setAnswer(typeof j.answer === "string" ? j.answer : "(no answer)");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="border-t border-border/50 pt-3 mt-2 space-y-2" data-testid={`ask-ai-${tradeId}`}>
      <div className="text-xs uppercase text-muted-foreground">Ask the AI about this trade</div>
      <div className="flex flex-wrap gap-1">
        {SUGGESTED_PROMPTS.map((p) => (
          <button key={p} onClick={() => { setQuestion(p); ask(p); }} disabled={loading}
            className="text-[10px] rounded border border-border/60 bg-muted/40 px-2 py-0.5 hover:bg-muted disabled:opacity-50"
            data-testid={`prompt-${p.slice(0, 10).replace(/\s+/g, "-")}`}>
            {p}
          </button>
        ))}
      </div>
      <textarea
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Ask anything about this trade…"
        rows={2}
        maxLength={500}
        className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
        data-testid="ask-ai-textarea"
      />
      <div className="flex justify-between items-center">
        <span className="text-[10px] text-muted-foreground">Read-only. AI cannot place or close trades.</span>
        <Button size="sm" variant="default" disabled={loading || !question.trim()} onClick={() => ask(question)} data-testid="button-ask-ai">
          {loading ? "Thinking…" : "Ask AI"}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {answer && (
        <div className="rounded border border-border/50 bg-muted/30 p-2 text-xs whitespace-pre-wrap" data-testid="ask-ai-answer">
          {answer}
        </div>
      )}
    </div>
  );
}

export function LiveTradeCard({ trade, onCoach }: { trade: Trade; onCoach?: () => void }) {
  const qc = useQueryClient();
  const [coachOpen, setCoachOpen] = useState(false);
  const { data: snap } = useGetTradeSnapshot(trade.id, { query: { queryKey: getGetTradeSnapshotQueryKey(trade.id), refetchInterval: 5000 } });
  const { data: coach, isLoading: coachLoading } = useGetCoachExplanation(trade.id, { query: { queryKey: getGetCoachExplanationQueryKey(trade.id), enabled: coachOpen } });
  const be = useMoveTradeToBreakeven();
  const trail = useTrailTradeStop();
  const partial = usePartialCloseTrade();
  const close = useCloseTradeManually();

  const refresh = () => {
    qc.invalidateQueries({ queryKey: getGetTradeSnapshotQueryKey(trade.id) });
    qc.invalidateQueries({ queryKey: getGetOpenTradesQueryKey() });
  };

  const healthColor = snap ? (snap.health.score >= 70 ? "[&>div]:bg-success" : snap.health.score >= 40 ? "[&>div]:bg-warning" : "[&>div]:bg-destructive") : "";

  return (
    <Card data-testid={`live-trade-card-${trade.id}`}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <span className={`p-1.5 rounded ${trade.direction === "BUY" ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
              {trade.direction === "BUY" ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
            </span>
            <span className="font-mono">{trade.symbol}</span>
            <Badge variant="outline" className="text-[10px]">{trade.lot} lots</Badge>
            <Badge variant="outline" className="text-[10px]">{trade.mode}</Badge>
          </CardTitle>
          <Button variant="ghost" size="icon" onClick={() => { setCoachOpen(true); onCoach?.(); }} data-testid={`button-coach-${trade.id}`}>
            <Brain size={16} className="text-primary" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <SafetyBadgeRow
          trade={trade}
          snap={snap}
          snapTargetsUnavailable={
            !snap ||
            Boolean((snap as unknown as { targetsUnavailableReason?: string | null }).targetsUnavailableReason)
          }
        />
        <div className="flex flex-wrap gap-1" data-testid={`aaci-badges-${trade.id}`}>
          <AaciTradeBadges symbol={trade.symbol} />
        </div>
        {!snap ? <Skeleton className="h-32 w-full" /> :
          <>
            <div className="grid grid-cols-3 gap-2 text-xs font-mono">
              <div><div className="text-muted-foreground">Entry</div><div>{trade.entryPrice.toFixed(5)}</div></div>
              <div><div className="text-muted-foreground">Current</div><div>{snap.currentPrice.toFixed(5)}</div></div>
              {/* No dollar P/L on this path: the snapshot has no contract
                  size or pip value, so it reports a signed price move only.
                  Showing "$0.00" or an invented amount here would be a
                  fabricated money figure. */}
              <div>
                <div className="text-muted-foreground">Move</div>
                <div
                  className={snap.priceMove >= 0 ? "text-success" : "text-destructive"}
                  title="Price distance from entry. Dollar P/L is not available for this trade."
                >
                  {snap.priceMove >= 0 ? "+" : ""}{snap.priceMove.toFixed(5)}
                </div>
              </div>
              <div><div className="text-muted-foreground">SL</div><div className="text-destructive">{trade.stopLoss.toFixed(5)}</div></div>
              <div><div className="text-muted-foreground">TP</div><div className="text-success">{trade.takeProfit.toFixed(5)}</div></div>
              <div><div className="text-muted-foreground">R</div><div className={snap.rMultiple >= 0 ? "text-success" : "text-destructive"}>{snap.rMultiple.toFixed(2)}R</div></div>
            </div>
            <div>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-muted-foreground">Health</span>
                <Badge variant="outline" className="text-[10px] capitalize">{snap.health.state.replace("_", " ")}</Badge>
              </div>
              <Progress value={snap.health.score} className={`h-2 ${healthColor}`} />
            </div>
            <div className="text-xs p-2 rounded bg-muted/30 border border-border/50">{snap.primarySuggestion}</div>
            <div className="grid grid-cols-2 gap-2">
              <Button size="sm" variant={snap.suggestions.breakEven.recommended ? "default" : "outline"} disabled={be.isPending} onClick={async () => { await be.mutateAsync({ id: trade.id }); refresh(); }} data-testid={`button-breakeven-${trade.id}`}>Break-Even</Button>
              <Button size="sm" variant={snap.suggestions.trail.recommended ? "default" : "outline"} disabled={trail.isPending} onClick={async () => { await trail.mutateAsync({ id: trade.id }); refresh(); }} data-testid={`button-trail-${trade.id}`}>Trail Stop</Button>
              <Button size="sm" variant={snap.suggestions.partial.recommended ? "default" : "outline"} disabled={partial.isPending} onClick={async () => { await partial.mutateAsync({ id: trade.id, data: { closePct: 50 } }); refresh(); }} data-testid={`button-partial-${trade.id}`}>Close 50%</Button>
              <Button size="sm" variant="destructive" disabled={close.isPending} onClick={async () => { await close.mutateAsync({ id: trade.id }); refresh(); }} data-testid={`button-close-${trade.id}`}><X size={14} className="mr-1" /> Close</Button>
            </div>
          </>
        }
      </CardContent>

      <Dialog open={coachOpen} onOpenChange={setCoachOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Brain size={18} className="text-primary" /> AI Coach: {trade.symbol}</DialogTitle></DialogHeader>
          {coachLoading || !coach ? <Skeleton className="h-48" /> :
            <div className="space-y-3 text-sm">
              <div><div className="text-xs uppercase text-muted-foreground mb-1">What happened</div><p>{coach.whatHappened}</p></div>
              <div><div className="text-xs uppercase text-muted-foreground mb-1">Setup validity</div><p>{coach.setupValid}</p></div>
              <div><div className="text-xs uppercase text-muted-foreground mb-1">What could be better</div><p>{coach.whatCouldBeBetter}</p></div>
              <div><div className="text-xs uppercase text-muted-foreground mb-1">Strategy adjustment</div><p>{coach.strategyAdjustment}</p></div>
              <div><div className="text-xs uppercase text-muted-foreground mb-1">Market avoidance</div><p>{coach.marketAvoidance}</p></div>
            </div>
          }
          <AskTradeAi tradeId={trade.id} />
        </DialogContent>
      </Dialog>
    </Card>
  );
}
