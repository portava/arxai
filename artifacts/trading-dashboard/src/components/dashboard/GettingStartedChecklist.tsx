import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Check, Circle, RotateCcw } from "lucide-react";
import {
  useFeatureUnlock,
  useAllUnlocks,
  useResetAllUnlocks,
  type FeatureKey,
} from "@/hooks/useFeatureUnlock";
import { ARX_BRAND } from "@/components/brand/ARXLogo";

interface ChecklistItem {
  feature: FeatureKey;
  title: string;
  body: string;
  cta: string;
}

const ITEMS: ChecklistItem[] = [
  {
    feature: "mt5",
    title: "Connect MT5 demo account",
    body: "Reveal your MT5 account, balance, equity and open positions on the dashboard.",
    cta: "Connect MT5",
  },
  {
    feature: "analysis",
    title: "Run your first AI analysis",
    body: "Show ARX trade-intelligence ideas, confidence scores and reasoning.",
    cta: "Enable analysis",
  },
  {
    feature: "paper",
    title: "Start demo trading",
    body: "Reveal P&L, recent trades and the trade journal cards.",
    cta: "Start demo",
  },
  {
    feature: "simulator",
    title: "Open the demo simulator",
    body: "Reveal the demo-only execution panel (real broker live execution stays disabled).",
    cta: "Open simulator",
  },
];

function ChecklistRow({ item }: { item: ChecklistItem }) {
  const { unlocked, unlock } = useFeatureUnlock(item.feature);
  return (
    <li
      className="flex items-start gap-3 p-3 rounded border border-zinc-800/80 bg-zinc-900/30"
      data-testid={`checklist-${item.feature}`}
    >
      <div className="mt-0.5">
        {unlocked ? (
          <Check size={18} className="text-emerald-400" />
        ) : (
          <Circle size={18} className="text-zinc-500" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-zinc-100">{item.title}</div>
        <div className="text-xs text-zinc-400 mt-0.5">{item.body}</div>
      </div>
      {!unlocked && (
        <Button
          size="sm"
          variant="outline"
          onClick={unlock}
          data-testid={`checklist-cta-${item.feature}`}
        >
          {item.cta}
        </Button>
      )}
    </li>
  );
}

export function GettingStartedChecklist() {
  const all = useAllUnlocks();
  const resetAll = useResetAllUnlocks();
  const done = Object.values(all).filter(Boolean).length;
  const total = ITEMS.length;

  return (
    <Card className="border-card-border" data-testid="getting-started-checklist">
      <CardHeader className="flex flex-row items-center justify-between pb-3 border-b border-border">
        <div>
          <CardTitle className="text-sm font-semibold uppercase tracking-wider">
            Welcome to {ARX_BRAND.name}
          </CardTitle>
          <p className="text-xs text-zinc-400 mt-1">
            {done === 0
              ? "Nothing is connected yet. Pick a step to begin."
              : `${done} of ${total} steps complete.`}
          </p>
        </div>
        {done > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={resetAll}
            data-testid="checklist-reset"
            title="Reset all unlocks (browser only)"
          >
            <RotateCcw size={14} className="mr-1" /> Reset
          </Button>
        )}
      </CardHeader>
      <CardContent className="pt-4">
        <ul className="grid gap-2">
          {ITEMS.map((item) => (
            <ChecklistRow key={item.feature} item={item} />
          ))}
        </ul>
        <p className="text-[11px] text-zinc-500 mt-4 leading-relaxed">
          Note: this checklist is a UI convenience layer for first-load
          discoverability. The real security boundary is enforced on the
          backend — every private account request requires an authenticated
          session cookie and filters every
          read and write by your own user id. You cannot see, edit, or close
          another user's MT5 account, trades, ledger, AI context, audit log,
          risk settings, command queue, or auto-close settings, regardless
          of any browser-side flag.
        </p>
      </CardContent>
    </Card>
  );
}
