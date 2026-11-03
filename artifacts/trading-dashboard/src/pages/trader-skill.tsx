import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { safeJson } from "@/lib/api/safeJson";
import {
  SkillLevelBadge, SkillBreakdownCard, LevelProgressMeter,
  NextLevelRequirementsCard,
} from "@/components/traderSkill";
import type {
  TraderSkillProfile, SkillLevelHistory, SkillSuggestion,
} from "@/components/traderSkill";

// Reads a skill endpoint and throws on a non-2xx status or an unreadable body,
// so a failed read is an error state rather than an empty result.
async function getSkillJson<T>(url: string, action: string, init?: RequestInit): Promise<T> {
  const r = await safeJson<T>(url, init);
  if (!r.ok) throw new Error(`${action} failed (${r.message})`);
  return r.data;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : "unknown error");

export default function TraderSkillPage() {
  const qc = useQueryClient();

  const profile = useQuery<{ profile: TraderSkillProfile | null }>({
    queryKey: ["skill-profile"],
    queryFn: () => getSkillJson("/api/skill/profile", "Loading your skill profile"),
  });
  const history = useQuery<{ history: SkillLevelHistory[] }>({
    queryKey: ["skill-history"],
    queryFn: () => getSkillJson("/api/skill/history", "Loading level history"),
  });
  const suggestions = useQuery<{ suggestions: SkillSuggestion[] }>({
    queryKey: ["skill-suggestions"],
    queryFn: () => getSkillJson("/api/skill/suggestions", "Loading next-level suggestions"),
  });

  const calc = useMutation({
    mutationFn: () => getSkillJson<unknown>("/api/skill/calculate", "Calculating your skill profile", { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["skill-profile"] });
      qc.invalidateQueries({ queryKey: ["skill-history"] });
      qc.invalidateQueries({ queryKey: ["skill-suggestions"] });
    },
  });

  // Auto-compute on first visit if the server confirmed no profile exists.
  // This runs at most once per page visit: a failed or empty calculation is
  // shown as such, and further attempts are the user's choice (Recalculate).
  const autoCalcTried = useRef(false);
  useEffect(() => {
    if (autoCalcTried.current) return;
    if (profile.isSuccess && profile.data?.profile === null && !calc.isPending) {
      autoCalcTried.current = true;
      calc.mutate();
    }
  }, [profile.isSuccess, profile.data?.profile, calc]);

  const p = profile.data?.profile ?? null;
  const profileState: string = profile.isError
    ? `Could not load your skill profile. ${errorMessage(profile.error)}`
    : profile.isPending
      ? "Loading your skill profile…"
      : calc.isPending
        ? "Building your first profile…"
        : calc.isError
          ? `Your skill profile could not be calculated. ${errorMessage(calc.error)}. Nothing is being built; use Recalculate to try again.`
          : "No skill profile yet. Use Recalculate to build one.";
  const profileFailed = profile.isError || calc.isError;

  return (
    <div className="space-y-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Trader skill profile</h1>
          <p className="text-xs text-slate-400">
            Process-quality benchmark. Higher levels do NOT predict future profit.
          </p>
        </div>
        <button onClick={() => calc.mutate()} disabled={calc.isPending}
          className="rounded bg-violet-600 px-3 py-1 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-40">
          {calc.isPending ? "Recalculating…" : "Recalculate"}
        </button>
      </header>

      {calc.isError && p && (
        <p role="alert" className="rounded border border-rose-700 p-2 text-xs text-rose-300">
          Your profile could not be recalculated. {errorMessage(calc.error)}. The profile below is the previous one.
        </p>
      )}

      {!p ? (
        <div data-testid="skill-profile-state" role={profileFailed ? "alert" : undefined}
          className={`rounded border border-dashed p-6 text-center text-xs ${profileFailed ? "border-rose-700 text-rose-300" : "border-slate-700 text-slate-400"}`}>
          {profileState}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <SkillLevelBadge level={p.skillLevel} total={p.totalScore} size="lg" />
            <span className="text-[11px] text-slate-500">
              updated {new Date(p.updatedAt).toLocaleString()}
            </span>
          </div>

          <LevelProgressMeter total={p.totalScore} level={p.skillLevel} />

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            <div className="lg:col-span-2"><SkillBreakdownCard profile={p} /></div>
            <div>
              {suggestions.isError ? (
                <p role="alert" className="rounded border border-dashed border-rose-700 p-3 text-center text-[11px] text-rose-300">
                  Next-level suggestions could not be loaded. {errorMessage(suggestions.error)}
                </p>
              ) : (
                <NextLevelRequirementsCard suggestions={suggestions.data?.suggestions ?? []} />
              )}
            </div>
          </div>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-200">Level history</h3>
            {history.isError ? (
              <p role="alert" className="rounded border border-dashed border-rose-700 p-3 text-center text-[11px] text-rose-300">
                Level history could not be loaded. {errorMessage(history.error)}
              </p>
            ) : history.isPending ? (
              <p className="p-3 text-center text-[11px] text-slate-500">Loading level history…</p>
            ) : (history.data?.history.length ?? 0) === 0 ? (
              <p className="rounded border border-dashed border-slate-700 p-3 text-center text-[11px] text-slate-500">
                No level changes yet.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {(history.data?.history ?? []).map((h) => (
                  <li key={h.id} className="rounded border border-slate-700 bg-slate-900/40 p-2 text-xs">
                    <div className="flex items-center gap-2">
                      <SkillLevelBadge level={h.previousLevel as TraderSkillProfile["skillLevel"]} size="sm" />
                      <span className="text-slate-500">→</span>
                      <SkillLevelBadge level={h.newLevel as TraderSkillProfile["skillLevel"]} size="sm" />
                      <span className="ml-auto text-[10px] text-slate-500">{new Date(h.createdAt).toLocaleString()}</span>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-300">{h.reason}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
