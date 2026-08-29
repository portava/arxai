// Testing Lab — one unified page that replaces the previously separate
// /backtesting and /forward-testing pages. The engines stay separate internally
// (backtest-runs vs forward-testing/shadow); only the UI is unified behind tabs.
// A page-level strategy selector is shared across the tabs so the chosen
// strategy persists when switching tabs.
//
// Surface consolidation item C: the standalone Shadow Mode, Strategy
// Tournament and Strategy Promotion pages are folded in as tabs too. Their
// backing routes (routes/shadowMode.ts) are ALL requireAdmin, so the three
// tab triggers render only for an ADMIN/OWNER session — an approved non-admin
// trader never sees a tab that would 403 (the render-then-403 defect Theme H
// fixed in the nav). The tab components themselves keep their cached-role
// pre-check + honest AccessDeniedCard, so a deep link (?tab=shadow) stays
// honest for everyone. Server requireAdmin remains the authority.

import { useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { BacktestingTab } from "@/components/testing-lab/BacktestingTab";
import { ForwardTestingTab } from "@/components/testing-lab/ForwardTestingTab";
import { ComparisonTab } from "@/components/testing-lab/ComparisonTab";
import { ResultsHistoryTab } from "@/components/testing-lab/ResultsHistoryTab";
import { TESTING_STRATEGIES } from "@/lib/testingStrategies";
import { useProductRole } from "@/hooks/useProductRole";
import ShadowMode from "@/pages/shadow-mode";
import StrategyTournament from "@/pages/strategy-tournament";
import StrategyPromotion from "@/pages/strategy-promotion";

const TABS = ["backtesting", "forward", "comparison", "history", "shadow", "tournament", "promotion"] as const;
type TabKey = (typeof TABS)[number];

function initialTab(): TabKey {
  if (typeof window === "undefined") return "backtesting";
  const t = new URLSearchParams(window.location.search).get("tab");
  return (TABS as readonly string[]).includes(t ?? "") ? (t as TabKey) : "backtesting";
}

export default function TestingLab() {
  const [strategyId, setStrategyId] = useState<string>(TESTING_STRATEGIES[0]);
  const [tab, setTab] = useState<TabKey>(initialTab);
  // Trigger visibility only — the shadow/tournament/promotion components carry
  // their own role pre-check and denied card. While the role is still
  // resolving the admin triggers stay hidden (hidden ≠ denied; a resolved
  // admin session gets them on the next render).
  const { isAdmin } = useProductRole();

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Testing Lab</h1>
        <p className="text-sm text-muted-foreground">
          Test strategies against historical data and live market conditions
          before trusting them.
        </p>
      </header>

      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Strategy</span>
        <select
          data-testid="shared-strategy-select"
          value={strategyId}
          onChange={(e) => setStrategyId(e.target.value)}
          className="rounded-md border border-input bg-transparent px-2.5 py-1.5 text-xs text-foreground shadow-xs focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/25"
        >
          {TESTING_STRATEGIES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <span className="text-xs text-muted-foreground">shared across all tabs</span>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
        <TabsList>
          <TabsTrigger value="backtesting">Backtesting</TabsTrigger>
          <TabsTrigger value="forward">Forward Testing</TabsTrigger>
          <TabsTrigger value="comparison">Comparison</TabsTrigger>
          <TabsTrigger value="history">Strategy Results</TabsTrigger>
          {isAdmin && (
            <>
              <TabsTrigger value="shadow">Shadow Mode</TabsTrigger>
              <TabsTrigger value="tournament">Tournament</TabsTrigger>
              <TabsTrigger value="promotion">Promotion</TabsTrigger>
            </>
          )}
        </TabsList>
        <TabsContent value="backtesting">
          <BacktestingTab strategyId={strategyId} onStrategyChange={setStrategyId} />
        </TabsContent>
        <TabsContent value="forward">
          <ForwardTestingTab strategyId={strategyId} />
        </TabsContent>
        <TabsContent value="comparison">
          <ComparisonTab strategyId={strategyId} />
        </TabsContent>
        <TabsContent value="history">
          <ResultsHistoryTab strategyId={strategyId} />
        </TabsContent>
        {/* Admin strategy-research surfaces — each component self-gates on the
            cached role and renders an honest denied card on a deep link. */}
        <TabsContent value="shadow">
          <ShadowMode />
        </TabsContent>
        <TabsContent value="tournament">
          <StrategyTournament />
        </TabsContent>
        <TabsContent value="promotion">
          <StrategyPromotion />
        </TabsContent>
      </Tabs>
    </div>
  );
}
