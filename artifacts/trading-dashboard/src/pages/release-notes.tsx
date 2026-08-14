import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface Brand { name: string; shortName: string; tagline: string; lockup: string; meaning: { analyze: string; risk: string; execute: string }; ownerTesterAccess: boolean; mt5Deferred: boolean; simulatorReady: boolean; realBrokerExecutionLocked: boolean; }
interface Notes { brand?: Brand; version: string; stage: string; worksNow: string[]; deferred: string[]; knownIssues: string[]; testingInstructions: string[]; nextMilestone: string; }

export default function ReleaseNotes() {
  const [n, setN] = useState<Notes | null>(null);
  useEffect(() => { void fetch("/api/release/notes").then((r) => r.json()).then(setN); }, []);
  if (!n) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;

  const Section = ({ title, items, tone }: { title: string; items: string[]; tone: "ok" | "warn" | "info" }) => (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent>
        {items.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : (
          <ul className="space-y-1 text-sm">
            {items.map((s, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className={tone === "ok" ? "text-emerald-400" : tone === "warn" ? "text-amber-400" : "text-cyan-400"}>•</span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-4 p-1" data-testid="page-release-notes">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">Release Notes</h1>
        <Badge className="bg-cyan-500/20 text-cyan-300 font-mono">{n.version}</Badge>
        <Badge className="bg-amber-500/20 text-amber-300">{n.stage}</Badge>
      </div>
      {n.brand && (
        <Card data-testid="release-brand-card">
          <CardHeader>
            <CardTitle className="text-base">Brand Identity — {n.brand.name}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="text-lg font-semibold">{n.brand.tagline}</div>
            <div className="text-muted-foreground italic">{n.brand.lockup}</div>
            <ul className="text-sm space-y-1 mt-2">
              <li><strong>Analyze:</strong> {n.brand.meaning.analyze}</li>
              <li><strong>Risk:</strong> {n.brand.meaning.risk}</li>
              <li><strong>eXecute:</strong> {n.brand.meaning.execute}</li>
            </ul>
            <div className="flex flex-wrap gap-2 pt-2">
              {n.brand.ownerTesterAccess && <Badge className="bg-emerald-500/20 text-emerald-300">Owner Tester Access Active</Badge>}
              {n.brand.mt5Deferred && <Badge className="bg-amber-500/20 text-amber-300">MT5 Deferred</Badge>}
              {n.brand.simulatorReady && <Badge className="bg-cyan-500/20 text-cyan-300">Simulator Ready</Badge>}
              {n.brand.realBrokerExecutionLocked && <Badge className="bg-zinc-500/20 text-zinc-300">Real broker execution locked</Badge>}
            </div>
          </CardContent>
        </Card>
      )}
      <Section title="Works now" items={n.worksNow} tone="ok" />
      <Section title="Deferred" items={n.deferred} tone="warn" />
      <Section title="Known issues" items={n.knownIssues} tone="warn" />
      <Section title="Testing instructions" items={n.testingInstructions} tone="info" />
      <Card><CardHeader><CardTitle className="text-base">Next milestone</CardTitle></CardHeader><CardContent className="text-sm">{n.nextMilestone}</CardContent></Card>
    </div>
  );
}
