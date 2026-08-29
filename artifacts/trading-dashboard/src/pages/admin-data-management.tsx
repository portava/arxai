import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const EXPORTS = [
  { kind: "Full system report", url: "/api/export/full-system-report", file: "full-system-report.json" },
  { kind: "Trades CSV", url: "/api/export/trades.csv", file: "trades.csv" },
  { kind: "Journal CSV", url: "/api/export/journal.csv", file: "journal.csv" },
  { kind: "AI decisions JSON", url: "/api/export/ai-decisions.json", file: "ai-decisions.json" },
  { kind: "Audit log JSON", url: "/api/export/audit.json", file: "audit.json" },
  { kind: "Strategy results", url: "/api/export/strategies.json", file: "strategies.json" },
  { kind: "Risk events", url: "/api/export/risk-events.json", file: "risk-events.json" },
  { kind: "Shadow results", url: "/api/export/shadow-results.json", file: "shadow-results.json" },
];

export default function AdminDataManagement() {
  const [confirmText, setConfirmText] = useState("");
  const [resetMsg, setResetMsg] = useState<string>("");
  async function download(url: string, file: string) {
    const r = await fetch(url, { credentials: "include" });
    const blob = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = file; a.click();
    URL.revokeObjectURL(a.href);
  }

  function reset(scope: string) {
    if (confirmText !== "CONFIRM RESET TEST DATA") {
      setResetMsg(`Type "CONFIRM RESET TEST DATA" first.`); return;
    }
    setResetMsg(`Reset request for ${scope} acknowledged. (Persistent records are not destroyed; reset is logged to audit. MT5 / future broker records are never touched.)`);
    void fetch("/api/audit/demo", { method: "POST" });
  }

  return (
    <div className="space-y-4" data-testid="page-admin-data-management">
      <div>
        <h1 className="text-2xl font-bold">Data Management</h1>
        <p className="text-sm text-muted-foreground">Backup, export, and (carefully) reset test data. MT5 and future-broker records are never cleared from this page.</p>
      </div>

      <Card>
        <CardHeader><CardTitle>Exports</CardTitle></CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-2">
          {EXPORTS.map((e) => (
            <Button key={e.url} size="sm" variant="outline" onClick={() => download(e.url, e.file)} data-testid={`btn-export-${e.file}`}>Export {e.kind}</Button>
          ))}
        </CardContent>
      </Card>

      <Card className="border-danger/40">
        <CardHeader><CardTitle>Reset (danger)</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div>
            <Badge variant="destructive">Confirmation required</Badge>{" "}
            Type the phrase below to enable the reset buttons.
          </div>
          <input
            className="w-full rounded border bg-background px-2 py-1 text-sm font-mono"
            placeholder="CONFIRM RESET TEST DATA"
            value={confirmText} onChange={(e) => setConfirmText(e.target.value)}
            data-testid="input-confirm-reset"
          />
          <div className="flex flex-wrap gap-2">
            {["Simulator data", "Live tester intents", "Shadow results", "All test data"].map((s) => (
              <Button key={s} size="sm" variant="destructive" disabled={confirmText !== "CONFIRM RESET TEST DATA"} onClick={() => reset(s)}>Clear {s}</Button>
            ))}
          </div>
          {resetMsg && <div className="text-xs text-warning">{resetMsg}</div>}
          <p className="text-[11px] text-muted-foreground">
            Reset never touches MT5 commands, future-broker placement records, or the immutable audit vault.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
