import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert } from "lucide-react";

type Sev = "critical" | "high" | "medium" | "low";
interface Issue {
  id: string; type: string; severity: Sev;
  userId: number | null; bridgeConnectionId: number | null;
  commandId: string | null; brokerTicket: string | null;
  symbol: string | null; status: string; reason: string;
  recommendedAction: string;
  createdAt: string | null; updatedAt: string | null;
  metadata: Record<string, unknown>;
}
interface Resp {
  ok: boolean; error?: string;
  issues?: Issue[];
  countsByType?: Record<string, number>;
  countsBySeverity?: Record<Sev, number>;
  total?: number; computedAt?: string;
  categories?: string[];
  reason?: string;
  /** True only when every detector ran; otherwise counts cover only the checks that ran. */
  complete?: boolean;
  /** Issue types whose detector could not run (unknown, not zero). */
  uncheckedTypes?: string[];
  failedChecks?: Array<{ check: string; type: string; severity: Sev; error: string }>;
}

const ACTIONS = [
  { key: "dismiss", label: "Dismiss" },
  { key: "mark-reviewed", label: "Mark reviewed" },
  { key: "link-attribution", label: "Link attribution" },
  { key: "resolve-manually", label: "Resolve manually" },
] as const;

export default function AdminReconciliationCenter() {
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setErr(null);
    try {
      const r = await fetch("/api/admin/reconciliation-center/issues", { credentials: "include" });
      if (r.status === 403) { setErr("Admin-only page."); return; }
      if (r.status === 401) { setErr("Sign in as admin to view this page."); return; }
      const j = (await r.json()) as Resp;
      // A failed request is a load failure, never "total 0 / no open issues".
      if (!r.ok || !j.ok) {
        setData(null);
        setErr(`Reconciliation issues could not be loaded${j.reason || j.error ? `: ${j.reason ?? j.error}` : ""}. This is a load failure, not an all-clear.`);
        return;
      }
      setData(j);
    } catch (e) {
      setData(null);
      setErr(`Reconciliation issues could not be loaded${e instanceof Error ? `: ${e.message}` : ""}. This is a load failure, not an all-clear.`);
    }
  }
  useEffect(() => { void load(); }, []);

  async function act(issue: Issue, action: typeof ACTIONS[number]["key"]) {
    const reason = window.prompt(`Reason for ${action} on ${issue.type}:`, "");
    if (!reason || reason.trim().length < 3) {
      alert("Reason is required (min 3 chars).");
      return;
    }
    const naturalKey = guessNaturalKey(issue);
    setBusy(issue.id);
    try {
      const r = await fetch(`/api/admin/reconciliation-center/issues/${issue.id}/${action}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason, type: issue.type, naturalKey, targetUserId: issue.userId }),
      });
      const j = (await r.json()) as { ok: boolean; error?: string };
      if (!j.ok) alert(`Action failed: ${j.error ?? "unknown"}`);
      await load();
    } finally { setBusy(null); }
  }

  if (err) return <div className="p-6"><Card><CardHeader><CardTitle>{err}</CardTitle></CardHeader></Card></div>;
  if (!data) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  const sev = data.countsBySeverity ?? { critical: 0, high: 0, medium: 0, low: 0 };
  const byType = data.countsByType ?? {};
  const complete = data.complete === true;
  const unchecked = data.uncheckedTypes ?? [];

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-3">
        <ShieldAlert className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Reconciliation Center</h1>
          <p className="text-sm text-muted-foreground">Admin-only. Read + audited actions only — never places trades.</p>
        </div>
        <Badge variant="outline">total {data.total ?? 0}</Badge>
        {!complete && <Badge variant="outline" className="border-warning/40 text-warning">incomplete check</Badge>}
      </div>

      {!complete && (
        <Card className="border-warning/40" data-testid="recon-unchecked">
          <CardContent className="pt-4 text-sm space-y-1">
            <p className="text-warning">
              Not every reconciliation check ran{data.computedAt ? ` (checked ${new Date(data.computedAt).toLocaleString()})` : ""}. Counts on this page cover only the checks that ran.
            </p>
            {unchecked.length > 0 ? (
              <p className="text-muted-foreground">Could not be checked: {unchecked.join(", ")}. Issues of these types may exist.</p>
            ) : (
              <p className="text-muted-foreground">The server did not confirm which checks ran.</p>
            )}
            {(data.failedChecks ?? []).map((f) => (
              <p key={f.check} className="text-xs text-muted-foreground">{f.check} ({f.type}): {f.error}</p>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Counts by severity</CardTitle></CardHeader>
        <CardContent className="flex gap-2 flex-wrap text-sm">
          <Badge className="bg-danger/20 text-danger">critical {sev.critical}</Badge>
          <Badge className="bg-warning/20 text-warning">high {sev.high}</Badge>
          <Badge className="bg-warning/20 text-warning">medium {sev.medium}</Badge>
          <Badge className="bg-primary/20 text-primary">low {sev.low}</Badge>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Counts by type</CardTitle></CardHeader>
        <CardContent className="grid gap-1 md:grid-cols-2 text-sm">
          {Object.entries(byType).map(([k, v]) => (
            <div key={k} className="flex justify-between border-b border-border/40 py-1" data-testid={`recon-type-${k}`}>
              <span className="text-muted-foreground">{k}</span>
              <span>{unchecked.includes(k) ? <span className="text-warning">not checked</span> : v}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Open issues</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {(data.issues ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {complete ? "No open reconciliation issues." : "No issues found by the checks that ran. Not every check ran, so this is not an all-clear."}
            </p>
          ) : (data.issues ?? []).map((i) => (
            <div key={i.id} className="rounded-md border border-border/60 p-3 text-sm space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{i.type}</Badge>
                <Badge>{i.severity}</Badge>
                {i.userId != null && <Badge variant="outline">user {i.userId}</Badge>}
                {i.bridgeConnectionId != null && <Badge variant="outline">bridge {i.bridgeConnectionId}</Badge>}
                {i.commandId && <Badge variant="outline">cmd {i.commandId}</Badge>}
                {i.brokerTicket && <Badge variant="outline">ticket {i.brokerTicket}</Badge>}
                {i.symbol && <Badge variant="outline">{i.symbol}</Badge>}
                <Badge variant="outline">{i.status}</Badge>
              </div>
              <div><span className="text-muted-foreground">Reason:</span> {i.reason}</div>
              <div><span className="text-muted-foreground">Recommended:</span> {i.recommendedAction}</div>
              <div className="text-xs text-muted-foreground">id {i.id.slice(0, 12)}…</div>
              <div className="flex gap-2 flex-wrap pt-1">
                {ACTIONS.map((a) => (
                  <Button key={a.key} size="sm" variant="outline"
                    disabled={busy === i.id} onClick={() => void act(i, a.key)}>{a.label}</Button>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function guessNaturalKey(i: Issue): string {
  const m = i.metadata ?? {};
  switch (i.type) {
    case "BRIDGE_MISMATCH":
    case "STALE_HEARTBEAT":
      return `conn:${i.bridgeConnectionId}`;
    case "ORPHAN_BROKER_POSITION":
      return String((m as { _pos?: string })._pos ?? "");
    case "MISSING_ATTRIBUTION":
      return String((m as { _att?: string })._att ?? "");
    case "COMMAND_RESULT_MISMATCH":
    case "LIVE_DEMO_MODE_MISMATCH":
      return `cmd:${i.commandId}`;
    case "BLOCKED_REJECTED_COMMAND": {
      const queue = (m.queue as string | undefined) ?? "live";
      return `${queue}:${i.commandId}`;
    }
    case "USER_ALLOCATION_MISMATCH":
      return String((m as { _vac?: string })._vac ?? "");
    case "MASTER_BRIDGE_EXPOSURE_WARNING":
      return String((m as { _sma?: string })._sma ?? "");
    case "USER_APPROVAL_RISK_LOCK_CONFLICT":
      return String((m as { _umla?: string })._umla ?? "");
    default:
      return "";
  }
}
