import { Target } from "lucide-react";
import type { MentorSession, SessionType } from "./types";
import { useAssistantName } from "@/lib/assistant-name";

// Humanize raw session-type codes for user-facing display.
function label(t: string): string {
  return t
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// The heading names the session's own cadence. Only WEEKLY_RESET is weekly;
// every other session is per-day or per-event.
const HEADING: Record<SessionType, string> = {
  DAILY_BRIEFING: "Today's Focus",
  PRE_MARKET_GUIDANCE: "Pre-Market Focus",
  POST_TRADE_GUIDANCE: "Post-Trade Focus",
  WEEKLY_RESET: "Weekly Focus",
  RISK_WARNING: "Session Focus",
  CONFIDENCE_REBUILD: "Session Focus",
  DISCIPLINE_CHECK: "Session Focus",
};

/**
 * `summaryShownElsewhere`: the caller already renders this session's focus
 * and message (MentorWarningCard for RISK_WARNING / DISCIPLINE_CHECK), so the
 * card shows only the next action instead of repeating them.
 */
export function DailyMentorBriefingCard({ session, summaryShownElsewhere = false }: { session: MentorSession; summaryShownElsewhere?: boolean }) {
  const { name } = useAssistantName();
  const heading = HEADING[session.sessionType] ?? "Mentor Focus";
  return (
    <div className="rounded-2xl border border-warning/30 bg-warning/[0.06] p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-warning/15 text-warning ring-1 ring-warning/25">
          <Target className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-bold text-warning">{heading}</h2>
            <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
              {label(session.sessionType)}
            </span>
            <span className="ml-auto text-[11px] text-txt-muted">
              {new Date(session.createdAt).toLocaleString()}
            </span>
          </div>
          {summaryShownElsewhere ? (
            <p className="mt-1.5 text-xs text-txt-muted">Focus and message are shown in the warning above.</p>
          ) : (
            <>
              <h3 className="mt-1.5 text-sm font-semibold text-foreground">{session.mainFocus}</h3>
              <p className="mt-1 text-sm leading-relaxed text-txt-secondary">{session.mentorMessage}</p>
            </>
          )}
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
