import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ClipboardList, Target, AlertTriangle, RefreshCcw } from "lucide-react";

type Plan = {
  bestSymbols: string[]; symbolsToAvoid: string[];
  preferredStrategy: string;
  maxTrades: number; maxRiskPerTradeUsd: number; maxRiskPerSessionUsd: number;
  marketConditions: string;
  rules: string[]; warningZones: string[]; focusAreas: string[];
  recommendedFirstTest: string; summary: string;
  dataSource: string; generatedAt: string;
};

export default function SessionPlanPage() {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    try {
      const r = await fetch("/api/ai/session-plan").then((x) => x.json());
      setPlan(r);
    } finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <ClipboardList className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">AI Session Plan</h1>
          <p className="text-sm text-muted-foreground">Generated from the latest scanner sweep. Simulator only.</p>
        </div>
        <Badge variant="outline">SIMULATOR</Badge>
        <Button size="sm" variant="outline" onClick={load} disabled={busy}><RefreshCcw className="h-4 w-4 mr-1" />Regenerate</Button>
      </div>

      {!plan ? <p className="text-sm text-muted-foreground">Loading…</p> : (
        <>
          <Card><CardHeader><CardTitle>Today's plan</CardTitle><CardDescription>{plan.marketConditions}</CardDescription></CardHeader>
            <CardContent><p className="text-sm">{plan.summary}</p></CardContent></Card>

          <div className="grid gap-3 md:grid-cols-3">
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-1 text-success"><Target className="h-4 w-4" /> Best symbols</CardTitle></CardHeader>
              <CardContent>{plan.bestSymbols.length ? plan.bestSymbols.map((s) => <Badge key={s} className="mr-1 mb-1">{s}</Badge>) : <span className="text-sm text-muted-foreground">none</span>}</CardContent></Card>
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-1 text-danger"><AlertTriangle className="h-4 w-4" /> Avoid</CardTitle></CardHeader>
              <CardContent>{plan.symbolsToAvoid.length ? plan.symbolsToAvoid.map((s) => <Badge key={s} variant="destructive" className="mr-1 mb-1">{s}</Badge>) : <span className="text-sm text-muted-foreground">none</span>}</CardContent></Card>
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Preferred strategy</CardTitle></CardHeader>
              <CardContent><p className="font-semibold">{plan.preferredStrategy}</p></CardContent></Card>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <StatCard label="Max trades" value={String(plan.maxTrades)} />
            <StatCard label="Max risk per trade" value={`$${plan.maxRiskPerTradeUsd}`} />
            <StatCard label="Max session risk" value={`$${plan.maxRiskPerSessionUsd}`} />
          </div>

          <Card>
            <CardHeader><CardTitle>Rules for the session</CardTitle></CardHeader>
            <CardContent><ul className="text-sm space-y-1">{plan.rules.map((r) => <li key={r}>· {r}</li>)}</ul></CardContent>
          </Card>

          <div className="grid gap-3 md:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-sm">Warning zones</CardTitle></CardHeader>
              <CardContent>{plan.warningZones.length ? <ul className="text-xs space-y-1">{plan.warningZones.map((w) => <li key={w}>⚠ {w}</li>)}</ul> : <span className="text-sm text-muted-foreground">none</span>}</CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">Focus areas</CardTitle></CardHeader>
              <CardContent>{plan.focusAreas.map((f) => <Badge key={f} variant="outline" className="mr-1 mb-1">{f}</Badge>)}</CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader><CardTitle>Recommended first test</CardTitle></CardHeader>
            <CardContent><p className="text-sm">{plan.recommendedFirstTest}</p></CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">Generated {new Date(plan.generatedAt).toLocaleString()} · {plan.dataSource}</p>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground uppercase">{label}</p><p className="text-2xl font-bold">{value}</p></CardContent></Card>;
}
