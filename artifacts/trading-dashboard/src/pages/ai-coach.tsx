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
  suggestedRuleChanges: string[];
  confidenceCalibration: string;
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

      {err && <p className="text-sm text-rose-400">{err}</p>}
      {!coach && !err && <p className="text-sm text-muted-foreground">Loading coach summary…</p>}

      {coach && (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="border-emerald-500/30">
              <CardHeader><CardTitle className="text-emerald-400 flex items-center gap-2"><Trophy className="h-5 w-5" /> What the AI is doing well</CardTitle></CardHeader>
              <CardContent><p className="text-sm">{coach.doingWell}</p></CardContent>
            </Card>
            <Card className="border-rose-500/30">
              <CardHeader><CardTitle className="text-rose-400 flex items-center gap-2"><AlertTriangle className="h-5 w-5" /> What the AI is doing poorly</CardTitle></CardHeader>
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
              <CardDescription>{coach.confidenceCalibration}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm font-medium mb-3">{coach.recommendedFocus}</p>
              <h4 className="text-xs uppercase text-muted-foreground mb-1">Suggested rule changes</h4>
              <ul className="text-sm space-y-1">
                {coach.suggestedRuleChanges.map((r) => <li key={r}>· {r}</li>)}
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
