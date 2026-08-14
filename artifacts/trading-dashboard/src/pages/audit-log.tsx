import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Audit = {
  auditId: string; eventType: string; severity: string; sourceBuild: string;
  sourceService: string; actor: string; action: string;
  metadata: Record<string, unknown>; createdAt: string;
};

type TabKey = "audit" | "safety" | "system";

const TABS: { key: TabKey; label: string; blurb: string }[] = [
  { key: "audit",  label: "Audit Log",     blurb: "Immutable record of every recorded event." },
  { key: "safety", label: "Safety Logs",   blurb: "Risk blocks, kill-switch, gates, and execution safety events." },
  { key: "system", label: "System Events", blurb: "Auth, health, exports, and platform-level events." },
];

const tone = (s: string): "default"|"secondary"|"destructive"|"outline" => {
  const u = String(s).toUpperCase();
  return u === "CRITICAL" || u === "DANGER" ? "destructive" : u === "HIGH" ? "secondary" : u === "WARNING" || u === "WARN" ? "outline" : "default";
};

// Categorize an event into a tab by its type/service keywords.
function categoryOf(a: Audit): TabKey {
  const t = `${a.eventType ?? ""} ${a.sourceService ?? ""}`.toUpperCase();
  if (/SAFETY|KILL|RISK|BLOCK|GATE|ADVERSARIAL|ATTRIBUTION|EMERGENCY|GUARD|LIVE|DISPATCH/.test(t)) return "safety";
  if (/AUTH|SYSTEM|HEALTH|EXPORT|VAULT|RETENTION|INTEGRITY|SNAPSHOT|LOGIN|LOGOUT/.test(t)) return "system";
  return "audit";
}

export default function AuditLogPage({ defaultTab = "audit" as TabKey }: { defaultTab?: TabKey }) {
  const [tab, setTab] = useState<TabKey>(defaultTab);
  const [items, setItems] = useState<Audit[]>([]);
  const [severity, setSeverity] = useState("");
  const [build, setBuild] = useState("");
  const [selected, setSelected] = useState<Audit | null>(null);

  // Pick the starting tab from the URL so /safety-logs and /audit-vault land right.
  useEffect(() => {
    const path = typeof window !== "undefined" ? window.location.pathname : "";
    if (path.includes("safety")) setTab("safety");
    else if (path.includes("vault")) setTab("audit");
  }, []);

  const load = async () => {
    const params = new URLSearchParams({ limit: "200" });
    if (severity) params.set("severity", severity);
    if (build) params.set("sourceBuild", build);
    const r = await fetch(`/api/audit/logs?${params}`, { credentials: "include" });
    const j = await r.json();
    setItems(Array.isArray(j.audits) ? j.audits : []);
  };
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [severity, build]);

  const filtered = useMemo(() => items.filter((a) => categoryOf(a) === tab), [items, tab]);

  const counts = useMemo(() => {
    const c: Record<TabKey, number> = { audit: 0, safety: 0, system: 0 };
    for (const a of items) c[categoryOf(a)]++;
    return c;
  }, [items]);

  const exportLogs = async () => {
    const r = await fetch("/api/audit/export", { method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify({ limit: 500 }) });
    const j = await r.json();
    const blob = new Blob([JSON.stringify(j.export, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `audit-export-${Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  const activeBlurb = TABS.find((t) => t.key === tab)?.blurb ?? "";

  return (
    <div className="space-y-4 p-4" data-testid="page-audit-log">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Records</h1>
          <p className="text-sm text-muted-foreground">{activeBlurb}</p>
        </div>
        <Button onClick={exportLogs} variant="outline" data-testid="btn-export-audit">Export JSON</Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setSelected(null); }}
            data-testid={`audit-tab-${t.key}`}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
              tab === t.key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label} <span className="ml-1 text-xs text-muted-foreground">({counts[t.key]})</span>
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <Input placeholder="Severity (INFO/WARNING/HIGH/CRITICAL)" value={severity} onChange={(e) => setSeverity(e.target.value.toUpperCase())} className="w-72" data-testid="input-severity" />
        <Input placeholder="Source build (AA..MM)" value={build} onChange={(e) => setBuild(e.target.value.toUpperCase())} className="w-48" data-testid="input-build" />
      </div>

      <Card>
        <CardHeader><CardTitle>{filtered.length} events</CardTitle></CardHeader>
        <CardContent>
          <div className="text-xs max-h-[60vh] overflow-auto">
            {filtered.map((a) => (
              <button key={a.auditId} className="w-full text-left flex justify-between border-b py-1 hover:bg-muted/50" onClick={() => setSelected(a)} data-testid={`audit-${a.auditId}`}>
                <span><Badge variant={tone(a.severity)}>{a.severity}</Badge> <strong className="ml-1">{a.sourceBuild}</strong> · {a.action}</span>
                <span className="text-muted-foreground">{a.createdAt ? new Date(a.createdAt).toLocaleString() : ""}</span>
              </button>
            ))}
            {filtered.length === 0 && <em className="text-muted-foreground">No events in this category.</em>}
          </div>
        </CardContent>
      </Card>

      {selected && (
        <Card>
          <CardHeader><CardTitle>Event detail · {selected.auditId}</CardTitle></CardHeader>
          <CardContent>
            <pre className="text-xs whitespace-pre-wrap max-h-72 overflow-auto">{JSON.stringify(selected, null, 2)}</pre>
            <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>Close</Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
