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
  ok: "border-emerald-500/40 text-emerald-300 bg-emerald-500/10",
  muted: "border-zinc-700 text-zinc-300 bg-zinc-800/40",
  warn: "border-amber-500/40 text-amber-300 bg-amber-500/10",
  danger: "border-red-500/40 text-red-300 bg-red-500/10",
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
// The card polls the trade snapshot every 5s. A snapshot not refreshed within
// three polls is not treated as current.
const SNAPSHOT_POLL_MS = 5_000;
const SNAPSHOT_CURRENT_MS = 3 * SNAPSHOT_POLL_MS;

/**
 * Whether the trade snapshot on screen is current. react-query keeps the last
 * successful data when a refetch fails or is paused (offline), so `snap` alone
 * does not say the server still has a quote now.
 */
export interface SnapshotReadState {
  /** The latest snapshot request failed (the data shown is from an earlier read). */
  refreshFailed: boolean;
  /** The refresh is paused (e.g. the browser is offline). */
  refreshPaused: boolean;
  /** When the data on screen was received (epoch ms); 0 / undefined when never. */
  updatedAtMs: number | undefined;
}

/** The snapshot on screen was read within three polls and its latest refresh neither failed nor is paused. */
export function isSnapshotCurrent(snapRead: SnapshotReadState, nowMs = Date.now()): boolean {
  const updatedAtMs = snapRead.updatedAtMs;
  const ageMs = typeof updatedAtMs === "number" && updatedAtMs > 0 ? nowMs - updatedAtMs : null;
  return !snapRead.refreshFailed && !snapRead.refreshPaused && ageMs != null && ageMs <= SNAPSHOT_CURRENT_MS;
}

/** When the snapshot on screen was received, as a time of day; null when never. */
function snapshotReadAt(snapRead: SnapshotReadState): string | null {
  const updatedAtMs = snapRead.updatedAtMs;
  return typeof updatedAtMs === "number" && updatedAtMs > 0 ? new Date(updatedAtMs).toLocaleTimeString() : null;
}

function SafetyBadgeRow({ trade, snap, snapTargetsUnavailable, snapRead }: { trade: Trade; snap: unknown; snapTargetsUnavailable: boolean; snapRead: SnapshotReadState }) {
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
  const newsConnected = market?.features?.news === true;
  const candlesConnected = market?.features?.candles === true;
  const dataInsufficient = !snap || !candlesConnected;

  type Tone = "muted" | "warn" | "danger" | "ok";
  const TONE: Record<Tone, string> = {
    muted: "border-zinc-700 text-zinc-300 bg-zinc-800/40",
    warn: "border-amber-500/40 text-amber-300 bg-amber-500/10",
    danger: "border-red-500/40 text-red-300 bg-red-500/10",
    ok: "border-emerald-500/40 text-emerald-300 bg-emerald-500/10",
  };
  const badges: Array<{ label: string; tone: Tone; testId: string; title?: string }> = [];

  // Account / execution gates.
  // Feature Truth Audit: "Live Trading Blocked" and "Bridge Offline" used to be
  // pushed UNCONDITIONALLY — a false state whenever the bridge was actually
  // online or live execution enabled. They now derive from the real backend
  // MT5 state (same source as the page header) and are only asserted when the
  // status has loaded AND reports that state. Unknown status asserts nothing.
  // Every row this card renders is a legacy simulated ARX record (lib/db
  // schema/trades.ts: no broker order stands behind any row). trade.mode is
  // the Safety Core state when the record was written, not a venue, so it
  // must not decide this badge — a mode of LIVE is still a simulated record.
  badges.push({
    label: "Simulated Record", tone: "muted", testId: "badge-paper-only",
    title: "This ARX trade record is simulated on the paper book; no broker order stands behind it, whatever the Safety Core state was at entry.",
  });
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
  // The stop / close capability badges used to be pushed UNCONDITIONALLY.
  // They now follow what /trade-management actually enforces
  // (api-server routes/tradeManagement.ts): the buttons change this ARX
  // record on the paper book through the Position Guardian, with no MT5
  // bridge involved, and Close / Trail Stop answer 409 NO_CURRENT_QUOTE when
  // the server has no quote. So the badges are claimed only when the
  // snapshot loaded WITH a current price; the bridge state is not a
  // condition. The protective auto-close kill switch does not gate these
  // routes either, but the badges stay withheld while it is engaged or
  // unread — that claims less, never more. The card can move the stop
  // (Break-Even / Trail) but has no take-profit editor, so the label names
  // the stop only.
  // They also need a CURRENT snapshot: after a failed or paused refresh, or
  // once the last read is older than three polls, the quote on screen is from
  // an earlier read and whether the server still has one was not checked.
  const killRead = typeof safety?.settings?.killSwitchEngaged === "boolean";
  const hasQuote = (snap as { currentPrice?: number | null } | null | undefined)?.currentPrice != null;
  const snapCurrent = isSnapshotCurrent(snapRead);
  if (snap && !snapCurrent) {
    const readAt = snapshotReadAt(snapRead);
    const lastRead = readAt ? `the last successful read at ${readAt}` : "an earlier read";
    badges.push({
      label: snapRead.refreshFailed ? "Snapshot Could Not Be Refreshed" : "Snapshot Not Current",
      tone: "warn",
      testId: "badge-snapshot-not-current",
      title: snapRead.refreshFailed
        ? `The latest request for this trade's snapshot failed. The figures shown are from ${lastRead}, so whether Close, Break-Even and Trail Stop can run now was not checked.`
        : `This trade's snapshot has not been refreshed since ${lastRead}, so whether Close, Break-Even and Trail Stop can run now was not checked.`,
    });
  }
  const controlsUsable = snapCurrent && hasQuote && killRead && !killEngaged;
  if (controlsUsable) {
    badges.push({
      label: "Stop Adjustable", tone: "ok", testId: "badge-sltp-editable",
      title: "Break-Even and Trail Stop move the stop on this ARX record (simulated, no broker order). The Position Guardian refuses any move that would widen the stop.",
    });
    badges.push({
      label: "Manual Close Available", tone: "ok", testId: "badge-manual-close",
      title: "Close books this ARX record at the server's current quote (simulated, no broker order).",
    });
  }

  return (
    <div className="flex flex-wrap gap-1" data-testid={`safety-badges-${trade.id}`}>
      {badges.map((b) => (
        <Badge key={b.label} variant="outline" className={`text-[10px] ${TONE[b.tone]}`} data-testid={b.testId} title={b.title}>{b.label}</Badge>
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
  const snapQ = useGetTradeSnapshot(trade.id, { query: { queryKey: getGetTradeSnapshotQueryKey(trade.id), refetchInterval: SNAPSHOT_POLL_MS } });
  const snap = snapQ.data;
  const snapRead: SnapshotReadState = {
    refreshFailed: snapQ.isError === true,
    refreshPaused: snapQ.isPaused === true,
    updatedAtMs: snapQ.dataUpdatedAt,
  };
  const { data: coach, isLoading: coachLoading } = useGetCoachExplanation(trade.id, { query: { queryKey: getGetCoachExplanationQueryKey(trade.id), enabled: coachOpen } });
  const be = useMoveTradeToBreakeven();
  const trail = useTrailTradeStop();
  const partial = usePartialCloseTrade();
  const close = useCloseTradeManually();

  const refresh = () => {
    qc.invalidateQueries({ queryKey: getGetTradeSnapshotQueryKey(trade.id) });
    qc.invalidateQueries({ queryKey: getGetOpenTradesQueryKey() });
  };
  // A refused or failed management request (e.g. 409 NO_CURRENT_QUOTE) is
  // shown on the card, never swallowed — a silent click reads as success.
  const [actionError, setActionError] = useState<string | null>(null);
  const runAction = async (label: string, fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof Error && e.message ? e.message : "the request failed";
      setActionError(`${label} did not go through: ${msg}`);
      return;
    }
    refresh();
  };

  // Truth rule: Current / P&L / R / Health are null when the server had no
  // quote — render "Unavailable" with the server's reason, never 0 or entry.
  const health = snap?.health ?? null;
  const healthColor = health ? (health.score >= 70 ? "[&>div]:bg-green-500" : health.score >= 40 ? "[&>div]:bg-yellow-500" : "[&>div]:bg-destructive") : "";
  const currentPrice = snap?.currentPrice ?? null;
  const floatingPnl = snap?.floatingPnl ?? null;
  const rMultiple = snap?.rMultiple ?? null;
  const quoteAt = snap?.quoteAt ?? null;
  // Only a quote the server confirmed "fresh" is the current price. "delayed"
  // (a receive-time stamp, or a tick past the fresh window) — or a snapshot
  // that does not say — is a last price, not confirmed current. So is any
  // quote in a snapshot that is no longer current: react-query keeps the last
  // snapshot when a refresh fails or is paused, so the server's verdict and
  // its relative note ("observed 2s ago") are from that earlier read.
  const snapCurrent = isSnapshotCurrent(snapRead);
  const confirmedCurrent = snapCurrent && snap?.quoteFreshness === "fresh";
  const quoteAsOf = quoteAt ? `Quote as of ${new Date(quoteAt).toLocaleTimeString()}.` : "";
  const readAt = snapshotReadAt(snapRead);
  const notRefreshed = snapRead.refreshFailed
    ? `This trade's snapshot could not be refreshed ${readAt ? `since ${readAt}` : "after an earlier read"}.`
    : `This trade's snapshot has not been refreshed ${readAt ? `since ${readAt}` : "after an earlier read"}.`;
  const unconfirmedDetail = snapCurrent
    ? (snap?.quoteNote ?? quoteAsOf)
    : `${notRefreshed}${quoteAsOf ? ` ${quoteAsOf}` : ""}`;

  return (
    <Card data-testid={`live-trade-card-${trade.id}`}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <span className={`p-1.5 rounded ${trade.direction === "BUY" ? "bg-green-500/10 text-green-500" : "bg-destructive/10 text-destructive"}`}>
              {trade.direction === "BUY" ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
            </span>
            <span className="font-mono">{trade.symbol}</span>
            <Badge variant="outline" className="text-[10px]">{trade.lot} lots</Badge>
            {/* trades.mode is the Safety Core state when the record was written,
                not a broker venue (lib/db schema/trades.ts) — label it so. */}
            <Badge
              variant="outline"
              className="text-[10px]"
              data-testid={`badge-trade-mode-${trade.id}`}
              title="Safety Core state when this ARX trade record was written. It is not a broker venue; this record is not a broker order."
            >
              Safety Core: {trade.mode ?? "unknown"} (at entry)
            </Badge>
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
          snapRead={snapRead}
          snapTargetsUnavailable={
            !snap ||
            Boolean((snap as unknown as { targetsUnavailableReason?: string | null }).targetsUnavailableReason)
          }
        />
        <div className="flex flex-wrap gap-1" data-testid={`aaci-badges-${trade.id}`}>
          <AaciTradeBadges symbol={trade.symbol} />
        </div>
        {!snap ? (snapRead.refreshFailed
          ? <p className="text-xs text-destructive" role="alert" data-testid={`snap-load-failed-${trade.id}`}>This trade's snapshot could not be loaded, so its price, P&L and management controls are not shown.</p>
          : <Skeleton className="h-32 w-full" />) :
          <>
            <div className="grid grid-cols-3 gap-2 text-xs font-mono">
              <div><div className="text-muted-foreground">Entry</div><div>{trade.entryPrice.toFixed(5)}</div></div>
              <div><div className="text-muted-foreground" data-testid={`snap-price-label-${trade.id}`}>{currentPrice == null || confirmedCurrent ? "Current" : "Last price"}</div><div data-testid={`snap-current-${trade.id}`}>{currentPrice != null ? currentPrice.toFixed(5) : <span className="text-muted-foreground">Unavailable</span>}</div></div>
              <div><div className="text-muted-foreground">P&L</div>{floatingPnl != null
                ? <div data-testid={`snap-pnl-${trade.id}`} className={floatingPnl >= 0 ? "text-green-500" : "text-destructive"}>{floatingPnl < 0 ? "-" : ""}${Math.abs(floatingPnl).toFixed(2)}</div>
                : <div data-testid={`snap-pnl-${trade.id}`} className="text-muted-foreground">Unavailable</div>}</div>
              <div><div className="text-muted-foreground">SL</div><div className="text-destructive">{trade.stopLoss.toFixed(5)}</div></div>
              <div><div className="text-muted-foreground">TP</div><div className="text-green-500">{trade.takeProfit.toFixed(5)}</div></div>
              <div><div className="text-muted-foreground">R</div>{rMultiple != null
                ? <div data-testid={`snap-r-${trade.id}`} className={rMultiple >= 0 ? "text-green-500" : "text-destructive"}>{rMultiple.toFixed(2)}R</div>
                : <div data-testid={`snap-r-${trade.id}`} className="text-muted-foreground">Unavailable</div>}</div>
            </div>
            {currentPrice != null && confirmedCurrent && quoteAt ? (
              <div className="text-[10px] text-muted-foreground" data-testid={`snap-quote-at-${trade.id}`}>Quote as of {new Date(quoteAt).toLocaleTimeString()}</div>
            ) : null}
            {currentPrice != null && !confirmedCurrent ? (
              <div className="text-[10px] text-amber-300" data-testid={`snap-quote-unconfirmed-${trade.id}`}>
                Last price · not confirmed current. {unconfirmedDetail} P&L, R and health are measured from this last price.
              </div>
            ) : null}
            {currentPrice != null && floatingPnl == null && snap.pnlUnavailableReason ? (
              <div className="text-[10px] text-amber-300" data-testid={`snap-pnl-unavailable-${trade.id}`}>{snap.pnlUnavailableReason}</div>
            ) : null}
            <div>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-muted-foreground">Health</span>
                {health
                  ? <Badge variant="outline" className="text-[10px] capitalize">{health.state.replace("_", " ")}</Badge>
                  : <Badge variant="outline" className="text-[10px]" data-testid={`snap-health-unavailable-${trade.id}`}>Not measured</Badge>}
              </div>
              {health ? <Progress value={health.score} className={`h-2 ${healthColor}`} /> : null}
            </div>
            <div className="text-xs p-2 rounded bg-muted/30 border border-border/50">{snap.primarySuggestion}</div>
            <div className="grid grid-cols-2 gap-2">
              <Button size="sm" variant={snap.suggestions.breakEven.recommended ? "default" : "outline"} disabled={be.isPending} onClick={() => runAction("Break-Even", () => be.mutateAsync({ id: trade.id }))} data-testid={`button-breakeven-${trade.id}`}>Break-Even</Button>
              <Button size="sm" variant={snap.suggestions.trail.recommended ? "default" : "outline"} disabled={trail.isPending} onClick={() => runAction("Trail Stop", () => trail.mutateAsync({ id: trade.id }))} data-testid={`button-trail-${trade.id}`}>Trail Stop</Button>
              <Button size="sm" variant={snap.suggestions.partial.recommended ? "default" : "outline"} disabled={partial.isPending} onClick={() => runAction("Close 50%", () => partial.mutateAsync({ id: trade.id, data: { closePct: 50 } }))} data-testid={`button-partial-${trade.id}`}>Close 50%</Button>
              <Button size="sm" variant="destructive" disabled={close.isPending} onClick={() => runAction("Close", () => close.mutateAsync({ id: trade.id }))} data-testid={`button-close-${trade.id}`}><X size={14} className="mr-1" /> Close</Button>
            </div>
            {actionError ? (
              <p className="text-xs text-destructive" role="alert" data-testid={`trade-action-error-${trade.id}`}>{actionError}</p>
            ) : null}
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
