import { Target } from "lucide-react";
import type { MentorSession } from "./types";
import { useAssistantName } from "@/lib/assistant-name";

// Humanize raw session-type codes for user-facing display.
function label(t: string): string {
  return t
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function DailyMentorBriefingCard({ session }: { session: MentorSession }) {
  const { name } = useAssistantName();
  return (
    <div className="rounded-2xl border border-warning/30 bg-warning/[0.06] p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-warning/15 text-warning ring-1 ring-warning/25">
          <Target className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-bold text-warning">Weekly Focus</h2>
            <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
              {label(session.sessionType)}
            </span>
            <span className="ml-auto text-[11px] text-txt-muted">
              {new Date(session.createdAt).toLocaleString()}
            </span>
          </div>
          <h3 className="mt-1.5 text-sm font-semibold text-foreground">{session.mainFocus}</h3>
          <p className="mt-1 text-sm leading-relaxed text-txt-secondary">{session.mentorMessage}</p>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-border bg-background/40 p-3">
        <div className="text-[11px] uppercase tracking-wide text-txt-muted">Next action</div>
        <p className="mt-0.5 text-sm font-medium text-foreground">{session.recommendedAction}</p>
      </div>

      <p className="mt-2 text-[10px] italic text-txt-muted">
        {name} guides behavior — it cannot override safety, locks, or trade authorization.
      </p>
    </div>
  );
}
