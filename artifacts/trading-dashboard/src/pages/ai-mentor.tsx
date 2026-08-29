import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DailyMentorBriefingCard, MentorActionItems, MentorWarningCard, MentorHistory,
} from "@/components/aiMentor";
import type { MentorSession, MentorActionItem, SessionType } from "@/components/aiMentor";

const TYPES: SessionType[] = [
  "DAILY_BRIEFING", "PRE_MARKET_GUIDANCE", "POST_TRADE_GUIDANCE",
  "WEEKLY_RESET", "CONFIDENCE_REBUILD", "DISCIPLINE_CHECK",
];

export default function AiMentorPage() {
  const qc = useQueryClient();

  const latest = useQuery<{ session: MentorSession | null; actionItems: MentorActionItem[] }>({
    queryKey: ["mentor-latest"],
    queryFn: async () => (await fetch("/api/mentor/sessions/latest")).json(),
  });
  const history = useQuery<{ sessions: MentorSession[] }>({
    queryKey: ["mentor-history"],
    queryFn: async () => (await fetch("/api/mentor/sessions?limit=20")).json(),
  });

  const generate = useMutation({
    mutationFn: async (sessionType?: SessionType) => {
      const r = await fetch("/api/mentor/sessions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(sessionType ? { sessionType } : {}),
      });
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mentor-latest"] });
      qc.invalidateQueries({ queryKey: ["mentor-history"] });
    },
  });
  const updateStatus = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: MentorActionItem["status"] }) => {
      const r = await fetch(`/api/mentor/action-items/${id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mentor-latest"] }),
  });

  // Auto-generate a briefing on first visit if none exists.
  useEffect(() => {
    if (latest.isSuccess && latest.data?.session == null && !generate.isPending) {
      generate.mutate(undefined);
    }
  }, [latest.isSuccess, latest.data?.session, generate]);

  const session = latest.data?.session ?? null;
  const items   = latest.data?.actionItems ?? [];

  return (
    <div className="space-y-4 p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-foreground">AI Mentor</h1>
          <p className="text-xs text-txt-secondary">
            Personalized daily guidance tied to your skill level, rules, and recent data. Behavior coaching only — no profit promises.
          </p>
        </div>
        <button onClick={() => generate.mutate(undefined)} disabled={generate.isPending}
          className="rounded bg-premium px-3 py-1 text-xs font-semibold text-white hover:bg-premium disabled:opacity-40">
          {generate.isPending ? "Generating…" : "Generate now (auto-detect)"}
        </button>
      </header>

      <div className="flex flex-wrap gap-1">
        {TYPES.map((t) => (
          <button key={t} onClick={() => generate.mutate(t)} disabled={generate.isPending}
            className="rounded border border-border bg-card px-2 py-0.5 text-[10px] font-semibold text-txt-secondary hover:bg-secondary">
            + {t.replace("_"," ")}
          </button>
        ))}
      </div>

      {!session ? (
        <p className="rounded border border-dashed border-border p-6 text-center text-xs text-txt-muted">
          Building your first mentor session…
        </p>
      ) : (
        <>
          <MentorWarningCard session={session} />
          <DailyMentorBriefingCard session={session} />
          <section>
            <h3 className="mb-2 text-sm font-semibold text-foreground">Action items</h3>
            <MentorActionItems items={items}
              onChangeStatus={(id, status) => updateStatus.mutate({ id, status })} />
          </section>
        </>
      )}

      <section>
        <h3 className="mb-2 text-sm font-semibold text-foreground">Recent sessions</h3>
        <MentorHistory sessions={history.data?.sessions ?? []} />
      </section>
    </div>
  );
}
