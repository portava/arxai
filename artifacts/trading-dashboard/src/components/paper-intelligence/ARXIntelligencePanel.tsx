import React from "react";
import {
  useAnalyzePaperIntelligence,
  useListPaperIdeas,
  useCreatePaperIdea,
  usePatchPaperIdea,
  useBlockedExecutionTest,
  getListPaperIdeasQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Brain, ShieldOff, Activity, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";

type AnalyzeResult = {
  symbol: string;
  decision: "MT5_DATA_STALE" | "WAIT" | "WATCHLIST_CANDIDATE" | "PAPER_TRADEABLE";
  mt5: {
    account: string | null; balance: number | null; equity: number | null;
    freeMargin: number | null; openPositionsCount: number;
    heartbeatAgeSeconds: number | null; freshnessThresholdSeconds: number; isFresh: boolean;
    currency: string | null;
  };
  signal: { direction: string; confidence: number; entryPrice: number; stopLoss: number; takeProfit: number; reason: string; strategy: string };
  confidenceScore: number;
  riskScore: number;
  riskPercent: number;
  suggestedLot: number;
  reasoning: string[];
  warnings: string[];
};

type IdeaRow = {
  id: number; symbol: string; direction: string;
  entryIdea: number; stopLossIdea: number; takeProfitIdea: number;
  riskPercent: number; confidenceScore: number; riskScore: number;
  suggestedLot: number; aiReasoning: string; status: string;
  createdAt: string;
};

type BlockedEnvelope = {
  status: string; reason: string;
  executionMode: string; placementLayer: string; blockedAt: string;
};

const fmt = (n: number | null | undefined, d = 2) =>
  n === null || n === undefined ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 2 });

function StatusPill({ tone, children }: { tone: "ok" | "warn" | "danger" | "info"; children: React.ReactNode }) {
  const cls = {
    ok:    "border-success/40 bg-success/10 text-success",
    warn:  "border-warning/40 bg-warning/10 text-warning",
    danger:"border-danger/40 bg-danger/10 text-danger",
    info:  "border-ruby/40 bg-ruby/10 text-ruby",
  }[tone];
  return <span className={`px-2 py-0.5 rounded border font-mono text-[10px] uppercase tracking-wider ${cls}`}>{children}</span>;
}

export function ARXIntelligencePanel() {
  const qc = useQueryClient();
  const [symbol, setSymbol] = React.useState("Volatility 75 Index");
  const [riskPercent, setRiskPercent] = React.useState(0.5);
  const [analysis, setAnalysis] = React.useState<AnalyzeResult | null>(null);
  const [blocked, setBlocked] = React.useState<BlockedEnvelope | null>(null);

  const ideasQuery = useListPaperIdeas({ limit: 5 });
  const ideasKey = getListPaperIdeasQueryKey({ limit: 5 });
  const ideas: IdeaRow[] = ((ideasQuery.data as { ideas?: IdeaRow[] } | undefined)?.ideas ?? []) as IdeaRow[];

  const analyzeMut = useAnalyzePaperIntelligence({
    mutation: { onSuccess: (data) => setAnalysis(data as unknown as AnalyzeResult) },
  });
  const createMut = useCreatePaperIdea({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: ideasKey }) },
  });
  const patchMut = usePatchPaperIdea({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: ideasKey }) },
  });
  const blockedMut = useBlockedExecutionTest({
    mutation: { onSuccess: (d) => setBlocked(d as unknown as BlockedEnvelope) },
  });

  const onAnalyze = () => {
    setBlocked(null);
    analyzeMut.mutate({ data: { symbol, riskPercent } });
  };

  const onSaveAsWatchlist = () => {
    if (!analysis || analysis.decision === "MT5_DATA_STALE") return;
    createMut.mutate({
      data: {
        symbol: analysis.symbol,
        direction: (analysis.signal.direction === "BUY" ? "BUY" : "SELL"),
        entryIdea: analysis.signal.entryPrice,
        stopLossIdea: analysis.signal.stopLoss,
        takeProfitIdea: analysis.signal.takeProfit,
        riskPercent: analysis.riskPercent,
        confidenceScore: analysis.confidenceScore,
        riskScore: analysis.riskScore,
        suggestedLot: analysis.suggestedLot,
        aiReasoning: analysis.reasoning.join("\n"),
        strategySource: analysis.signal.strategy,
        status: "WATCHLIST",
      },
    });
  };

  const onTestBlocked = () =>
    blockedMut.mutate({ data: { attemptKind: "PLACE_ORDER", symbol: analysis?.symbol ?? symbol, source: "dashboard:ARXIntelligencePanel" } });

  const mt5 = analysis?.mt5;
  const fresh = mt5?.isFresh ?? false;
  const stale = analysis?.decision === "MT5_DATA_STALE";

  return (
    <Card className="border-card-border" data-testid="arx-intelligence-panel">
      <CardHeader className="flex flex-row items-center justify-between pb-3 border-b border-border">
        <CardTitle className="text-sm font-semibold uppercase tracking-wider flex items-center gap-2">
          <Brain size={14} className="text-primary" /> ARX AI — Trade Intelligence
        </CardTitle>
        <div className="flex flex-wrap gap-2">
          <StatusPill tone={stale ? "danger" : fresh ? "ok" : "warn"}>
            {stale ? "MT5 Data Stale" : fresh ? "MT5 Connected" : "MT5 Standby"}
          </StatusPill>
          <StatusPill tone="info">Mode: READ_ONLY</StatusPill>
          <StatusPill tone="danger">Live Execution: Disabled</StatusPill>
          <StatusPill tone="warn">Broker Placement: Not Implemented</StatusPill>
          <StatusPill tone="ok">Demo Trading: Enabled</StatusPill>
          <StatusPill tone="ok">Read-Only Guard: Active</StatusPill>
        </div>
      </CardHeader>
      <CardContent className="p-5 space-y-5">
        {/* Canonical safety posture — single source of truth, never says liveLocked=false */}
        <div className="rounded-md border border-border bg-card/50 p-3 text-[11px] font-mono grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1" data-testid="arx-canonical-safety">
          <div><span className="text-muted-foreground">Mode:</span> <span className="text-ruby">READ_ONLY</span></div>
          <div><span className="text-muted-foreground">Live Execution:</span> <span className="text-danger">Disabled</span></div>
          <div><span className="text-muted-foreground">Broker Placement:</span> <span className="text-warning">Not Implemented</span></div>
          <div><span className="text-muted-foreground">Demo Trading:</span> <span className="text-success">Enabled</span></div>
          <div><span className="text-muted-foreground">Read-Only Guard:</span> <span className="text-success">Active</span></div>
          <div><span className="text-muted-foreground">Live Locked:</span> <span className="text-success">True</span></div>
        </div>
        {/* MT5 snapshot strip */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
          <div><div className="text-muted-foreground">Account</div><div className="font-mono font-semibold">{mt5?.account ?? "—"}</div></div>
          <div><div className="text-muted-foreground">Balance</div><div className="font-mono font-semibold">{fmt(mt5?.balance)} {mt5?.currency ?? ""}</div></div>
          <div><div className="text-muted-foreground">Equity</div><div className="font-mono font-semibold">{fmt(mt5?.equity)} {mt5?.currency ?? ""}</div></div>
          <div><div className="text-muted-foreground">Free Margin</div><div className="font-mono font-semibold">{fmt(mt5?.freeMargin)}</div></div>
          <div><div className="text-muted-foreground">Open Positions</div><div className="font-mono font-semibold">{mt5?.openPositionsCount ?? "—"}</div></div>
        </div>

        {/* Analyze form */}
        <div className="flex flex-col md:flex-row gap-2 md:items-end">
          <div className="flex-1">
            <label className="text-[11px] uppercase tracking-wider text-muted-foreground">Symbol</label>
            <Input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="Volatility 75 Index" data-testid="arx-intel-symbol" />
          </div>
          <div className="w-32">
            <label className="text-[11px] uppercase tracking-wider text-muted-foreground">Risk %</label>
            <Input type="number" min={0.05} max={5} step={0.05} value={riskPercent}
                   onChange={(e) => setRiskPercent(Math.max(0.05, Math.min(5, Number(e.target.value) || 0.5)))}
                   data-testid="arx-intel-risk" />
          </div>
          <Button onClick={onAnalyze} disabled={analyzeMut.isPending} data-testid="arx-intel-analyze">
            {analyzeMut.isPending ? "Analyzing…" : "Analyze with ARX AI"}
          </Button>
          <Button variant="outline" onClick={onTestBlocked} disabled={blockedMut.isPending} data-testid="arx-intel-blocked-test">
            <ShieldOff size={14} className="mr-1" /> Test Read-Only Guard
          </Button>
        </div>

        {/* Stale-data banner */}
        {stale && (
          <div className="rounded border border-danger/40 bg-danger/10 p-3 text-sm text-danger flex gap-2 items-start" data-testid="arx-intel-stale-banner">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold">MT5 DATA STALE — analysis withheld.</div>
              <div className="text-xs mt-1">Heartbeat age {analysis?.mt5.heartbeatAgeSeconds ?? "—"}s exceeds {analysis?.mt5.freshnessThresholdSeconds}s threshold. ARX AI refuses to issue fresh trade decisions until the bridge recovers.</div>
            </div>
          </div>
        )}

        {/* Analysis result */}
        {analysis && !stale && (
          <div className="rounded border border-border p-3 space-y-3" data-testid="arx-intel-result">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone={analysis.decision === "PAPER_TRADEABLE" ? "ok" : analysis.decision === "WATCHLIST_CANDIDATE" ? "info" : "warn"}>
                {analysis.decision === "PAPER_TRADEABLE" ? "DEMO_TRADEABLE" : analysis.decision}
              </StatusPill>
              <StatusPill tone={analysis.signal.direction === "BUY" ? "ok" : analysis.signal.direction === "SELL" ? "danger" : "warn"}>
                {analysis.signal.direction} {analysis.symbol}
              </StatusPill>
              <StatusPill tone="info">Confidence {analysis.confidenceScore}/100</StatusPill>
              <StatusPill tone={analysis.riskScore >= 50 ? "danger" : analysis.riskScore >= 25 ? "warn" : "ok"}>
                Risk {analysis.riskScore}/100
              </StatusPill>
              <StatusPill tone="info">Suggested lot {analysis.suggestedLot}</StatusPill>
              <StatusPill tone="info">Strategy: {analysis.signal.strategy}</StatusPill>
            </div>
            <div className="grid grid-cols-3 gap-3 text-xs font-mono">
              <div><div className="text-muted-foreground">Entry</div><div>{analysis.signal.entryPrice.toFixed(5)}</div></div>
              <div><div className="text-muted-foreground">Stop Loss</div><div>{analysis.signal.stopLoss.toFixed(5)}</div></div>
              <div><div className="text-muted-foreground">Take Profit</div><div>{analysis.signal.takeProfit.toFixed(5)}</div></div>
            </div>
            <div className="text-xs text-muted-foreground space-y-1">
              {analysis.reasoning.map((r, i) => <div key={i}>• {r}</div>)}
            </div>
            {analysis.warnings.length > 0 && (
              <div className="text-xs text-warning space-y-1">
                {analysis.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <Button size="sm" onClick={onSaveAsWatchlist} disabled={createMut.isPending} data-testid="arx-intel-save">
                Save to Watchlist
              </Button>
              <Button size="sm" variant="outline" onClick={() => createMut.mutate({
                data: {
                  symbol: analysis.symbol,
                  direction: analysis.signal.direction === "BUY" ? "BUY" : "SELL",
                  entryIdea: analysis.signal.entryPrice, stopLossIdea: analysis.signal.stopLoss, takeProfitIdea: analysis.signal.takeProfit,
                  riskPercent: analysis.riskPercent, confidenceScore: analysis.confidenceScore, riskScore: analysis.riskScore,
                  suggestedLot: analysis.suggestedLot, aiReasoning: analysis.reasoning.join("\n"),
                  strategySource: analysis.signal.strategy, status: "PAPER_OPEN",
                },
              })} disabled={createMut.isPending || analysis.decision !== "PAPER_TRADEABLE"}>
                Open Demo Trade
              </Button>
            </div>
          </div>
        )}

        {/* Blocked envelope display */}
        {blocked && (
          <div className="rounded border border-danger/40 bg-danger/10 p-3 text-xs text-danger" data-testid="arx-intel-blocked-result">
            <div className="font-semibold flex items-center gap-2"><ShieldOff size={14} /> {blocked.status}</div>
            <div className="mt-1">{blocked.reason}</div>
            <div className="mt-1 font-mono text-[11px]">executionMode={blocked.executionMode} · placementLayer={blocked.placementLayer}</div>
          </div>
        )}

        {/* Latest ideas */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <Activity size={12} /> Latest Ideas
            </div>
            <div className="text-[11px] text-muted-foreground">{ideas.length} shown</div>
          </div>
          {ideasQuery.isLoading ? (
            <div className="h-12 rounded bg-muted/30 animate-pulse" />
          ) : ideas.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">No ideas yet — analyze a symbol above.</div>
          ) : (
            <div className="divide-y divide-border/50">
              {ideas.map((idea) => {
                const tone = idea.status === "PAPER_OPEN" ? "info"
                          : idea.status === "PAPER_CLOSED" ? "ok"
                          : idea.status === "REJECTED" ? "danger" : "warn";
                return (
                  <div key={idea.id} className="py-2 flex flex-col md:flex-row md:items-center gap-2" data-testid={`arx-intel-idea-${idea.id}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill tone={tone}>{idea.status === "PAPER_OPEN" ? "DEMO_OPEN" : idea.status === "PAPER_CLOSED" ? "DEMO_CLOSED" : idea.status === "PAPER_TRADEABLE" ? "DEMO_TRADEABLE" : idea.status}</StatusPill>
                      <StatusPill tone={idea.direction === "BUY" ? "ok" : "danger"}>{idea.direction}</StatusPill>
                      <span className="font-mono text-xs font-semibold">{idea.symbol}</span>
                    </div>
                    <div className="text-[11px] text-muted-foreground font-mono flex-1">
                      conf {idea.confidenceScore} · risk {idea.riskScore} · lot {idea.suggestedLot} · {idea.riskPercent}%
                    </div>
                    <div className="flex gap-1">
                      {idea.status === "WATCHLIST" && (
                        <Button size="sm" variant="outline" onClick={() => patchMut.mutate({ id: idea.id, data: { status: "PAPER_OPEN" } })}>
                          <CheckCircle2 size={12} className="mr-1" /> Open
                        </Button>
                      )}
                      {(idea.status === "WATCHLIST" || idea.status === "PAPER_OPEN") && (
                        <Button size="sm" variant="ghost" onClick={() => patchMut.mutate({ id: idea.id, data: { status: "REJECTED" } })}>
                          <XCircle size={12} className="mr-1" /> Reject
                        </Button>
                      )}
                      {idea.status === "PAPER_OPEN" && (
                        <Button size="sm" variant="ghost" onClick={() => patchMut.mutate({ id: idea.id, data: { status: "PAPER_CLOSED", outcomeNote: "Closed from dashboard" } })}>
                          Close
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {idea_reasoning_preview(ideas)}
        </div>
      </CardContent>
    </Card>
  );
}

function idea_reasoning_preview(ideas: IdeaRow[]) {
  const top = ideas[0];
  if (!top) return null;
  return (
    <div className="mt-3 rounded border border-border/60 bg-muted/20 p-2 text-[11px] text-muted-foreground whitespace-pre-line line-clamp-4" data-testid="arx-intel-reasoning-preview">
      <span className="font-semibold text-foreground">Latest reasoning · {top.symbol}: </span>{top.aiReasoning}
    </div>
  );
}
