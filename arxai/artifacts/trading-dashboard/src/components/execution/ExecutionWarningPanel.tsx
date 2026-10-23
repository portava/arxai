import React from "react";
import { AlertTriangle, ShieldX } from "lucide-react";

interface Props {
  warnings?: string[];
  blockers?: string[];
}

/**
 * Execution Warning Panel — Build F.
 * Renders blockers (red) above warnings (amber). Empty when both arrays are empty.
 */
export function ExecutionWarningPanel({ warnings = [], blockers = [] }: Props) {
  if (warnings.length === 0 && blockers.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="execution-warning-panel">
      {blockers.length > 0 && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3">
          <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-red-500 mb-1.5">
            <ShieldX size={12} /> Blockers ({blockers.length})
          </div>
          <ul className="text-xs space-y-1 list-disc pl-5">
            {blockers.map((b, i) => <li key={`b-${i}`}>{b}</li>)}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
          <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-amber-500 mb-1.5">
            <AlertTriangle size={12} /> Warnings ({warnings.length})
          </div>
          <ul className="text-xs space-y-1 list-disc pl-5">
            {warnings.map((w, i) => <li key={`w-${i}`}>{w}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
