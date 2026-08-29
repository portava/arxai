// ARX 5.0 Cockpit — modern, mobile-first trading dashboard.
//
// This is a UI/UX refactor of the previous developer-style dashboard. The
// app, trading system, bridge, Ruby, scanner and risk logic are unchanged.
// Every card binds to the SAME existing read-only hooks (see CockpitCards).
//
// User-facing surface (the 7 questions a trader actually asks):
//   • Account status      → AccountSnapshotCard
//   • Can I trade?        → TradingPermissionSummaryCard
//   • What is Ruby seeing → RubyMarketViewCard
//   • What's urgent       → CriticalEventsCard
//   • What's open         → OpenPositionsCard
//   • How am I doing      → TodayPerformanceCard
//   • What needs me       → AlertsSummaryCard
//
// All the setup / readiness / demo / operator / risk-activity / portfolio
// panels from the legacy cockpit are PRESERVED — moved into a collapsed,
// admin-only "System Health" section. Nothing was removed; regular users
// simply no longer see developer/debug surfaces.

import { useState } from "react";
import type { ComponentType, ReactNode } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ChevronDown,
  Wrench,
  Settings2,
  Shield,
  Bot,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useViewMode } from "@/hooks/useViewMode";
import { LiveAccountSnapshotProvider, useLiveAccountSnapshotCtx } from "@/hooks/useLiveAccountSnapshotContext";
import { useLiveBridgeRefreshState } from "@/hooks/useLiveBridgeRefresh";
import { LiveBridgeAutoRefreshControl } from "@/components/live/LiveBridgeAutoRefreshControl";
import { CanonicalBalanceCard } from "@/components/account/CanonicalBalancePanel";

// Always-visible safety surface (kept — these are real safety gates, not debug)
import { CriticalAlertBanner } from "@/components/alerts/CriticalAlertBanner";
import { RiskLockBanner } from "@/components/safety";

// New cockpit surface
import { EnvironmentPill } from "@/components/dashboard/cockpit/EnvironmentPill";
import { CockpitHeader } from "@/components/dashboard/cockpit/CockpitHeader";
import {
  AccountSnapshotCard,
  TradingPermissionSummaryCard,
  RubyMarketViewCard,
  CriticalEventsCard,
  OpenPositionsCard,
  TodayPerformanceCard,
  AlertsSummaryCard,
} from "@/components/dashboard/cockpit/CockpitCards";
import { BestMarketsCard, AvoidMarketsCard } from "@/components/dashboard/cockpit/CockpitTimingWidgets";
import { ApprovalPathCard } from "@/components/dashboard/cockpit/ApprovalPathCard";

// Preserved advanced/operator panels (moved into admin System Health) ───────
import { RiskEventFeed, TradingPermissionCard } from "@/components/safety";
import { SharedAccountCard } from "@/components/sharedAccount/SharedAccountCard";
import { ARXIntelligencePanel } from "@/components/paper-intelligence/ARXIntelligencePanel";
import { DemoExecutionPanel } from "@/components/paper-intelligence/DemoExecutionPanel";
import {
  PortfolioRiskCard,
  CorrelationWarningBanner,
  ExposureBreakdownPanel,
} from "@/components/portfolioRisk";
import { WeeklyFocusDashboardCard } from "@/components/weeklyReview";
import { AdminTesterCards } from "@/components/dashboard/AdminTesterCards";
import { FirstRunReadinessPanel } from "@/components/readiness/FirstRunReadinessPanel";
import { GettingStartedChecklist } from "@/components/dashboard/GettingStartedChecklist";
import { TradingSetupReadinessCard } from "@/components/readiness";

/** Collapsible advanced block — closed by default, one click away. */
function SystemSection({
  title,
  description,
  icon: Icon,
  testid,
  defaultOpen = false,
  children,
}: {
  title: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  testid: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 rounded-xl border border-card-border bg-card/60 px-4 py-3 text-left transition-colors hover:bg-card"
          data-testid={`collapsible-${testid}`}
        >
          <div className="flex min-w-0 items-center gap-3">
            <Icon className="h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <div className="text-sm font-semibold">{title}</div>
              <div className="truncate text-xs text-muted-foreground">{description}</div>
            </div>
          </div>
          <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 space-y-4">{children}</CollapsibleContent>
    </Collapsible>
  );
}

// Consumes the shared snapshot context (no second SSE stream) and layers the
// auto-refresh UX state on top. Must render inside <LiveAccountSnapshotProvider>.
function DashboardAutoRefreshControl() {
  const base = useLiveAccountSnapshotCtx();
  const bridge = useLiveBridgeRefreshState(base);
  return (
    <LiveBridgeAutoRefreshControl
      autoRefreshEnabled={bridge.autoRefreshEnabled}
      toggleAutoRefresh={bridge.toggleAutoRefresh}
      refreshNow={bridge.refreshNow}
      isRefreshing={bridge.isRefreshing}
      lastRefreshAt={bridge.lastRefreshAt}
      nextRefreshInMs={bridge.nextRefreshInMs}
      bridgeState={bridge.bridgeState}
    />
  );
}

export default function Dashboard() {
  const { effectiveIsAdmin: isAdmin } = useViewMode();

  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
      {/* Cockpit-only header (shared Topbar hidden on this route) */}
      <CockpitHeader />

      {/* One status line under the header — never conflicting states */}
      <EnvironmentPill />

      {/* Real safety gates stay always-visible (not debug noise) */}
      <CriticalAlertBanner />
      <RiskLockBanner />

      {/* Pending/unapproved traders: honest status + concrete path to approval
           (Task #771). Self-gates to null for approved traders and managing
           admins, so approved sessions see no change. */}
      <ApprovalPathCard />

      {/* 1 · Account snapshot + Open positions share a single SSE connection
           via LiveAccountSnapshotProvider — identical numbers, one stream. */}
      <LiveAccountSnapshotProvider>
        {/* Auto-refresh control — consumes the SAME shared snapshot context so
             it never opens a second SSE stream. */}
        <div className="flex justify-end">
          <DashboardAutoRefreshControl />
        </div>

        {/* 0 · Canonical balance (Task #430) — single source of truth shared
             with Open Trades, account, risk, wallet and admin. */}
        <CanonicalBalanceCard />

        {/* 1 · Account snapshot — full width */}
        <AccountSnapshotCard />

        {/* 2/3 · Permission + Ruby's view */}
        <div className="grid gap-4 lg:grid-cols-2">
          <TradingPermissionSummaryCard />
          <RubyMarketViewCard />
        </div>

        {/* 4/5 · Critical events + Open positions */}
        <div className="grid gap-4 lg:grid-cols-2">
          <CriticalEventsCard />
          <OpenPositionsCard />
        </div>
      </LiveAccountSnapshotProvider>

      {/* 6/7 · Today performance + Alerts summary */}
      <div className="grid gap-4 lg:grid-cols-2">
        <TodayPerformanceCard />
        <AlertsSummaryCard />
      </div>

      {/* 8/9 · Phase 3 — Best Markets / Avoid Right Now (advisory timing, fail-open) */}
      <div className="grid gap-4 lg:grid-cols-2">
        <BestMarketsCard />
        <AvoidMarketsCard />
      </div>

      {/* ── Admin-only: System Health ──────────────────────────────────────
          Everything the legacy cockpit exposed to regular users — setup,
          readiness, demo simulator, operator workspace, portfolio risk,
          risk activity, raw account/intelligence panels — is preserved here,
          collapsed, and gated to admin/operator sessions. Backend route
          guards remain authoritative; this is purely a visibility change. */}
      {isAdmin && (
        <div className="space-y-3 border-t border-border/60 pt-5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            System Health · Admin
          </div>

          <SystemSection
            title="Setup & readiness"
            description="Onboarding checklist, first-run readiness, MT5 setup status."
            icon={Settings2}
            testid="sys-setup"
          >
            <FirstRunReadinessPanel />
            <GettingStartedChecklist />
            <TradingSetupReadinessCard />
          </SystemSection>

          <SystemSection
            title="Account & intelligence detail"
            description="Shared master account, ARX intelligence, permission detail."
            icon={Shield}
            testid="sys-account"
          >
            <TradingPermissionCard />
            <SharedAccountCard />
            <ARXIntelligencePanel />
          </SystemSection>

          <SystemSection
            title="Portfolio & risk activity"
            description="Correlation, exposure, and recent risk events."
            icon={Shield}
            testid="sys-risk"
          >
            <CorrelationWarningBanner />
            <PortfolioRiskCard />
            <ExposureBreakdownPanel />
            <RiskEventFeed limit={20} />
          </SystemSection>

          <SystemSection
            title="Operator workspace"
            description="Demo execution, tester cards, weekly focus review."
            icon={Wrench}
            testid="sys-operator"
          >
            <DemoExecutionPanel />
            <AdminTesterCards />
            <WeeklyFocusDashboardCard />
          </SystemSection>

          <SystemSection
            title="Demo simulator"
            description="Run demo trades with the demo execution panel."
            icon={Bot}
            testid="sys-demo"
          >
            <DemoExecutionPanel />
          </SystemSection>
        </div>
      )}
    </div>
  );
}
