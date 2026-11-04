// Broker Mirrors — a read-only mirror of every connected MT5 bridge's balance,
// equity, margin, freshness and open positions.
//
// SAFETY: strictly read. No bridge token, IP, or account number is shown; this
// only mirrors what the bridge already reported. Full bridge operator controls
// live on the Master Bridge page, deep-linked below.

import {
  useGetAdminFundBookBrokerMirror,
  useGetAdminFundBookPlAllocation,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link } from "wouter";
import { Server, ExternalLink } from "lucide-react";
import {
  StatusBadge,
  FreshnessBadge,
  PnlValue,
  EmptyState,
  ErrorState,
  fmtMoney,
  fmtInt,
  fmtTimeAgo,
} from "./format";

export function BrokerMirrorsSection() {
  const mirrorQ = useGetAdminFundBookBrokerMirror();
  const plQ = useGetAdminFundBookPlAllocation();

  if (mirrorQ.isLoading) {
    return <Skeleton className="h-64 w-full" data-testid="mirrors-loading" />;
  }

  if (mirrorQ.isError) {
    return (
      <ErrorState
        title="Broker mirror unavailable"
        body="The mirrored bridge state could not be loaded. This is a load failure, not a sign that no bridges are connected."
        onRetry={() => void mirrorQ.refetch()}
        busy={mirrorQ.isFetching}
        testid="mirrors-error"
      />
    );
  }

  const bridges = mirrorQ.data?.bridges ?? [];
  const positions = mirrorQ.data?.openPositions ?? [];
  const poolKeyById = plQ.data?.poolKeyById ?? {};

  return (
    <div className="space-y-4" data-testid="mirrors-section">
      <div className="flex justify-end">
        <Link href="/admin/master-bridge">
          <a>
            <Button variant="outline" size="sm" data-testid="link-master-bridge">
              <ExternalLink className="mr-1 h-3 w-3" /> Master Bridge controls
            </Button>
          </a>
        </Link>
      </div>

      {bridges.length === 0 ? (
        <EmptyState
          icon={Server}
          title="No broker bridges connected"
          body="When an MT5 bridge sends its first heartbeat, its mirrored account state will appear here."
          testid="mirrors-empty"
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {bridges.map((b) => {
            const ccy = b.accountCurrency || "USD";
            return (
              <Card key={b.bridgeConnectionId} data-testid={`bridge-card-${b.bridgeConnectionId}`}>
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Server className="h-4 w-4" />
                      {b.connectionName || `Bridge #${b.bridgeConnectionId}`}
                    </CardTitle>
                    <div className="flex items-center gap-1">
                      <StatusBadge status={b.status} />
                      <Badge variant="outline">{b.accountType}</Badge>
                    </div>
                  </div>
                  <div className="pt-1">
                    <FreshnessBadge freshness={b.freshness} asOf={b.freshnessAsOf} />
                  </div>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <Field label="Balance" value={fmtMoney(b.accountBalance, ccy)} />
                  <Field label="Equity" value={fmtMoney(b.accountEquity, ccy)} />
                  <Field label="Margin" value={fmtMoney(b.margin, ccy)} />
                  <Field label="Free margin" value={fmtMoney(b.freeMargin, ccy)} />
                  <Field label="Floating P/L" value={<PnlValue value={b.floatingPlTotal} currency={ccy} />} />
                  <Field label="Open positions" value={fmtInt(b.openPositionCount)} />
                  <Field label="Heartbeat" value={fmtTimeAgo(b.lastHeartbeatAt)} />
                  <Field label="Positions synced" value={fmtTimeAgo(b.lastPositionsSnapshotAt)} />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            Open positions (mirrored) <Badge variant="outline">{fmtInt(positions.length)}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {positions.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="positions-empty">
              No open positions are currently mirrored from any bridge.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Symbol</TableHead>
                    <TableHead>Side</TableHead>
                    <TableHead className="text-right">Volume</TableHead>
                    <TableHead className="text-right">Floating P/L</TableHead>
                    <TableHead>Pool</TableHead>
                    <TableHead>Allocation</TableHead>
                    <TableHead>Ticket</TableHead>
                    <TableHead>Synced</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {positions.map((p) => {
                    const pool =
                      p.strategyPoolId != null ? poolKeyById[String(p.strategyPoolId)] : null;
                    return (
                      <TableRow key={`${p.bridgeConnectionId}-${p.brokerTicket}`} data-testid={`position-${p.brokerTicket}`}>
                        <TableCell className="font-medium">{p.symbol}</TableCell>
                        <TableCell>{p.side ?? "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{p.volume ?? "—"}</TableCell>
                        <TableCell className="text-right">
                          <PnlValue value={p.floatingPl} />
                        </TableCell>
                        <TableCell>{pool ?? "—"}</TableCell>
                        <TableCell>
                          {p.allocationStatus ? <StatusBadge status={p.allocationStatus} /> : "—"}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{p.brokerTicket}</TableCell>
                        <TableCell className="text-muted-foreground">{fmtTimeAgo(p.lastSyncedAt)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
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
