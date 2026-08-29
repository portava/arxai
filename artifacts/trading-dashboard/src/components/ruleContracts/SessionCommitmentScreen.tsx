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
      <div className="rounded-lg border border-success/40 bg-success/30 p-4 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-success">Session commitment ACTIVE</h3>
          <span className="text-[10px] text-success">{active.sessionDate}</span>
        </div>
        <p className="rounded bg-background/40 p-2 text-xs italic text-foreground">"{active.commitmentText}"</p>
        <div className="flex gap-2">
          <button onClick={()=>onEnd("ENDED")} disabled={busy} className="rounded bg-success/15 px-3 py-1 text-xs text-white hover:bg-success disabled:opacity-50">End session — kept commitment</button>
          <button onClick={()=>onEnd("ABANDONED")} disabled={busy} className="rounded bg-warning/15 px-3 py-1 text-xs text-white hover:bg-warning disabled:opacity-50">Mark abandoned</button>
        </div>
        <p className="text-[10px] text-success/80">Accountability framing — this is honest reflection, not punishment.</p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-2">
      <h3 className="text-sm font-semibold text-foreground">Start a session commitment</h3>
      <p className="text-[11px] text-txt-secondary">Write a short statement of intent before you trade today.</p>
      <textarea value={text} onChange={(e)=>setText(e.target.value)} rows={3}
        className="w-full rounded border border-border bg-background p-2 text-xs text-foreground"/>
      <button onClick={()=>onStart(text)} disabled={busy || text.trim().length < 5}
        className="rounded bg-ruby px-3 py-1.5 text-xs font-semibold text-white hover:bg-ruby disabled:opacity-50">
        {busy ? "Starting…" : "Commit to today"}
      </button>
    </div>
  );
}
