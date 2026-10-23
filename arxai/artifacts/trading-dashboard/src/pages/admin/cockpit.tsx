// Admin Cockpit — admin/owner-only control room.
//
// One dense real-time screen that unifies the scattered admin surfaces:
// traders, investors, bridge/MT5, open trades & exposure, risk alerts,
// capital/pool/NAV, approval/activation, the admin-only Pattern Sync command
// center and the audit timeline.
//
// SAFETY: this page is READ + operator-control only. Every mutation routes
// through the generated cockpit hooks → EXISTING audited admin handlers, plus a
// cockpit audit row. It opens NO new execution path and relaxes NO gate. Broker
// account values are masked unless the session is OWNER (decided server-side).
// The whole page is wrapped in AdminDiagnosticsGate so a normal user — or an
// admin previewing-as-user — sees only a clean placeholder.

import { useGetAdminCockpitOverview, getGetAdminCockpitOverviewQueryKey, useRefreshAdminCockpit } from "@workspace/api-client-react";
import { AdminDiagnosticsGate } from "@/components/admin/AdminDiagnosticsGate";
import { PageTabs } from "@/components/ui/PageTabs";
import { Button } from "@/components/ui/button";
import { RefreshCw, LayoutGrid, Users, Wallet, Plug, TrendingUp, Banknote, GitCompare } from "lucide-react";
import {
  Chip,
  cockpitQuery,
  fmtNum,
  fmtPl,
  useCockpitAction,
} from "@/components/admin/cockpit/cockpitShared";
import { OverviewSection } from "@/components/admin/cockpit/OverviewSection";
import { TradersSection } from "@/components/admin/cockpit/TradersSection";
import { InvestorsSection } from "@/components/admin/cockpit/InvestorsSection";
import { BridgeSection } from "@/components/admin/cockpit/BridgeSection";
import { TradesSection } from "@/components/admin/cockpit/TradesSection";
import { CapitalSection } from "@/components/admin/cockpit/CapitalSection";
import { PatternSyncSection } from "@/components/admin/cockpit/PatternSyncSection";
import { RiskRail } from "@/components/admin/cockpit/RiskRail";
import { AuditTimeline } from "@/components/admin/cockpit/AuditTimeline";

function StatusStrip() {
  const q = useGetAdminCockpitOverview({ query: { queryKey: getGetAdminCockpitOverviewQueryKey(), ...cockpitQuery } });
  const d = q.data;
  if (!d) return null;
  const pl = fmtPl(d.exposure.totalFloatingPl);
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="cockpit-status-strip">
      <Chip tone="info">Mode {d.safety.platformMode}</Chip>
      <Chip tone={d.safety.liveExecutionEnabled ? "warning" : "muted"}>Live exec {d.safety.liveExecutionEnabled ? "ON" : "OFF"}</Chip>
      <Chip tone={d.safety.killSwitchActive ? "danger" : "success"}>Kill {d.safety.killSwitchActive ? "ACTIVE" : "clear"}</Chip>
      <Chip tone={d.bridge.connected && d.bridge.live ? "success" : "muted"}>Bridge {d.bridge.connected ? (d.bridge.live ? "LIVE" : "demo") : "down"}</Chip>
      <Chip tone="muted">Open {fmtNum(d.exposure.openPositions, 0)}</Chip>
      <Chip tone={pl.tone}>Floating P/L {pl.text}</Chip>
      <Chip tone={d.alerts.critical > 0 ? "danger" : d.alerts.open > 0 ? "warning" : "success"}>Alerts {fmtNum(d.alerts.open, 0)}</Chip>
    </div>
  );
}

export default function AdminCockpitPage() {
  const action = useCockpitAction();
  const refresh = useRefreshAdminCockpit({
    mutation: {
      onSuccess: () => action.onDone("Cockpit refreshed"),
      onError: action.onError,
    },
  });

  const tabs = [
    { id: "overview", label: "Overview", icon: <LayoutGrid className="h-4 w-4" />, content: <OverviewSection /> },
    { id: "traders", label: "Traders", icon: <Users className="h-4 w-4" />, content: <TradersSection /> },
    { id: "investors", label: "Investors", icon: <Wallet className="h-4 w-4" />, content: <InvestorsSection /> },
    { id: "bridge", label: "Bridge / MT5", icon: <Plug className="h-4 w-4" />, content: <BridgeSection /> },
    { id: "trades", label: "Open Trades", icon: <TrendingUp className="h-4 w-4" />, content: <TradesSection /> },
    { id: "capital", label: "Capital", icon: <Banknote className="h-4 w-4" />, content: <CapitalSection /> },
    { id: "pattern-sync", label: "Pattern Sync", icon: <GitCompare className="h-4 w-4" />, content: <PatternSyncSection /> },
  ];

  return (
    <AdminDiagnosticsGate
      pageTitle="Admin Cockpit"
      pageDescription="Admin/owner-only control room — read state and run audited operator controls."
    >
      <div className="space-y-4 p-4" data-testid="admin-cockpit-page">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-foreground">Admin Cockpit</h1>
            <p className="text-xs text-txt-muted">
              Unified control room · auto-refreshing · every control is audited and relaxes no gate.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            data-testid="cockpit-refresh"
          >
            <RefreshCw className={`mr-1.5 h-4 w-4 ${refresh.isPending ? "animate-spin" : ""}`} />
            {refresh.isPending ? "Refreshing…" : "Refresh"}
          </Button>
        </header>

        <StatusStrip />

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <main className="min-w-0">
            <PageTabs tabs={tabs} storageKey="admin-cockpit" variant="pill" />
          </main>
          <aside className="xl:sticky xl:top-4 xl:self-start" data-testid="cockpit-rail">
            <RiskRail />
          </aside>
        </div>

        <AuditTimeline />
      </div>
    </AdminDiagnosticsGate>
  );
}
