// Profit Waterfall & ARX internal split (task #142, updated task #610).
// Split updated to 45.5% ARX / 24.5% trader / 30% investor-distributable.
// Lets an admin/OWNER run a crystallization waterfall for a pool/period and
// reverse an existing run, and shows the full run ledger INCLUDING the
// admin-only ARX internal + trader shares.
//
// SAFETY: admin/OWNER only (the page is wrapped in AdminDiagnosticsGate). This
// surface is RECORD-ONLY — it never redeems units, discounts NAV, or writes fee
// entries, and it never touches live execution or the 16-gate evaluator. Both
// mutations are reason-gated (≥3 chars) and audited server-side. The 45.5% ARX
// internal and 24.5% trader shares are admin-only and are NEVER returned to investors.

import { useState } from "react";
import {
  useGetAdminFundBookPools,
  useGetAdminFundBookWaterfall,
  useGetAdminFundBookWaterfallRun,
  useRunAdminFundBookWaterfall,
  useReverseAdminFundBookWaterfall,
} from "@workspace/api-client-react";
import type { AdminWaterfallRun } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Waves, Lock, Undo2, Play, ChevronDown, ChevronRight, Users } from "lucide-react";
import {
  StatusBadge,
  PnlValue,
  ReasonDialog,
  EmptyState,
  ErrorState,
  fmtMoney,
  fmtPct,
  fmtUnits,
  fmtDate,
} from "./format";

function defaultPeriodKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function WaterfallSection() {
  const poolsQ = useGetAdminFundBookPools();
  const runsQ = useGetAdminFundBookWaterfall();
  const run = useRunAdminFundBookWaterfall();
  const reverse = useReverseAdminFundBookWaterfall();

  const [runOpen, setRunOpen] = useState(false);
  const [poolKey, setPoolKey] = useState("");
  const [periodKey, setPeriodKey] = useState(defaultPeriodKey());
  const [reverseTarget, setReverseTarget] = useState<AdminWaterfallRun | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [err, setErr] = useState<string | null>(null);

  function toggleExpanded(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (poolsQ.isLoading || runsQ.isLoading) {
    return <Skeleton className="h-64 w-full" data-testid="waterfall-loading" />;
  }

  if (runsQ.isError) {
    return (
      <ErrorState
        title="Waterfall ledger unavailable"
        body="The profit-waterfall run ledger could not be loaded. This is a load failure, not an empty book."
        onRetry={() => void runsQ.refetch()}
        busy={runsQ.isFetching}
        testid="waterfall-error"
      />
    );
  }

  const pools = poolsQ.data?.pools ?? [];
  const runs = runsQ.data?.runs ?? [];

  function submitRun(reason: string) {
    if (!poolKey || !periodKey.trim()) return;
    setErr(null);
    run.mutate(
      { data: { poolKey, periodKey: periodKey.trim(), reason } },
      {
        onSuccess: () => {
          setRunOpen(false);
          void runsQ.refetch();
        },
        onError: (e) => setErr(e instanceof Error ? e.message : "Waterfall run failed."),
      },
    );
  }

  function submitReverse(reason: string) {
    if (!reverseTarget) return;
    setErr(null);
    reverse.mutate(
      { runId: reverseTarget.id, data: { reason } },
      {
        onSuccess: () => {
          setReverseTarget(null);
          void runsQ.refetch();
        },
        onError: (e) => setErr(e instanceof Error ? e.message : "Reversal failed."),
      },
    );
  }

  return (
    <div className="space-y-4" data-testid="waterfall-section">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Waves className="h-4 w-4" /> Profit Waterfall (45.5 / 24.5 / 30)
            </CardTitle>
            <Button
              size="sm"
              disabled={pools.length === 0 || run.isPending}
              onClick={() => {
                setPoolKey("");
                setPeriodKey(defaultPeriodKey());
                setErr(null);
                setRunOpen(true);
              }}
              data-testid="button-run-waterfall"
            >
              <Play className="mr-1 h-4 w-4" /> Run waterfall
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            When a pool's net value exceeds its own crystallization high-water mark,
            eligible new profit is split{" "}
            <strong>45.5% ARX internal</strong> /{" "}
            <strong>24.5% trader</strong> /{" "}
            <strong>30% investor-distributable</strong>{" "}
            (pro-rata by units at the run cutoff). Record-only: no units are redeemed,
            NAV is untouched, and no fee entries are written. The ARX and trader shares
            are admin-only.
          </p>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <EmptyState
              icon={Waves}
              title="No waterfall runs yet"
              body="When you run a crystallization waterfall for a pool/period, the run, its 45.5/24.5/30 split and the per-investor distributable allocations will appear here."
              testid="waterfall-empty"
            />
          ) : (
            <div className="space-y-3">
              {runs.map((r) => {
                const reversed = r.status !== "ACTIVE";
                const isReversal = r.runType === "REVERSAL";
                return (
                  <div
                    key={r.id}
                    className="rounded-md border border-border/60 p-3"
                    data-testid={`waterfall-run-${r.id}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{r.poolKey ?? `pool ${r.strategyPoolId}`}</Badge>
                        <Badge variant="outline">{r.periodKey}</Badge>
                        <StatusBadge status={r.status} />
                        {isReversal ? (
                          <Badge className="bg-warning/15 text-warning">
                            <Undo2 className="mr-1 h-3 w-3" /> Reversal
                            {r.reversalOfRunId != null ? ` of #${r.reversalOfRunId}` : ""}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => toggleExpanded(r.id)}
                          data-testid={`button-toggle-allocations-${r.id}`}
                        >
                          {expanded.has(r.id) ? (
                            <ChevronDown className="mr-1 h-4 w-4" />
                          ) : (
                            <ChevronRight className="mr-1 h-4 w-4" />
                          )}
                          <Users className="mr-1 h-4 w-4" /> Investors
                        </Button>
                        {!reversed && !isReversal ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={reverse.isPending}
                            onClick={() => {
                              setReverseTarget(r);
                              setErr(null);
                            }}
                            data-testid={`button-reverse-${r.id}`}
                          >
                            <Undo2 className="mr-1 h-4 w-4" /> Reverse
                          </Button>
                        ) : null}
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-3">
                      <Field
                        label="Net value"
                        value={fmtMoney(r.currentNetValue)}
                        hint={r.currentNetValueSource}
                      />
                      <Field label="HWM before" value={fmtMoney(r.highWaterValueBefore)} />
                      <Field label="HWM after" value={fmtMoney(r.highWaterValueAfter)} />
                      <Field
                        label="Eligible profit"
                        value={<PnlValue value={r.eligibleProfit} />}
                      />
                      <Field
                        label={`ARX internal (${fmtPct(r.arxSharePct, 0)})`}
                        value={
                          <span className="inline-flex items-center gap-1 text-premium">
                            <Lock className="h-3 w-3" /> {fmtMoney(r.arxInternalShare)}
                          </span>
                        }
                      />
                      {r.traderShare != null ? (
                        <Field
                          label={`Trader share (${r.traderSharePct != null ? fmtPct(r.traderSharePct, 0) : "24.5%"})`}
                          value={
                            <span className="inline-flex items-center gap-1 text-warning">
                              <Lock className="h-3 w-3" /> {fmtMoney(r.traderShare)}
                            </span>
                          }
                        />
                      ) : null}
                      <Field
                        label={`Investor distributable (${fmtPct(r.investorSharePct, 0)})`}
                        value={fmtMoney(r.investorDistributable)}
                      />
                      <Field
                        label="Units at cutoff"
                        value={fmtUnits(r.totalUnitsAtCutoff)}
                      />
                      <Field label="Run #" value={`#${r.id}`} />
                      <Field label="Created" value={fmtDate(r.createdAt)} />
                    </div>

                    <p className="mt-2 text-xs text-muted-foreground">
                      Reason: {r.reason}
                      {reversed && r.reversalReason ? ` · Reversed: ${r.reversalReason}` : ""}
                    </p>

                    {expanded.has(r.id) ? <RunAllocations runId={r.id} /> : null}
                  </div>
                );
              })}
            </div>
          )}
          {err ? <p className="mt-2 text-xs text-danger">{err}</p> : null}
        </CardContent>
      </Card>

      <ReasonDialog
        open={runOpen}
        onOpenChange={(o) => {
          if (!o) setRunOpen(false);
        }}
        title="Run profit waterfall"
        description="Crystallize eligible new profit above the pool's high-water mark and split it 45.5% ARX / 24.5% trader / 30% investor-distributable. Record-only and idempotent per pool/period."
        confirmLabel="Run waterfall"
        busy={run.isPending}
        extraValid={!!poolKey && periodKey.trim().length > 0}
        extra={
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="waterfall-pool">Pool</Label>
              <Select value={poolKey} onValueChange={setPoolKey}>
                <SelectTrigger id="waterfall-pool" data-testid="select-waterfall-pool">
                  <SelectValue placeholder="Choose a pool" />
                </SelectTrigger>
                <SelectContent>
                  {pools.map((p) => (
                    <SelectItem key={p.poolKey} value={p.poolKey}>
                      {p.name} ({p.poolKey})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="waterfall-period">Period key</Label>
              <Input
                id="waterfall-period"
                data-testid="input-waterfall-period"
                value={periodKey}
                onChange={(e) => setPeriodKey(e.target.value)}
                placeholder="e.g. 2026-06"
              />
              <p className="text-xs text-muted-foreground">
                A re-run with the same pool and period is a no-op (idempotent).
              </p>
            </div>
          </div>
        }
        onConfirm={(reason) => submitRun(reason)}
      />

      <ReasonDialog
        open={reverseTarget != null}
        onOpenChange={(o) => {
          if (!o) setReverseTarget(null);
        }}
        title={reverseTarget ? `Reverse waterfall run #${reverseTarget.id}` : "Reverse run"}
        description="Post an offsetting reversal run with negated allocations and a negated ARX entry. Append-only — the original run is marked reversed, never deleted."
        confirmLabel="Reverse run"
        confirmVariant="destructive"
        busy={reverse.isPending}
        onConfirm={(reason) => submitReverse(reason)}
      />
    </div>
  );
}

// Lazy per-investor allocation breakdown for a single run. Fetches the
// run-detail endpoint only when its parent row is expanded. ARX share lives on
// the run header, never per-investor, so this allocation list is ARX-free.
function RunAllocations({ runId }: { runId: number }) {
  const detailQ = useGetAdminFundBookWaterfallRun(runId);

  if (detailQ.isLoading) {
    return (
      <Skeleton
        className="mt-3 h-20 w-full"
        data-testid={`waterfall-allocations-loading-${runId}`}
      />
    );
  }

  if (detailQ.isError) {
    return (
      <p
        className="mt-3 text-xs text-danger"
        data-testid={`waterfall-allocations-error-${runId}`}
      >
        Per-investor allocations could not be loaded. This is a load failure, not
        an empty allocation set.
      </p>
    );
  }

  const allocations = detailQ.data?.allocations ?? [];

  if (allocations.length === 0) {
    return (
      <p
        className="mt-3 text-xs text-muted-foreground"
        data-testid={`waterfall-allocations-empty-${runId}`}
      >
        No per-investor allocations for this run (no eligible profit to
        distribute).
      </p>
    );
  }

  return (
    <div
      className="mt-3 rounded-md border border-border/40 bg-muted/20 p-2"
      data-testid={`waterfall-allocations-${runId}`}
    >
      <div className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <Users className="h-3 w-3" /> Per-investor distributable
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="py-1 font-normal">Investor</th>
            <th className="py-1 text-right font-normal">Units</th>
            <th className="py-1 text-right font-normal">Ownership</th>
            <th className="py-1 text-right font-normal">Distributable</th>
          </tr>
        </thead>
        <tbody>
          {allocations.map((a) => (
            <tr
              key={a.id}
              className="border-t border-border/30"
              data-testid={`waterfall-allocation-${runId}-${a.userId}`}
            >
              <td className="py-1 tabular-nums">#{a.userId}</td>
              <td className="py-1 text-right tabular-nums">{fmtUnits(a.unitsAtCutoff)}</td>
              <td className="py-1 text-right tabular-nums">{fmtPct(a.ownershipFraction, 2)}</td>
              <td className="py-1 text-right tabular-nums">{fmtMoney(a.distributableShare)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Field({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex flex-col border-b border-border/30 py-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
      {hint ? <span className="text-[10px] text-muted-foreground/70">{hint}</span> : null}
    </div>
  );
}
