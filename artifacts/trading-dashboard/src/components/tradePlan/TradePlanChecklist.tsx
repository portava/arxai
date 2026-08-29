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
  PASS: <Check className="h-4 w-4 text-success" />,
  FAIL: <X className="h-4 w-4 text-danger" />,
  WARN: <AlertTriangle className="h-4 w-4 text-warning" />,
  UNKNOWN: <HelpCircle className="h-4 w-4 text-txt-secondary" />,
};

export function TradePlanChecklist({ checklist }: { checklist: Checklist | null | undefined }) {
  if (!checklist) {
    return (
      <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm text-txt-secondary">
        Click <span className="font-semibold text-foreground">Validate plan</span> to run the pre-trade checklist.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border bg-muted/40">
      <div className="flex items-center justify-between border-b border-border px-4 py-2 text-sm">
        <span className="font-semibold text-foreground">Pre-Trade Checklist</span>
        <span className="text-xs text-txt-secondary">
          {checklist.passCount} pass · {checklist.warnCount} warn · {checklist.failCount} fail
        </span>
      </div>
      <ul className="divide-y divide-border">
        {checklist.items.map((item) => (
          <li key={item.key} className="flex items-start gap-3 px-4 py-2 text-sm">
            <span className="mt-0.5">{ICON[item.status]}</span>
            <div className="flex-1">
              <div className="font-medium text-foreground">{item.label}</div>
              <div className="text-xs text-txt-secondary">{item.detail}</div>
            </div>
          </li>
        ))}
      </ul>
      <div className={`border-t border-border px-4 py-2 text-sm ${checklist.isReady ? "text-success" : "text-warning"}`}>
        {checklist.isReady ? "Ready — plan passes all blocking checks." : "Not ready — resolve blocking items above."}
      </div>
    </div>
  );
}
