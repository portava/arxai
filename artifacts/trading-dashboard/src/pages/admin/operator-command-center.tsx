import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { useAssistantName } from "@/lib/assistant-name";

type OperatorPayload = {
  ok: boolean;
  generatedAt: string;
  tookMs: number;
  systemStatus: {
    appOnline: boolean; apiOk: boolean; databaseOk: boolean;
    cacheMode: string; activeUserCount: number;
    currentAppMode: string; latestQaStatus: string;
  };
  bridgeStatus: Record<string, unknown> | null;
  tradingMode: {
    modeLabel: string;
    platformMasterBridgeConnectionId: number | null;
    sharedLiveTradingEnabled: boolean;
    masterLiveUserApprovalRequired: boolean;
    liveBrokerExecutionEnabled: boolean;
  };
  safetyControls: {
    platformMode: string; killSwitchEngaged: boolean; killSwitchReason: string | null;
    liveBrokerExecutionEnabled: boolean; liveExecutionHardLockActive?: boolean; paperOnlyHardLockActive: boolean;
    sharedLiveTradingEnabled: boolean; oneClickPolicy: string;
    stopLossRequiredDefault: boolean; maxLotDefault: number;
    queueDepth: number; openLiveCommandsNonTerminal: number;
  };
  userApprovals: {
    total: number; approvedForMasterLive: number; pendingReview: number;
    disabled: number; suspended: number; riskLocked: number;
    notApproved: number; withDisclosureAccepted: number;
    sample: Array<{
      userId: number; approved: boolean; status: string;
      disclosureAccepted: boolean; maxLot: number | null; requireStopLoss: boolean;
    }>;
  };
  liveTestReadiness: {
    currentLiveBridgeDetected: boolean; currentLiveBridgePrimaryReason: string | null;
    operatorDisclosureAccepted: boolean; operatorArmed: boolean;
    operatorKillSwitchEngaged: boolean; preflightOnly: boolean;
    autoFireDisabled: boolean; preflightEndpoint: string;
  };
  reconciliationSummary: {
    total: number; critical: number; high: number; medium: number; low: number;
    byType: Record<string, number>;
  };
};

// ARX status chip — green when healthy, danger when not.
function Chip({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${ok ? "border-success/40 bg-success/10 text-success" : "border-danger/40 bg-danger/10 text-danger"}`}>
      {children}
    </span>
  );
}

function Panel({ title, testid, children }: { title: string; testid: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4" data-testid={testid}>
      <h2 className="mb-3 text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </div>
  );
}

export default function OperatorCommandCenter() {
  const { name } = useAssistantName();
  const q = useQuery<OperatorPayload>({
    queryKey: ["admin", "operator-command-center"],
    queryFn: async () => {
      const r = await fetch("/api/admin/operator-command-center", { credentials: "include" });
      if (r.status === 403) throw new Error("ADMIN_REQUIRED");
      if (r.status === 401) throw new Error("AUTH_REQUIRED");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 15000,
  });

  if (q.isLoading) return <div className="mx-auto w-full max-w-[1280px] text-sm text-txt-muted">Loading Operator Command Center…</div>;
  if (q.isError) {
    const msg = (q.error as Error).message;
    if (msg === "AUTH_REQUIRED") {
      return (
        <div className="mx-auto w-full max-w-[1280px]">
          <div className="rounded-2xl border border-border bg-card p-6 text-center">
            <h1 className="text-lg font-semibold">Sign in required</h1>
            <p className="mt-1 text-sm text-txt-muted">Your session has expired. Please sign in again to view the Operator Command Center.</p>
            <Button asChild className="mt-4" data-testid="button-occ-signin">
              <Link href="/login">Go to sign in</Link>
            </Button>
          </div>
        </div>
      );
    }
    if (msg === "ADMIN_REQUIRED") {
      return (
        <div className="mx-auto w-full max-w-[1280px]">
          <div className="rounded-2xl border border-border bg-card p-6 text-center">
            <h1 className="text-lg font-semibold">Admin access required</h1>
            <p className="mt-1 text-sm text-txt-muted">This is an operator control surface. Your account doesn&apos;t have access.</p>
          </div>
        </div>
      );
    }
    return <div className="mx-auto w-full max-w-[1280px] text-danger">Failed to load: {msg}</div>;
  }
  const d = q.data!;

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-4 pb-32 md:pb-6" data-testid="operator-command-center">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold leading-tight">Operator Command Center</h1>
          <p className="text-sm text-txt-secondary">System, bridge, safety and approval summary.</p>
        </div>
        <span className="text-xs text-txt-muted">
          Updated {new Date(d.generatedAt).toLocaleString()} ({d.tookMs}ms)
        </span>
      </header>

      {/* A. System Status */}
      <Panel title="System Status" testid="panel-system-status">
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <div className="flex items-center gap-2">App <Chip ok={d.systemStatus.appOnline}>{d.systemStatus.appOnline ? "online" : "offline"}</Chip></div>
          <div className="flex items-center gap-2">API <Chip ok={d.systemStatus.apiOk}>{d.systemStatus.apiOk ? "ok" : "down"}</Chip></div>
          <div className="flex items-center gap-2">DB <Chip ok={d.systemStatus.databaseOk}>{d.systemStatus.databaseOk ? "ok" : "down"}</Chip></div>
          <div className="flex items-center gap-2">Cache <Badge variant="secondary">{d.systemStatus.cacheMode}</Badge></div>
          <div className="flex items-center gap-2">Active users <Badge variant="secondary">{d.systemStatus.activeUserCount}</Badge></div>
          <div className="flex items-center gap-2">App mode <Badge variant="secondary">{d.systemStatus.currentAppMode}</Badge></div>
          <div className="col-span-2 flex items-center gap-2">Latest QA <Badge variant="default">{d.systemStatus.latestQaStatus}</Badge></div>
        </div>
      </Panel>

      {/* B. Bridge Status */}
      <Panel title="Bridge Status (current connected)" testid="panel-bridge-status">
        {d.bridgeStatus ? (
          <pre className="whitespace-pre-wrap break-all rounded-xl border border-border bg-background/40 p-3 text-xs text-txt-secondary">
            {JSON.stringify(d.bridgeStatus, null, 2)}
          </pre>
        ) : <em className="text-txt-muted">No bridge currently detected.</em>}
      </Panel>

      {/* C. Trading Mode */}
      <Panel title="Trading Mode" testid="panel-trading-mode">
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2">Mode: <Badge variant={d.tradingMode.modeLabel.includes("LIVE_ENABLED") ? "destructive" : "secondary"}>{d.tradingMode.modeLabel}</Badge></div>
          <div>Platform master bridge id: <code className="text-txt-secondary">{d.tradingMode.platformMasterBridgeConnectionId ?? "—"}</code></div>
          <div className="flex items-center gap-2">Shared live trading enabled: <Chip ok={!d.tradingMode.sharedLiveTradingEnabled}>{String(d.tradingMode.sharedLiveTradingEnabled)}</Chip></div>
          <div className="flex items-center gap-2">Master live user approval required: <Badge variant="default">true</Badge></div>
          <div className="flex items-center gap-2">Server master switch (live broker execution): <Chip ok={!d.tradingMode.liveBrokerExecutionEnabled}>{String(d.tradingMode.liveBrokerExecutionEnabled)}</Chip></div>
        </div>
      </Panel>

      {/* D. Safety Controls */}
      <Panel title="Safety Controls" testid="panel-safety-controls">
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
          <div className="flex items-center gap-2">Kill switch: <Chip ok={!d.safetyControls.killSwitchEngaged}>{d.safetyControls.killSwitchEngaged ? "ENGAGED" : "clear"}</Chip></div>
          <div className="flex items-center gap-2">Live-execution hard lock: <Chip ok={d.safetyControls.liveExecutionHardLockActive ?? d.safetyControls.paperOnlyHardLockActive}>{String(d.safetyControls.liveExecutionHardLockActive ?? d.safetyControls.paperOnlyHardLockActive)}</Chip></div>
          <div className="flex items-center gap-2">One-click policy: <Badge variant="secondary">{d.safetyControls.oneClickPolicy}</Badge></div>
          <div className="flex items-center gap-2">Stop loss required (default): <Badge variant="default">{String(d.safetyControls.stopLossRequiredDefault)}</Badge></div>
          <div className="flex items-center gap-2">Max lot (default): <Badge variant="secondary">{d.safetyControls.maxLotDefault}</Badge></div>
          <div className="flex items-center gap-2">Queue depth: <Badge variant="secondary">{d.safetyControls.queueDepth}</Badge></div>
          <div className="flex items-center gap-2">Open live commands (non-terminal): <Chip ok={d.safetyControls.openLiveCommandsNonTerminal === 0}>{d.safetyControls.openLiveCommandsNonTerminal}</Chip></div>
          {d.safetyControls.killSwitchReason && (
            <div className="col-span-full text-danger">Reason: {d.safetyControls.killSwitchReason}</div>
          )}
        </div>
      </Panel>

      {/* E. User Approval Center */}
      <Panel title="User Approval Center" testid="panel-user-approvals">
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-3 gap-2 md:grid-cols-4">
            <div>Total: <strong>{d.userApprovals.total}</strong></div>
            <div>Approved for master live: <strong>{d.userApprovals.approvedForMasterLive}</strong></div>
            <div>Pending review: <strong>{d.userApprovals.pendingReview}</strong></div>
            <div>Disabled: <strong>{d.userApprovals.disabled}</strong></div>
            <div>Suspended: <strong>{d.userApprovals.suspended}</strong></div>
            <div>Risk-locked: <strong>{d.userApprovals.riskLocked}</strong></div>
            <div>Not approved: <strong>{d.userApprovals.notApproved}</strong></div>
            <div>Disclosure accepted: <strong>{d.userApprovals.withDisclosureAccepted}</strong></div>
          </div>
          {d.userApprovals.sample.length > 0 && (
            <div className="overflow-x-auto">
              <table className="mt-2 w-full text-xs">
                <thead><tr className="border-b border-border text-left text-txt-muted">
                  <th className="py-1.5 pr-3 font-medium">userId</th><th className="py-1.5 pr-3 font-medium">approved</th><th className="py-1.5 pr-3 font-medium">status</th><th className="py-1.5 pr-3 font-medium">disclosure</th><th className="py-1.5 pr-3 font-medium">maxLot</th><th className="py-1.5 font-medium">SL required</th>
                </tr></thead>
                <tbody>
                  {d.userApprovals.sample.map(s => (
                    <tr key={s.userId} className="border-b border-border/50">
                      <td className="py-1.5 pr-3">{s.userId}</td>
                      <td className="py-1.5 pr-3">{String(s.approved)}</td>
                      <td className="py-1.5 pr-3">{s.status}</td>
                      <td className="py-1.5 pr-3">{String(s.disclosureAccepted)}</td>
                      <td className="py-1.5 pr-3">{s.maxLot ?? "—"}</td>
                      <td className="py-1.5">{String(s.requireStopLoss)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Link href="/admin/master-bridge" className="text-xs text-primary underline">Manage individual user approvals →</Link>
        </div>
      </Panel>

      {/* F. Live Test Readiness */}
      <Panel title="Live Test Readiness" testid="panel-live-test-readiness">
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2">Current live bridge detected: <Chip ok={d.liveTestReadiness.currentLiveBridgeDetected}>{String(d.liveTestReadiness.currentLiveBridgeDetected)}</Chip></div>
          {!d.liveTestReadiness.currentLiveBridgeDetected && d.liveTestReadiness.currentLiveBridgePrimaryReason && (
            <div className="text-xs text-txt-muted">Reason: {d.liveTestReadiness.currentLiveBridgePrimaryReason}</div>
          )}
          <div className="flex items-center gap-2">Operator disclosure accepted: <Chip ok={d.liveTestReadiness.operatorDisclosureAccepted}>{String(d.liveTestReadiness.operatorDisclosureAccepted)}</Chip></div>
          <div className="flex items-center gap-2">Operator armed: <Badge variant={d.liveTestReadiness.operatorArmed ? "destructive" : "secondary"}>{String(d.liveTestReadiness.operatorArmed)}</Badge></div>
          <div className="flex items-center gap-2">Operator kill switch: <Chip ok={!d.liveTestReadiness.operatorKillSwitchEngaged}>{d.liveTestReadiness.operatorKillSwitchEngaged ? "ENGAGED" : "clear"}</Chip></div>
          <div className="flex items-center gap-2">Preflight only: <Badge variant="default">{String(d.liveTestReadiness.preflightOnly)}</Badge></div>
          <div className="flex items-center gap-2">Auto-fire disabled: <Badge variant="default">{String(d.liveTestReadiness.autoFireDisabled)}</Badge></div>
          <div className="pt-2">
            <Button asChild variant="outline" size="sm" data-testid="link-preflight">
              <Link href="/admin/live-test-readiness">Open preflight (dry-run only) →</Link>
            </Button>
          </div>
        </div>
      </Panel>

      {/* G. Reconciliation Summary */}
      <Panel title="Reconciliation Summary" testid="panel-reconciliation">
        <div className="space-y-2 text-sm">
          <div className="grid grid-cols-5 gap-2">
            <div>Total: <strong>{d.reconciliationSummary.total}</strong></div>
            <div>Critical: <strong className="text-danger">{d.reconciliationSummary.critical}</strong></div>
            <div>High: <strong>{d.reconciliationSummary.high}</strong></div>
            <div>Medium: <strong>{d.reconciliationSummary.medium}</strong></div>
            <div>Low: <strong>{d.reconciliationSummary.low}</strong></div>
          </div>
          {Object.keys(d.reconciliationSummary.byType).length > 0 && (
            <pre className="rounded-xl border border-border bg-background/40 p-2 text-xs text-txt-secondary">{JSON.stringify(d.reconciliationSummary.byType, null, 2)}</pre>
          )}
          <Link href="/admin/reconciliation-center" className="text-xs text-primary underline">Open Reconciliation Center →</Link>
        </div>
      </Panel>

      {/* H. Ruby Admin Summary */}
      <Panel title={`${name} Admin Summary`} testid="panel-ruby-admin">
        <p className="text-sm text-txt-secondary">
          Ask {name}: <em>"{name}, summarize launch readiness."</em> {name} will
          summarize what is ready, what is blocked, what needs admin
          action, what should not be touched, and whether live trading is
          safe to manually test. {name} cannot expose secrets, place trades,
          or modify connections.
        </p>
      </Panel>
    </div>
  );
}
