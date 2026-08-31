import { useMemo, useState, useEffect } from "react";
import {
  useGetTimingBrain,
  getGetTimingBrainQueryKey,
  useGetTimingBrainMulti,
  getGetTimingBrainMultiQueryKey,
  GetTimingBrainTimeframe,
  GetTimingBrainMultiTimeframe,
  type GetTimingBrainParams,
  type GetTimingBrainMultiParams,
  type MarketTimingRead,
} from "@workspace/api-client-react";
import { useChartSymbol, bareSymbol } from "@/lib/use-chart-symbol";
import { scorePercent, TRAP_WARNING_THRESHOLD } from "@/lib/score-percent";
import { useAssistantName } from "@/lib/assistant-name";
import { PageTabs } from "@/components/ui/PageTabs";
import { useTradingMode } from "@/hooks/useTradingMode";
import { useViewMode } from "@/hooks/useViewMode";
import { GlobalMarketHeatCard } from "@/components/scanner/GlobalMarketHeatCard";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  Thermometer, Clock, AlertTriangle, TrendingUp, TrendingDown, Minus,
  Activity, Radio, Newspaper, BarChart2, History, Database,
  ShieldAlert, ArrowRight, CheckCircle2, XCircle, Pause, Info,
  CalendarDays, Flame, Zap, Star, Globe,
} from "lucide-react";

const MULTI_SYMBOLS = "EURUSD,GBPUSD,USDJPY,XAUUSD,GBPJPY,USDCAD";

// ── Colour helpers ───────────────────────────────────────────────────────────

function heatBg(score: number): string {
  if (score >= 80) return "bg-success/20 border-success/30 text-success";
  if (score >= 60) return "bg-warning/20 border-warning/30 text-warning";
  if (score >= 40) return "bg-primary/20 border-primary/30 text-primary";
  return "bg-muted border-border/20 text-txt-secondary";
}

function heatBar(score: number): string {
  if (score >= 80) return "bg-success";
  if (score >= 60) return "bg-warning";
  if (score >= 40) return "bg-primary";
  return "bg-muted";
}

function gradeColor(grade: string): string {
  if (grade === "A+" || grade === "A") return "bg-success/20 text-success border-success/40";
  if (grade === "B") return "bg-primary/20 text-primary border-primary/40";
  if (grade === "C") return "bg-warning/20 text-warning border-warning/40";
  if (grade === "D") return "bg-warning/20 text-warning border-warning/40";
  return "bg-danger/20 text-danger border-danger/40";
}

function permissionColor(perm: string): string {
  if (perm === "GO") return "bg-success/20 text-success border-success/40";
  if (perm === "WAIT_FOR_ENTRY" || perm === "WAIT_NEWS") return "bg-warning/20 text-warning border-warning/40";
  return "bg-danger/20 text-danger border-danger/40";
}

function actionColor(action: string): string {
  if (action === "BUY") return "bg-success/20 text-success border-success/40";
  if (action === "SELL") return "bg-danger/20 text-danger border-danger/40";
  if (action.startsWith("WAIT")) return "bg-warning/20 text-warning border-warning/40";
  if (action === "STAND_DOWN") return "bg-danger/20 text-danger border-danger/40";
  return "bg-muted text-txt-secondary border-border/20";
}

function flowVerdict(verdict: string): string {
  if (verdict === "ALIGNED") return "bg-success/20 text-success border-success/40";
  if (verdict === "CONFLICTED" || verdict === "OPPOSING") return "bg-danger/20 text-danger border-danger/40";
  if (verdict === "NEUTRAL") return "bg-muted text-txt-secondary border-border/20";
  return "bg-muted text-txt-secondary border-border/20";
}

function humanizePermission(perm: string): string {
  const map: Record<string, string> = {
    GO: "Go",
    WAIT_FOR_ENTRY: "Wait for entry",
    WAIT_NEWS: "Wait — news active",
    NO_TRADE: "No trade",
    STAND_DOWN: "Stand down",
  };
  return map[perm] ?? perm;
}

function humanizeAction(action: string): string {
  const map: Record<string, string> = {
    BUY: "Buy",
    SELL: "Sell",
    WAIT_FOR_PULLBACK: "Wait for pullback",
    WAIT_FOR_NEWS: "Wait for news",
    WAIT_BETTER_TIMING: "Wait — better timing",
    STAND_DOWN: "Stand down",
    WATCH_ONLY: "Watch only",
  };
  return map[action] ?? action;
}

function humanizeMoveStage(stage: string): string {
  const map: Record<string, string> = {
    EARLY: "Early move",
    DEVELOPING: "Developing",
    MATURE: "Mature",
    EXHAUSTED: "Exhausted",
  };
  return map[stage] ?? stage;
}

function humanizeNewsPhase(phase: string): string {
  const map: Record<string, string> = {
    PRE_EVENT: "Pre-event",
    AT_EVENT: "At event",
    POST_EVENT: "Post-event",
    SETTLED: "Settled",
    NONE: "No event",
  };
  return map[phase] ?? phase;
}

function humanizeBroadVerdict(verdict: string): string {
  const map: Record<string, string> = {
    ALIGNED: "Aligned",
    CONFLICTED: "Conflicted",
    NEUTRAL: "Neutral",
    OPPOSING: "Opposing",
    UNAVAILABLE: "Unavailable",
  };
  return map[verdict] ?? verdict;
}

// ── Shared small components ─────────────────────────────────────────────────

function ScoreBar({ label, score, tooltip }: { label: string; score: number; tooltip?: string }) {
  return (
    <div className="space-y-1" title={tooltip}>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono tabular-nums">{Math.round(score)}</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", heatBar(score))}
          style={{ width: `${Math.min(100, Math.max(0, score))}%` }}
        />
      </div>
    </div>
  );
}

function ScorePill({ label, value, cls }: { label: string; value: React.ReactNode; cls?: string }) {
  return (
    <div className={cn("flex flex-col items-center rounded-lg border p-2 gap-0.5 text-center min-w-0", cls)}>
      <span className="text-[10px] text-muted-foreground leading-none truncate w-full text-center">{label}</span>
      <span className="text-xs font-semibold leading-tight">{value}</span>
    </div>
  );
}

function TimingLoadingSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-28 w-full rounded-xl" />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16 rounded-lg" />)}
      </div>
      <Skeleton className="h-36 w-full rounded-xl" />
    </div>
  );
}

function HonestEmpty({ message }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center space-y-2">
      <Activity className="h-8 w-8 text-muted-foreground/40" />
      <p className="text-sm text-muted-foreground">
        {message ?? "Timing data not available for this symbol right now."}
      </p>
      <p className="text-xs text-muted-foreground/60">Data is live when a market provider is active.</p>
    </div>
  );
}

function DataQualityBadge({ label }: { label: string }) {
  const cls =
    label === "real" ? "bg-success/20 text-success border-success/40"
    : label === "partial" ? "bg-warning/20 text-warning border-warning/40"
    : label === "basic_timing_estimate" ? "bg-primary/20 text-primary border-primary/40"
    : "bg-muted text-txt-secondary border-border/20";
  const labels: Record<string, string> = {
    real: "Real data",
    partial: "Partial data",
    basic_timing_estimate: "Basic timing estimate",
    unavailable: "Unavailable",
  };
  return <Badge variant="outline" className={cn("text-[10px] font-medium", cls)}>{labels[label] ?? label}</Badge>;
}

// Non-admin status-card copy for the Data Status tab. Three DISTINCT honest
// states: no read / unavailable ≠ session-clock-only estimate ≠ live market
// intelligence. A "basic_timing_estimate" read is derived from the session
// clock alone (no candles AND no quotes), so it must never be described as
// active market intelligence. Exported for tests.
export function timingStatusDescription(label: string | null): string {
  if (label == null || label === "unavailable") {
    return "Market timing data is currently unavailable for the selected symbol. Your trading surfaces are unaffected — timing is advisory only.";
  }
  if (label === "basic_timing_estimate") {
    return "Session-clock estimate only — no live market data (candles or quotes) is connected for this symbol. Scores here are timing estimates, not measured market readings.";
  }
  return "Market timing intelligence is active for the selected symbol. Scores update automatically.";
}

// ── Tab: Now ────────────────────────────────────────────────────────────────

function NowTab({ data, isLoading, symbol }: { data: MarketTimingRead | undefined; isLoading: boolean; symbol: string }) {
  if (isLoading) return <TimingLoadingSkeleton />;
  if (!data) return <HonestEmpty message={`No timing data available for ${symbol || "the selected symbol"}.`} />;

  const biasIcon =
    data.pressureBias === "BUY" ? <TrendingUp className="h-3.5 w-3.5 text-success" />
    : data.pressureBias === "SELL" ? <TrendingDown className="h-3.5 w-3.5 text-danger" />
    : <Minus className="h-3.5 w-3.5 text-txt-secondary" />;

  return (
    <div className="space-y-4">
      {/* Heat summary hero card */}
      <Card className={cn("border", heatBg(data.heatScore))}>
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Thermometer className="h-4 w-4" />
                {data.symbol}
                <span className="text-muted-foreground font-normal text-sm">· {data.timeframe}</span>
              </CardTitle>
              <CardDescription className="mt-0.5">
                {data.heatState}
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <DataQualityBadge label={data.dataQuality.label} />
              <Badge variant="outline" className={cn(gradeColor(data.timingGrade))}>
                Grade {data.timingGrade}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-4xl font-bold tabular-nums">{Math.round(data.heatScore)}</div>
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span>Heat score (0–100)</span>
              <span>{humanizeMoveStage(data.moveStage)}</span>
            </div>
          </div>

          {/* Separated scores */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <ScorePill label="Tradeability" value={Math.round(data.tradeabilityScore)} />
            <ScorePill label="Edge" value={Math.round(data.edgeScore)} />
            <ScorePill label="Danger" value={Math.round(data.dangerScore)} cls="border-danger/20" />
            <ScorePill label="Trap prob." value={scorePercent(data.trapProbability)} />
            <ScorePill label="Room to move" value={Math.round(data.roomToMove)} />
            <ScorePill
              label="Pressure"
              value={
                <span className="flex items-center gap-1">
                  {biasIcon}
                  {data.pressureBias === "BUY" ? "Buyers" : data.pressureBias === "SELL" ? "Sellers" : "Neutral"}
                </span>
              }
            />
          </div>

          {/* Entry permission + best action */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className={cn("rounded-lg border p-3", permissionColor(data.entryPermission))}>
              <div className="text-[10px] text-muted-foreground mb-0.5">Entry permission</div>
              <div className="font-semibold text-sm">{humanizePermission(data.entryPermission)}</div>
            </div>
            <div className={cn("rounded-lg border p-3", actionColor(data.bestAction))}>
              <div className="text-[10px] text-muted-foreground mb-0.5">Best action</div>
              <div className="font-semibold text-sm">{humanizeAction(data.bestAction)}</div>
            </div>
          </div>

          {data.actionReason && (
            <p className="text-xs text-muted-foreground leading-relaxed border-l-2 border-border pl-3">
              {data.actionReason}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Score bars */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Score Breakdown</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <ScoreBar label="Heat" score={data.heatScore} />
          <ScoreBar label="Tradeability" score={data.tradeabilityScore} />
          <ScoreBar label="Edge" score={data.edgeScore} />
          <ScoreBar label="Danger" score={data.dangerScore} tooltip="Higher = more dangerous" />
          <ScoreBar label="Room to move" score={data.roomToMove} />
        </CardContent>
      </Card>

      {/* Heat source */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Heat Source</CardTitle>
          <CardDescription className="text-xs">{data.heatSource.explanation}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Primary source</span>
            <span className="font-medium">{data.heatSource.primary}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Primary confidence</span>
            <span className="font-mono tabular-nums">{scorePercent(data.heatSource.primaryConfidence)}</span>
          </div>
          {data.heatSource.backup && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Backup source</span>
                <span className="font-medium">{data.heatSource.backup}</span>
              </div>
              {data.heatSource.backupConfidence != null && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Backup confidence</span>
                  <span className="font-mono tabular-nums">{scorePercent(data.heatSource.backupConfidence)}</span>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Session summary inline */}
      <SessionCard session={data.session} compact />
    </div>
  );
}

// ── Tab: Today ─────────────────────────────────────────────────────────────

function TodayTab({ data, multiData }: { data: MarketTimingRead | undefined; multiData: MarketTimingRead[] }) {
  const session = data?.session;
  const localTime = session?.userLocalTime;

  return (
    <div className="space-y-4">
      {/* Session overview */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            Today's Market Sessions
          </CardTitle>
          {localTime && (
            <CardDescription className="text-xs">Your local time: {localTime}</CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {session ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {["Asia", "London", "New York"].map((name) => {
                  const isCurrent = session.sessionName.toLowerCase().includes(name.toLowerCase());
                  return (
                    <div
                      key={name}
                      className={cn(
                        "rounded-lg border p-3 text-xs",
                        isCurrent
                          ? "border-primary/40 bg-primary/5"
                          : "border-border bg-card/50"
                      )}
                    >
                      <div className="flex items-center gap-1.5 mb-1.5">
                        {isCurrent && (
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
                        )}
                        <span className={cn("font-medium", isCurrent ? "text-foreground" : "text-muted-foreground")}>
                          {name}
                        </span>
                        {isCurrent && (
                          <Badge variant="outline" className="text-[9px] px-1 py-0 border-success/40 text-success">
                            Active
                          </Badge>
                        )}
                      </div>
                      {isCurrent && (
                        <div className="space-y-0.5 text-muted-foreground">
                          <div>Kill zone: <span className="text-foreground">{session.killZone}</span></div>
                          <div>Heat bonus: <span className="text-foreground font-mono">+{session.sessionHeatBonus}</span></div>
                          <div>Fakeout risk: <span className="text-foreground font-mono">{scorePercent(session.fakeoutRisk)}</span></div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">{session.sessionDescription}</p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground py-4 text-center">
              Session data will appear when timing data is available.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Multi-symbol quick view */}
      {multiData.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Today's Symbol Heat</CardTitle>
            <CardDescription className="text-xs">Advisory — never an execution gate.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {multiData.map((r) => (
                <div key={r.symbol} className="flex items-center gap-3">
                  <span className="text-xs font-medium w-16 shrink-0">{r.symbol}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className={cn("h-full rounded-full", heatBar(r.heatScore))}
                      style={{ width: `${r.heatScore}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono tabular-nums w-8 text-right">{Math.round(r.heatScore)}</span>
                  <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 h-5", actionColor(r.bestAction))}>
                    {humanizeAction(r.bestAction)}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {multiData.length === 0 && !data && (
        <HonestEmpty message="Timing overview will be available when market data is connected." />
      )}
    </div>
  );
}

// ── Tab: By Symbol ─────────────────────────────────────────────────────────

function BySymbolTab({ results, isLoading, selectedSymbol }: { results: MarketTimingRead[]; isLoading: boolean; selectedSymbol: string }) {
  if (isLoading) return <TimingLoadingSkeleton />;
  if (results.length === 0) return <HonestEmpty message="No timing data available. Multi-symbol reads require a connected market data provider." />;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Showing heat scores across 6 major pairs. Scores are advisory only.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {results.map((r) => {
          const isSelected = r.symbol === selectedSymbol;
          return (
            <Card
              key={r.symbol}
              className={cn("transition-colors", isSelected && "ring-1 ring-primary/40 border-primary/30")}
            >
              <CardHeader className="pb-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <CardTitle className="text-sm">{r.symbol}</CardTitle>
                    {isSelected && (
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-primary/40 text-primary">
                        Selected
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <DataQualityBadge label={r.dataQuality.label} />
                    <Badge variant="outline" className={cn("text-[10px]", gradeColor(r.timingGrade))}>
                      {r.timingGrade}
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-2.5">
                <div className={cn("rounded-md border p-2 flex items-center justify-between", heatBg(r.heatScore))}>
                  <div className="text-xs text-muted-foreground">{r.heatState}</div>
                  <div className="text-xl font-bold tabular-nums">{Math.round(r.heatScore)}</div>
                </div>
                <div className="grid grid-cols-3 gap-1.5 text-[10px] text-muted-foreground text-center">
                  <ScorePill label="Edge" value={Math.round(r.edgeScore)} />
                  <ScorePill label="Danger" value={Math.round(r.dangerScore)} />
                  <ScorePill label="Trade" value={Math.round(r.tradeabilityScore)} />
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className={cn("inline-flex items-center gap-1 rounded border px-2 py-0.5 font-medium", actionColor(r.bestAction))}>
                    {humanizeAction(r.bestAction)}
                  </span>
                  <span className={cn("inline-flex items-center gap-1 rounded border px-2 py-0.5", permissionColor(r.entryPermission))}>
                    {humanizePermission(r.entryPermission)}
                  </span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ── Shared session card ─────────────────────────────────────────────────────

function SessionCard({
  session,
  compact = false,
}: {
  session: MarketTimingRead["session"] | undefined;
  compact?: boolean;
}) {
  if (!session) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Radio className="h-4 w-4 text-muted-foreground" />
            Session: {session.sessionName}
          </CardTitle>
          <div className="flex items-center gap-1.5">
            {session.isKillZoneActive && (
              <Badge variant="outline" className="text-[10px] bg-warning/20 text-warning border-warning/40">
                Kill zone active
              </Badge>
            )}
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              {session.killZone}
            </Badge>
          </div>
        </div>
        {session.userLocalTime && (
          <CardDescription className="text-xs">Local: {session.userLocalTime}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {!compact && (
          <p className="text-xs text-muted-foreground leading-relaxed">{session.sessionDescription}</p>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
          <ScorePill label="Heat bonus" value={`+${session.sessionHeatBonus}`} />
          <ScorePill label="Fakeout risk" value={scorePercent(session.fakeoutRisk)} />
          <ScorePill label="Trade bonus" value={`+${session.tradeabilityBonus}`} />
        </div>
        {session.bestSymbols.length > 0 && (
          <div>
            <div className="text-[10px] text-muted-foreground mb-1">Best this session</div>
            <div className="flex flex-wrap gap-1">
              {session.bestSymbols.map((s) => (
                <Badge key={s} variant="outline" className="text-[10px] bg-success/10 text-success border-success/30">
                  {s}
                </Badge>
              ))}
            </div>
          </div>
        )}
        {session.dangerSymbols.length > 0 && (
          <div>
            <div className="text-[10px] text-muted-foreground mb-1">Caution this session</div>
            <div className="flex flex-wrap gap-1">
              {session.dangerSymbols.map((s) => (
                <Badge key={s} variant="outline" className="text-[10px] bg-danger/10 text-danger border-danger/30">
                  {s}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Tab: By Session ─────────────────────────────────────────────────────────

function BySessionTab({ data }: { data: MarketTimingRead | undefined }) {
  if (!data) return <HonestEmpty message="Session data requires a timing read for the selected symbol." />;
  return (
    <div className="space-y-4">
      <SessionCard session={data.session} />
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Session Context</CardTitle>
          <CardDescription className="text-xs">
            Session timing is derived from UTC hour {data.session.utcHour}:00. Kill zones mark the highest-probability windows.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground leading-relaxed">{data.session.sessionDescription}</p>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Tab: Buy/Sell Windows ───────────────────────────────────────────────────

function BuySellWindowsTab({ data }: { data: MarketTimingRead | undefined }) {
  if (!data) return <HonestEmpty message="Buy/sell pressure data requires a timing read for the selected symbol." />;

  const buy = data.buyPressure;
  const sell = data.sellPressure;
  const bias = data.pressureBias;
  // Without candle data the engine has no volume/candle evidence — its
  // pressure fields are defaults, not measurements. Withhold them honestly
  // instead of rendering a fabricated 50/50 meter.
  const hasCandles = data.dataQuality.hasCandleData;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-sm">Buyer vs. Seller Control</CardTitle>
            <DataQualityBadge label={data.dataQuality.label} />
          </div>
          <CardDescription className="text-xs">
            Advisory pressure meter. Higher score = stronger side control. Not a signal; use with full read context.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!hasCandles ? (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
              <div className="text-xs leading-relaxed">
                <div className="text-sm font-semibold text-warning">
                  Couldn't measure buy/sell pressure — no candle data for {data.symbol}.
                </div>
                <div className="text-muted-foreground mt-0.5">
                  Pressure is measured from real candle volume. Showing nothing rather than guessing a neutral 50/50.
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* Visual meter */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs font-medium">
                  <span className="text-success">Buyers</span>
                  <span className="text-danger">Sellers</span>
                </div>
                <div className="relative h-4 rounded-full overflow-hidden bg-muted flex">
                  <div className="h-full bg-success/70 transition-all" style={{ width: `${buy}%` }} />
                  <div className="h-full bg-danger/70 transition-all" style={{ width: `${sell}%` }} />
                </div>
                <div className="flex justify-between text-xs text-muted-foreground font-mono tabular-nums">
                  <span>{Math.round(buy)}</span>
                  <span>{Math.round(sell)}</span>
                </div>
              </div>

              {/* Bias verdict */}
              <div className={cn(
                "rounded-lg border p-3 flex items-center gap-3",
                bias === "BUY" ? "bg-success/10 border-success/30"
                : bias === "SELL" ? "bg-danger/10 border-danger/30"
                : "bg-muted border-border/20"
              )}>
                {bias === "BUY" ? <TrendingUp className="h-5 w-5 text-success shrink-0" />
                  : bias === "SELL" ? <TrendingDown className="h-5 w-5 text-danger shrink-0" />
                  : <Minus className="h-5 w-5 text-txt-secondary shrink-0" />}
                <div>
                  <div className="text-sm font-semibold">
                    {bias === "BUY" ? "Buyer control" : bias === "SELL" ? "Seller control" : "Neutral pressure"}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">{data.actionReason}</div>
                </div>
              </div>

              {/* Scores detail */}
              <div className="grid grid-cols-2 gap-2">
                <ScorePill
                  label="Buy pressure"
                  value={<span className="text-success">{Math.round(buy)}</span>}
                  cls="border-success/20"
                />
                <ScorePill
                  label="Sell pressure"
                  value={<span className="text-danger">{Math.round(sell)}</span>}
                  cls="border-danger/20"
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Best action for this window */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Window Verdict</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cn("inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-semibold", actionColor(data.bestAction))}>
              {humanizeAction(data.bestAction)}
            </span>
            <span className={cn("inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm", permissionColor(data.entryPermission))}>
              {humanizePermission(data.entryPermission)}
            </span>
          </div>
          {data.actionReason && (
            <p className="text-xs text-muted-foreground leading-relaxed">{data.actionReason}</p>
          )}
          {!hasCandles && (
            <p className="text-xs text-warning flex items-center gap-1.5">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              Based on session timing only — no candle data behind this verdict.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Tab: Danger Windows ─────────────────────────────────────────────────────

function DangerWindowsTab({ data, results }: { data: MarketTimingRead | undefined; results: MarketTimingRead[] }) {
  return (
    <div className="space-y-4">
      {data && (
        <Card className={cn("border", data.dangerScore >= 60 ? "border-danger/30 bg-danger/5" : "")}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <CardTitle className="text-sm flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-danger" />
                {data.symbol} — Danger Window
              </CardTitle>
              <div className="flex items-center gap-1.5">
                <DataQualityBadge label={data.dataQuality.label} />
                <Badge
                  variant="outline"
                  className={cn(
                    "text-xs",
                    data.dangerScore >= 70 ? "bg-danger/20 text-danger border-danger/40"
                    : data.dangerScore >= 40 ? "bg-warning/20 text-warning border-warning/40"
                    : "bg-muted text-txt-secondary border-border/20"
                  )}
                >
                  Danger {Math.round(data.dangerScore)}
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <ScorePill label="Danger score" value={Math.round(data.dangerScore)} cls={data.dangerScore >= 60 ? "border-danger/20" : ""} />
              {/* Without candle data the engine's "trap probability" is just the
                  session's static fakeout-risk constant — withhold the number
                  rather than dressing a session default up as a measurement. */}
              <ScorePill
                label="Trap prob."
                value={data.dataQuality.hasCandleData ? scorePercent(data.trapProbability) : "—"}
                cls={data.dataQuality.hasCandleData && data.trapProbability >= TRAP_WARNING_THRESHOLD ? "border-warning/20" : ""}
              />
              <ScorePill label="Move stage" value={humanizeMoveStage(data.moveStage)} />
            </div>
            {!data.dataQuality.hasCandleData && (
              <p className="text-xs text-warning flex items-center gap-1.5">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                No candle data — trap probability can't be measured, and the danger score reflects session timing and news only.
              </p>
            )}
            {data.newsOverlay.blocksTrade && (
              <div className="rounded-md border border-danger/30 bg-danger/10 p-2.5 text-xs text-danger flex items-center gap-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                News event is blocking trade — active event: {data.newsOverlay.eventName ?? "economic event"}
              </div>
            )}
            {data.entryPermission === "STAND_DOWN" && (
              <div className="rounded-md border border-danger/30 bg-danger/10 p-2.5 text-xs text-danger flex items-center gap-2">
                <XCircle className="h-3.5 w-3.5 shrink-0" />
                Entry permission: Stand down — this is a high-risk window
              </div>
            )}
            {data.dangerScore < 40 && !data.newsOverlay.blocksTrade && (
              <div className="rounded-md border border-success/30 bg-success/10 p-2.5 text-xs text-success flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                Low danger — no active danger window detected
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Cross-symbol danger rankings */}
      {results.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Cross-Symbol Danger Ranking</CardTitle>
            <CardDescription className="text-xs">Symbols ranked by danger score. Higher = more dangerous right now.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {[...results].sort((a, b) => b.dangerScore - a.dangerScore).map((r) => (
                <div key={r.symbol} className="flex items-center gap-3">
                  <span className="text-xs font-medium w-16 shrink-0">{r.symbol}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        r.dangerScore >= 70 ? "bg-danger" : r.dangerScore >= 40 ? "bg-warning" : "bg-muted"
                      )}
                      style={{ width: `${r.dangerScore}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono tabular-nums w-8 text-right">{Math.round(r.dangerScore)}</span>
                  {/* A trap warning is only real when candles backed the read;
                      otherwise trapProbability is a session constant. */}
                  {!r.dataQuality.hasCandleData ? (
                    <Badge variant="outline" className="text-[9px] px-1 bg-muted text-txt-secondary border-border/20" title="No candle data — danger reflects session timing and news only">
                      No candles
                    </Badge>
                  ) : r.trapProbability >= TRAP_WARNING_THRESHOLD && (
                    <Badge variant="outline" className="text-[9px] px-1 bg-warning/10 text-warning border-warning/30">
                      Trap
                    </Badge>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {!data && results.length === 0 && (
        <HonestEmpty message="Danger window data requires timing reads. Connect a market data provider to activate." />
      )}
    </div>
  );
}

// ── Tab: News Heat ──────────────────────────────────────────────────────────

function NewsHeatTab({ data }: { data: MarketTimingRead | undefined }) {
  if (!data) return <HonestEmpty message="News heat data requires a timing read for the selected symbol." />;

  const news = data.newsOverlay;
  const hasEvent = news.phase !== "NONE";

  return (
    <div className="space-y-4">
      <Card className={cn("border", news.blocksTrade ? "border-danger/30 bg-danger/5" : hasEvent ? "border-warning/30 bg-warning/5" : "")}>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-sm flex items-center gap-2">
              <Newspaper className="h-4 w-4 text-muted-foreground" />
              {data.symbol} — News Heat
            </CardTitle>
            <Badge
              variant="outline"
              className={cn(
                "text-[10px]",
                news.blocksTrade ? "bg-danger/20 text-danger border-danger/40"
                : hasEvent ? "bg-warning/20 text-warning border-warning/40"
                : "bg-muted text-txt-secondary border-border/20"
              )}
            >
              {humanizeNewsPhase(news.phase)}
            </Badge>
          </div>
          {data.dataQuality.hasNewsData ? (
            <CardDescription className="text-xs">Live news data</CardDescription>
          ) : (
            <CardDescription className="text-xs text-warning/80">
              No live news feed connected — showing basic timing estimate only
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {hasEvent && news.eventName ? (
            <>
              <div className="flex items-start gap-2">
                <AlertTriangle className={cn("h-4 w-4 mt-0.5 shrink-0", news.blocksTrade ? "text-danger" : "text-warning")} />
                <div>
                  <div className="text-sm font-medium">{news.eventName}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Type: {news.eventType.replace(/_/g, " ")}
                    {news.minutesUntil != null && news.minutesUntil > 0 && ` · in ${Math.round(news.minutesUntil)} min`}
                    {news.minutesSince != null && news.minutesSince > 0 && ` · ${Math.round(news.minutesSince)} min ago`}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <ScorePill
                  label="Heat adjustment"
                  value={news.heatAdjustment >= 0 ? `+${news.heatAdjustment}` : `${news.heatAdjustment}`}
                  cls={news.heatAdjustment > 0 ? "border-warning/20" : ""}
                />
                {news.surpriseScore != null && (
                  <ScorePill label="Surprise score" value={scorePercent(news.surpriseScore)} />
                )}
                <ScorePill
                  label="Blocks trade"
                  value={news.blocksTrade ? "Yes" : "No"}
                  cls={news.blocksTrade ? "border-danger/20" : "border-success/20"}
                />
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
              No active news events detected for {data.symbol}.
              {!data.dataQuality.hasNewsData && (
                <span className="text-warning/80"> (No live news feed)</span>
              )}
            </div>
          )}

          {news.heatAdjustment !== 0 && (
            <p className="text-xs text-muted-foreground border-l-2 border-border pl-3">
              News is {news.heatAdjustment > 0 ? "increasing" : "decreasing"} heat by {Math.abs(news.heatAdjustment)} points.
            </p>
          )}
        </CardContent>
      </Card>

      {!data.dataQuality.hasNewsData && (
        <Card className="border-border/50">
          <CardContent className="pt-4">
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5 shrink-0 mt-0.5 text-primary" />
              <span>
                Real-time news heat requires a connected news/economic calendar provider.
                Timing estimates are still available — they're labelled as "basic timing estimate."
              </span>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Tab: Broad Flow ─────────────────────────────────────────────────────────

function BroadFlowTab({ data }: { data: MarketTimingRead | undefined }) {
  if (!data) return <HonestEmpty message="Broad flow data requires a timing read for the selected symbol." />;

  const flow = data.broadFlow;
  const available = flow.verdict !== "UNAVAILABLE";

  return (
    <div className="space-y-4">
      <Card className={cn("border", flowVerdict(flow.verdict).split(" ").filter((c) => c.startsWith("border-")).join(" "))}>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-sm flex items-center gap-2">
              <BarChart2 className="h-4 w-4 text-muted-foreground" />
              Broad / Institutional Flow
            </CardTitle>
            <Badge variant="outline" className={cn("text-[10px]", flowVerdict(flow.verdict))}>
              {humanizeBroadVerdict(flow.verdict)}
            </Badge>
          </div>
          {data.dataQuality.hasBroadFlowData ? (
            <CardDescription className="text-xs">Live cross-asset data</CardDescription>
          ) : (
            <CardDescription className="text-xs text-warning/80">Basic estimate — no cross-asset feed connected</CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {available ? (
            <>
              <p className="text-sm leading-relaxed">{flow.description}</p>

              <div className="grid grid-cols-2 gap-2">
                <ScorePill
                  label="Institutional flow score"
                  value={Math.round(flow.institutionalFlowScore)}
                />
                <ScorePill
                  label="Competing catalyst"
                  value={flow.competingCatalyst ? "Yes" : "No"}
                  cls={flow.competingCatalyst ? "border-warning/20" : "border-success/20"}
                />
              </div>

              {flow.correlatedAssets.length > 0 && (
                <div>
                  <div className="text-xs text-muted-foreground mb-2">Correlated assets</div>
                  <div className="space-y-1.5">
                    {flow.correlatedAssets.map((asset) => (
                      <div key={asset.symbol} className="flex items-center gap-2 text-xs">
                        <span className="font-medium w-16 shrink-0">{asset.symbol}</span>
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[9px] px-1.5",
                            asset.direction === "BULL" ? "text-success border-success/30"
                            : asset.direction === "BEAR" ? "text-danger border-danger/30"
                            : "text-txt-secondary border-border/20"
                          )}
                        >
                          {asset.direction}
                        </Badge>
                        <ArrowRight className="h-2.5 w-2.5 text-muted-foreground" />
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[9px] px-1.5",
                            asset.contribution === "CONFIRMS" ? "text-success border-success/30"
                            : asset.contribution === "CONFLICTS" ? "text-danger border-danger/30"
                            : "text-txt-secondary border-border/20"
                          )}
                        >
                          {asset.contribution.toLowerCase()}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Pause className="h-4 w-4 shrink-0" />
              Broad flow data is unavailable right now. A cross-asset market provider is required.
            </div>
          )}
        </CardContent>
      </Card>

      {!data.dataQuality.hasBroadFlowData && (
        <Card className="border-border/50">
          <CardContent className="pt-4">
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5 shrink-0 mt-0.5 text-primary" />
              <span>
                Institutional flow scores require cross-asset data (indices, bonds, commodities).
                When unavailable, timing estimates are still provided from session and candle analysis.
              </span>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Tab: Replay ─────────────────────────────────────────────────────────────

type HeatSnapshot = {
  id: number; symbol: string; timeframe: string; generatedAt: string;
  heatScore: number; tradeabilityScore: number; edgeScore: number;
  dangerScore: number; trapProbability: number; roomToMove: number;
  timingGrade: string; entryPermission: string; heatState: string;
  moveStage: string; bestAction: string; broadFlowVerdict: string;
  newsPhase: string; dataQualityLabel: string;
};
type ReplayEvent = {
  type: string; label: string; at: string;
  heatScore: number; heatState: string; grade: string;
};
type ReplayData = {
  honestEmpty: boolean;
  symbol: string;
  fromDate: string; toDate: string;
  snapshotCount?: number;
  snapshots: HeatSnapshot[];
  replayEvents?: ReplayEvent[];
  message?: string;
};

function replayGradeColor(g: string): string {
  if (g === "A+" || g === "A") return "text-success";
  if (g === "B") return "text-primary";
  if (g === "C") return "text-warning";
  if (g === "D") return "text-warning";
  return "text-danger";
}
function heatStateLabel(s: string): string {
  return s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}
function eventIcon(type: string) {
  if (type === "best_entry") return <Star className="h-3.5 w-3.5 text-success" />;
  if (type === "heat_rising") return <Flame className="h-3.5 w-3.5 text-warning" />;
  if (type === "flow_confirm") return <TrendingUp className="h-3.5 w-3.5 text-primary" />;
  if (type === "fakeout") return <AlertTriangle className="h-3.5 w-3.5 text-warning" />;
  if (type === "news_hit") return <Newspaper className="h-3.5 w-3.5 text-warning" />;
  if (type === "exhaustion") return <XCircle className="h-3.5 w-3.5 text-danger" />;
  return <Zap className="h-3.5 w-3.5 text-muted-foreground" />;
}
function fmtTime(iso: string) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function ReplayTab() {
  const [busSymbol] = useChartSymbol();
  const sym = bareSymbol(busSymbol);

  const today = new Date().toISOString().slice(0, 10);
  const [dateParam, setDateParam] = useState(today);
  const [data, setData] = useState<ReplayData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<HeatSnapshot | null>(null);

  useEffect(() => {
    if (!sym) return;
    setLoading(true);
    setErr(null);
    setSelected(null);
    fetch(`/api/me/heat/replay?symbol=${encodeURIComponent(sym)}&date=${dateParam}`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setErr(String(e)); setLoading(false); });
  }, [sym, dateParam]);

  return (
    <div className="space-y-4">
      {/* Controls */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <History className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Heat Map Replay</span>
            </div>
            <Badge variant="outline" className="text-[10px] text-muted-foreground">Advisory only</Badge>
            <div className="ml-auto flex items-center gap-2">
              <label className="text-xs text-muted-foreground">Symbol</label>
              <span className="rounded border border-border bg-secondary/60 px-2 py-0.5 text-xs font-mono">{sym || "—"}</span>
              <label className="text-xs text-muted-foreground">Date</label>
              <input
                type="date"
                value={dateParam}
                max={today}
                onChange={(e) => setDateParam(e.target.value)}
                className="rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {loading && (
        <div className="grid gap-3 md:grid-cols-2">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      )}
      {err && <p className="text-sm text-danger rounded border border-danger/40 bg-danger/10 px-3 py-2">{err}</p>}

      {!loading && !err && data && (
        data.honestEmpty ? (
          <Card>
            <CardContent className="pt-6">
              <div className="flex flex-col items-center justify-center py-10 text-center space-y-3 max-w-sm mx-auto">
                <History className="h-10 w-10 text-muted-foreground/30" />
                <h3 className="text-sm font-medium text-muted-foreground">No snapshots for {sym} on {dateParam}</h3>
                <p className="text-xs text-muted-foreground/70 leading-relaxed">
                  {data.message ?? "Heat snapshots accumulate as the heat map is used on a symbol. Try a different date or use the heat map tab to generate snapshots."}
                </p>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-3">
            {/* Replay events timeline */}
            <Card className="lg:col-span-1">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Zap className="h-4 w-4 text-primary" /> Key Events
                </CardTitle>
                <CardDescription className="text-xs">
                  {data.replayEvents?.length ?? 0} market events derived from {data.snapshotCount} snapshots
                </CardDescription>
              </CardHeader>
              <CardContent>
                {(data.replayEvents?.length ?? 0) === 0 ? (
                  <p className="text-xs text-muted-foreground">No notable events detected in this window.</p>
                ) : (
                  <div className="space-y-2">
                    {data.replayEvents!.map((ev, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        {eventIcon(ev.type)}
                        <span className="w-16 shrink-0 text-muted-foreground">{fmtTime(ev.at)}</span>
                        <span className="flex-1 min-w-0 truncate">{ev.label}</span>
                        <span className={cn("shrink-0 font-mono font-bold", replayGradeColor(ev.grade))}>{ev.grade}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Snapshot list */}
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <BarChart2 className="h-4 w-4 text-muted-foreground" /> Snapshots
                </CardTitle>
                <CardDescription className="text-xs">
                  {sym} · {dateParam} · {data.snapshotCount} records
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-left text-[11px] text-muted-foreground">
                        <th className="pb-1.5 pr-3 font-medium">Time</th>
                        <th className="pb-1.5 pr-3 font-medium">Grade</th>
                        <th className="pb-1.5 pr-3 font-medium">Heat</th>
                        <th className="pb-1.5 pr-3 font-medium">State</th>
                        <th className="pb-1.5 pr-3 font-medium">Permission</th>
                        <th className="pb-1.5 font-medium">Stage</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.snapshots.slice(0, 50).map((s) => (
                        <tr
                          key={s.id}
                          onClick={() => setSelected(selected?.id === s.id ? null : s)}
                          className={cn(
                            "border-b border-border/40 last:border-0 cursor-pointer hover:bg-secondary/30",
                            selected?.id === s.id && "bg-secondary/40",
                          )}
                        >
                          <td className="py-1.5 pr-3 text-muted-foreground font-mono">{fmtTime(s.generatedAt)}</td>
                          <td className={cn("py-1.5 pr-3 font-bold", replayGradeColor(s.timingGrade))}>{s.timingGrade}</td>
                          <td className="py-1.5 pr-3 font-mono">{s.heatScore}</td>
                          <td className="py-1.5 pr-3">{heatStateLabel(s.heatState)}</td>
                          <td className="py-1.5 pr-3 text-muted-foreground">{s.entryPermission.replace(/_/g, " ")}</td>
                          <td className="py-1.5 text-muted-foreground">{s.moveStage.toLowerCase()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {(data.snapshotCount ?? 0) > 50 && (
                    <p className="mt-2 text-[11px] text-muted-foreground">Showing first 50 of {data.snapshotCount} snapshots.</p>
                  )}
                </div>

                {/* Selected snapshot detail */}
                {selected && (
                  <div className="mt-4 rounded-lg border border-primary/30 bg-secondary/30 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold">Snapshot detail — {fmtTime(selected.generatedAt)}</span>
                      <button onClick={() => setSelected(null)} className="text-muted-foreground hover:text-foreground">
                        <XCircle className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                      <span className="text-muted-foreground">Grade</span><span className={cn("font-bold", replayGradeColor(selected.timingGrade))}>{selected.timingGrade}</span>
                      <span className="text-muted-foreground">Heat score</span><span className="font-mono">{selected.heatScore}/100</span>
                      <span className="text-muted-foreground">Tradeability</span><span className="font-mono">{selected.tradeabilityScore}/100</span>
                      <span className="text-muted-foreground">Edge</span><span className="font-mono">{selected.edgeScore}/100</span>
                      <span className="text-muted-foreground">Danger</span><span className="font-mono">{selected.dangerScore}/100</span>
                      <span className="text-muted-foreground">Trap prob.</span><span className="font-mono">{selected.trapProbability}%</span>
                      <span className="text-muted-foreground">Best action</span><span>{selected.bestAction.replace(/_/g, " ")}</span>
                      <span className="text-muted-foreground">Broad flow</span><span>{selected.broadFlowVerdict}</span>
                      <span className="text-muted-foreground">News phase</span><span>{selected.newsPhase}</span>
                      <span className="text-muted-foreground">Data quality</span><span>{selected.dataQualityLabel}</span>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )
      )}
    </div>
  );
}

// ── Tab: Admin Data Status ──────────────────────────────────────────────────

function AdminDataStatusTab({ data, isLoading }: { data: MarketTimingRead | undefined; isLoading: boolean }) {
  const mode = useTradingMode();

  // Fail-closed: show admin diagnostics ONLY when admin is positively confirmed.
  // Any unresolved, errored, or non-admin state defaults to the user-safe card.
  const showAdminDiag =
    !mode.isLoading &&
    !!mode.envelope &&
    mode.shouldShowAdminDiagnostics &&
    !mode.isAdminPreviewingUserMode;

  if (!showAdminDiag) {
    return (
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            Market timing data
          </CardTitle>
          <CardDescription>
            {mode.isLoading || isLoading
              ? "Checking market timing data availability…"
              : timingStatusDescription(data?.dataQuality.label ?? null)}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // Admin positively confirmed (not previewing) → full data quality diagnostics.
  return (
    <div className="space-y-4">
      {isLoading && <TimingLoadingSkeleton />}
      {!isLoading && !data && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Database className="h-4 w-4 text-muted-foreground" />
              No Data Available
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              No timing read could be completed for the selected symbol. Check that a market data provider is configured
              and the symbol is valid.
            </p>
          </CardContent>
        </Card>
      )}
      {data && (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Database className="h-4 w-4 text-muted-foreground" />
                Data Quality — {data.symbol}
              </CardTitle>
              <CardDescription className="text-xs">
                Generated at {new Date(data.generatedAt).toLocaleTimeString()} · {data.timeframe}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { label: "Candle data", ok: data.dataQuality.hasCandleData },
                  { label: "Quote data", ok: data.dataQuality.hasQuoteData },
                  { label: "News data", ok: data.dataQuality.hasNewsData },
                  { label: "Broad flow", ok: data.dataQuality.hasBroadFlowData },
                ].map(({ label, ok }) => (
                  <div
                    key={label}
                    className={cn(
                      "rounded-lg border p-2 flex flex-col items-center gap-1",
                      ok ? "border-success/30 bg-success/5" : "border-border/20 bg-muted",
                    )}
                  >
                    {ok ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5 text-txt-secondary" />
                    )}
                    <span className="text-[10px] text-center text-muted-foreground leading-tight">{label}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-border/50 pt-2">
                <span className="text-muted-foreground">Quality label</span>
                <DataQualityBadge label={data.dataQuality.label} />
              </div>
              {data.dataQuality.note && (
                <p className="text-muted-foreground leading-relaxed border-l-2 border-border pl-3 mt-1">
                  {data.dataQuality.note}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-muted-foreground" />
                Engine Notes
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground space-y-1">
              <p>Heat score is advisory only and never gates live or demo execution.</p>
              <p>
                Heat source: <span className="text-foreground">{data.heatSource.primary}</span>
                {data.heatSource.backup && <> / {data.heatSource.backup}</>}.
              </p>
              <p>{data.heatSource.explanation}</p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function MarketHeatMapPage() {
  const [chartSymbol] = useChartSymbol();
  const symbol = bareSymbol(chartSymbol);
  const { name } = useAssistantName();
  const { realIsAdmin } = useViewMode();
  const tz = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; }
  }, []);

  const singleParams = useMemo<GetTimingBrainParams>(
    () => ({ timeframe: GetTimingBrainTimeframe.M15, tz }),
    [tz],
  );
  const multiParams = useMemo<GetTimingBrainMultiParams>(
    () => ({ symbols: MULTI_SYMBOLS, timeframe: GetTimingBrainMultiTimeframe.M15, tz }),
    [tz],
  );

  const { data, isLoading } = useGetTimingBrain(symbol, singleParams, {
    query: {
      queryKey: getGetTimingBrainQueryKey(symbol, singleParams),
      refetchInterval: 30_000,
      enabled: !!symbol,
    },
  });

  const { data: multiData, isLoading: multiLoading } = useGetTimingBrainMulti(multiParams, {
    query: {
      queryKey: getGetTimingBrainMultiQueryKey(multiParams),
      refetchInterval: 60_000,
    },
  });

  const results = multiData?.results ?? [];

  const tabs = useMemo(() => [
    {
      id: "now",
      label: "Now",
      icon: <Thermometer className="h-3.5 w-3.5" />,
      content: <NowTab data={data} isLoading={isLoading} symbol={symbol} />,
    },
    {
      // Surface consolidation item A — heat is ONE surface. The global
      // country/currency/synthetic heat card (previously a second heat surface
      // on the Market Scanner's Focus tab) now lives here as its own tab.
      // SOURCE RECONCILIATION: this tab reads the read-only market-heat
      // service (GET /api/market-heat — news + calendar + price providers,
      // honest `unavailable` when a provider is missing). Every other tab on
      // this page reads the timing brain. Each view names its own engine and
      // neither is re-labelled as the other; where they disagree, the timing
      // brain remains authoritative for session/timing windows and the heat
      // service for global news/country heat.
      id: "global-heat",
      label: "Global Heat",
      icon: <Globe className="h-3.5 w-3.5" />,
      content: (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Country, currency and synthetic heat from the global market-heat
            service (news + calendar + price). The other tabs on this page read
            {" "}{name}&apos;s timing brain — different engines, each honest about
            its own sources.
          </p>
          <GlobalMarketHeatCard />
        </div>
      ),
    },
    {
      id: "today",
      label: "Today",
      icon: <Clock className="h-3.5 w-3.5" />,
      content: <TodayTab data={data} multiData={results} />,
    },
    {
      id: "by-symbol",
      label: "By Symbol",
      icon: <Activity className="h-3.5 w-3.5" />,
      content: <BySymbolTab results={results} isLoading={multiLoading} selectedSymbol={symbol} />,
    },
    {
      id: "by-session",
      label: "By Session",
      icon: <Radio className="h-3.5 w-3.5" />,
      content: <BySessionTab data={data} />,
    },
    {
      id: "buy-sell",
      label: "Buy/Sell Windows",
      icon: <TrendingUp className="h-3.5 w-3.5" />,
      content: <BuySellWindowsTab data={data} />,
    },
    {
      id: "danger",
      label: "Danger Windows",
      icon: <AlertTriangle className="h-3.5 w-3.5" />,
      content: <DangerWindowsTab data={data} results={results} />,
    },
    {
      id: "news-heat",
      label: "News Heat",
      icon: <Newspaper className="h-3.5 w-3.5" />,
      content: <NewsHeatTab data={data} />,
    },
    {
      id: "broad-flow",
      label: "Broad Flow",
      icon: <BarChart2 className="h-3.5 w-3.5" />,
      content: <BroadFlowTab data={data} />,
    },
    {
      id: "replay",
      label: "Replay",
      icon: <History className="h-3.5 w-3.5" />,
      content: <ReplayTab />,
    },
    // The data-status tab is an operator diagnostics view labelled "Admin";
    // hide it from non-admin sessions so the nav never advertises an admin
    // surface to a normal trader (same defect class as Theme H). The data it
    // renders is the page's own timing-brain read — no extra endpoint.
    ...(realIsAdmin
      ? [{
          id: "admin-status",
          label: "Admin Data Status",
          icon: <Database className="h-3.5 w-3.5" />,
          content: <AdminDataStatusTab data={data} isLoading={isLoading} />,
        }]
      : []),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [data, isLoading, multiLoading, results, symbol, realIsAdmin]);

  return (
    <div className="space-y-4 pb-24 min-h-0">
      {/* Page header */}
      <div className="space-y-1">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
              <Thermometer className="h-5 w-5 text-primary" />
              Market Heat Map
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Track market movement windows, critical news heat, broad flow, and {name}'s timing guidance.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge variant="outline" className="text-[10px] text-muted-foreground border-border">
              Advisory only
            </Badge>
          </div>
        </div>

        {/* Symbol + local time context bar */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap mt-1">
          <span className="font-medium text-foreground">{symbol || "—"}</span>
          <span>·</span>
          <span>{GetTimingBrainTimeframe.M15}</span>
          {data?.session?.userLocalTime && (
            <>
              <span>·</span>
              <span>Local: {data.session.userLocalTime}</span>
            </>
          )}
          {data && (
            <>
              <span>·</span>
              <span>Updated {new Date(data.generatedAt).toLocaleTimeString()}</span>
            </>
          )}
        </div>
      </div>

      {/* Tabs */}
      <PageTabs
        tabs={tabs}
        storageKey="market-heat-map"
        variant="pill"
      />
    </div>
  );
}
