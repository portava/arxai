import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface Brand { name: string; shortName: string; tagline: string; lockup: string; meaning: { analyze: string; risk: string; execute: string }; ownerTesterAccess: boolean; mt5Deferred: boolean; simulatorReady: boolean; realBrokerExecutionLocked: boolean; }
// knownIssues: real open P0/P1 rows from the feedback tracker; null = the
// server could not read the tracker (rendered as unavailable, never "None").
interface Notes { brand?: Brand; version: string; stage: string; worksNow: string[]; deferred: string[]; knownIssues: string[] | null; testingInstructions: string[]; nextMilestone: string; }

export default function ReleaseNotes() {
  const [n, setN] = useState<Notes | null>(null);
  useEffect(() => { void fetch("/api/release/notes").then((r) => r.json()).then(setN); }, []);
  if (!n) return <div className="text-sm text-muted-foreground">Loading…</div>;

  const Section = ({ title, items, tone }: { title: string; items: string[] | null; tone: "ok" | "warn" | "info" }) => (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent>
        {items === null ? (
          <p className="text-sm text-warning">Unavailable — the issue tracker could not be read, so this list is unknown (not empty).</p>
        ) : items.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : (
          <ul className="space-y-1 text-sm">
            {items.map((s, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className={tone === "ok" ? "text-success" : tone === "warn" ? "text-warning" : "text-ruby"}>•</span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-4" data-testid="page-release-notes">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">Release Notes</h1>
        <Badge className="bg-ruby/20 text-ruby font-mono">{n.version}</Badge>
        <Badge className="bg-warning/20 text-warning">{n.stage}</Badge>
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
              {n.brand.ownerTesterAccess && <Badge className="bg-success/20 text-success">Owner Tester Access Active</Badge>}
              {n.brand.mt5Deferred && <Badge className="bg-warning/20 text-warning">MT5 Deferred</Badge>}
              {n.brand.simulatorReady && <Badge className="bg-ruby/20 text-ruby">Simulator Ready</Badge>}
              {n.brand.realBrokerExecutionLocked && <Badge className="bg-muted text-txt-secondary">Real broker execution locked</Badge>}
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
