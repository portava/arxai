import { Check, X, AlertTriangle, HelpCircle } from "lucide-react";
import { safeDate } from "@/lib/safeFormat";

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
  /** When validate computed this checklist (absent on plans validated before it was recorded). */
  checkedAtIso?: string | null;
}

const ICON: Record<ChecklistItem["status"], React.ReactNode> = {
  PASS: <Check className="h-4 w-4 text-green-500" />,
  FAIL: <X className="h-4 w-4 text-red-500" />,
  WARN: <AlertTriangle className="h-4 w-4 text-amber-500" />,
  UNKNOWN: <HelpCircle className="h-4 w-4 text-slate-400" />,
};

interface Props {
  checklist: Checklist | null | undefined;
  /** The plan's current status. A checklist only says "ready" for a READY plan. */
  planStatus?: string;
  /** Server flag: the plan was saved after this checklist was computed. */
  stale?: boolean;
}

// The footer only claims what this checklist proves about the plan as it is
// now. A DRAFT carrying a checklist was saved after it was computed (validate
// always leaves READY or INVALIDATED), so its items describe earlier values.
function footer(checklist: Checklist, planStatus: string | undefined, stale: boolean): { text: string; tone: string } {
  if (stale) {
    return {
      text: "Out of date — the plan was saved after this check ran, so these results describe its earlier values. Validate again to check the current plan.",
      tone: "text-amber-400",
    };
  }
  if (!checklist.isReady) return { text: "Not ready — resolve blocking items above.", tone: "text-amber-400" };
  if (planStatus == null || planStatus === "READY") return { text: "Ready — plan passes all blocking checks.", tone: "text-green-400" };
  if (planStatus === "EXECUTED") {
    return { text: "Passed all blocking checks when it was validated, before it was sent to confirmation.", tone: "text-slate-300" };
  }
  return { text: "Passed all blocking checks when it was last validated.", tone: "text-slate-300" };
}

export function TradePlanChecklist({ checklist, planStatus, stale }: Props) {
  if (!checklist) {
    return (
      <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4 text-sm text-slate-400">
        Click <span className="font-semibold text-slate-200">Validate plan</span> to run the pre-trade checklist.
      </div>
    );
  }
  // UNKNOWN items echo the user's own inputs (market condition, confidence,
  // risk amount); ARX did not check them, so they are counted separately.
  const unchecked = checklist.items.filter((i) => i.status === "UNKNOWN").length;
  const isStale = stale === true || planStatus === "DRAFT";
  const foot = footer(checklist, planStatus, isStale);
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40">
      <div className="flex items-center justify-between border-b border-slate-700 px-4 py-2 text-sm">
        <span className="font-semibold text-slate-100">
          Pre-Trade Checklist{isStale && <span className="ml-1 font-normal text-amber-400">(last check, out of date)</span>}
        </span>
        <span className="text-xs text-slate-400" data-testid="trade-plan-checklist-counts">
          {checklist.passCount} pass · {checklist.warnCount} warn · {checklist.failCount} fail
          {unchecked > 0 ? ` · ${unchecked} your input, not checked` : ""}
        </span>
      </div>
      {checklist.checkedAtIso && (
        <div className="border-b border-slate-800 px-4 py-1 text-xs text-slate-500">Checked {safeDate(checklist.checkedAtIso)}</div>
      )}
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
      <div className={`border-t border-slate-700 px-4 py-2 text-sm ${foot.tone}`}>
        {foot.text}
      </div>
    </div>
  );
}
