// Master Overview — the at-a-glance command summary across the whole Fund Book.
//
// SAFETY: read-only. Every figure is derived from already-audited admin
// endpoints; broker numbers are mirrored (read), never written. Freshness is
// always surfaced so a stale bridge can't masquerade as a live figure.

import {
  useGetAdminFundBookPools,
  useGetAdminFundBookReconciliationOverview,
  useGetAdminFundBookBrokerMirror,
  useGetAdminFundBookPlAllocation,
  useListAdminCapitalRequests,
  useGetAdminCapitalSettings,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Activity,
  Banknote,
  Layers,
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
} from "lucide-react";
import {
  StatCard,
  PnlValue,
  FreshnessBadge,
  ErrorState,
  fmtMoney,
  fmtPct,
  fmtInt,
  fmtTimeAgo,
  worstFreshness,
} from "./format";

// A failed query must never read as a real zero. Render a muted "Unavailable"
// in place of a computed value so a load failure can't masquerade as calm.
function Unavailable() {
  return <span className="text-sm font-normal text-muted-foreground">Unavailable</span>;
}

const PENDING_STATUSES = new Set([
  "REQUESTED",
  "PENDING",
  "PENDING_APPROVAL",
  "UNDER_REVIEW",
  "REVIEWING",
]);

export function OverviewSection() {
  const poolsQ = useGetAdminFundBookPools();
  const reconQ = useGetAdminFundBookReconciliationOverview();
  const mirrorQ = useGetAdminFundBookBrokerMirror();
  const plQ = useGetAdminFundBookPlAllocation();
  const requestsQ = useListAdminCapitalRequests();
  const settingsQ = useGetAdminCapitalSettings();

  if (poolsQ.isLoading || mirrorQ.isLoading) {
    return <Skeleton className="h-64 w-full" data-testid="overview-loading" />;
  }

  // Both primary sources down ⇒ the page has nothing trustworthy to show.
  if (poolsQ.isError && mirrorQ.isError) {
    return (
      <ErrorState
        title="Overview unavailable"
        body="Neither the pool ledger nor the broker mirror could be loaded. This is a load failure — figures are not zero."
        onRetry={() => {
          void poolsQ.refetch();
          void mirrorQ.refetch();
        }}
        busy={poolsQ.isFetching || mirrorQ.isFetching}
        testid="overview-error"
      />
    );
  }

  const pools = poolsQ.data?.pools ?? [];
  const bridges = mirrorQ.data?.bridges ?? [];
  const positions = mirrorQ.data?.openPositions ?? [];
  const recon = reconQ.data;
  const pl = plQ.data;
  const requests = requestsQ.data?.requests ?? [];
  const settings = settingsQ.data?.settings;

  const totalBrokerEquity = bridges.reduce((s, b) => s + (b.accountEquity ?? 0), 0);
  const totalBrokerBalance = bridges.reduce((s, b) => s + (b.accountBalance ?? 0), 0);
  const totalPoolValue = pools.reduce((s, p) => s + (p.totalPoolValue ?? 0), 0);
  const totalFeesAccrued = pools.reduce((s, p) => s + (p.feesAccrued ?? 0), 0);
  const totalFloating = bridges.reduce((s, b) => s + (b.floatingPlTotal ?? 0), 0);
  const openPositionCount =
    bridges.reduce((s, b) => s + (b.openPositionCount ?? 0), 0) || positions.length;
  const bridgeFreshness = worstFreshness(bridges.map((b) => b.freshness));

  const pendingDeposits = requests.filter(
    (r) => r.movementType === "DEPOSIT" && PENDING_STATUSES.has(r.status.toUpperCase()),
  ).length;
  const pendingWithdrawals = requests.filter(
    (r) => r.movementType === "WITHDRAWAL" && PENDING_STATUSES.has(r.status.toUpperCase()),
  ).length;

  const openDiscrepancies = recon?.openCount ?? 0;
  const criticalDiscrepancies = recon?.criticalOpenCount ?? 0;

  return (
    <div className="space-y-4" data-testid="overview-section">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Broker equity (mirrored)"
          testid="kpi-broker-equity"
          hint={
            mirrorQ.isError ? (
              "Broker mirror unavailable"
            ) : (
              <span className="flex items-center gap-1">
                Balance {fmtMoney(totalBrokerBalance)} <FreshnessBadge freshness={bridgeFreshness} />
              </span>
            )
          }
        >
          {mirrorQ.isError ? <Unavailable /> : fmtMoney(totalBrokerEquity)}
        </StatCard>

        <StatCard
          label="Total pool value"
          testid="kpi-pool-value"
          hint={poolsQ.isError ? "Pool ledger unavailable" : `${fmtInt(pools.length)} ${pools.length === 1 ? "pool" : "pools"}`}
        >
          {poolsQ.isError ? <Unavailable /> : fmtMoney(totalPoolValue)}
        </StatCard>

        <StatCard
          label="Open exposure (floating)"
          testid="kpi-open-exposure"
          hint={
            mirrorQ.isError
              ? "Broker mirror unavailable"
              : `${fmtInt(openPositionCount)} open ${openPositionCount === 1 ? "position" : "positions"}`
          }
        >
          {mirrorQ.isError ? <Unavailable /> : <PnlValue value={totalFloating} />}
        </StatCard>

        <StatCard
          label="Fees accrued"
          testid="kpi-fees-accrued"
          hint={
            poolsQ.isError
              ? "Pool ledger unavailable"
              : settings
                ? `Mgmt ${fmtPct(settings.managementFeeAnnualPct)} · Perf ${fmtPct(settings.performanceFeePct)}`
                : "Fee policy unavailable"
          }
        >
          {poolsQ.isError ? <Unavailable /> : fmtMoney(totalFeesAccrued)}
        </StatCard>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-amber-400" /> Reconciliation
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {reconQ.isError ? (
              <Row label="Status" value={<Unavailable />} testid="kpi-recon-unavailable" />
            ) : (
              <>
                <Row label="Open discrepancies" value={fmtInt(openDiscrepancies)} testid="kpi-open-discrepancies" />
                <Row
                  label="Critical open"
                  value={fmtInt(criticalDiscrepancies)}
                  emphasize={criticalDiscrepancies > 0}
                  testid="kpi-critical-discrepancies"
                />
                <Row label="Investigating" value={fmtInt(recon?.investigatingCount ?? 0)} />
                <Row label="Active freezes" value={fmtInt(recon?.activeFreezes?.length ?? 0)} />
                <p className="pt-1 text-xs text-muted-foreground">
                  {recon?.lastRunAt
                    ? `Last reconciled ${fmtTimeAgo(recon.lastRunAt)}`
                    : "No reconciliation run recorded yet."}
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Banknote className="h-4 w-4 text-emerald-400" /> Capital queue
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {requestsQ.isError ? (
              <Row label="Status" value={<Unavailable />} testid="kpi-capital-unavailable" />
            ) : (
              <>
                <Row
                  label="Pending deposits"
                  value={
                    <span className="flex items-center gap-1">
                      <ArrowDownToLine className="h-3 w-3" /> {fmtInt(pendingDeposits)}
                    </span>
                  }
                  emphasize={pendingDeposits > 0}
                  testid="kpi-pending-deposits"
                />
                <Row
                  label="Pending withdrawals"
                  value={
                    <span className="flex items-center gap-1">
                      <ArrowUpFromLine className="h-3 w-3" /> {fmtInt(pendingWithdrawals)}
                    </span>
                  }
                  emphasize={pendingWithdrawals > 0}
                  testid="kpi-pending-withdrawals"
                />
                <Row label="Total requests on file" value={fmtInt(requests.length)} />
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Layers className="h-4 w-4 text-sky-400" /> Allocation
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {plQ.isError ? (
              <Row label="Status" value={<Unavailable />} testid="kpi-allocation-unavailable" />
            ) : (
              <>
                <Row
                  label="Assigned floating P/L"
                  value={<PnlValue value={pl?.assignedTotal ?? 0} />}
                />
                <Row label="Assigned positions" value={fmtInt(pl?.assignedCount ?? 0)} />
                <Row
                  label="Unassigned positions"
                  value={fmtInt(pl?.unassigned?.length ?? 0)}
                  emphasize={(pl?.unassigned?.length ?? 0) > 0}
                  testid="kpi-unassigned-positions"
                />
                <Row label="Unavailable P/L" value={fmtInt(pl?.unavailableCount ?? 0)} />
              </>
            )}
            <p className="flex items-center gap-1 pt-1 text-xs text-muted-foreground">
              <Activity className="h-3 w-3" />{" "}
              {mirrorQ.isError
                ? "Broker mirror unavailable"
                : `Broker mirror ${fmtInt(bridges.length)} ${bridges.length === 1 ? "bridge" : "bridges"}`}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  emphasize,
  testid,
}: {
  label: string;
  value: React.ReactNode;
  emphasize?: boolean;
  testid?: string;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border/40 py-1 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${emphasize ? "font-bold text-amber-400" : ""}`} data-testid={testid}>
        {value}
      </span>
    </div>
  );
}
