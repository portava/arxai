import { Brain } from "lucide-react";

export function AIPlanReviewCard({ summary }: { summary: string | null | undefined }) {
  return (
    <div className="rounded-lg border border-indigo-700/40 bg-indigo-950/30 p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-indigo-200">
        <Brain className="h-4 w-4" />
        AI Plan Review
      </div>
      <p className="text-sm leading-relaxed text-slate-200">
        {summary ?? "Validate the plan to receive an AI review of strengths, gaps, and risk."}
      </p>
      <p className="mt-2 text-xs text-slate-500">
        AI assists planning only. It cannot execute trades — final execution remains gated by the live-execution safety layer.
      </p>
    </div>
  );
}
