import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface Version { version: string; stage: string; fullTesterAccess: boolean; mt5Deferred: boolean; realBrokerExecutionAvailable: boolean; lastUpdated: string; }
interface Gate { key: string; label: string; pass: boolean; detail?: string; }
interface Readiness { releaseReady: boolean; readinessScore: number; stage: string; gates: Gate[]; criticalIssues: Array<{ feedbackId: string; title: string }>; mt5Deferred: boolean; }

export default function ReleaseStatus() {
  const [v, setV] = useState<Version | null>(null);
  const [r, setR] = useState<Readiness | null>(null);

  useEffect(() => {
    void fetch("/api/release/version").then((x) => x.json()).then(setV);
    void fetch("/api/release/readiness").then((x) => x.json()).then(setR);
  }, []);

  const Pill = ({ ok, label }: { ok: boolean; label: string }) => (
    <Badge className={ok ? "bg-emerald-500/20 text-emerald-300" : "bg-rose-500/20 text-rose-300"}>{label}: {ok ? "OK" : "NO"}</Badge>
  );

  return (
    <div className="space-y-4 p-1" data-testid="page-release-status">
      <div>
        <h1 className="text-2xl font-bold">Release Status</h1>
        <p className="text-sm text-muted-foreground">Beta Tester Mode Active — all tester workflows are open. Real broker execution requires MT5 bridge connection.</p>
      </div>

      {v && (
        <Card>
          <CardHeader><CardTitle>Version</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2 text-sm">
            <Badge className="bg-cyan-500/20 text-cyan-300 font-mono">{v.version}</Badge>
            <Badge className="bg-amber-500/20 text-amber-300">{v.stage}</Badge>
            <Pill ok={v.fullTesterAccess} label="Full tester access" />
            <Pill ok={v.mt5Deferred} label="MT5 deferred" />
            <Pill ok={!v.realBrokerExecutionAvailable} label="Real broker locked" />
            <span className="text-xs text-muted-foreground ml-auto">{new Date(v.lastUpdated).toLocaleString()}</span>
          </CardContent>
        </Card>
      )}

      {r && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-3">
              Readiness Score
              <Badge className={r.readinessScore >= 90 ? "bg-emerald-500/20 text-emerald-300" : r.readinessScore >= 70 ? "bg-amber-500/20 text-amber-300" : "bg-rose-500/20 text-rose-300"}>{r.readinessScore}/100</Badge>
              <Pill ok={r.releaseReady} label="Release ready" />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm" data-testid="release-gates">
              {r.gates.map((g) => (
                <li key={g.key} className="flex items-center justify-between gap-2 rounded border border-border/40 px-2 py-1.5">
                  <span className="truncate">{g.label}</span>
                  <Pill ok={g.pass} label={g.pass ? "PASS" : "FAIL"} />
                </li>
              ))}
            </ul>
            {r.criticalIssues.length > 0 && (
              <div className="mt-4 rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm">
                <p className="font-semibold text-rose-300">Critical open issues</p>
                <ul className="mt-2 space-y-1">{r.criticalIssues.map((c) => <li key={c.feedbackId}>{c.feedbackId} — {c.title}</li>)}</ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
