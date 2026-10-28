import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert } from "lucide-react";

type Sev = "critical" | "high" | "medium" | "low";
interface IssueLastAction {
  action: string; at: string | null; adminId: number | null; reason: string | null;
}
interface Issue {
  id: string; type: string; severity: Sev;
  /** The key the server derived `id` from; every action must send it back. */
  naturalKey?: string;
  /** Most recent recorded action (actions are audit notes only). */
  lastAction?: IssueLastAction | null;
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
  /** false: recorded actions could not be read, so a missing lastAction is unknown. */
  actionsReadable?: boolean;
}

const ACTION_DONE_LABEL: Record<string, string> = {
  RECONCILIATION_ISSUE_DISMISSED: "Dismissed",
  RECONCILIATION_ISSUE_REVIEWED: "Marked reviewed",
  RECONCILIATION_ATTRIBUTION_LINKED: "Attribution link recorded",
  RECONCILIATION_MANUAL_RESOLUTION: "Manual resolution recorded",
};

const ACTIONS = [
  { key: "dismiss", label: "Dismiss" },
  { key: "mark-reviewed", label: "Mark reviewed" },
  { key: "link-attribution", label: "Link attribution" },
  { key: "resolve-manually", label: "Resolve manually" },
] as const;

export default function AdminReconciliationCenter() {
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Set when the issue list could not be loaded: nothing was evaluated, so
  // the page must not show zero counts or "No open reconciliation issues."
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setErr(null);
    try {
      const r = await fetch("/api/admin/reconciliation-center/issues", { credentials: "include" });
      if (r.status === 403) { setErr("Admin-only page."); return; }
      if (r.status === 401) { setErr("Sign in as admin to view this page."); return; }
      let j: Resp | null = null;
      try { j = (await r.json()) as Resp; } catch { j = null; }
      if (!r.ok || !j || j.ok !== true || !Array.isArray(j.issues)) {
        setData(null);
        setLoadErr(`HTTP ${r.status}${j?.error ? `: ${j.error}` : ""}`);
        return;
      }
      setData(j); setLoadErr(null);
    } catch (e) {
      setData(null);
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => { void load(); }, []);

  async function act(issue: Issue, action: typeof ACTIONS[number]["key"]) {
    const reason = window.prompt(`Reason for ${action} on ${issue.type}:`, "");
    if (!reason || reason.trim().length < 3) {
      alert("Reason is required (min 3 chars).");
      return;
    }
    const naturalKey = issue.naturalKey || guessNaturalKey(issue);
    if (!naturalKey) {
      alert("This issue came without its action key, so no action can be recorded for it. Reload the page and try again.");
      return;
    }
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
  if (loadErr) {
    return (
      <div className="p-6">
        <Card data-testid="card-reconciliation-load-error">
          <CardHeader><CardTitle className="text-base">Reconciliation issues could not be loaded.</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-danger">({loadErr})</p>
            <p className="text-muted-foreground">
              Nothing was evaluated, so this page cannot say whether any
              reconciliation issues are open. It is not a count of zero.
            </p>
            <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
          </CardContent>
        </Card>
      </div>
    );
  }
  if (!data) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  const sev = data.countsBySeverity ?? { critical: 0, high: 0, medium: 0, low: 0 };
  const byType = data.countsByType ?? {};

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-3">
        <ShieldAlert className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Reconciliation Center</h1>
          <p className="text-sm text-muted-foreground">Admin-only. Read + audited notes only — never places trades.</p>
        </div>
        <Badge variant="outline">total {data.total ?? 0}</Badge>
      </div>

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
            <div key={k} className="flex justify-between border-b border-border/40 py-1">
              <span className="text-muted-foreground">{k}</span><span>{v}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Detected issues</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground" data-testid="text-reconciliation-actions-note">
            Dismiss, Mark reviewed, Link attribution and Resolve manually each
            record an audited note with your reason. None of them changes, fixes
            or hides the issue: it stays listed while its condition is still
            detected.
            {data.actionsReadable === false && " Recorded actions could not be loaded, so earlier notes are not shown."}
          </p>
          {(data.issues ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No open reconciliation issues.</p>
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
              {i.lastAction && (
                <div className="text-xs text-warning" data-testid={`text-issue-last-action-${i.id}`}>
                  {ACTION_DONE_LABEL[i.lastAction.action] ?? i.lastAction.action}
                  {i.lastAction.adminId != null ? ` by admin #${i.lastAction.adminId}` : ""}
                  {i.lastAction.at ? ` at ${new Date(i.lastAction.at).toLocaleString()}` : ""}
                  {i.lastAction.reason ? ` (“${i.lastAction.reason}”)` : ""}
                  {" — still detected."}
                </div>
              )}
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

// Fallback for a response without `naturalKey`. Only the types whose key is
// built from fields the issue carries can be rebuilt; the row-id keyed types
// (pos:/att:/vac:/sma:/umla:) cannot, and return "" (the action is refused
// here rather than sent with a key the server would reject).
function guessNaturalKey(i: Issue): string {
  const m = i.metadata ?? {};
  switch (i.type) {
    case "BRIDGE_MISMATCH":
    case "STALE_HEARTBEAT":
      return i.bridgeConnectionId != null ? `conn:${i.bridgeConnectionId}` : "";
    case "COMMAND_RESULT_MISMATCH":
    case "LIVE_DEMO_MODE_MISMATCH":
      return i.commandId ? `cmd:${i.commandId}` : "";
    case "BLOCKED_REJECTED_COMMAND": {
      const queue = (m.queue as string | undefined) ?? "live";
      return i.commandId ? `${queue}:${i.commandId}` : "";
    }
    default:
      return "";
  }
}
