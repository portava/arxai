import { ClipboardCheck } from "lucide-react";

// The summary comes from summarizePlan (lib/domain trade-plan): a fixed
// rule-based string that restates the plan's inputs, its reward-to-risk
// against the target, and the checklist results. No AI model is consulted,
// so the card does not call it an AI review.
export function AIPlanReviewCard({ summary }: { summary: string | null | undefined }) {
  return (
    <div className="rounded-lg border border-indigo-700/40 bg-indigo-950/30 p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-indigo-200" data-testid="plan-review-title">
        <ClipboardCheck className="h-4 w-4" />
        Plan review
      </div>
      <p className="mb-2 text-[11px] text-slate-400" data-testid="plan-review-basis">
        Assembled by fixed rules from your plan&apos;s inputs and checklist results — not written by an AI model.
      </p>
      <p className="text-sm leading-relaxed text-slate-200">
        {summary ?? "Validate the plan to see a rule-based review of its reward-to-risk, confidence and checklist results."}
      </p>
      <p className="mt-2 text-xs text-slate-500">
        This review is advisory. It cannot execute trades — final execution remains gated by the live-execution safety layer.
      </p>
    </div>
  );
}
