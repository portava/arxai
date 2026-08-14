// Task #199 — Admin Ruby Quality dashboard (ADMIN/OWNER only).
//
// SAFETY / SCOPE:
//   - Lives under /admin → RouteAccessGuard already requires an effective-admin
//     session; AdminDiagnosticsGate is defence-in-depth for preview-as-user.
//   - READ-ONLY over trade results. The only mutation is the audited
//     tuning-threshold update (reason required), which tunes OUTCOME-LEARNING
//     classification ONLY — never any execution gate or the live pipeline.
//   - Detailed operator metrics never appear on any user/investor surface; the
//     investor-summary card is the single sanitized aggregate.

import { useMemo, useState } from "react";
import {
  useGetAdminRubyQualityMetrics,
  useGetAdminRubyMissedOpportunities,
  useGetAdminRubyThresholds,
  useUpdateAdminRubyThresholds,
  useGetAdminRubyInvestorSummary,
  type RubyQualityThresholds,
  type AdminRubyThresholdsUpdateReqThresholds,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AdminDiagnosticsGate } from "@/components/admin/AdminDiagnosticsGate";
import { PageTabs } from "@/components/ui/PageTabs";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Gauge, Filter, History, SlidersHorizontal, TrendingUp } from "lucide-react";
import { useAssistantName } from "@/lib/assistant-name";

// ── helpers ─────────────────────────────────────────────────────────────────
function pct(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${(n * 100).toFixed(1)}%`;
}
function num(n: number | null | undefined, digits = 0): string {
  if (n == null) return "—";
  return n.toFixed(digits);
}

const THRESHOLD_FIELDS: {
  key: keyof RubyQualityThresholds;
  label: string;
  help: string;
}[] = [
  { key: "lateEntrySeconds", label: "Late entry (s)", help: "Seconds after signal that an entry is graded LATE" },
  { key: "minConfidence", label: "Min confidence", help: "Confidence floor for a quality signal" },
  { key: "minEdge", label: "Min edge", help: "Edge-score floor for a quality signal" },
  { key: "newsLockoutMinutes", label: "News lockout (min)", help: "Minutes around news treated as news-nearby" },
  { key: "maxSpread", label: "Max spread", help: "Spread ceiling at signal" },
  { key: "maxSlippage", label: "Max slippage", help: "Acceptable slippage ceiling" },
  { key: "minRiskReward", label: "Min R:R", help: "Minimum planned risk/reward" },
  { key: "strongMovePct", label: "Strong move %", help: "Favorable move that counts as a strong outcome" },
  { key: "breakevenR", label: "Breakeven R", help: "R band treated as breakeven" },
  { key: "evidenceExpiryMinutes", label: "Evidence expiry (min)", help: "Window to collect resolving evidence" },
];

// ── metrics overview ─────────────────────────────────────────────────────────
function MetricsTab() {
  const [symbol, setSymbol] = useState("");
  const [session, setSession] = useState("");
  const [decision, setDecision] = useState("");
  const [applied, setApplied] = useState<{ symbol?: string; session?: string; decision?: string }>({});

  const params = useMemo(() => {
    const p: Record<string, string> = {};
    if (applied.symbol) p.symbol = applied.symbol;
    if (applied.session) p.session = applied.session;
    if (applied.decision) p.decision = applied.decision;
    return p;
  }, [applied]);

  const q = useGetAdminRubyQualityMetrics(params);

  const m = q.data?.metrics;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-txt-secondary" aria-hidden="true" />
            <CardTitle className="text-base">Filters</CardTitle>
          </div>
          <CardDescription>Scope metrics by symbol, session, or decision.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <div className="space-y-1">
              <Label htmlFor="f-symbol">Symbol</Label>
              <Input id="f-symbol" placeholder="e.g. EURUSD" value={symbol} onChange={(e) => setSymbol(e.target.value)} data-testid="filter-symbol" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="f-session">Session</Label>
              <Input id="f-session" placeholder="london / newyork…" value={session} onChange={(e) => setSession(e.target.value)} data-testid="filter-session" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="f-decision">Decision</Label>
              <Input id="f-decision" placeholder="approve / observe…" value={decision} onChange={(e) => setDecision(e.target.value)} data-testid="filter-decision" />
            </div>
            <div className="flex items-end gap-2">
              <Button
                onClick={() => setApplied({ symbol: symbol.trim() || undefined, session: session.trim() || undefined, decision: decision.trim() || undefined })}
                data-testid="apply-filters"
              >
                Apply
              </Button>
              <Button
                variant="outline"
                onClick={() => { setSymbol(""); setSession(""); setDecision(""); setApplied({}); }}
                data-testid="clear-filters"
              >
                Clear
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {q.isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
        </div>
      ) : q.isError ? (
        <Card><CardContent className="py-6 text-sm text-danger">Failed to load metrics.</CardContent></Card>
      ) : !m ? null : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Tracked" value={num(m.totals.tracked)} />
            <StatCard label="Resolved" value={num(m.totals.resolved)} />
            <StatCard label="Pending" value={num(m.totals.pending)} sub="Awaiting real evidence" />
            <StatCard label="Graded" value={num(m.totals.graded)} />
            <StatCard label="Win rate" value={pct(m.rates.winRate)} />
            <StatCard label="TP rate" value={pct(m.rates.tpRate)} />
            <StatCard label="SL rate" value={pct(m.rates.slRate)} />
            <StatCard label="Late rate" value={pct(m.rates.lateRate)} />
            <StatCard label="Avoided bad trades" value={num(m.avoidedBadTrades)} />
            <StatCard label="Missed opportunities" value={num(m.missedOpportunities)} />
            <StatCard label="News failures" value={num(m.newsFailures)} />
            <StatCard label="Execution failures" value={num(m.executionFailures)} />
            <StatCard label="Explanation accuracy" value={pct(m.explanationAccuracy)} />
            <StatCard label="Ignored warnings" value={num(m.ignoredWarnings)} />
            <StatCard label="Avg MFE" value={num(m.averages.mfe, 2)} />
            <StatCard label="Avg MAE" value={num(m.averages.mae, 2)} />
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <RankTable title="Best symbols" rows={m.bestSymbols} />
            <RankTable title="Worst symbols" rows={m.worstSymbols} />
            <RankTable title="Best sessions" rows={m.bestSessions} />
            <RankTable title="Worst sessions" rows={m.worstSessions} />
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <BucketTable title="Confidence vs outcome" rows={m.confidenceVsOutcome} />
            <BucketTable title="Edge vs outcome" rows={m.edgeVsOutcome} />
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card data-testid={`stat-${label.replace(/\s+/g, "-").toLowerCase()}`}>
      <CardContent className="py-4">
        <div className="text-xs text-txt-secondary">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
        {sub && <div className="mt-1 text-[11px] text-txt-secondary">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function RankTable({ title, rows }: { title: string; rows: { key: string; graded: number; wins: number; winRate: number; avgPnlR?: number | null }[] }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="text-sm text-txt-secondary">No graded signals yet.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead className="text-right">Graded</TableHead>
                <TableHead className="text-right">Wins</TableHead>
                <TableHead className="text-right">Win rate</TableHead>
                <TableHead className="text-right">Avg R</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.key}>
                  <TableCell className="font-medium">{r.key}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(r.graded)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(r.wins)}</TableCell>
                  <TableCell className="text-right tabular-nums">{pct(r.winRate)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(r.avgPnlR, 2)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function BucketTable({ title, rows }: { title: string; rows: { bucket: string; total: number; wins: number; losses: number; winRate: number }[] }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="text-sm text-txt-secondary">No graded signals yet.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bucket</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Wins</TableHead>
                <TableHead className="text-right">Losses</TableHead>
                <TableHead className="text-right">Win rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.bucket}>
                  <TableCell className="font-medium">{r.bucket}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(r.total)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(r.wins)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(r.losses)}</TableCell>
                  <TableCell className="text-right tabular-nums">{pct(r.winRate)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ── missed-opportunity replay ────────────────────────────────────────────────
function MissedTab() {
  const { name } = useAssistantName();
  const [symbol, setSymbol] = useState("");
  const [applied, setApplied] = useState<string | undefined>(undefined);
  const params = useMemo(() => (applied ? { symbol: applied } : {}), [applied]);
  const q = useGetAdminRubyMissedOpportunities(params);
  const replays = q.data?.replays ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-txt-secondary" aria-hidden="true" />
            <CardTitle className="text-base">Missed-opportunity replay</CardTitle>
          </div>
          <CardDescription>
            Signals graded NO_TRADE_MISSED, reconstructed from recorded evidence only. Sparse
            evidence is shown honestly — nothing is re-derived or invented.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="m-symbol">Symbol</Label>
              <Input id="m-symbol" placeholder="e.g. EURUSD" value={symbol} onChange={(e) => setSymbol(e.target.value)} data-testid="missed-symbol" />
            </div>
            <Button onClick={() => setApplied(symbol.trim() || undefined)} data-testid="missed-apply">Apply</Button>
            <Button variant="outline" onClick={() => { setSymbol(""); setApplied(undefined); }} data-testid="missed-clear">Clear</Button>
          </div>
        </CardContent>
      </Card>

      {q.isLoading ? (
        <Skeleton className="h-40" />
      ) : q.isError ? (
        <Card><CardContent className="py-6 text-sm text-danger">Failed to load replays.</CardContent></Card>
      ) : replays.length === 0 ? (
        <Card><CardContent className="py-6 text-sm text-txt-secondary">No missed opportunities recorded yet.</CardContent></Card>
      ) : (
        <div className="space-y-3">
          {replays.map((r) => (
            <Card key={r.outcomeId} data-testid={`missed-${r.outcomeId}`}>
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base">{r.symbol} · {r.timeframe}</CardTitle>
                  <Badge variant="outline">{r.verdict}</Badge>
                </div>
                <CardDescription>{r.evidenceNote}</CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1 text-sm">
                  <div className="text-xs font-medium uppercase text-txt-secondary">What {name} saw</div>
                  <KV k="Direction" v={r.whatRubySaw.direction ?? "—"} />
                  <KV k="Decision" v={r.whatRubySaw.decision ?? "—"} />
                  <KV k="Confidence" v={num(r.whatRubySaw.confidence)} />
                  <KV k="Edge" v={num(r.whatRubySaw.edge, 1)} />
                  <KV k="Flame stage" v={r.whatRubySaw.flameStage ?? "—"} />
                  <KV k="News nearby" v={r.whatRubySaw.newsNearby ? "Yes" : "No"} />
                  <KV k="Planned entry" v={num(r.whatRubySaw.plannedEntry, 5)} />
                  <KV k="Planned stop" v={num(r.whatRubySaw.plannedStop, 5)} />
                  <KV k="Planned target" v={num(r.whatRubySaw.plannedTarget, 5)} />
                </div>
                <div className="space-y-1 text-sm">
                  <div className="text-xs font-medium uppercase text-txt-secondary">How it moved</div>
                  <KV k="Max favorable" v={num(r.howItMoved.maxFavorableExcursion, 2)} />
                  <KV k="Max adverse" v={num(r.howItMoved.maxAdverseExcursion, 2)} />
                  <KV k="Elapsed (ms)" v={num(r.howItMoved.elapsedMs)} />
                  <KV k="Data complete" v={r.howItMoved.dataComplete ? "Yes" : "Partial"} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-txt-secondary">{k}</span>
      <span className="tabular-nums">{v}</span>
    </div>
  );
}

// ── audited tuning ────────────────────────────────────────────────────────────
function TuningTab() {
  const qc = useQueryClient();
  const q = useGetAdminRubyThresholds();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const update = useUpdateAdminRubyThresholds({
    mutation: {
      onSuccess: () => {
        setMsg({ kind: "ok", text: "Thresholds updated and audited." });
        setReason("");
        setDraft({});
        qc.invalidateQueries({ queryKey: ["/api/admin/ruby-quality/thresholds"] });
      },
      onError: () => setMsg({ kind: "err", text: "Update failed. Check values and reason (min 3 chars)." }),
    },
  });

  const current = q.data?.thresholds;
  const defaults = q.data?.defaults;

  function valueFor(key: keyof RubyQualityThresholds): string {
    if (draft[key] != null) return draft[key];
    return current ? String(current[key]) : "";
  }

  function submit() {
    setMsg(null);
    const thresholds: AdminRubyThresholdsUpdateReqThresholds = {};
    for (const f of THRESHOLD_FIELDS) {
      const raw = draft[f.key];
      if (raw == null || raw === "") continue;
      const n = Number(raw);
      if (Number.isFinite(n)) thresholds[f.key] = n;
    }
    if (Object.keys(thresholds).length === 0) {
      setMsg({ kind: "err", text: "Change at least one value before saving." });
      return;
    }
    if (reason.trim().length < 3) {
      setMsg({ kind: "err", text: "A reason of at least 3 characters is required (audited)." });
      return;
    }
    update.mutate({ data: { reason: reason.trim(), thresholds } });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-txt-secondary" aria-hidden="true" />
            <CardTitle className="text-base">Outcome-learning thresholds</CardTitle>
          </div>
          <CardDescription>
            These tune how signal outcomes are CLASSIFIED for learning. They never feed any
            execution gate, the kill switch, or the live pipeline. Every change is clamped and
            written with a fail-closed audit row.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {q.isLoading ? (
            <Skeleton className="h-64" />
          ) : q.isError ? (
            <div className="text-sm text-danger">Failed to load thresholds.</div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {THRESHOLD_FIELDS.map((f) => (
                  <div key={f.key} className="space-y-1">
                    <Label htmlFor={`t-${f.key}`}>{f.label}</Label>
                    <Input
                      id={`t-${f.key}`}
                      type="number"
                      value={valueFor(f.key)}
                      onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                      data-testid={`threshold-${f.key}`}
                    />
                    <div className="text-[11px] text-txt-secondary">
                      {f.help}
                      {defaults ? ` · default ${defaults[f.key]}` : ""}
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-4 space-y-1">
                <Label htmlFor="t-reason">Reason (required, audited)</Label>
                <Textarea
                  id="t-reason"
                  placeholder="Why are you changing these thresholds?"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  data-testid="threshold-reason"
                />
              </div>

              {msg && (
                <div
                  className={`mt-3 text-sm ${msg.kind === "ok" ? "text-success" : "text-danger"}`}
                  data-testid="threshold-msg"
                >
                  {msg.text}
                </div>
              )}

              <div className="mt-4 flex items-center gap-2">
                <Button onClick={submit} disabled={update.isPending} data-testid="threshold-save">
                  {update.isPending ? "Saving…" : "Save (audited)"}
                </Button>
                {q.data?.updatedAt && (
                  <span className="text-xs text-txt-secondary">
                    Last updated {new Date(q.data.updatedAt).toLocaleString()}
                    {q.data.updatedByAdminId != null ? ` by admin #${q.data.updatedByAdminId}` : ""}
                  </span>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── investor summary (sanitized) ─────────────────────────────────────────────
function InvestorTab() {
  const q = useGetAdminRubyInvestorSummary();
  const s = q.data?.summary;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-txt-secondary" aria-hidden="true" />
          <CardTitle className="text-base">Investor-reporting summary (sanitized)</CardTitle>
        </div>
        <CardDescription>
          Aggregate-only snapshot suitable for investor reporting. No per-user rows, internal
          tokens, or operator detail.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <Skeleton className="h-32" />
        ) : q.isError ? (
          <div className="text-sm text-danger">Failed to load summary.</div>
        ) : !s ? null : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Signals tracked" value={num(s.signalsTracked)} />
              <StatCard label="Signals graded" value={num(s.signalsGraded)} />
              <StatCard label="Win rate" value={s.winRatePct != null ? `${s.winRatePct.toFixed(1)}%` : "—"} />
              <StatCard label="Avoided bad trades" value={num(s.avoidedBadTrades)} />
            </div>
            <p className="mt-4 text-xs text-txt-secondary">{s.disclaimer}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────
export default function AdminRubyQualityPage() {
  const { name } = useAssistantName();
  return (
    <AdminDiagnosticsGate
      pageTitle={`${name} Signal Quality`}
      pageDescription={`${name} signal-quality analytics`}
    >
      <div className="mx-auto max-w-7xl space-y-4 p-4">
        <div className="flex items-center gap-2">
          <Gauge className="h-5 w-5 text-primary" aria-hidden="true" />
          <div>
            <h1 className="text-xl font-semibold">{name} Signal Quality</h1>
            <p className="text-sm text-txt-secondary">
              Outcome learning, self-review quality, missed-opportunity replay, and audited tuning.
              Read-only over trade results; outcomes resolve only on real evidence.
            </p>
          </div>
        </div>

        <PageTabs
          storageKey="admin-ruby-quality"
          tabs={[
            { id: "metrics", label: "Metrics", content: <MetricsTab /> },
            { id: "missed", label: "Missed opportunities", content: <MissedTab /> },
            { id: "tuning", label: "Tuning", content: <TuningTab /> },
            { id: "investor", label: "Investor summary", content: <InvestorTab /> },
          ]}
        />
      </div>
    </AdminDiagnosticsGate>
  );
}
