import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SkillLevelBadge, SkillBreakdownCard, LevelProgressMeter,
  NextLevelRequirementsCard,
} from "@/components/traderSkill";
import type {
  TraderSkillProfile, SkillLevelHistory, SkillSuggestion,
} from "@/components/traderSkill";

export default function TraderSkillPage() {
  const qc = useQueryClient();

  const profile = useQuery<{ profile: TraderSkillProfile | null }>({
    queryKey: ["skill-profile"],
    queryFn: async () => (await fetch("/api/skill/profile")).json(),
  });
  const history = useQuery<{ history: SkillLevelHistory[] }>({
    queryKey: ["skill-history"],
    queryFn: async () => (await fetch("/api/skill/history")).json(),
  });
  const suggestions = useQuery<{ suggestions: SkillSuggestion[] }>({
    queryKey: ["skill-suggestions"],
    queryFn: async () => (await fetch("/api/skill/suggestions")).json(),
  });

  const calc = useMutation({
    mutationFn: async () =>
      (await fetch("/api/skill/calculate", { method: "POST" })).json(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["skill-profile"] });
      qc.invalidateQueries({ queryKey: ["skill-history"] });
      qc.invalidateQueries({ queryKey: ["skill-suggestions"] });
    },
  });

  // Auto-compute on first visit if no profile exists.
  useEffect(() => {
    if (profile.isSuccess && profile.data?.profile == null && !calc.isPending) {
      calc.mutate();
    }
  }, [profile.isSuccess, profile.data?.profile, calc]);

  const p = profile.data?.profile ?? null;

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

      {!p ? (
        <div className="rounded border border-dashed border-slate-700 p-6 text-center text-xs text-slate-400">
          Building your first profile…
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
              <NextLevelRequirementsCard suggestions={suggestions.data?.suggestions ?? []} />
            </div>
          </div>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-200">Level history</h3>
            {(history.data?.history.length ?? 0) === 0 ? (
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
