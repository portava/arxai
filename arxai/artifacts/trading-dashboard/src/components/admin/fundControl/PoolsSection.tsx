// Strategy Pools — NAV, units, value, P/L, drawdown and holders per pool, plus
// the unassigned-trade queue with a reason-gated assign-to-pool action.
//
// SAFETY: read-only except the audited assign mutation, which only links an
// already-open broker position to exactly one pool for accounting. It never
// opens, closes, or modifies a trade and never touches the 16-gate live path.

import { useState } from "react";
import {
  useGetAdminFundBookPools,
  useGetAdminFundBookPlAllocation,
  useGetAdminFundBookTradeAllocations,
  useAssignAdminFundBookTradeAllocation,
} from "@workspace/api-client-react";
import type { TradePoolAllocation } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Layers, Snowflake } from "lucide-react";
import { PoolTierPanel } from "./PoolTierPanel";
import {
  StatusBadge,
  FreshnessBadge,
  PnlValue,
  ReasonDialog,
  EmptyState,
  ErrorState,
  fmtMoney,
  fmtPct,
  fmtUnits,
  fmtInt,
} from "./format";

export function PoolsSection() {
  const poolsQ = useGetAdminFundBookPools();
  const plQ = useGetAdminFundBookPlAllocation();
  const allocQ = useGetAdminFundBookTradeAllocations();
  const assign = useAssignAdminFundBookTradeAllocation();

  const [target, setTarget] = useState<TradePoolAllocation | null>(null);
  const [poolKey, setPoolKey] = useState("");
  const [err, setErr] = useState<string | null>(null);

  if (poolsQ.isLoading) {
    return <Skeleton className="h-64 w-full" data-testid="pools-loading" />;
  }

  if (poolsQ.isError) {
    return (
      <ErrorState
        title="Strategy pools unavailable"
        body="The pool ledger could not be loaded. This is a load failure, not an empty book."
        onRetry={() => void poolsQ.refetch()}
        busy={poolsQ.isFetching}
        testid="pools-error"
      />
    );
  }

  const pools = poolsQ.data?.pools ?? [];
  const floatingByPool = new Map<string, number>();
  for (const p of plQ.data?.byPool ?? []) floatingByPool.set(p.poolKey, p.floatingPl);

  const allocations = allocQ.data?.allocations ?? [];
  const unassigned = allocations.filter((a) => !a.poolKey && a.strategyPoolId == null);

  function submitAssign(reason: string) {
    if (!target || !poolKey) return;
    setErr(null);
    assign.mutate(
      { id: target.id, data: { poolKey, reason } },
      {
        onSuccess: () => {
          setTarget(null);
          setPoolKey("");
          void allocQ.refetch();
          void plQ.refetch();
          void poolsQ.refetch();
        },
        onError: (e) => setErr(e instanceof Error ? e.message : "Assignment failed."),
      },
    );
  }

  return (
    <div className="space-y-4" data-testid="pools-section">
      {pools.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No strategy pools configured"
          body="When a strategy pool is created and capital is allocated, its NAV, units and holders will appear here."
          testid="pools-empty"
        />
      ) : (
        <div className="space-y-4">
          {/* Tier pricing panels — one per pool above the NAV cards */}
          {pools.map((p) => (
            <PoolTierPanel key={`tier-${p.id}`} poolKey={p.poolKey} poolName={p.name} />
          ))}
          <div className="grid gap-3 lg:grid-cols-2">
          {pools.map((p) => {
            const ccy = p.baseCurrency || "USD";
            const floating = floatingByPool.get(p.poolKey);
            return (
              <Card key={p.id} data-testid={`pool-card-${p.poolKey}`}>
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2 text-base">
                      {p.name}
                      <Badge variant="outline">{p.poolKey}</Badge>
                    </CardTitle>
                    <div className="flex items-center gap-1">
                      <StatusBadge status={p.status} />
                      {p.frozen ? (
                        <Badge className="bg-sky-500/15 text-sky-400">
                          <Snowflake className="mr-1 h-3 w-3" /> Frozen
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <Badge variant="outline">Risk: {p.riskLevel}</Badge>
                    <FreshnessBadge freshness={p.navStatus} asOf={p.calculatedAt} />
                  </div>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <Field label="NAV / unit" value={fmtMoney(p.navPerUnit, ccy)} />
                  <Field label="Units outstanding" value={fmtUnits(p.totalUnitsOutstanding)} />
                  <Field label="Pool value" value={fmtMoney(p.totalPoolValue, ccy)} />
                  <Field label="Holders" value={fmtInt(p.holderCount)} />
                  <Field label="Realized P/L" value={<PnlValue value={p.realizedPl} currency={ccy} />} />
                  <Field label="Unrealized P/L" value={<PnlValue value={p.unrealizedPl} currency={ccy} />} />
                  <Field
                    label="Floating (mirror)"
                    value={
                      plQ.isError ? (
                        <span className="text-xs font-normal text-muted-foreground">Unavailable</span>
                      ) : floating == null ? (
                        "—"
                      ) : (
                        <PnlValue value={floating} currency={ccy} />
                      )
                    }
                  />
                  <Field
                    label="Drawdown"
                    value={
                      <span className={p.currentDrawdownPercent < 0 ? "text-red-400" : ""}>
                        {fmtPct(p.currentDrawdownPercent)}
                      </span>
                    }
                  />
                  <Field label="Deposits allocated" value={fmtMoney(p.depositsAllocated, ccy)} />
                  <Field label="Withdrawals redeemed" value={fmtMoney(p.withdrawalsRedeemed, ccy)} />
                  <Field label="Fees accrued" value={fmtMoney(p.feesAccrued, ccy)} />
                  <Field label="Starting capital" value={fmtMoney(p.startingCapital, ccy)} />
                </CardContent>
              </Card>
            );
          })}
          </div>
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="h-4 w-4" /> Unassigned positions
            <Badge variant="outline">{fmtInt(unassigned.length)}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {allocQ.isError ? (
            <ErrorState
              title="Allocation queue unavailable"
              body="The trade-allocation list could not be loaded. This is a load failure — it does not mean every position is attributed."
              onRetry={() => void allocQ.refetch()}
              busy={allocQ.isFetching}
              testid="unassigned-error"
            />
          ) : unassigned.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="unassigned-empty">
              Every open position is attributed to a pool.
            </p>
          ) : (
            unassigned.map((a) => (
              <div
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 p-3 text-sm"
                data-testid={`unassigned-${a.id}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{a.symbol}</Badge>
                  {a.side ? <Badge variant="outline">{a.side}</Badge> : null}
                  <span className="text-muted-foreground">ticket {a.brokerTicket}</span>
                  {a.volume != null ? <span className="text-muted-foreground">vol {a.volume}</span> : null}
                  <StatusBadge status={a.status} />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pools.length === 0 || assign.isPending}
                  onClick={() => {
                    setTarget(a);
                    setPoolKey("");
                    setErr(null);
                  }}
                  data-testid={`button-assign-${a.id}`}
                >
                  Assign to pool
                </Button>
              </div>
            ))
          )}
          {err ? <p className="text-xs text-red-400">{err}</p> : null}
        </CardContent>
      </Card>

      <ReasonDialog
        open={target != null}
        onOpenChange={(o) => {
          if (!o) setTarget(null);
        }}
        title={target ? `Assign ${target.symbol} (ticket ${target.brokerTicket})` : "Assign position"}
        description="Link this open position to exactly one pool for accounting. This does not change the trade."
        confirmLabel="Assign"
        busy={assign.isPending}
        extraValid={!!poolKey}
        extra={
          <div className="space-y-2">
            <Label htmlFor="assign-pool">Destination pool</Label>
            <Select value={poolKey} onValueChange={setPoolKey}>
              <SelectTrigger id="assign-pool" data-testid="select-assign-pool">
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
        }
        onConfirm={(reason) => submitAssign(reason)}
      />
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border/30 py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
