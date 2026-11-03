import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ClipboardList, Target, AlertTriangle, RefreshCcw } from "lucide-react";
import { safeDate } from "@/lib/safeFormat";

type Plan = {
  bestSymbols: string[]; symbolsToAvoid: string[];
  preferredStrategy: string;
  maxTrades: number; maxRiskPerTradeUsd: number; maxRiskPerSessionUsd: number;
  marketConditions: string;
  rules: string[]; warningZones: string[]; focusAreas: string[];
  recommendedFirstTest: string; summary: string;
  /** generatedAt is the time of the scanner sweep the plan was built from. */
  dataSource: string; generatedAt: string;
  /** Set when the server withheld the plan's values for this viewer. */
  withheld?: boolean;
};

const WITHHELD = "Withheld";

function isPlan(v: unknown): v is Plan {
  const p = v as Partial<Plan> | null;
  return !!p && typeof p === "object" && !("error" in p)
    && Array.isArray(p.bestSymbols) && Array.isArray(p.symbolsToAvoid)
    && Array.isArray(p.rules) && Array.isArray(p.warningZones) && Array.isArray(p.focusAreas);
}

function sweepAge(iso: string): string | null {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const min = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (min < 1) return "under a minute ago";
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ${min % 60} min ago`;
}

export default function SessionPlanPage() {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    try {
      const res = await fetch("/api/ai/session-plan");
      const body: unknown = await res.json().catch(() => null);
      if (res.ok && isPlan(body)) {
        setPlan(body);
        setFailed(false);
      } else {
        setPlan(null);
        setFailed(true);
      }
    } catch {
      setPlan(null);
      setFailed(true);
    } finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);

  const withheld = plan?.withheld === true;
  const sweptAt = plan ? safeDate(plan.generatedAt, "datetime", "") : "";
  const age = plan ? sweepAge(plan.generatedAt) : null;
  const held = <span className="text-sm text-muted-foreground">{WITHHELD}</span>;

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

      {failed ? (
        <p role="alert" className="text-sm text-destructive" data-testid="session-plan-error">
          The session plan could not be loaded, so no plan is shown. Use Regenerate to try again.
        </p>
      ) : !plan ? <p className="text-sm text-muted-foreground">Loading…</p> : (
        <>
          {withheld && (
            <p className="text-sm text-yellow-300" data-testid="session-plan-withheld">
              This plan's values are withheld for your account until a verified feed is available. Withheld values are not zero.
            </p>
          )}
          <Card><CardHeader><CardTitle>Today's plan</CardTitle><CardDescription>{plan.marketConditions}</CardDescription></CardHeader>
            <CardContent><p className="text-sm">{plan.summary}</p></CardContent></Card>

          <div className="grid gap-3 md:grid-cols-3">
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-1 text-emerald-400"><Target className="h-4 w-4" /> Best symbols</CardTitle></CardHeader>
              <CardContent>{withheld ? held : plan.bestSymbols.length ? plan.bestSymbols.map((s) => <Badge key={s} className="mr-1 mb-1">{s}</Badge>) : <span className="text-sm text-muted-foreground">none</span>}</CardContent></Card>
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-1 text-rose-400"><AlertTriangle className="h-4 w-4" /> Avoid</CardTitle></CardHeader>
              <CardContent>{withheld ? held : plan.symbolsToAvoid.length ? plan.symbolsToAvoid.map((s) => <Badge key={s} variant="destructive" className="mr-1 mb-1">{s}</Badge>) : <span className="text-sm text-muted-foreground">none</span>}</CardContent></Card>
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Preferred strategy</CardTitle></CardHeader>
              <CardContent><p className="font-semibold">{plan.preferredStrategy}</p></CardContent></Card>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <StatCard label="Max trades" value={withheld ? WITHHELD : String(plan.maxTrades)} />
            <StatCard label="Max risk per trade" value={withheld ? WITHHELD : `$${plan.maxRiskPerTradeUsd}`} />
            <StatCard label="Max session risk" value={withheld ? WITHHELD : `$${plan.maxRiskPerSessionUsd}`} />
          </div>
          <p className="text-xs text-muted-foreground" data-testid="session-plan-limits-scope">
            These caps are fixed numbers built into the simulator plan. They are not read from your risk settings and nothing enforces them.
          </p>

          <Card>
            <CardHeader>
              <CardTitle>Rules for the session</CardTitle>
              <CardDescription>Fixed plan text, not your risk settings. Nothing enforces these rules.</CardDescription>
            </CardHeader>
            <CardContent>{withheld ? held : <ul className="text-sm space-y-1">{plan.rules.map((r) => <li key={r}>· {r}</li>)}</ul>}</CardContent>
          </Card>

          <div className="grid gap-3 md:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-sm">Warning zones</CardTitle></CardHeader>
              <CardContent>{withheld ? held : plan.warningZones.length ? <ul className="text-xs space-y-1">{plan.warningZones.map((w) => <li key={w}>⚠ {w}</li>)}</ul> : <span className="text-sm text-muted-foreground">none</span>}</CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">Focus areas</CardTitle></CardHeader>
              <CardContent>{withheld ? held : plan.focusAreas.map((f) => <Badge key={f} variant="outline" className="mr-1 mb-1">{f}</Badge>)}</CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader><CardTitle>Recommended first test</CardTitle></CardHeader>
            <CardContent><p className="text-sm">{plan.recommendedFirstTest}</p></CardContent>
          </Card>

          <p className="text-xs text-muted-foreground" data-testid="session-plan-sweep-time">
            {sweptAt
              ? `Built from the scanner sweep at ${sweptAt}${age ? ` (${age})` : ""}`
              : "Scanner sweep time not reported"}
            {` · ${plan.dataSource} · Regenerate rebuilds the plan from the latest sweep and scans only when there is none.`}
          </p>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground uppercase">{label}</p><p className="text-2xl font-bold">{value}</p></CardContent></Card>;
}
