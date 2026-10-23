import { useState } from "react";
import {
  PaperAccountCard, PaperOrderTicket, PaperOpenPositionsPanel,
  PaperTradeHistory, PaperPerformanceSummary, PendingOrdersPanel,
} from "@/components/paperTrading";

export default function PaperTradingPage() {
  const [accountId, setAccountId] = useState<number | null>(null);
  return (
    <div className="space-y-4 p-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Demo Trading Sandbox</h1>
          <p className="text-xs text-amber-300">All orders here are simulated. Never sent to a live broker.</p>
        </div>
        <span className="rounded bg-amber-700 px-3 py-1 text-xs font-bold text-white">SIMULATED</span>
      </header>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-1">
          <PaperAccountCard onActive={setAccountId} />
          <PaperOrderTicket accountId={accountId} />
          <PendingOrdersPanel />
        </div>
        <div className="space-y-3 lg:col-span-2">
          <PaperPerformanceSummary accountId={accountId} />
          <PaperOpenPositionsPanel accountId={accountId} />
          <PaperTradeHistory accountId={accountId} />
        </div>
      </div>
    </div>
  );
}
