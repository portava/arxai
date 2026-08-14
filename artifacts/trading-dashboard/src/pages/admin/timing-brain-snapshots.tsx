// Admin Timing Brain Snapshots (Task #225).
//
// Read-only admin view of the persisted MarketTimingRead heat-snapshot
// time-series (heat_snapshots). Shows symbol, timestamp, grade,
// entryPermission and heatScore (plus a few supporting columns) for the last
// N snapshots, with an optional per-symbol filter and pagination.
//
// SAFETY: read-only. No mutations, no trade actions. Wrapped in
// AdminDiagnosticsGate (admin-only; admin-previewing-as-user is blocked).
// The backend independently gates every row to ADMIN/OWNER.

import { useState } from "react";
import {
  useListAdminTimingBrainSnapshots,
  getListAdminTimingBrainSnapshotsQueryKey,
} from "@workspace/api-client-react";
import { AdminDiagnosticsGate } from "@/components/admin/AdminDiagnosticsGate";
import { HeatRetentionCard } from "@/components/admin/HeatRetentionCard";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Brain, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";

const PAGE_SIZE = 50;
const ALL_SYMBOLS = "__ALL__";

function gradeVariant(grade: string): "default" | "secondary" | "destructive" | "outline" {
  const g = grade.toUpperCase();
  if (g.startsWith("A")) return "default";
  if (g.startsWith("B")) return "secondary";
  if (g.startsWith("F") || g.startsWith("D")) return "destructive";
  return "outline";
}

function permissionVariant(p: string): "default" | "secondary" | "destructive" | "outline" {
  const v = p.toUpperCase();
  if (v.includes("ALLOW") || v.includes("GREEN") || v.includes("PERMIT")) return "default";
  if (v.includes("BLOCK") || v.includes("DENY") || v.includes("RED") || v.includes("NO")) return "destructive";
  if (v.includes("CAUTION") || v.includes("WAIT") || v.includes("AMBER")) return "secondary";
  return "outline";
}

function formatTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function TimingBrainSnapshotsInner() {
  const [symbol, setSymbol] = useState<string>(ALL_SYMBOLS);
  const [offset, setOffset] = useState<number>(0);

  const params = {
    limit: PAGE_SIZE,
    offset,
    ...(symbol !== ALL_SYMBOLS ? { symbol } : {}),
  };

  const { data, isLoading, isFetching, isError, refetch } = useListAdminTimingBrainSnapshots(
    params,
    { query: { queryKey: getListAdminTimingBrainSnapshotsQueryKey(params) } },
  );

  const snapshots = data?.snapshots ?? [];
  const hasMore = data?.hasMore ?? false;
  const symbols = data?.symbols ?? [];
  const page = Math.floor(offset / PAGE_SIZE) + 1;

  function onSymbolChange(next: string) {
    setSymbol(next);
    setOffset(0);
  }

  return (
    <div className="container mx-auto py-6 space-y-6" data-testid="page-timing-brain-snapshots">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          <div className="rounded-md bg-primary/10 p-2">
            <Brain className="h-5 w-5 text-primary" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Timing Brain Snapshots</h1>
            <p className="text-sm text-txt-secondary max-w-2xl">
              Persisted MarketTimingRead heat-snapshot history per symbol. Read-only,
              advisory — never an execution gate.
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid="button-refresh-snapshots"
        >
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isFetching ? "animate-spin" : ""}`} aria-hidden="true" />
          Refresh
        </Button>
      </div>

      <HeatRetentionCard />

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <CardTitle className="text-base">Snapshot history</CardTitle>
              <CardDescription>
                {symbol !== ALL_SYMBOLS ? `Filtered to ${symbol}` : "All symbols"} · newest first
              </CardDescription>
            </div>
            <div className="w-56">
              <Select value={symbol} onValueChange={onSymbolChange}>
                <SelectTrigger data-testid="select-symbol-filter">
                  <SelectValue placeholder="Filter by symbol" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_SYMBOLS}>All symbols</SelectItem>
                  {symbols.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isError ? (
            <div className="py-12 text-center text-sm text-destructive" data-testid="text-snapshots-error">
              Failed to load snapshots. Try refreshing.
            </div>
          ) : isLoading ? (
            <div className="py-12 text-center text-sm text-txt-secondary" data-testid="text-snapshots-loading">
              Loading snapshots…
            </div>
          ) : snapshots.length === 0 ? (
            <div className="py-12 text-center text-sm text-txt-secondary" data-testid="text-snapshots-empty">
              No persisted snapshots yet
              {symbol !== ALL_SYMBOLS ? ` for ${symbol}` : ""}.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="table-snapshots">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-txt-secondary">
                    <th className="py-2 pr-4 font-medium">Symbol</th>
                    <th className="py-2 pr-4 font-medium">TF</th>
                    <th className="py-2 pr-4 font-medium">Timestamp</th>
                    <th className="py-2 pr-4 font-medium">Grade</th>
                    <th className="py-2 pr-4 font-medium">Entry Permission</th>
                    <th className="py-2 pr-4 font-medium text-right">Heat</th>
                    <th className="py-2 pr-4 font-medium text-right">Tradeability</th>
                    <th className="py-2 pr-4 font-medium text-right">Danger</th>
                    <th className="py-2 pr-4 font-medium">Best Action</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshots.map((s) => (
                    <tr
                      key={s.id}
                      className="border-b border-border/50 hover:bg-muted/30"
                      data-testid={`row-snapshot-${s.id}`}
                    >
                      <td className="py-2 pr-4 font-medium">{s.symbol}</td>
                      <td className="py-2 pr-4 text-txt-secondary">{s.timeframe}</td>
                      <td className="py-2 pr-4 whitespace-nowrap text-txt-secondary">
                        {formatTs(s.generatedAt)}
                      </td>
                      <td className="py-2 pr-4">
                        <Badge variant={gradeVariant(s.timingGrade)}>{s.timingGrade}</Badge>
                      </td>
                      <td className="py-2 pr-4">
                        <Badge variant={permissionVariant(s.entryPermission)}>
                          {s.entryPermission}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{s.heatScore}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{s.tradeabilityScore}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{s.dangerScore}</td>
                      <td className="py-2 pr-4 text-txt-secondary whitespace-nowrap">{s.bestAction}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-4 flex items-center justify-between gap-4">
            <p className="text-xs text-txt-secondary" data-testid="text-pagination-info">
              Page {page} · showing {snapshots.length} {snapshots.length === 1 ? "snapshot" : "snapshots"}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0 || isFetching}
                onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                data-testid="button-prev-page"
              >
                <ChevronLeft className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!hasMore || isFetching}
                onClick={() => setOffset((o) => o + PAGE_SIZE)}
                data-testid="button-next-page"
              >
                Next
                <ChevronRight className="h-3.5 w-3.5 ml-1" aria-hidden="true" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function TimingBrainSnapshotsPage() {
  return (
    <AdminDiagnosticsGate
      pageTitle="Timing Brain Snapshots"
      pageDescription="Timing Brain snapshot history"
      userSafeMessage="This page shows internal timing-brain diagnostics for operators. Your account does not require any action here."
    >
      <TimingBrainSnapshotsInner />
    </AdminDiagnosticsGate>
  );
}
