// Capital Movements — the deposit/withdrawal approval queue. No page rendered
// this before; it is the operator front door for reviewing investor requests.
//
// SAFETY: read + audited approve/reject only (each requires a ≥3-char reason).
// Approving resolves the NAV cutoff cycle server-side; this UI never computes or
// asserts a settlement price itself and never moves money directly.

import { useState } from "react";
import {
  useListAdminCapitalRequests,
  useApproveAdminCapitalRequest,
  useRejectAdminCapitalRequest,
} from "@workspace/api-client-react";
import type { CapitalMovementRequest } from "@workspace/api-client-react";
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
import { ArrowDownToLine, ArrowUpFromLine, Banknote } from "lucide-react";
import { StatusBadge, ReasonDialog, EmptyState, ErrorState, fmtMoney, fmtInt, fmtDate } from "./format";

const PENDING_STATUSES = new Set([
  "REQUESTED",
  "PENDING",
  "PENDING_APPROVAL",
  "UNDER_REVIEW",
  "REVIEWING",
]);

const TYPE_OPTIONS = ["ALL", "DEPOSIT", "WITHDRAWAL"];
const STATUS_OPTIONS = ["PENDING", "ALL", "APPROVED", "SETTLED", "REJECTED", "CANCELLED"];

export function CapitalMovementsSection() {
  const [type, setType] = useState("ALL");
  const [status, setStatus] = useState("PENDING");
  const [pending, setPending] = useState<{ r: CapitalMovementRequest; mode: "approve" | "reject" } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // "PENDING" is a client-side rollup of all open statuses; the server filter
  // takes a single concrete status, so we fetch unfiltered and narrow locally.
  const listQ = useListAdminCapitalRequests(type !== "ALL" ? { movementType: type } : undefined);
  const approve = useApproveAdminCapitalRequest();
  const reject = useRejectAdminCapitalRequest();
  const busy = approve.isPending || reject.isPending;

  const all = listQ.data?.requests ?? [];
  const requests = all.filter((r) => {
    if (status === "ALL") return true;
    if (status === "PENDING") return PENDING_STATUSES.has(r.status.toUpperCase());
    return r.status.toUpperCase() === status;
  });

  function submit(reason: string, note?: string) {
    if (!pending) return;
    setErr(null);
    const mut = pending.mode === "approve" ? approve : reject;
    mut.mutate(
      { id: pending.r.id, data: { reason, ...(note ? { reviewNote: note } : {}) } },
      {
        onSuccess: () => {
          setPending(null);
          void listQ.refetch();
        },
        onError: (e) => setErr(e instanceof Error ? e.message : "Action failed."),
      },
    );
  }

  return (
    <div className="space-y-4" data-testid="capital-movements-section">
      <div className="flex flex-wrap gap-2">
        <Select value={type} onValueChange={setType}>
          <SelectTrigger className="w-44" data-testid="select-movement-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TYPE_OPTIONS.map((t) => (
              <SelectItem key={t} value={t}>
                Type: {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44" data-testid="select-movement-status">
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
        <Badge variant="outline" className="self-center">
          {fmtInt(requests.length)} shown
        </Badge>
      </div>

      {err ? <p className="text-xs text-red-400">{err}</p> : null}

      {listQ.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : listQ.isError ? (
        <ErrorState
          title="Capital requests unavailable"
          body="The approval queue could not be loaded. This is a load failure, not an empty queue — pending requests may still need review."
          onRetry={() => void listQ.refetch()}
          busy={listQ.isFetching}
          testid="capital-error"
        />
      ) : requests.length === 0 ? (
        <EmptyState
          icon={Banknote}
          title="No matching capital requests"
          body="Investor deposit and withdrawal requests appear here for review. Nothing matches the current filters."
          testid="capital-empty"
        />
      ) : (
        <div className="space-y-3">
          {requests.map((r) => {
            const isDeposit = r.movementType === "DEPOSIT";
            const isPending = PENDING_STATUSES.has(r.status.toUpperCase());
            return (
              <Card key={r.id} data-testid={`capital-request-${r.id}`}>
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2 text-sm">
                      {isDeposit ? (
                        <ArrowDownToLine className="h-4 w-4 text-emerald-400" />
                      ) : (
                        <ArrowUpFromLine className="h-4 w-4 text-amber-400" />
                      )}
                      {r.movementType} · user {r.userId}
                    </CardTitle>
                    <StatusBadge status={r.status} />
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
                    <Field label="Gross" value={fmtMoney(r.grossAmount, r.currency)} />
                    <Field label="Total fees" value={fmtMoney(r.totalFeeAmount, r.currency)} />
                    <Field label="Net" value={fmtMoney(r.netAmount, r.currency)} />
                    <Field label="Speed tier" value={r.speedTierKey} />
                    <Field label="NAV timing" value={r.navCycleTiming ?? "—"} />
                    <Field label="NAV cut" value={r.navCutAt ? fmtDate(r.navCutAt) : "—"} />
                    {r.targetPoolKey ? <Field label="Target pool" value={r.targetPoolKey} /> : null}
                    {r.isFullExit ? <Field label="Full exit" value="Yes" /> : null}
                  </div>
                  {r.requestNote ? (
                    <p className="text-xs text-muted-foreground">
                      <span className="font-semibold">Investor note:</span> {r.requestNote}
                    </p>
                  ) : null}
                  {r.reviewNote ? (
                    <p className="text-xs text-muted-foreground">
                      <span className="font-semibold">Review note:</span> {r.reviewNote}
                    </p>
                  ) : null}
                  {isPending ? (
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setPending({ r, mode: "approve" });
                          setErr(null);
                        }}
                        data-testid={`button-approve-${r.id}`}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        onClick={() => {
                          setPending({ r, mode: "reject" });
                          setErr(null);
                        }}
                        data-testid={`button-reject-${r.id}`}
                      >
                        Reject
                      </Button>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {r.reviewedAt ? `Reviewed ${fmtDate(r.reviewedAt)}` : "No further action available."}
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <ReasonDialog
        open={pending != null}
        onOpenChange={(o) => {
          if (!o) setPending(null);
        }}
        title={
          pending
            ? `${pending.mode === "approve" ? "Approve" : "Reject"} ${pending.r.movementType} · user ${pending.r.userId}`
            : "Review request"
        }
        description={
          pending?.mode === "approve"
            ? "Approving resolves the NAV cutoff cycle server-side. Recorded with your reason."
            : "Rejecting closes this request. Recorded with your reason."
        }
        confirmLabel={pending?.mode === "approve" ? "Approve" : "Reject"}
        confirmVariant={pending?.mode === "reject" ? "destructive" : "default"}
        withNote
        noteLabel="Review note (optional)"
        busy={busy}
        onConfirm={submit}
      />
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
