import { useState } from "react";

interface Commitment { id: number; commitmentText: string; status: string; sessionDate: string; startedAt: string }
interface Props {
  active: Commitment | null;
  onStart: (text: string) => void;
  onEnd: (status: "ENDED"|"ABANDONED") => void;
  busy?: boolean;
}

export function SessionCommitmentScreen({ active, onStart, onEnd, busy }: Props) {
  const [text, setText] = useState("Today I will follow my rules. I will not chase. I will respect my stop.");
  if (active && active.status === "ACTIVE") {
    return (
      <div className="rounded-lg border border-emerald-700 bg-emerald-950/30 p-4 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-emerald-200">Session commitment ACTIVE</h3>
          <span className="text-[10px] text-emerald-300">{active.sessionDate}</span>
        </div>
        <p className="rounded bg-slate-950/40 p-2 text-xs italic text-slate-200">"{active.commitmentText}"</p>
        <div className="flex gap-2">
          <button onClick={()=>onEnd("ENDED")} disabled={busy} className="rounded bg-emerald-700 px-3 py-1 text-xs text-white hover:bg-emerald-600 disabled:opacity-50">End session — kept commitment</button>
          <button onClick={()=>onEnd("ABANDONED")} disabled={busy} className="rounded bg-amber-700 px-3 py-1 text-xs text-white hover:bg-amber-600 disabled:opacity-50">Mark abandoned</button>
        </div>
        <p className="text-[10px] text-emerald-300/80">Accountability framing — this is honest reflection, not punishment.</p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4 space-y-2">
      <h3 className="text-sm font-semibold text-slate-100">Start a session commitment</h3>
      <p className="text-[11px] text-slate-400">Write a short statement of intent before you trade today.</p>
      <textarea value={text} onChange={(e)=>setText(e.target.value)} rows={3}
        className="w-full rounded border border-slate-700 bg-slate-950 p-2 text-xs text-slate-100"/>
      <button onClick={()=>onStart(text)} disabled={busy || text.trim().length < 5}
        className="rounded bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-50">
        {busy ? "Starting…" : "Commit to today"}
      </button>
    </div>
  );
}
