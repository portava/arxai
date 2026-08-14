// Testing Lab — one unified page that replaces the previously separate
// /backtesting and /forward-testing pages. The engines stay separate internally
// (backtest-runs vs forward-testing/shadow); only the UI is unified behind tabs.
// A page-level strategy selector is shared across the tabs so the chosen
// strategy persists when switching tabs.

import { useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { BacktestingTab } from "@/components/testing-lab/BacktestingTab";
import { ForwardTestingTab } from "@/components/testing-lab/ForwardTestingTab";
import { ComparisonTab } from "@/components/testing-lab/ComparisonTab";
import { ResultsHistoryTab } from "@/components/testing-lab/ResultsHistoryTab";
import { TESTING_STRATEGIES } from "@/lib/testingStrategies";

const TABS = ["backtesting", "forward", "comparison", "history"] as const;
type TabKey = (typeof TABS)[number];

function initialTab(): TabKey {
  if (typeof window === "undefined") return "backtesting";
  const t = new URLSearchParams(window.location.search).get("tab");
  return (TABS as readonly string[]).includes(t ?? "") ? (t as TabKey) : "backtesting";
}

export default function TestingLab() {
  const [strategyId, setStrategyId] = useState<string>(TESTING_STRATEGIES[0]);
  const [tab, setTab] = useState<TabKey>(initialTab);

  return (
    <div className="space-y-4 p-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-slate-100">Testing Lab</h1>
        <p className="text-sm text-muted-foreground">
          Test strategies against historical data and live market conditions
          before trusting them.
        </p>
      </header>

      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-400">Strategy</span>
        <select
          data-testid="shared-strategy-select"
          value={strategyId}
          onChange={(e) => setStrategyId(e.target.value)}
          className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
        >
          {TESTING_STRATEGIES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <span className="text-[10px] text-slate-500">shared across all tabs</span>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
        <TabsList>
          <TabsTrigger value="backtesting">Backtesting</TabsTrigger>
          <TabsTrigger value="forward">Forward Testing</TabsTrigger>
          <TabsTrigger value="comparison">Comparison</TabsTrigger>
          <TabsTrigger value="history">Strategy Results</TabsTrigger>
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
      </Tabs>
    </div>
  );
}
