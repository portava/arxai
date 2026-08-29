// Discrepancies — the reconciliation safety-net queue with reason-gated
// investigate / resolve / dismiss / note actions.
//
// SAFETY: read + audited status actions only. No action closes a trade or
// touches the live pipeline; the full controls (freezes, capacity) live on the
// Reconciliation Center, deep-linked below.

import { useState } from "react";
import {
  useGetAdminFundBookReconciliationOverview,
  useListAdminFundBookDiscrepancies,
  useActOnAdminFundBookDiscrepancy,
} from "@workspace/api-client-react";
import type { FundDiscrepancy, DiscrepancyActionReqAction } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Link } from "wouter";
import { ShieldAlert, ExternalLink } from "lucide-react";
import { StatusBadge, ReasonDialog, EmptyState, ErrorState, fmtMoney, fmtInt, fmtTimeAgo } from "./format";

const ACTIONS: Array<{ key: DiscrepancyActionReqAction; label: string; note?: boolean; destructive?: boolean }> = [
  { key: "INVESTIGATE", label: "Investigate" },
  { key: "NOTE", label: "Add note", note: true },
  { key: "RESOLVE", label: "Resolve" },
  { key: "DISMISS", label: "Dismiss", destructive: true },
];

const STATUS_OPTIONS = ["ALL", "OPEN", "INVESTIGATING", "RESOLVED", "DISMISSED"];
const SEVERITY_OPTIONS = ["ALL", "CRITICAL", "HIGH", "MEDIUM", "LOW"];

export function DiscrepancySection() {
  const [status, setStatus] = useState("OPEN");
  const [severity, setSeverity] = useState("ALL");
  const [pending, setPending] = useState<{ d: FundDiscrepancy; action: (typeof ACTIONS)[number] } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const overviewQ = useGetAdminFundBookReconciliationOverview();
  const listQ = useListAdminFundBookDiscrepancies({
    ...(status !== "ALL" ? { status } : {}),
    ...(severity !== "ALL" ? { severity } : {}),
  });
  const act = useActOnAdminFundBookDiscrepancy();

  const overview = overviewQ.data;
  const discrepancies = listQ.data?.discrepancies ?? [];

  function submit(reason: string, note?: string) {
    if (!pending) return;
    setErr(null);
    act.mutate(
      {
        id: pending.d.id,
        data: {
          action: pending.action.key,
          reason,
          ...(pending.action.note && note ? { note } : {}),
        },
      },
      {
        onSuccess: () => {
          setPending(null);
          void listQ.refetch();
          void overviewQ.refetch();
        },
        onError: (e) => setErr(e instanceof Error ? e.message : "Action failed."),
      },
    );
  }

  return (
    <div className="space-y-4" data-testid="discrepancy-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {overview ? (
            <>
              <Badge className="bg-warning/15 text-warning">open {fmtInt(overview.openCount)}</Badge>
              <Badge className="bg-danger/15 text-danger">critical {fmtInt(overview.criticalOpenCount)}</Badge>
              <Badge className="bg-ruby/15 text-ruby">investigating {fmtInt(overview.investigatingCount)}</Badge>
              <span className="text-xs text-muted-foreground">
                {overview.lastRunAt ? `Last run ${fmtTimeAgo(overview.lastRunAt)}` : "No run recorded"}
              </span>
            </>
          ) : null}
        </div>
        <Link href="/admin/reconciliation-center">
          <a>
            <Button variant="outline" size="sm" data-testid="link-recon-center">
              <ExternalLink className="mr-1 h-3 w-3" /> Reconciliation Center
            </Button>
          </a>
        </Link>
      </div>

      <div className="flex flex-wrap gap-2">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44" data-testid="select-discrepancy-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s} value={s}>
                Status: {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={severity} onValueChange={setSeverity}>
          <SelectTrigger className="w-44" data-testid="select-discrepancy-severity">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SEVERITY_OPTIONS.map((s) => (
              <SelectItem key={s} value={s}>
                Severity: {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {err ? <p className="text-xs text-danger">{err}</p> : null}

      {listQ.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : listQ.isError ? (
        <ErrorState
          title="Discrepancy queue unavailable"
          body="The reconciliation queue could not be loaded. This is a load failure, not an all-clear."
          onRetry={() => void listQ.refetch()}
          busy={listQ.isFetching}
          testid="discrepancy-error"
        />
      ) : discrepancies.length === 0 ? (
        <EmptyState
          icon={ShieldAlert}
          title="No discrepancies match"
          body="Nothing requires attention for the selected status and severity."
          testid="discrepancy-empty"
        />
      ) : (
        <div className="space-y-3">
          {discrepancies.map((d) => (
            <Card key={d.id} data-testid={`discrepancy-${d.id}`}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-sm">{d.discrepancyType}</CardTitle>
                  <StatusBadge status={d.severity} />
                  <StatusBadge status={d.status} />
                  <Badge variant="outline">{d.entityType}</Badge>
                  {d.userId != null ? <Badge variant="outline">user {d.userId}</Badge> : null}
                </div>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p>{d.summary}</p>
                {d.recommendedAction ? (
                  <p className="text-muted-foreground">
                    <span className="font-semibold">Recommended:</span> {d.recommendedAction}
                  </p>
                ) : null}
                {(d.expectedValue != null || d.observedValue != null) && (
                  <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                    {d.expectedValue != null ? <span>Expected {fmtMoney(d.expectedValue)}</span> : null}
                    {d.observedValue != null ? <span>Observed {fmtMoney(d.observedValue)}</span> : null}
                    {d.deltaAbsolute != null ? <span>Δ {fmtMoney(d.deltaAbsolute)}</span> : null}
                  </div>
                )}
                <div className="flex flex-wrap gap-2 pt-1">
                  {ACTIONS.map((a) => (
                    <Button
                      key={a.key}
                      size="sm"
                      variant={a.destructive ? "destructive" : "outline"}
                      disabled={act.isPending}
                      onClick={() => {
                        setPending({ d, action: a });
                        setErr(null);
                      }}
                      data-testid={`button-${a.key.toLowerCase()}-${d.id}`}
                    >
                      {a.label}
                    </Button>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ReasonDialog
        open={pending != null}
        onOpenChange={(o) => {
          if (!o) setPending(null);
        }}
        title={pending ? `${pending.action.label}: ${pending.d.discrepancyType}` : "Action"}
        description="This action is recorded with your reason in the admin audit log."
        confirmLabel={pending?.action.label ?? "Confirm"}
        confirmVariant={pending?.action.destructive ? "destructive" : "default"}
        withNote={pending?.action.note}
        busy={act.isPending}
        onConfirm={submit}
      />
    </div>
  );
}
