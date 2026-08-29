// ── Profit Mission — "Performance" view (DISPLAY ONLY) ──────────────────────
//
// A polished, at-a-glance read of a mission's strategy performance over time.
// It charts BACKTEST (historical / simulated) vs FORWARD (real closed trades)
// side by side, with honest labels + sample-size warnings, shows the strategy
// drift severity and its history, and clearly explains a SEVERE-drift demotion
// (what was demoted, why, risk reduced, promotion paused).
//
// HONESTY CONTRACT: every number here is read from data the backend already
// computed (mission test results, the drift decision, journaled mission
// events). Forward / live figures appear ONLY when real FORWARD test-result
// rows exist — this view never estimates or implies live performance without
// real evidence. There is NO execution path anywhere on this surface.

import { AlertCircle } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import {
  useListMissionTestResults,
  useGetMissionDrift,
  useGetMissionPromotion,
  useGetMissionBriefing,
  useGetMissionEodReview,
  useGetMissionReport,
  useListProfitMissionEvents,
  getListMissionTestResultsQueryKey,
  getGetMissionDriftQueryKey,
  getGetMissionPromotionQueryKey,
} from "@workspace/api-client-react";
import type { MissionTestResult } from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CompactAlert } from "@/components/ui/CompactAlert";
import {
  latestByKind,
  buildComparisonRows,
  buildForwardTrend,
  buildDriftHistory,
  driftSeverityMeta,
  deltaTone,
  formatMetric,
  readNum,
  readStr,
  readBool,
  readStringArray,
  readSignals,
  shortDateTime,
  type ComparisonRow,
  type DriftHistoryEntry,
} from "./missionPerformanceFormat";

const AXIS = "#64748b";
const GRID = "#1e293b";
const FORWARD_LINE = "#10b981"; // emerald — real forward results
const BASELINE = "#f59e0b"; // amber — backtest baseline reference

function readTextBlock(obj: unknown): { headline: string | null; lines: string[] } {
  const rec = (obj && typeof obj === "object" ? obj : {}) as Record<string, unknown>;
  const headline = readStr(rec, "headline") ?? readStr(rec, "summary");
  const linesRaw = rec.lines ?? rec.notes ?? rec.highlights;
  const lines = Array.isArray(linesRaw) ? linesRaw.filter((x): x is string => typeof x === "string") : [];
  return { headline, lines };
}

export function MissionPerformanceView({ missionId }: { missionId: number }): React.ReactElement {
  const { data: testing } = useListMissionTestResults(missionId, undefined, {
    query: { queryKey: getListMissionTestResultsQueryKey(missionId) },
  });
  const { data: drift } = useGetMissionDrift(missionId, {
    query: { queryKey: getGetMissionDriftQueryKey(missionId) },
  });
  const { data: promotion } = useGetMissionPromotion(missionId, undefined, {
    query: { queryKey: getGetMissionPromotionQueryKey(missionId) },
  });
  const { data: briefing } = useGetMissionBriefing(missionId);
  const { data: eod } = useGetMissionEodReview(missionId);
  const { data: report } = useGetMissionReport(missionId);
  const { data: events } = useListProfitMissionEvents(missionId, { limit: 100, offset: 0 });

  const results = testing?.results ?? [];
  const { backtest, forward } = latestByKind(results);
  const rows = buildComparisonRows(backtest, forward);
  const trend = buildForwardTrend(results);
  const driftHistory = buildDriftHistory(events ?? []);

  const driftObj = (drift?.drift && typeof drift.drift === "object" ? drift.drift : null) as
    | Record<string, unknown>
    | null;
  const insufficientEvidence = drift?.insufficientEvidence === true;
  const severityMeta = driftSeverityMeta(readStr(driftObj, "severity"));
  const driftScore = readNum(driftObj, "score");
  const driftReasons = readStringArray(driftObj, "reasons");
  const driftSignals = readSignals(driftObj);
  const recommendDemote = readBool(driftObj, "recommendDemote");
  const recommendReduceRisk = readBool(driftObj, "recommendReduceRisk");
  const recommendPausePromotion = readBool(driftObj, "recommendPausePromotion");
  const demoted = drift?.demoted === true;
  const promotionPaused = drift?.promotionPaused === true;
  const showDemotionPanel = demoted || severityMeta.severity === "SEVERE" || recommendDemote;

  const promotionObj = (promotion && typeof promotion === "object" ? promotion : {}) as Record<string, unknown>;
  const decisionObj = (promotionObj.decision && typeof promotionObj.decision === "object"
    ? promotionObj.decision
    : {}) as Record<string, unknown>;
  const currentLevel = readNum(promotionObj, "currentLevel") ?? readNum(decisionObj, "currentLevel");
  const riskReducedByDrift = readBool(promotionObj, "riskReducedByDrift") || readBool(decisionObj, "riskReducedByDrift");

  return (
    <div className="space-y-4" data-testid="view-mission-performance">
      <CompactAlert
        tone="info"
        testId="alert-performance-honesty"
        title="Strategy performance over time"
        description="Backtest is historical / simulated. Forward numbers come only from real closed trades."
        details={
          <span>
            Backtest results model the strategy against historical data. Forward results are
            aggregated from your mission's real closed trades, so they may be empty until trades
            close. This view never estimates or implies live performance — when there is no real
            evidence, you'll see an honest empty state instead of a number.
          </span>
        }
      />

      {/* ── Backtest vs Forward comparison ─────────────────────────────── */}
      <Card data-testid="card-performance-comparison">
        <CardHeader>
          <CardTitle>Backtest vs Forward</CardTitle>
          <CardDescription>
            Side-by-side, honestly labelled. Lower is better for drawdown; higher is better elsewhere.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 gap-y-1 text-sm">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Metric</div>
            <div className="text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Backtest
            </div>
            <div className="text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Forward
            </div>
            <div className="text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Δ
            </div>
            {rows.map((row) => (
              <ComparisonRowCells key={row.key} row={row} />
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <SideSummary kind="Backtest" sub="Historical / simulated" result={backtest} testId="summary-backtest" />
            <SideSummary kind="Forward" sub="Real closed trades" result={forward} testId="summary-forward" />
          </div>
        </CardContent>
      </Card>

      {/* ── Forward performance over time ──────────────────────────────── */}
      <Card data-testid="card-performance-trend">
        <CardHeader>
          <CardTitle>Forward expectancy over time</CardTitle>
          <CardDescription>
            Each point is a real forward result, compared against the backtest baseline.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {trend.length === 0 ? (
            <p
              className="rounded border border-dashed border-border p-6 text-center text-sm text-muted-foreground"
              data-testid="empty-performance-trend"
            >
              No real forward trades yet. Forward performance will appear here once your mission closes
              real trades — nothing is estimated.
            </p>
          ) : (
            <div className="h-60" data-testid="chart-performance-trend">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trend} margin={{ top: 5, right: 12, left: -10, bottom: 0 }}>
                  <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
                  <XAxis dataKey="date" stroke={AXIS} fontSize={10} />
                  <YAxis stroke={AXIS} fontSize={10} tickFormatter={(v) => `${v}R`} />
                  <Tooltip
                    contentStyle={{ background: "#0f172a", border: "1px solid #334155", fontSize: 11 }}
                    formatter={(v: number) => [`${v.toFixed(2)}R`, "Forward expectancy"]}
                  />
                  {backtest && (
                    <ReferenceLine
                      y={backtest.metrics.expectancyR}
                      stroke={BASELINE}
                      strokeDasharray="4 4"
                      label={{
                        value: `Backtest baseline ${backtest.metrics.expectancyR.toFixed(2)}R`,
                        position: "insideTopRight",
                        fill: BASELINE,
                        fontSize: 10,
                      }}
                    />
                  )}
                  <Line
                    type="monotone"
                    dataKey="expectancyR"
                    stroke={FORWARD_LINE}
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          {trend.length > 0 && !backtest && (
            <p className="mt-2 text-xs text-muted-foreground" data-testid="text-no-baseline">
              No backtest baseline yet — run a backtest in the Testing Lab to compare forward results
              against an expected expectancy.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Strategy drift ────────────────────────────────────────────── */}
      <Card data-testid="card-drift-detail">
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle>Strategy drift</CardTitle>
              <CardDescription>
                How forward performance compares to the historical baseline.
              </CardDescription>
            </div>
            <Badge className={severityMeta.cls} data-testid="badge-drift-severity">
              {severityMeta.label}
              {driftScore != null && severityMeta.severity !== "UNKNOWN" ? ` · ${driftScore.toFixed(2)}` : ""}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {insufficientEvidence ? (
            <p className="text-sm text-muted-foreground" data-testid="text-drift-insufficient">
              Not enough data on both sides yet for an honest comparison. Drift is undetermined until
              there are real forward results to compare against the baseline.
            </p>
          ) : (
            <>
              {driftReasons.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground" data-testid="list-drift-reasons">
                  {driftReasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
              {driftSignals.length > 0 && (
                <div className="space-y-1" data-testid="list-drift-signals">
                  {driftSignals.map((s, i) => (
                    <div key={i} className="flex items-start justify-between gap-2 text-xs">
                      <span className="text-muted-foreground">
                        <span className="font-medium text-foreground">{s.name}</span> — {s.detail}
                      </span>
                      {s.weight != null && (
                        <span className="shrink-0 text-muted-foreground">+{s.weight.toFixed(2)}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {showDemotionPanel && (
            <div
              className="rounded-md border border-danger/40 bg-danger/10 p-3 text-danger"
              data-testid="alert-drift-demotion"
            >
              <div className="flex items-center gap-2 text-sm font-medium text-danger">
                <AlertCircle className="h-4 w-4 shrink-0" />
                Severe drift — the mission was made safer automatically
              </div>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                <li data-testid="demotion-what">
                  What changed: automation was demoted{currentLevel != null ? ` to "${automationLabel(currentLevel)}"` : ""}
                  {demoted ? "" : " (recommended)"}, so live actions need closer oversight.
                </li>
                {(recommendReduceRisk || riskReducedByDrift) && (
                  <li data-testid="demotion-risk">Risk was reduced for new trades while forward results recover.</li>
                )}
                {(promotionPaused || recommendPausePromotion) && (
                  <li data-testid="demotion-promotion">Promotion to higher automation is paused.</li>
                )}
                <li data-testid="demotion-why">
                  Why: {driftReasons[0] ?? "forward performance has drifted from the historical baseline."}
                </li>
              </ul>
            </div>
          )}

          {/* Drift severity history (journaled checks) */}
          <div data-testid="drift-history">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Drift history
            </p>
            {driftHistory.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="empty-drift-history">
                No drift checks recorded yet.
              </p>
            ) : (
              <ul className="space-y-1" data-testid="list-drift-history">
                {driftHistory.map((h) => (
                  <DriftHistoryRow key={h.id} entry={h} />
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Mission summary (briefing / EOD / report) ─────────────────── */}
      <Card data-testid="card-performance-summary">
        <CardHeader>
          <CardTitle>What the mission says</CardTitle>
          <CardDescription>Advisory read-outs the mission generated from its own results.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <SummaryBlock title="Daily briefing" obj={briefing} testId="perf-block-briefing" />
          <SummaryBlock title="End-of-day review" obj={eod} testId="perf-block-eod" />
          <SummaryBlock title="Mission report" obj={(report as Record<string, unknown> | undefined)?.report} testId="perf-block-report" />
        </CardContent>
      </Card>
    </div>
  );
}

const AUTOMATION_LABELS: Record<number, string> = {
  0: "Off",
  1: "Advisory",
  2: "Approval (default)",
  3: "Demo auto",
  4: "Micro live",
  5: "Limited live auto",
  6: "Full live auto",
};

function automationLabel(level: number): string {
  return AUTOMATION_LABELS[level] ?? `Level ${level}`;
}

function ComparisonRowCells({ row }: { row: ComparisonRow }): React.ReactElement {
  const tone = deltaTone(row);
  const toneCls =
    tone === "better" ? "text-success" : tone === "worse" ? "text-danger" : "text-muted-foreground";
  const arrow = tone === "better" ? "▲" : tone === "worse" ? "▼" : "·";
  return (
    <>
      <div className="text-muted-foreground" data-testid={`row-metric-${row.key}`}>
        {row.label}
      </div>
      <div className="text-right tabular-nums" data-testid={`cell-backtest-${row.key}`}>
        {formatMetric(row.backtest, row.unit)}
      </div>
      <div className="text-right tabular-nums" data-testid={`cell-forward-${row.key}`}>
        {formatMetric(row.forward, row.unit)}
      </div>
      <div className={`text-right tabular-nums ${toneCls}`} data-testid={`cell-delta-${row.key}`}>
        {arrow}
      </div>
    </>
  );
}

function SideSummary({
  kind,
  sub,
  result,
  testId,
}: {
  kind: string;
  sub: string;
  result: MissionTestResult | null;
  testId: string;
}): React.ReactElement {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3" data-testid={testId}>
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">{kind}</p>
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{sub}</span>
      </div>
      {result ? (
        <div className="mt-1 space-y-1">
          <p className="text-xs text-muted-foreground">{result.label}</p>
          <p className="text-xs text-muted-foreground" data-testid={`${testId}-sample`}>
            Sample size: {result.sampleSize} trade{result.sampleSize === 1 ? "" : "s"}
            {result.isVerified ? " · verified" : ""}
          </p>
          {result.sampleWarning && (
            <p className="text-xs text-warning" data-testid={`${testId}-warning`}>
              ⚠ {result.sampleWarning}
            </p>
          )}
        </div>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground" data-testid={`${testId}-empty`}>
          {kind === "Forward"
            ? "No real forward results yet — nothing is estimated."
            : "No backtest yet — run one in the Testing Lab to set a baseline."}
        </p>
      )}
    </div>
  );
}

function DriftHistoryRow({ entry }: { entry: DriftHistoryEntry }): React.ReactElement {
  const meta = driftSeverityMeta(entry.severity);
  return (
    <li className="flex items-center justify-between gap-2 text-xs" data-testid={`drift-history-${entry.id}`}>
      <span className="flex items-center gap-2">
        <Badge className={`${meta.cls} px-1.5 py-0`}>{meta.label}</Badge>
        {entry.demoted && (
          <span className="text-danger" data-testid={`drift-history-demoted-${entry.id}`}>
            demoted
          </span>
        )}
        {entry.score != null && <span className="text-muted-foreground">{entry.score.toFixed(2)}</span>}
      </span>
      <span className="text-muted-foreground">{shortDateTime(entry.createdAt)}</span>
    </li>
  );
}

function SummaryBlock({ title, obj, testId }: { title: string; obj: unknown; testId: string }): React.ReactElement {
  const { headline, lines } = readTextBlock(obj);
  return (
    <div data-testid={testId}>
      <p className="font-medium">{title}</p>
      {headline ? (
        <p className="text-muted-foreground">{headline}</p>
      ) : lines.length === 0 ? (
        <p className="text-muted-foreground">No data yet.</p>
      ) : null}
      {lines.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
