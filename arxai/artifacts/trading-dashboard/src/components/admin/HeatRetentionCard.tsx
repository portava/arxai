// Heat-snapshot retention status card (Task #266).
//
// Admin-only read of the heat_snapshots retention policy + status: policy
// active, last prune run, rows pruned, protected rows, oldest retained snapshot.
// Includes a safe dry-run preview and an explicit "Run prune now" action (both
// route through the audited backend; the dry-run deletes nothing).
//
// SAFETY: rendered only inside AdminDiagnosticsGate on the snapshots page; the
// backend independently gates ADMIN/OWNER. Pruning never touches audit-critical
// records or decision-linked snapshots.

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetAdminTimingBrainRetention,
  getGetAdminTimingBrainRetentionQueryKey,
  useRunAdminTimingBrainRetentionPrune,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Trash2, ShieldCheck, RefreshCw, Eye } from "lucide-react";

function fmtTs(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Stat({ label, value, testId }: { label: string; value: React.ReactNode; testId: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-txt-secondary">{label}</p>
      <p className="text-sm font-medium tabular-nums" data-testid={testId}>{value}</p>
    </div>
  );
}

export function HeatRetentionCard() {
  const qc = useQueryClient();
  const queryKey = getGetAdminTimingBrainRetentionQueryKey();
  const { data, isLoading, isError, isFetching, refetch } = useGetAdminTimingBrainRetention({
    query: { queryKey },
  });
  const prune = useRunAdminTimingBrainRetentionPrune();

  const [notice, setNotice] = useState<string | null>(null);

  const policy = data?.policy;
  const plan = data?.plan;
  const lastRun = data?.lastRun ?? null;
  const worker = data?.worker;

  async function runPrune(dryRun: boolean) {
    setNotice(null);
    const reason = dryRun
      ? "Admin dry-run preview from Timing Brain Snapshots page"
      : "Manual admin prune from Timing Brain Snapshots page";
    if (!dryRun) {
      const ok = window.confirm(
        `This will permanently delete ${plan?.wouldDelete ?? 0} old heat snapshots ` +
          `(decision-linked snapshots are protected and kept). Continue?`,
      );
      if (!ok) return;
    }
    try {
      const res = await prune.mutateAsync({ data: { dryRun, reason } });
      setNotice(
        dryRun
          ? `Dry-run: ${res.plan.wouldDelete} would be deleted, ${res.plan.protectedCount} protected.`
          : `Pruned ${res.run.rowsDeleted} snapshots (${res.run.protectedRows} protected).`,
      );
      await qc.invalidateQueries({ queryKey });
    } catch {
      setNotice("Action failed. Please retry.");
    }
  }

  return (
    <Card data-testid="card-heat-retention">
      <CardHeader>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <div className="rounded-md bg-primary/10 p-2">
              <Trash2 className="h-5 w-5 text-primary" aria-hidden="true" />
            </div>
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                Retention policy
                {policy ? (
                  <Badge
                    variant={policy.enabled ? "default" : "secondary"}
                    data-testid="badge-retention-enabled"
                  >
                    {policy.enabled ? "Active" : "Disabled"}
                  </Badge>
                ) : null}
              </CardTitle>
              <CardDescription>
                Automatic pruning of old heat snapshots. Decision-linked snapshots are
                always protected. Advisory data — never an execution gate.
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              data-testid="button-retention-refresh"
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isFetching ? "animate-spin" : ""}`} aria-hidden="true" />
              Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => runPrune(true)}
              disabled={prune.isPending || isLoading}
              data-testid="button-retention-dryrun"
            >
              <Eye className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
              Preview
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => runPrune(false)}
              disabled={prune.isPending || isLoading || !policy?.enabled || (plan?.wouldDelete ?? 0) === 0}
              data-testid="button-retention-prune"
            >
              <Trash2 className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
              Prune now
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isError ? (
          <div className="py-6 text-center text-sm text-destructive" data-testid="text-retention-error">
            Failed to load retention status.
          </div>
        ) : isLoading ? (
          <div className="py-6 text-center text-sm text-txt-secondary" data-testid="text-retention-loading">
            Loading retention status…
          </div>
        ) : (
          <>
            {notice ? (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm" data-testid="text-retention-notice">
                {notice}
              </div>
            ) : null}

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat
                label="Keep full detail"
                value={`${policy?.fullDetailRetentionDays ?? 0} days`}
                testId="stat-full-days"
              />
              <Stat
                label="Hard-delete after"
                value={`${policy?.effectiveCutoffDays ?? 0} days`}
                testId="stat-cutoff-days"
              />
              <Stat
                label="Oldest retained"
                value={fmtTs(plan?.oldestRetainedAt)}
                testId="stat-oldest-retained"
              />
              <Stat label="Total rows" value={plan?.totalRows ?? 0} testId="stat-total-rows" />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Eligible by age" value={plan?.eligibleByAge ?? 0} testId="stat-eligible" />
              <Stat label="Would delete now" value={plan?.wouldDelete ?? 0} testId="stat-would-delete" />
              <Stat
                label="Protected"
                value={
                  <span className="inline-flex items-center gap-1">
                    <ShieldCheck className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                    {plan?.protectedCount ?? 0}
                  </span>
                }
                testId="stat-protected"
              />
              <Stat
                label="Rollups (31–180d)"
                value={policy?.rollupsImplemented ? "On" : "Future-ready"}
                testId="stat-rollups"
              />
            </div>

            <div className="rounded-md border border-border/60 px-3 py-2 text-xs text-txt-secondary space-y-1">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span data-testid="text-last-run">
                  <span className="font-medium text-foreground">Last run:</span>{" "}
                  {lastRun
                    ? `${fmtTs(lastRun.ranAt)} · ${lastRun.trigger}${lastRun.dryRun ? " (dry-run)" : ""} · ${lastRun.rowsDeleted} deleted, ${lastRun.protectedRows} protected`
                    : "never"}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span data-testid="text-worker-status">
                  <span className="font-medium text-foreground">Auto worker:</span>{" "}
                  {worker?.running ? "running" : "stopped"} · every{" "}
                  {Math.round((worker?.intervalMs ?? 0) / (60 * 60 * 1000))}h · {worker?.cyclesRun ?? 0} cycles
                </span>
                <span>
                  <span className="font-medium text-foreground">Protection window:</span>{" "}
                  ±{policy?.protectionWindowMinutes ?? 0} min around trades/decisions
                </span>
              </div>
              {policy?.activeProtectionSources?.length ? (
                <div data-testid="text-protection-sources">
                  <span className="font-medium text-foreground">Protected from:</span>{" "}
                  {policy.activeProtectionSources.join(", ")}
                </div>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
