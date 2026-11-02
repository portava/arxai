import { useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, Wrench, Settings2, Shield, Bot, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { useViewMode } from "@/hooks/useViewMode";
import { CriticalAlertBanner } from "@/components/alerts/CriticalAlertBanner";
import { RiskLockBanner } from "@/components/safety";
import { ApprovalPathCard } from "@/components/dashboard/cockpit/ApprovalPathCard";
import { CommandWorkspaceProviders } from "@/components/dashboard/CommandWorkspace";
import { RiskEventFeed, TradingPermissionCard } from "@/components/safety";
import { SharedAccountCard } from "@/components/sharedAccount/SharedAccountCard";
import { ARXIntelligencePanel } from "@/components/paper-intelligence/ARXIntelligencePanel";
import { DemoExecutionPanel } from "@/components/paper-intelligence/DemoExecutionPanel";
import { PortfolioRiskCard, CorrelationWarningBanner, ExposureBreakdownPanel } from "@/components/portfolioRisk";
import { WeeklyFocusDashboardCard } from "@/components/weeklyReview";
import { AdminTesterCards } from "@/components/dashboard/AdminTesterCards";
import { FirstRunReadinessPanel } from "@/components/readiness/FirstRunReadinessPanel";
import { GettingStartedChecklist } from "@/components/dashboard/GettingStartedChecklist";
import { TradingSetupReadinessCard } from "@/components/readiness";
import "@/components/dashboard/command-workspace.css";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

function SystemSection({
  title, description, icon: Icon, testid, children,
}: {
  title: string; description: string; icon: ComponentType<{ className?: string }>;
  testid: string; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return <Collapsible open={open} onOpenChange={setOpen}>
    <CollapsibleTrigger asChild>
      <button type="button" className="flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-card/60 px-4 py-3 text-left transition-colors hover:bg-card" data-testid={`collapsible-${testid}`}>
        <div className="flex min-w-0 items-center gap-3"><Icon className="h-4 w-4 shrink-0 text-primary"/><div className="min-w-0"><div className="text-sm font-semibold">{title}</div><div className="truncate text-xs text-secondary">{description}</div></div></div>
        <ChevronDown className={cn("h-4 w-4 text-muted transition-transform", open && "rotate-180")}/>
      </button>
    </CollapsibleTrigger>
    <CollapsibleContent className="mt-3 space-y-4">{children}</CollapsibleContent>
  </Collapsible>;
}

export default function Dashboard() {
  const { effectiveIsAdmin: isAdmin } = useViewMode();
  const [systemDetailsOpen, setSystemDetailsOpen] = useState(false);
  const adminDetails = isAdmin ? (
    <Sheet open={systemDetailsOpen} onOpenChange={setSystemDetailsOpen}>
      <button
        type="button"
        className="arx-admin-details-button"
        onClick={() => setSystemDetailsOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={systemDetailsOpen}
        data-testid="button-admin-system-details"
      >
        <SlidersHorizontal size={14} /> System details
      </button>
      <SheetContent side="right" className="w-full overflow-y-auto border-slate-700 bg-[#07111a] text-slate-100 sm:max-w-2xl">
        <SheetHeader><SheetTitle className="text-slate-100">System health · Admin</SheetTitle></SheetHeader>
        <div className="mt-5 space-y-3">
          <SystemSection title="Setup & readiness" description="Onboarding checklist, first-run readiness, MT5 setup status." icon={Settings2} testid="sys-setup">
            <FirstRunReadinessPanel/><GettingStartedChecklist/><TradingSetupReadinessCard/>
          </SystemSection>
          <SystemSection title="Account & intelligence detail" description="Shared master account, ARX intelligence, permission detail." icon={Shield} testid="sys-account">
            <TradingPermissionCard/><SharedAccountCard/><ARXIntelligencePanel/>
          </SystemSection>
          <SystemSection title="Portfolio & risk activity" description="Correlation, exposure, and recent risk events." icon={Shield} testid="sys-risk">
            <CorrelationWarningBanner/><PortfolioRiskCard/><ExposureBreakdownPanel/><RiskEventFeed limit={20}/>
          </SystemSection>
          <SystemSection title="Operator workspace" description="Demo execution, tester cards, weekly focus review." icon={Wrench} testid="sys-operator">
            <AdminTesterCards/><WeeklyFocusDashboardCard/>
          </SystemSection>
          <SystemSection title="Demo simulator" description="Run demo trades with the demo execution panel." icon={Bot} testid="sys-demo">
            <DemoExecutionPanel/>
          </SystemSection>
        </div>
      </SheetContent>
    </Sheet>
  ) : null;

  return <div className="arx-dashboard-root mx-auto h-full min-h-0 w-full max-w-[1760px] animate-in fade-in duration-300">
    <CommandWorkspaceProviders
      headerActions={adminDetails}
      warningContent={<><CriticalAlertBanner/><RiskLockBanner/><ApprovalPathCard compact/></>}
    />
  </div>;
}
