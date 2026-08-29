import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Brain, Trophy, AlertTriangle, Target, Sparkles, RefreshCcw } from "lucide-react";

type Coach = {
  doingWell: string; doingPoorly: string;
  bestStrategy: string | null; worstStrategy: string | null;
  bestSymbol: string | null; weakestSymbol: string | null;
  mostCommonMistake: string;
  recommendedFocus: string;
  /** Derived from THIS user's journal. Empty when their journal supports none. */
  suggestedRuleChanges: Array<{ rule: string; evidence: string }>;
  /** Fixed engine rules — the same for every trader. Labelled as such. */
  generalRules: string[];
  /** Always false today: journal entries carry no confidence value to calibrate. */
  confidenceCalibrationAvailable: boolean;
  confidenceCalibrationNote: string;
  dataSource: string; generatedAt: string;
};

export default function AiCoach() {
  const [coach, setCoach] = useState<Coach | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function load() {
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/ai/coach-summary").then((x) => x.json());
      if (r.error) throw new Error(r.error);
      setCoach(r);
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Brain className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">AI Coach</h1>
          <p className="text-sm text-muted-foreground">
            What the AI is doing well, where it is weak, and what to do next session.
          </p>
        </div>
        <Badge variant="outline" className="ml-auto">SIMULATOR</Badge>
        <Button size="sm" variant="outline" onClick={load} disabled={busy}>
          <RefreshCcw className="h-4 w-4 mr-1" /> {busy ? "…" : "Refresh"}
        </Button>
      </div>

      {err && <p className="text-sm text-danger">{err}</p>}
      {!coach && !err && <p className="text-sm text-muted-foreground">Loading coach summary…</p>}

      {coach && (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="border-success/30">
              <CardHeader><CardTitle className="text-success flex items-center gap-2"><Trophy className="h-5 w-5" /> What the AI is doing well</CardTitle></CardHeader>
              <CardContent><p className="text-sm">{coach.doingWell}</p></CardContent>
            </Card>
            <Card className="border-danger/30">
              <CardHeader><CardTitle className="text-danger flex items-center gap-2"><AlertTriangle className="h-5 w-5" /> What the AI is doing poorly</CardTitle></CardHeader>
              <CardContent><p className="text-sm">{coach.doingPoorly}</p></CardContent>
            </Card>
          </div>

          <div className="grid gap-4 md:grid-cols-4">
            <Stat label="Best strategy" value={coach.bestStrategy ?? "—"} />
            <Stat label="Worst strategy" value={coach.worstStrategy ?? "—"} />
            <Stat label="Best symbol" value={coach.bestSymbol ?? "—"} />
            <Stat label="Weakest symbol" value={coach.weakestSymbol ?? "—"} />
          </div>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><Target className="h-5 w-5" /> Most common mistake</CardTitle></CardHeader>
            <CardContent><p className="text-lg font-semibold">{coach.mostCommonMistake}</p></CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Sparkles className="h-5 w-5" /> Recommended focus next session</CardTitle>
              {/* The old subtitle claimed "Average confidence aligns with win
                  rate within N pts" — nothing measured the user's confidence. */}
              {!coach.confidenceCalibrationAvailable && (
                <CardDescription>{coach.confidenceCalibrationNote}</CardDescription>
              )}
            </CardHeader>
            <CardContent>
              <p className="text-sm font-medium mb-3">{coach.recommendedFocus}</p>

              <h4 className="text-xs uppercase text-muted-foreground mb-1">From your journal</h4>
              {coach.suggestedRuleChanges.length === 0 ? (
                <p className="text-sm text-muted-foreground mb-3">
                  Nothing in your journal yet supports a rule change specific to you. Tag mistakes
                  and log outcomes and rules will appear here.
                </p>
              ) : (
                <ul className="text-sm space-y-1.5 mb-3">
                  {coach.suggestedRuleChanges.map((r) => (
                    <li key={r.rule}>
                      · {r.rule}
                      <span className="block text-xs text-muted-foreground ml-3">{r.evidence}</span>
                    </li>
                  ))}
                </ul>
              )}

              <h4 className="text-xs uppercase text-muted-foreground mb-1">
                General rules (same for every trader)
              </h4>
              <ul className="text-sm space-y-1">
                {(coach.generalRules ?? []).map((r) => <li key={r}>· {r}</li>)}
              </ul>
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            Data source: {coach.dataSource} · generated {new Date(coach.generatedAt).toLocaleString()}
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card><CardContent className="p-4">
      <p className="text-xs text-muted-foreground uppercase">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </CardContent></Card>
  );
}
