import { Check, X, AlertTriangle, HelpCircle } from "lucide-react";

interface ChecklistItem {
  key: string;
  label: string;
  status: "PASS" | "FAIL" | "WARN" | "UNKNOWN";
  detail: string;
}

interface Checklist {
  items: ChecklistItem[];
  passCount: number;
  failCount: number;
  warnCount: number;
  isReady: boolean;
  rewardToRisk?: number | null;
}

const ICON: Record<ChecklistItem["status"], React.ReactNode> = {
  PASS: <Check className="h-4 w-4 text-green-500" />,
  FAIL: <X className="h-4 w-4 text-red-500" />,
  WARN: <AlertTriangle className="h-4 w-4 text-amber-500" />,
  UNKNOWN: <HelpCircle className="h-4 w-4 text-slate-400" />,
};

export function TradePlanChecklist({ checklist }: { checklist: Checklist | null | undefined }) {
  if (!checklist) {
    return (
      <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4 text-sm text-slate-400">
        Click <span className="font-semibold text-slate-200">Validate plan</span> to run the pre-trade checklist.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40">
      <div className="flex items-center justify-between border-b border-slate-700 px-4 py-2 text-sm">
        <span className="font-semibold text-slate-100">Pre-Trade Checklist</span>
        <span className="text-xs text-slate-400">
          {checklist.passCount} pass · {checklist.warnCount} warn · {checklist.failCount} fail
        </span>
      </div>
      <ul className="divide-y divide-slate-800">
        {checklist.items.map((item) => (
          <li key={item.key} className="flex items-start gap-3 px-4 py-2 text-sm">
            <span className="mt-0.5">{ICON[item.status]}</span>
            <div className="flex-1">
              <div className="font-medium text-slate-100">{item.label}</div>
              <div className="text-xs text-slate-400">{item.detail}</div>
            </div>
          </li>
        ))}
      </ul>
      <div className={`border-t border-slate-700 px-4 py-2 text-sm ${checklist.isReady ? "text-green-400" : "text-amber-400"}`}>
        {checklist.isReady ? "Ready — plan passes all blocking checks." : "Not ready — resolve blocking items above."}
      </div>
    </div>
  );
}
