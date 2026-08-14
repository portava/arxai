import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, AlertTriangle, ShieldAlert, Loader2 } from "lucide-react";

type ReadinessStatus = "pass" | "fail" | "warning" | "blocked" | "not_required";
interface ReadinessStatusItem {
  id: string;
  label: string;
  status: ReadinessStatus;
  nextStep: string | null;
}
interface ReadinessReport {
  accountMode: "USER_OWNED_MT5" | "SHARED_MASTER_MT5" | null;
  /** Canonical Phase-10 name. */
  liveExecutionHardLockActive?: boolean;
  /** @deprecated Use `liveExecutionHardLockActive`. */
  paperOnlyHardLockActive: boolean;
  ready_for_paper: boolean;
  ready_for_demo: boolean;
  ready_for_live: boolean;
  blockers: string[];
  statuses: ReadinessStatusItem[];
}
interface ReadinessResponse {
  ok: boolean;
  report?: ReadinessReport;
  canPlaceLiveTrade?: boolean;
  appMode?: string;
  liveTradingStatus?: string;
}

export function TradingSetupReadinessCard() {
  const q = useQuery<ReadinessResponse>({
    queryKey: ["/api/readiness/me"],
    queryFn: async () => {
      const r = await fetch("/api/readiness/me", { credentials: "include" });
      if (!r.ok) throw new Error(`readiness ${r.status}`);
      return r.json();
    },
    refetchInterval: 60_000,
    retry: 1,
  });

  return (
    <Card data-testid="card-trading-setup-readiness">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          Trading Setup Readiness
          <Badge variant="outline" className="text-xs">DEMO_ONLY</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {q.isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking your readiness…
          </div>
        )}
        {q.isError && (
          <div className="text-sm text-destructive">
            Couldn’t load readiness right now.
          </div>
        )}
        {q.data && !q.data.ok && (
          <div className="text-sm text-destructive">
            Readiness check failed.
          </div>
        )}
        {q.data?.ok && q.data.report && (
          <ReadinessBody report={q.data.report} />
        )}
      </CardContent>
    </Card>
  );
}

function ReadinessBody({ report }: { report: ReadinessReport }) {
  const total = report.statuses.length;
  const passed = report.statuses.filter(s => s.status === "pass" || s.status === "not_required").length;
  const percent = total > 0 ? Math.round((passed / total) * 100) : 0;
  const failing = report.statuses.filter(s => s.status === "fail" || s.status === "blocked");
  const firstFail = failing[0];

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-3">
        <div className="text-3xl font-semibold tabular-nums">{percent}%</div>
        <div className="text-sm text-muted-foreground pb-1">
          {passed} of {total} checks complete
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs">
        <StatChip
          label="Demo"
          ok={report.ready_for_paper}
          testId="readiness-paper"
        />
        <StatChip
          label="Demo"
          ok={report.ready_for_demo}
          testId="readiness-demo"
        />
        <StatChip
          label="Live"
          ok={report.ready_for_live}
          locked={report.liveExecutionHardLockActive ?? report.paperOnlyHardLockActive}
          testId="readiness-live"
        />
      </div>

      {report.accountMode && (
        <div className="text-xs text-muted-foreground">
          Account mode: <span className="font-medium">{report.accountMode === "USER_OWNED_MT5" ? "User-owned MT5" : "Shared Account"}</span>
        </div>
      )}

      {firstFail && (
        <div className="rounded-md border bg-muted/30 p-2 text-xs">
          <div className="flex items-center gap-1 font-medium">
            <AlertTriangle className="h-3.5 w-3.5" /> Next step
          </div>
          <div className="mt-0.5">{firstFail.label}</div>
          {firstFail.nextStep && (
            <div className="mt-0.5 text-muted-foreground">{firstFail.nextStep}</div>
          )}
        </div>
      )}

      {(report.liveExecutionHardLockActive ?? report.paperOnlyHardLockActive) && (
        <div className="text-[11px] text-muted-foreground flex items-start gap-1">
          <ShieldAlert className="h-3 w-3 mt-0.5 shrink-0" />
          Live trading is system-locked. No single action — including admin approval — can enable it.
        </div>
      )}

      <Button asChild variant="outline" size="sm" className="w-full" data-testid="button-view-full-readiness">
        <Link href="/trading-readiness">View full readiness</Link>
      </Button>
    </div>
  );
}

function StatChip({ label, ok, locked, testId }: { label: string; ok: boolean; locked?: boolean; testId: string }) {
  return (
    <div
      data-testid={testId}
      className={`rounded-md border px-2 py-1.5 flex flex-col items-center gap-0.5 ${
        ok ? "border-emerald-500/40 bg-emerald-500/5" : "border-muted bg-muted/20"
      }`}
    >
      <div className="font-medium">{label}</div>
      <div className="flex items-center gap-1">
        {ok ? (
          <CheckCircle2 className="h-3 w-3 text-emerald-500" />
        ) : locked ? (
          <ShieldAlert className="h-3 w-3 text-muted-foreground" />
        ) : (
          <AlertTriangle className="h-3 w-3 text-amber-500" />
        )}
        <span className="text-[11px] text-muted-foreground">
          {ok ? "Ready" : locked ? "Locked" : "Not ready"}
        </span>
      </div>
    </div>
  );
}
