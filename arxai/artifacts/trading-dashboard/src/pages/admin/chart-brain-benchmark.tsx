// Chart Brain Benchmark — admin-only scorecard (Chart Brain v2 Task 6).
//
// Aggregates REAL decision receipts, outcomes, and agent-governance traces
// into 15 benchmark scores plus trend, weak areas, recent failed reads,
// successful no-trades, and speed/feed warnings. No fabricated scores: a
// dimension renders "insufficient data" when the backend returns null.
//
// Access: lives under /admin so RouteAccessGuard already requires an
// effective-admin session; AdminDiagnosticsGate is defence-in-depth for the
// admin-previewing-as-user case. Read-only — no mutations, no dispatches.

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Brain,
  Gauge,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import {
  useGetAdminChartBenchmark,
  getGetAdminChartBenchmarkQueryKey,
} from "@workspace/api-client-react";
import type {
  ChartBenchmarkScore,
  ChartBenchmarkRecentRead,
} from "@workspace/api-client-react";
import { AdminDiagnosticsGate } from "@/components/admin/AdminDiagnosticsGate";

function scoreTone(score: number | null): string {
  if (score == null) return "text-txt-secondary";
  if (score >= 70) return "text-success";
  if (score >= 45) return "text-warning";
  return "text-danger";
}

function scoreBarTone(score: number | null): string {
  if (score == null) return "bg-secondary";
  if (score >= 70) return "bg-success";
  if (score >= 45) return "bg-warning";
  return "bg-danger";
}

function ScoreCard({ s }: { s: ChartBenchmarkScore }) {
  const insufficient = s.score == null;
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium text-foreground">{s.label}</div>
        <div className={`text-lg font-bold tabular-nums ${scoreTone(s.score)}`}>
          {insufficient ? "—" : Math.round(s.score as number)}
        </div>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={`h-full ${scoreBarTone(s.score)}`}
          style={{ width: insufficient ? "0%" : `${Math.max(0, Math.min(100, s.score as number))}%` }}
        />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-txt-muted">
          {insufficient ? "Insufficient data" : s.note}
        </span>
        <span className="text-[10px] text-txt-muted">n={s.sampleSize}</span>
      </div>
    </div>
  );
}

function RecentReadRow({ r }: { r: ChartBenchmarkRecentRead }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2 text-xs">
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-foreground">
          {r.symbol} · {r.timeframe}
        </span>
        <span className="truncate text-txt-muted">
          {(r.intent ?? "read")}
          {r.direction ? ` · ${r.direction}` : ""}
          {" · user "}
          {r.userId}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {r.outcome ? (
          <Badge variant="outline" className="border-border text-txt-secondary">
            {r.outcome}
          </Badge>
        ) : null}
        {r.qualityLabel ? (
          <span className="text-[10px] text-txt-muted">{r.qualityLabel}</span>
        ) : null}
      </div>
    </div>
  );
}

function BenchmarkBody() {
  const [windowDays, setWindowDays] = useState<number>(30);

  const query = useGetAdminChartBenchmark(
    { windowDays },
    {
      query: {
        queryKey: getGetAdminChartBenchmarkQueryKey({ windowDays }),
        staleTime: 15_000,
      },
    },
  );

  const benchmark = query.data?.benchmark;
  const isError = query.isError;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-indigo-500/10 p-2">
            <Brain className="h-5 w-5 text-indigo-300" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground">Chart Brain Benchmark</h1>
            <p className="text-sm text-txt-secondary">
              Real receipts, outcomes &amp; governance traces — scored, never fabricated.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={String(windowDays)}
            onValueChange={(v) => setWindowDays(Number(v))}
          >
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {isError ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not load benchmark</AlertTitle>
          <AlertDescription>
            The benchmark endpoint returned an error. This page is read-only and does
            not affect trading.
          </AlertDescription>
        </Alert>
      ) : null}

      {query.isLoading ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-txt-muted">
            Loading benchmark…
          </CardContent>
        </Card>
      ) : null}

      {benchmark ? (
        <>
          {/* Evidence summary */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-4 w-4 text-success" />
                Evidence base
              </CardTitle>
              <CardDescription>
                Window: {benchmark.windowDays} days · generated{" "}
                {new Date(benchmark.generatedAt).toLocaleString()}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { label: "Receipts", value: benchmark.totalReceipts },
                  { label: "Outcomes", value: benchmark.totalOutcomes },
                  { label: "Reviews", value: benchmark.totalReviews },
                  { label: "Gov. traces", value: benchmark.totalTraces },
                ].map((m) => (
                  <div
                    key={m.label}
                    className="rounded-lg border border-border bg-card p-3"
                  >
                    <div className="text-2xl font-bold tabular-nums text-foreground">
                      {m.value}
                    </div>
                    <div className="text-xs text-txt-muted">{m.label}</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Warnings */}
          {benchmark.warnings.length > 0 ? (
            <Alert className="border-warning/50 bg-warning/5">
              <Gauge className="h-4 w-4 text-warning" />
              <AlertTitle className="text-warning">Speed &amp; feed warnings</AlertTitle>
              <AlertDescription>
                <ul className="ml-4 list-disc space-y-1 text-warning/90">
                  {benchmark.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          {/* 15 scores */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <BarChart3 className="h-4 w-4 text-indigo-300" />
                Benchmark scores
              </CardTitle>
              <CardDescription>
                Each dimension is a real number or “insufficient data” — never
                fabricated.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {benchmark.scores.map((s) => (
                  <ScoreCard key={s.key} s={s} />
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Weak areas */}
          {benchmark.weakAreas.length > 0 ? (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <AlertTriangle className="h-4 w-4 text-danger" />
                  Weakest areas
                </CardTitle>
                <CardDescription>
                  Lowest-scoring dimensions with enough evidence to judge.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {benchmark.weakAreas.map((s) => (
                    <ScoreCard key={s.key} s={s} />
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : null}

          {/* Trend */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Activity className="h-4 w-4 text-primary" />
                Daily trend
              </CardTitle>
              <CardDescription>
                Reads, resolved outcomes, and win rate per day.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {benchmark.trend.length === 0 ? (
                <p className="py-4 text-center text-sm text-txt-muted">
                  No reads in this window yet.
                </p>
              ) : (
                <div className="space-y-1">
                  {benchmark.trend.map((t) => (
                    <div
                      key={t.date}
                      className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-xs odd:bg-card"
                    >
                      <span className="text-txt-secondary">{t.date}</span>
                      <div className="flex items-center gap-4 tabular-nums">
                        <span className="text-txt-secondary">{t.reads} reads</span>
                        <span className="text-txt-muted">{t.resolved} resolved</span>
                        <span
                          className={`w-14 text-right ${
                            t.winRate == null ? "text-txt-muted" : scoreTone(t.winRate)
                          }`}
                        >
                          {t.winRate == null ? "—" : `${Math.round(t.winRate)}%`}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent failed reads + successful no-trades */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base text-danger">
                  Recent failed reads
                </CardTitle>
                <CardDescription>
                  Reads that resolved against the call.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {benchmark.recentFailedReads.length === 0 ? (
                  <p className="py-4 text-center text-sm text-txt-muted">
                    None in this window.
                  </p>
                ) : (
                  benchmark.recentFailedReads.map((r) => (
                    <RecentReadRow key={r.receiptId} r={r} />
                  ))
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base text-success">
                  Successful no-trades
                </CardTitle>
                <CardDescription>
                  Correct decisions to stand aside.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {benchmark.recentSuccessfulNoTrades.length === 0 ? (
                  <p className="py-4 text-center text-sm text-txt-muted">
                    None in this window.
                  </p>
                ) : (
                  benchmark.recentSuccessfulNoTrades.map((r) => (
                    <RecentReadRow key={r.receiptId} r={r} />
                  ))
                )}
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}

export default function ChartBrainBenchmarkPage() {
  return (
    <AdminDiagnosticsGate
      pageTitle="Chart Brain Benchmark"
      pageDescription="Operator-only scorecard of chart-intelligence quality."
    >
      <BenchmarkBody />
    </AdminDiagnosticsGate>
  );
}
