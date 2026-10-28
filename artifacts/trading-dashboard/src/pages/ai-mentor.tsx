import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DailyMentorBriefingCard, MentorActionItems, MentorWarningCard, MentorHistory, isMentorWarningSession,
} from "@/components/aiMentor";
import type { MentorSession, MentorActionItem, SessionType } from "@/components/aiMentor";
// readMentorJson throws on a non-2xx status, so a 401/403/500 is an error state
// on the page rather than an empty "no session yet" result.
import { MENTOR_LATEST_QUERY_KEY, mentorHistoryQueryKey, readMentorJson } from "@/lib/mentorApi";

const TYPES: SessionType[] = [
  "DAILY_BRIEFING", "PRE_MARKET_GUIDANCE", "POST_TRADE_GUIDANCE",
  "WEEKLY_RESET", "CONFIDENCE_REBUILD", "DISCIPLINE_CHECK",
];

const MENTOR_HISTORY_LIMIT = 20;

export default function AiMentorPage() {
  const qc = useQueryClient();

  type LatestResponse = { session: MentorSession | null; actionItems: MentorActionItem[] };
  type HistoryResponse = { sessions: MentorSession[] };
  const latest = useQuery<LatestResponse>({
    queryKey: MENTOR_LATEST_QUERY_KEY,
    queryFn: async () => readMentorJson<LatestResponse>(await fetch("/api/mentor/sessions/latest"), "Loading the latest mentor session"),
  });
  const history = useQuery<HistoryResponse>({
    queryKey: mentorHistoryQueryKey(MENTOR_HISTORY_LIMIT),
    queryFn: async () => readMentorJson<HistoryResponse>(await fetch(`/api/mentor/sessions?limit=${MENTOR_HISTORY_LIMIT}`), "Loading mentor history"),
  });

  const generate = useMutation({
    mutationFn: async (sessionType?: SessionType) => {
      const r = await fetch("/api/mentor/sessions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(sessionType ? { sessionType } : {}),
      });
      return readMentorJson<unknown>(r, "Generating a mentor session");
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

  // Auto-generate a briefing on first visit if none exists. This runs at most
  // once per page visit: a failed or empty generation is shown as such, and
  // further attempts are the user's choice (the buttons above). Only an
  // explicit `session: null` from the server means "none exists"; a body
  // without a session field is not that answer.
  const autoGenerateTried = useRef(false);
  useEffect(() => {
    if (autoGenerateTried.current) return;
    if (latest.isSuccess && latest.data?.session === null && !generate.isPending) {
      autoGenerateTried.current = true;
      generate.mutate(undefined);
    }
  }, [latest.isSuccess, latest.data?.session, generate]);

  const session = latest.data?.session ?? null;
  const items   = latest.data?.actionItems ?? [];
  const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : "unknown error");
  const emptyState: string = latest.isError
    ? `Could not load your mentor sessions. ${errorMessage(latest.error)}`
    : latest.isPending
      ? "Loading your latest mentor session…"
      : generate.isPending
        ? "Building your first mentor session…"
        : generate.isError
          ? `Your mentor session could not be generated. ${errorMessage(generate.error)}. Nothing is being built; use the buttons above to try again.`
          : "No mentor session yet. Use the buttons above to generate one.";

  return (
    <div className="space-y-4 p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">AI Mentor</h1>
          <p className="text-xs text-slate-400">
            Personalized daily guidance tied to your skill level, rules, and recent data. Behavior coaching only — no profit promises.
          </p>
        </div>
        <button onClick={() => generate.mutate(undefined)} disabled={generate.isPending}
          className="rounded bg-violet-600 px-3 py-1 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-40">
          {generate.isPending ? "Generating…" : "Generate now (auto-detect)"}
        </button>
      </header>

      <div className="flex flex-wrap gap-1">
        {TYPES.map((t) => (
          <button key={t} onClick={() => generate.mutate(t)} disabled={generate.isPending}
            className="rounded border border-slate-700 bg-slate-900 px-2 py-0.5 text-[10px] font-semibold text-slate-300 hover:bg-slate-800">
            + {t.replace("_"," ")}
          </button>
        ))}
      </div>

      {!session ? (
        <p data-testid="mentor-state" role={latest.isError || generate.isError ? "alert" : undefined}
          className={`rounded border border-dashed p-6 text-center text-xs ${latest.isError || generate.isError ? "border-rose-700 text-rose-300" : "border-slate-700 text-slate-500"}`}>
          {emptyState}
        </p>
      ) : (
        <>
          <MentorWarningCard session={session} />
          <DailyMentorBriefingCard session={session} summaryShownElsewhere={isMentorWarningSession(session)} />
          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-200">Action items</h3>
            <MentorActionItems items={items}
              onChangeStatus={(id, status) => updateStatus.mutate({ id, status })} />
          </section>
        </>
      )}

      <section>
        <h3 className="mb-2 text-sm font-semibold text-slate-200">Recent sessions</h3>
        {history.isError ? (
          <p data-testid="mentor-history-error" role="alert" className="text-xs text-rose-300">
            Could not load your recent mentor sessions. {history.error instanceof Error ? history.error.message : "unknown error"}
          </p>
        ) : (
          <MentorHistory sessions={history.data?.sessions ?? []} pageLimit={MENTOR_HISTORY_LIMIT} />
        )}
      </section>
    </div>
  );
}
