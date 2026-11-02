import { useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, Wrench, Settings2, Shield, Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import { useViewMode } from "@/hooks/useViewMode";
import { CriticalAlertBanner } from "@/components/alerts/CriticalAlertBanner";
import { RiskLockBanner } from "@/components/safety";
import { ApprovalPathCard } from "@/components/dashboard/cockpit/ApprovalPathCard";
import { CommandWorkspaceProviders } from "@/components/dashboard/CommandWorkspace";
import { CockpitHeader } from "@/components/dashboard/cockpit/CockpitHeader";
import { EnvironmentPill } from "@/components/dashboard/cockpit/EnvironmentPill";
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
  return <div className="mx-auto w-full max-w-[1760px] space-y-3 animate-in fade-in duration-300">
    <CockpitHeader showSymbolPicker={false}/>
    <EnvironmentPill/>
    <CriticalAlertBanner/>
    <RiskLockBanner/>
    <ApprovalPathCard/>
    <CommandWorkspaceProviders/>
    {isAdmin && <div className="space-y-3 border-t border-border/60 pt-5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">System Health · Admin</div>
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
        <DemoExecutionPanel/><AdminTesterCards/><WeeklyFocusDashboardCard/>
      </SystemSection>
      <SystemSection title="Demo simulator" description="Run demo trades with the demo execution panel." icon={Bot} testid="sys-demo">
        <DemoExecutionPanel/>
      </SystemSection>
    </div>}
  </div>;
}
