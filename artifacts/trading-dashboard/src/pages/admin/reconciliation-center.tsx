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
    const r = await fetch("/api/admin/reconciliation-center/issues", { credentials: "include" });
    if (r.status === 403) { setErr("Admin-only page."); return; }
    if (r.status === 401) { setErr("Sign in as admin to view this page."); return; }
    const j = (await r.json()) as Resp;
    setData(j);
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

  if (err) return <div><Card><CardHeader><CardTitle>{err}</CardTitle></CardHeader></Card></div>;
  if (!data) return <div className="text-sm text-muted-foreground">Loading…</div>;

  const sev = data.countsBySeverity ?? { critical: 0, high: 0, medium: 0, low: 0 };
  const byType = data.countsByType ?? {};

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <ShieldAlert className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Reconciliation Center</h1>
          <p className="text-sm text-muted-foreground">Admin-only. Read + audited actions only — never places trades.</p>
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

      <BrokerAbsenceSection />

      <Card>
        <CardHeader><CardTitle className="text-base">Open issues</CardTitle></CardHeader>
        <CardContent className="space-y-3">
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

// ── Broker absence ──────────────────────────────────────────────────────────
//
// GET /admin/reconciliation-center/broker-absence-candidates (audited dry-run
// report + policy snapshot) and POST .../broker-absence-reconcile shipped
// fully implemented with no UI at all: an operator could not see which
// positions the broker had stopped reporting, nor run the dry run, from the
// product.
//
// HONESTY (inviolable):
//   * The dry run is the default and is labelled as a dry run. The apply
//     press is separate, requires a reason and a bridge id, and the server
//     still refuses it while the feature flag is off (FEATURE_DISABLED) — that
//     refusal is shown verbatim rather than retried or softened.
//   * A read failure renders the failure. It never renders "no candidates".

function BrokerAbsenceSection() {
  const [report, setReport] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [userId, setUserId] = useState("");
  const [bridgeId, setBridgeId] = useState("");
  const [reason, setReason] = useState("");
  const [applyResult, setApplyResult] = useState<Record<string, unknown> | null>(null);

  async function loadCandidates() {
    setBusy(true);
    setErr(null);
    try {
      const qs = userId.trim() ? `?userId=${encodeURIComponent(userId.trim())}` : "";
      const r = await fetch(`/api/admin/reconciliation-center/broker-absence-candidates${qs}`, { credentials: "include" });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) {
        setReport(null);
        setErr(`Candidate read failed (${r.status}): ${String(j.error ?? "")}`);
        return;
      }
      setReport(j);
    } catch (e) {
      setReport(null);
      setErr(`Candidate read failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function run(dryRun: boolean) {
    setBusy(true);
    setApplyResult(null);
    try {
      const r = await fetch("/api/admin/reconciliation-center/broker-absence-reconcile", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: reason.trim(),
          targetUserId: Number(userId),
          dryRun,
          ...(bridgeId.trim() ? { bridgeConnectionId: Number(bridgeId) } : {}),
        }),
      });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      setApplyResult({ httpStatus: r.status, ...j });
    } catch (e) {
      setApplyResult({ error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="broker-absence-section">
      <CardHeader><CardTitle className="text-base">Broker absence</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Positions the broker has stopped reporting. The report below is a dry run — it stamps nothing. Applying is a
          separate, audited press that requires a reason and a bridge connection, and the server refuses it entirely
          while the broker-absence write flag is off.
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="space-y-1">
            <span className="text-muted-foreground">User id (blank = all users with open live positions)</span>
            <input
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              value={userId} onChange={(e) => setUserId(e.target.value)} inputMode="numeric"
              data-testid="input-absence-user"
            />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">Bridge connection id (required to apply)</span>
            <input
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              value={bridgeId} onChange={(e) => setBridgeId(e.target.value)} inputMode="numeric"
              data-testid="input-absence-bridge"
            />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">Reason (min 3 chars, audited)</span>
            <input
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              value={reason} onChange={(e) => setReason(e.target.value)}
              data-testid="input-absence-reason"
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void loadCandidates()} data-testid="button-absence-candidates">
            Load candidates (dry run)
          </Button>
          <Button
            size="sm" variant="outline"
            disabled={busy || reason.trim().length < 3 || !userId.trim()}
            onClick={() => void run(true)}
            data-testid="button-absence-dryrun"
          >
            Run dry run for this user
          </Button>
          <Button
            size="sm"
            disabled={busy || reason.trim().length < 3 || !userId.trim() || !bridgeId.trim()}
            onClick={() => void run(false)}
            data-testid="button-absence-apply"
          >
            Apply (audited)
          </Button>
        </div>
        {err && <p className="text-danger" data-testid="absence-error">{err}</p>}
        {report && (
          <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-[11px]" data-testid="absence-report">
            {JSON.stringify(report, null, 2)}
          </pre>
        )}
        {applyResult && (
          <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-[11px]" data-testid="absence-run-result">
            {JSON.stringify(applyResult, null, 2)}
          </pre>
        )}
      </CardContent>
    </Card>
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
