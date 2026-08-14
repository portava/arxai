import { ShieldAlert, NotebookPen, Trophy, Sparkles, AlertTriangle } from "lucide-react";
import type { MentorSession, SessionType } from "./types";
import { useAssistantName } from "@/lib/assistant-name";

// Group raw session types into user-facing conversation categories. The full
// session list is still passed in and every session remains accessible via
// onSelect — we only group the *display*, never drop history.
type GroupKey = "risk" | "post-trade" | "coaching" | "briefing";

const GROUP_OF: Record<SessionType, GroupKey> = {
  RISK_WARNING: "risk",
  DISCIPLINE_CHECK: "risk",
  POST_TRADE_GUIDANCE: "post-trade",
  WEEKLY_RESET: "coaching",
  CONFIDENCE_REBUILD: "coaching",
  DAILY_BRIEFING: "briefing",
  PRE_MARKET_GUIDANCE: "briefing",
};

const GROUP_META: Record<GroupKey, { title: string; noun: string; icon: typeof ShieldAlert; accent: string; ring: string; text: string; btn: string }> = {
  risk:        { title: "Risk Warnings",       noun: "warning",      icon: ShieldAlert,  accent: "border-danger/30 bg-danger/[0.05]",  ring: "bg-danger/15 text-danger ring-danger/25",   text: "text-danger",  btn: "border-danger/40 text-danger hover:bg-danger/10" },
  "post-trade":{ title: "Post-Trade Guidance", noun: "note",         icon: NotebookPen,  accent: "border-ruby/30 bg-ruby/[0.05]",      ring: "bg-ruby/15 text-ruby ring-ruby/25",         text: "text-ruby",    btn: "border-ruby/40 text-ruby hover:bg-ruby/10" },
  coaching:    { title: "Weekly Coaching",     noun: "coaching note",icon: Trophy,       accent: "border-warning/30 bg-warning/[0.05]",ring: "bg-warning/15 text-warning ring-warning/25",text: "text-warning", btn: "border-warning/40 text-warning hover:bg-warning/10" },
  briefing:    { title: "Daily Briefings",     noun: "briefing",     icon: Sparkles,     accent: "border-primary/30 bg-primary/[0.05]",ring: "bg-primary/15 text-primary ring-primary/25",text: "text-primary", btn: "border-primary/40 text-primary hover:bg-primary/10" },
};

const GROUP_ORDER: GroupKey[] = ["risk", "post-trade", "coaching", "briefing"];

export function MentorHistory({ sessions, onSelect }:
  { sessions: MentorSession[]; onSelect?: (s: MentorSession) => void }) {
  const { name } = useAssistantName();
  if (sessions.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-txt-muted">
        No recent conversations yet. {name}'s coaching, trade reviews, and risk notes will appear here.
      </p>
    );
  }

  // Bucket sessions by group, newest first (sessions arrive newest-first).
  const groups = new Map<GroupKey, MentorSession[]>();
  for (const s of sessions) {
    const g = GROUP_OF[s.sessionType] ?? "briefing";
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(s);
  }

  const present = GROUP_ORDER.filter((g) => groups.has(g));

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {present.map((g) => {
        const meta = GROUP_META[g];
        const list = groups.get(g)!;
        const latest = list[0];
        const Icon = meta.icon;
        const count = list.length;
        return (
          <div key={g} className={`rounded-2xl border p-4 ${meta.accent}`} data-testid={`conversation-group-${g}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className={`grid h-8 w-8 place-items-center rounded-lg ring-1 ${meta.ring}`}><Icon className="h-4 w-4" /></span>
                <h4 className="text-sm font-semibold text-foreground">{meta.title}</h4>
              </div>
            </div>
            <p className={`mt-2 text-xs font-medium ${meta.text}`}>{count} {meta.noun}{count === 1 ? "" : "s"}</p>
            <p className="mt-1 text-xs leading-snug text-txt-secondary line-clamp-2">
              Latest: {latest.mainFocus}
            </p>
            <button
              onClick={() => onSelect?.(latest)}
              className={`mt-3 w-full rounded-lg border py-1.5 text-xs font-semibold ${meta.btn}`}
              data-testid={`conversation-view-${g}`}
            >
              View
            </button>
          </div>
        );
      })}
    </div>
  );
}
