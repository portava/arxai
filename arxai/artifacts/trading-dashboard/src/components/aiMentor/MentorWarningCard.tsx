import type { MentorSession } from "./types";

// Humanize raw session-type codes for user-facing display.
function label(t: string): string {
  return t
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function MentorWarningCard({ session }: { session: MentorSession }) {
  const isWarn = session.sessionType === "RISK_WARNING" || session.sessionType === "DISCIPLINE_CHECK";
  if (!isWarn) return null;
  return (
    <div className="rounded-2xl border border-danger/40 bg-danger/10 p-4">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-lg">⚠</span>
        <h3 className="text-sm font-bold tracking-wide text-danger">{label(session.sessionType)}</h3>
      </div>
      <p className="text-sm font-semibold text-foreground">{session.mainFocus}</p>
      <p className="mt-1 text-xs leading-relaxed text-txt-secondary">{session.mentorMessage}</p>
    </div>
  );
}
