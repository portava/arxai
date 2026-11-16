// Task #33 — /admin/ea-updates
//
// OPERATOR-ONLY EA Updates dashboard. Consumes the existing audited admin update
// endpoints (/api/admin/ea/manifests + /update-reports). Surfaces the publish →
// stage → approve → revoke workflow, manifest filters (channel/status), the
// manual-bootstrap-required flag, and the self-update history. NO new feature,
// NO new trading path — every mutation reuses the existing reason-gated, audited
// endpoint from Task #32.
//
// SECURITY: wrapped in AdminDiagnosticsGate (also blocks admin-previewing-as-user).
// The server independently requires an ADMIN/OWNER session on every endpoint and
// requires a trimmed reason (>=3 chars) on every mutation (fail-closed audit row).
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AdminDiagnosticsGate } from "@/components/admin/AdminDiagnosticsGate";
import { RefreshCw, AlertTriangle, CheckCircle2 } from "lucide-react";

type ApiResp<T> = T & { ok?: boolean; error?: string; detail?: string };
const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
async function apiJson<T>(path: string, init?: RequestInit): Promise<ApiResp<T>> {
  const r = await fetch(`${BASE}${path}`, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  return (await r.json()) as ApiResp<T>;
}

type Manifest = {
  id: number; version: string; channel: string; minimumVersion: string | null;
  changelog: string | null; sha256Checksum: string; signature: string | null;
  downloadUrl: string; rollbackVersion: string | null; isUpdaterCapable: boolean;
  releaseStatus: string; createdByAdminId: number | null; approvedAt: string | null;
  revokedReason: string | null; notes: string | null; createdAt: string | null;
};
type Report = {
  id: number; userId: number; bridgeConnectionId: number | null; manifestId: number | null;
  fromVersion: string | null; toVersion: string | null; channel: string | null;
  phase: string; outcome: string; checksumVerified: boolean; blockReason: string | null;
  detail: string | null; reportedAt: string | null;
};

const CHANNELS = ["stable", "beta", "emergency"] as const;
const STATUSES = ["draft", "staged", "approved", "revoked"] as const;

function statusBadge(s: string) {
  const map: Record<string, string> = {
    draft: "border-border text-txt-secondary",
    staged: "border-primary/40 text-primary",
    approved: "border-success/40 text-success",
    revoked: "border-danger/40 text-danger",
  };
  return <Badge variant="outline" className={map[s] ?? ""}>{s.toUpperCase()}</Badge>;
}

function EaUpdatesInner() {
  const [manifests, setManifests] = useState<Manifest[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  // Create-draft form.
  const [form, setForm] = useState({
    version: "", channel: "stable", sha256Checksum: "", downloadUrl: "",
    minimumVersion: "", rollbackVersion: "", changelog: "", isUpdaterCapable: true,
  });

  async function load() {
    try {
      setLoading(true);
      const [m, r] = await Promise.all([
        apiJson<{ manifests: Manifest[] }>("/api/admin/ea/manifests"),
        apiJson<{ reports: Report[] }>("/api/admin/ea/update-reports"),
      ]);
      if (m.ok) setManifests(m.manifests ?? []);
      if (r.ok) setReports(r.reports ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load EA updates");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => manifests.filter((m) =>
    (channelFilter === "all" || m.channel === channelFilter) &&
    (statusFilter === "all" || m.releaseStatus === statusFilter)
  ), [manifests, channelFilter, statusFilter]);

  const latestApprovedByChannel = useMemo(() => {
    const map: Record<string, Manifest> = {};
    for (const m of manifests) {
      if (m.releaseStatus !== "approved") continue;
      if (!map[m.channel] || (m.approvedAt ?? "") > (map[m.channel]!.approvedAt ?? "")) map[m.channel] = m;
    }
    return map;
  }, [manifests]);

  const manualBootstrapReports = useMemo(
    () => reports.filter((r) => r.phase === "MANUAL_BOOTSTRAP_REQUIRED"),
    [reports],
  );

  async function transition(id: number, action: "stage" | "approve" | "revoke") {
    const reason = window.prompt(`Reason for ${action} (min 3 chars):`);
    if (!reason || reason.trim().length < 3) { setError("A reason of at least 3 characters is required."); return; }
    setBusy(true); setError(null); setNotice(null);
    const r = await apiJson<{ manifest: Manifest }>(`/api/admin/ea/manifests/${id}/${action}`, {
      method: "POST", body: JSON.stringify({ reason: reason.trim() }),
    });
    setBusy(false);
    if (!r.ok) { setError(r.detail || r.error || `Failed to ${action}`); return; }
    setNotice(`Manifest #${id} ${action}d.`);
    load();
  }

  // Rollback is DISTINCT from revoke: it reverts the currently-approved release
  // back to its declared rollbackVersion (revokes current + re-approves prior),
  // so the EA's next update-check is served the previous good build.
  async function rollback(id: number, rollbackVersion: string) {
    const reason = window.prompt(
      `Roll back this approved release to v${rollbackVersion}? This re-approves the prior build. Reason (min 3 chars):`,
    );
    if (!reason || reason.trim().length < 3) { setError("A reason of at least 3 characters is required."); return; }
    setBusy(true); setError(null); setNotice(null);
    const r = await apiJson<{ ok: boolean; error?: string; detail?: string }>(
      `/api/admin/ea/manifests/${id}/rollback`,
      { method: "POST", body: JSON.stringify({ reason: reason.trim() }) },
    );
    setBusy(false);
    if (!r.ok) { setError(r.detail || r.error || "Failed to roll back"); return; }
    setNotice(`Manifest #${id} rolled back to v${rollbackVersion}.`);
    load();
  }

  async function createDraft() {
    const reason = window.prompt("Reason for publishing this draft (min 3 chars):");
    if (!reason || reason.trim().length < 3) { setError("A reason of at least 3 characters is required."); return; }
    if (!form.version || !form.sha256Checksum || !form.downloadUrl) {
      setError("Version, sha256 checksum, and download URL are required.");
      return;
    }
    setBusy(true); setError(null); setNotice(null);
    const r = await apiJson<{ manifest: Manifest }>("/api/admin/ea/manifests", {
      method: "POST",
      body: JSON.stringify({
        reason: reason.trim(),
        version: form.version.trim(),
        channel: form.channel,
        sha256Checksum: form.sha256Checksum.trim(),
        downloadUrl: form.downloadUrl.trim(),
        minimumVersion: form.minimumVersion.trim() || undefined,
        rollbackVersion: form.rollbackVersion.trim() || undefined,
        changelog: form.changelog.trim() || undefined,
        isUpdaterCapable: form.isUpdaterCapable,
      }),
    });
    setBusy(false);
    if (!r.ok) { setError(r.detail || r.error || "Failed to create draft"); return; }
    setNotice(`Draft manifest v${form.version} created.`);
    setForm({ version: "", channel: "stable", sha256Checksum: "", downloadUrl: "", minimumVersion: "", rollbackVersion: "", changelog: "", isUpdaterCapable: true });
    load();
  }

  return (
    <div className="max-w-7xl mx-auto p-4 space-y-4" data-testid="admin-ea-updates">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold">EA Updates</h1>
          <p className="text-sm text-txt-secondary">Operator-only EA build manager. Publish → stage → approve → revoke. Only an approved manifest is ever served to an EA, and the EA verifies the checksum before applying.</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} data-testid="ea-updates-refresh">
          <RefreshCw className="w-3.5 h-3.5 mr-1" /> Refresh
        </Button>
      </div>

      {error && <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertTitle>Error</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {notice && <Alert><CheckCircle2 className="h-4 w-4" /><AlertTitle>Done</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert>}

      <div className="grid sm:grid-cols-3 gap-3">
        {CHANNELS.map((ch) => {
          const m = latestApprovedByChannel[ch];
          return (
            <Card key={ch} data-testid={`latest-approved-${ch}`}>
              <CardContent className="p-4">
                <div className="text-xs uppercase tracking-wider text-txt-secondary">{ch} — latest approved</div>
                <div className="text-xl font-semibold mt-1">{m ? `v${m.version}` : "—"}</div>
                {m && <div className="text-xs text-txt-muted mt-1">updater-capable: {m.isUpdaterCapable ? "yes" : "no"}</div>}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {manualBootstrapReports.length > 0 && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Manual bootstrap EA install required</AlertTitle>
          <AlertDescription>
            {manualBootstrapReports.length} bridge(s) reported they cannot self-update and need a manual bootstrap install of an updater-capable EA package.
          </AlertDescription>
        </Alert>
      )}

      {/* Create draft */}
      <Card>
        <CardHeader><CardTitle className="text-base">Publish a new draft manifest</CardTitle><CardDescription>Creates a draft. It must be staged then approved before any EA can take it.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div><Label className="text-xs">Version *</Label><Input value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} placeholder="1.30" data-testid="ea-updates-version" /></div>
            <div>
              <Label className="text-xs">Channel</Label>
              <select className="w-full h-9 rounded-md bg-card border border-border px-2 text-sm" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
                {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div><Label className="text-xs">Minimum version</Label><Input value={form.minimumVersion} onChange={(e) => setForm({ ...form, minimumVersion: e.target.value })} placeholder="1.27" /></div>
            <div><Label className="text-xs">Rollback version</Label><Input value={form.rollbackVersion} onChange={(e) => setForm({ ...form, rollbackVersion: e.target.value })} placeholder="1.29" /></div>
            <div className="lg:col-span-2"><Label className="text-xs">SHA-256 checksum *</Label><Input value={form.sha256Checksum} onChange={(e) => setForm({ ...form, sha256Checksum: e.target.value })} placeholder="hex digest" data-testid="ea-updates-checksum" /></div>
            <div className="lg:col-span-2"><Label className="text-xs">Download URL *</Label><Input value={form.downloadUrl} onChange={(e) => setForm({ ...form, downloadUrl: e.target.value })} placeholder="https://…" /></div>
            <div className="lg:col-span-4"><Label className="text-xs">Changelog / release notes</Label><Input value={form.changelog} onChange={(e) => setForm({ ...form, changelog: e.target.value })} placeholder="What changed" /></div>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isUpdaterCapable} onChange={(e) => setForm({ ...form, isUpdaterCapable: e.target.checked })} /> Package is updater-capable</label>
            <Button onClick={createDraft} disabled={busy} data-testid="ea-updates-create">Publish draft</Button>
          </div>
        </CardContent>
      </Card>

      {/* Manifest list */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-base">Manifests</CardTitle>
            <div className="flex items-center gap-2 text-sm">
              <select className="h-8 rounded-md bg-card border border-border px-2" value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)} data-testid="filter-channel">
                <option value="all">all channels</option>
                {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select className="h-8 rounded-md bg-card border border-border px-2" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} data-testid="filter-status">
                <option value="all">all statuses</option>
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading && manifests.length === 0 && <div className="text-sm text-txt-secondary">Loading…</div>}
          {!loading && filtered.length === 0 && <div className="text-sm text-txt-secondary">No manifests match the current filter.</div>}
          <div className="space-y-2">
            {filtered.map((m) => (
              <div key={m.id} className="rounded-md border border-border bg-card p-3" data-testid={`manifest-row-${m.id}`}>
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold">v{m.version}</span>
                    <Badge variant="outline">{m.channel}</Badge>
                    {statusBadge(m.releaseStatus)}
                    {m.isUpdaterCapable && <Badge variant="outline" className="border-success/40 text-success">updater-capable</Badge>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {m.releaseStatus === "draft" && <Button size="sm" variant="outline" disabled={busy} onClick={() => transition(m.id, "stage")} data-testid={`stage-${m.id}`}>Stage</Button>}
                    {m.releaseStatus === "staged" && <Button size="sm" variant="outline" disabled={busy} onClick={() => transition(m.id, "approve")} data-testid={`approve-${m.id}`}>Approve</Button>}
                    {m.releaseStatus === "approved" && m.rollbackVersion && <Button size="sm" variant="outline" disabled={busy} onClick={() => rollback(m.id, m.rollbackVersion!)} data-testid={`rollback-${m.id}`}>Roll back to v{m.rollbackVersion}</Button>}
                    {m.releaseStatus !== "revoked" && <Button size="sm" variant="destructive" disabled={busy} onClick={() => transition(m.id, "revoke")} data-testid={`revoke-${m.id}`}>Revoke</Button>}
                  </div>
                </div>
                {m.changelog && <div className="text-sm text-txt-secondary mt-2">{m.changelog}</div>}
                <div className="text-xs text-txt-muted mt-2 flex flex-wrap gap-x-4 gap-y-1">
                  <span>min: {m.minimumVersion ?? "—"}</span>
                  <span>rollback: {m.rollbackVersion ?? "—"}</span>
                  <span>created: {m.createdAt ? new Date(m.createdAt).toLocaleString() : "—"}</span>
                  {m.revokedReason && <span className="text-danger">revoked: {m.revokedReason}</span>}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Update history */}
      <Card>
        <CardHeader><CardTitle className="text-base">Self-update history</CardTitle><CardDescription>Every check / download / verify / apply / rollback the EAs reported.</CardDescription></CardHeader>
        <CardContent>
          {reports.length === 0 && <div className="text-sm text-txt-secondary">No self-update reports yet.</div>}
          <div className="space-y-1.5">
            {reports.map((r) => (
              <div key={r.id} className="flex items-center justify-between flex-wrap gap-2 text-xs border-b border-border pb-1.5" data-testid={`report-row-${r.id}`}>
                <div className="flex items-center gap-2">
                  <span className="text-txt-muted">user #{r.userId}</span>
                  <Badge variant="outline">{r.phase}</Badge>
                  <Badge variant="outline" className={r.outcome === "OK" ? "border-success/40 text-success" : r.outcome === "FAILED" ? "border-danger/40 text-danger" : "border-warning/40 text-warning"}>{r.outcome}</Badge>
                  <span className="text-txt-secondary">{r.fromVersion ?? "?"} → {r.toVersion ?? "?"}</span>
                  <span className="text-txt-muted">checksum {r.checksumVerified ? "ok" : "no"}</span>
                  {r.blockReason && <span className="text-warning">{r.blockReason}</span>}
                </div>
                <span className="text-txt-muted">{r.reportedAt ? new Date(r.reportedAt).toLocaleString() : "—"}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function AdminEaUpdatesPage() {
  return (
    <AdminDiagnosticsGate pageTitle="EA Updates" pageDescription="EA Updates">
      <EaUpdatesInner />
    </AdminDiagnosticsGate>
  );
}
