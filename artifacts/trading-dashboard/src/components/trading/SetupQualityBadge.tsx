import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";

type ScoreResp = {
  ok: boolean;
  dataAvailable?: boolean;
  reason?: string;
  decision?: "pass" | "warning" | "block";
  score?: number;
  label?: string;
  matchedPlaybook?: { id: number; title: string } | null;
};

const LABEL_TONE: Record<string, string> = {
  "A+": "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  A: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  B: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  C: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  low: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  avoid: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

export function SetupQualityBadge({ symbol, side }: { symbol: string; side?: string }) {
  const [state, setState] = useState<ScoreResp | { ok: false; error: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/setups/score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ symbol, side: side ?? null }),
    })
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setState(j); })
      .catch(() => { if (!cancelled) setState({ ok: false, error: "fetch_failed" }); });
    return () => { cancelled = true; };
  }, [symbol, side]);

  if (!state) return <span className="text-[10px] text-muted-foreground">—</span>;
  if (!state.ok) return <span className="text-[10px] text-muted-foreground" title="setup score unavailable">n/a</span>;
  const r = state as ScoreResp;
  if (r.dataAvailable === false) {
    return <span className="text-[10px] text-muted-foreground" title={r.reason ?? "no active playbook"}>No playbook</span>;
  }
  const label = r.label ?? "—";
  const decision = r.decision ?? "warning";
  const decisionText = decision === "pass" ? "Matching strategy" : decision === "block" ? "Blocked" : "Warning";
  return (
    <div className="flex flex-col gap-0.5 max-w-[140px]">
      <Badge variant="outline" className={`text-[10px] ${LABEL_TONE[label] ?? ""}`}>
        {label} setup
      </Badge>
      <span className="text-[10px] text-muted-foreground" title={r.matchedPlaybook?.title ?? ""}>
        {decisionText}{r.score != null ? ` · ${r.score}` : ""}
      </span>
    </div>
  );
}
