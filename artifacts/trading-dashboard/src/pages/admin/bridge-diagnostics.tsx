// Task #33 — /admin/bridge-diagnostics
//
// OPERATOR-ONLY Bridge Diagnostics dashboard. Consolidates existing bridge
// signals: watchdog liveness, the masked connection list with reason-gated token
// rotation/revoke, the friendly MT5 retcode dictionary, and EA-reported broker
// symbol capabilities. Every endpoint already exists and is admin-gated; this
// page only consolidates them. NO new feature, NO new trading path.
//
// SECURITY: wrapped in AdminDiagnosticsGate (also blocks admin-previewing-as-user).
// The server emits only the allowlist connection projection. The raw rotated
// token is shown EXACTLY ONCE here, returned by the rotation endpoint — it is
// never re-served by any list endpoint.
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AdminDiagnosticsGate } from "@/components/admin/AdminDiagnosticsGate";
import { RefreshCw, AlertTriangle, CheckCircle2, KeyRound, Ban, Copy } from "lucide-react";

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

type Conn = {
  id: number; userId: number | null; connectionName: string | null; status: string | null;
  accountType: string | null; broker: string | null; server: string | null;
  eaVersion: string | null; tokenLast4: string | null; tokenRotatedAt: string | null;
  previousTokenExpiresAt: string | null; graceWindowActive: boolean;
  tokenRevokedAt?: string | null;
  lastHeartbeatAt: string | null; heartbeatAgeSeconds: number | null;
};
type Verdict = {
  connectionId: number; connectionName: string | null; liveness: string;
  conditions: string[]; heartbeatAgeSeconds: number | null; summary: string; shouldAlert: boolean;
};
type Retcode = { code: number; key: string; friendly: string; transient: boolean; success: boolean };
type ReconIssue = {
  id: string; type: string; severity: "critical" | "high" | "medium" | "low";
  userId: number | null; bridgeConnectionId: number | null; commandId: string | null;
  brokerTicket: string | null; symbol: string | null; status: string;
  reason: string; recommendedAction: string; createdAt: string | null; updatedAt: string | null;
};
type SymbolCap = {
  userId: number; symbol: string; brokerSymbol: string | null; accountType: string | null;
  visible: boolean | null; tradeAllowed: boolean | null; tradeMode: string | null;
  marketOpen: boolean | null; minVolume: string | number | null; maxVolume: string | number | null;
  volumeStep: string | number | null; spreadPoints: number | null; stopsLevelPoints: number | null;
  reportedAgeSeconds: number | null;
};

function livenessBadge(l: string, testId?: string) {
  const map: Record<string, string> = {
    fresh: "border-success/40 text-success",
    stale: "border-warning/40 text-warning",
    offline: "border-danger/40 text-danger",
    revoked: "border-border/40 text-txt-secondary",
  };
  return <Badge variant="outline" className={map[l] ?? ""} data-testid={testId}>{l.toUpperCase()}</Badge>;
}

// The five endpoints this page reads. Each one loads or fails on its own; a
// failed one is "could not be loaded" (its earlier data is dropped, never
// shown as current), and never reads as empty, clean or offline.
type Section = "connections" | "watchdog" | "retcodes" | "issues" | "symbols";
type SectionStatus = "loading" | "loaded" | "failed";
const SECTION_LABEL: Record<Section, string> = {
  connections: "Bridge list",
  watchdog: "Watchdog liveness",
  retcodes: "Retcode dictionary",
  issues: "Reconciliation issues",
  symbols: "Symbol capabilities",
};
type Fetched<T> = { ok: true; body: ApiResp<T> } | { ok: false; error: string };
async function fetchSection<T>(path: string): Promise<Fetched<T>> {
  try {
    const body = await apiJson<T>(path);
    if (body.ok === true) return { ok: true, body };
    return { ok: false, error: body.detail || body.error || "the server did not answer ok" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "request failed" };
  }
}

function Unavailable({ what, testId }: { what: string; testId: string }) {
  return <div className="text-xs text-danger" data-testid={testId}>{what} could not be loaded — not checked.</div>;
}

function BridgeDiagnosticsInner() {
  const [conns, setConns] = useState<Conn[]>([]);
  const [verdicts, setVerdicts] = useState<Verdict[]>([]);
  const [retcodes, setRetcodes] = useState<Retcode[]>([]);
  const [issues, setIssues] = useState<ReconIssue[]>([]);
  const [symbols, setSymbols] = useState<SymbolCap[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rawToken, setRawToken] = useState<string | null>(null);
  const [retcodeFilter, setRetcodeFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Record<Section, SectionStatus>>({
    connections: "loading", watchdog: "loading", retcodes: "loading", issues: "loading", symbols: "loading",
  });
  const [loadErrors, setLoadErrors] = useState<Partial<Record<Section, string>>>({});

  async function load() {
    // fetchSection never throws: each endpoint resolves to loaded or failed.
    const [c, w, rc, ri, sc] = await Promise.all([
      fetchSection<{ connections: Conn[] }>("/api/admin/bridge/connections"),
      fetchSection<{ verdicts: Verdict[] }>("/api/admin/bridge/watchdog"),
      fetchSection<{ retcodes: Retcode[] }>("/api/admin/ea/retcodes"),
      fetchSection<{ issues: ReconIssue[] }>("/api/admin/ea/reconciliation-issues"),
      fetchSection<{ symbols: SymbolCap[] }>("/api/admin/ea/symbol-capabilities"),
    ]);
    const errors: Partial<Record<Section, string>> = {};
    // A failed section drops what an earlier poll loaded: it is not current.
    setConns(c.ok ? c.body.connections ?? [] : []); if (!c.ok) errors.connections = c.error;
    setVerdicts(w.ok ? w.body.verdicts ?? [] : []); if (!w.ok) errors.watchdog = w.error;
    setRetcodes(rc.ok ? rc.body.retcodes ?? [] : []); if (!rc.ok) errors.retcodes = rc.error;
    setIssues(ri.ok ? ri.body.issues ?? [] : []); if (!ri.ok) errors.issues = ri.error;
    setSymbols(sc.ok ? sc.body.symbols ?? [] : []); if (!sc.ok) errors.symbols = sc.error;
    setLoadErrors(errors);
    setStatus({
      connections: c.ok ? "loaded" : "failed",
      watchdog: w.ok ? "loaded" : "failed",
      retcodes: rc.ok ? "loaded" : "failed",
      issues: ri.ok ? "loaded" : "failed",
      symbols: sc.ok ? "loaded" : "failed",
    });
  }

  useEffect(() => {
    load();
    const id = setInterval(() => { if (document.visibilityState === "visible") load(); }, 15000);
    return () => clearInterval(id);
  }, []);

  const verdictById = useMemo(() => {
    const m: Record<number, Verdict> = {};
    verdicts.forEach((v) => { m[v.connectionId] = v; });
    return m;
  }, [verdicts]);

  const reconGroups = useMemo(() => {
    const orphans = issues.filter((i) => i.type === "ORPHAN_BROKER_POSITION");
    const stale = issues.filter((i) => i.type === "COMMAND_RESULT_MISMATCH" || i.type === "STALE_HEARTBEAT");
    // Duplicate-bridge signal comes from the watchdog leader_conflict condition.
    const duplicates = verdicts.filter((v) => v.conditions.includes("leader_conflict"));
    const other = issues.filter(
      (i) =>
        i.type !== "ORPHAN_BROKER_POSITION" &&
        i.type !== "COMMAND_RESULT_MISMATCH" &&
        i.type !== "STALE_HEARTBEAT",
    );
    return { orphans, stale, duplicates, other };
  }, [issues, verdicts]);

  const filteredRetcodes = useMemo(() => {
    const q = retcodeFilter.trim().toLowerCase();
    if (!q) return retcodes;
    return retcodes.filter((r) =>
      String(r.code).includes(q) || r.key.toLowerCase().includes(q) ||
      r.friendly.toLowerCase().includes(q));
  }, [retcodes, retcodeFilter]);

  async function rotate(id: number) {
    const reason = window.prompt("Reason for rotating this bridge token (min 3 chars):");
    if (!reason || reason.trim().length < 3) { setError("A reason of at least 3 characters is required."); return; }
    setBusy(true); setError(null); setNotice(null); setRawToken(null);
    const r = await apiJson<{ rawToken?: string }>(`/api/admin/bridge/connections/${id}/rotate-token`, {
      method: "POST", body: JSON.stringify({ reason: reason.trim() }),
    });
    setBusy(false);
    if (!r.ok) { setError(r.detail || r.error || "Rotation failed"); return; }
    setRawToken(r.rawToken ?? null);
    setNotice(`Token rotated for connection #${id}. Copy the new token now — it is shown only once.`);
    load();
  }

  async function revoke(id: number) {
    const reason = window.prompt("Reason for REVOKING this bridge token (min 3 chars). The EA will stop working immediately:");
    if (!reason || reason.trim().length < 3) { setError("A reason of at least 3 characters is required."); return; }
    setBusy(true); setError(null); setNotice(null);
    const r = await apiJson(`/api/admin/bridge/connections/${id}/revoke`, {
      method: "POST", body: JSON.stringify({ reason: reason.trim() }),
    });
    setBusy(false);
    if (!r.ok) { setError(r.detail || r.error || "Revoke failed"); return; }
    setNotice(`Token revoked for connection #${id}.`);
    load();
  }

  return (
    <div className="mx-auto w-full max-w-7xl p-4 md:p-6 pb-32 md:pb-6 space-y-4" data-testid="admin-bridge-diagnostics">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Bridge Diagnostics</h1>
          <p className="text-sm text-txt-secondary">Operator-only consolidated view of bridge liveness, token lifecycle, MT5 retcodes, and broker symbol capabilities. Token values are never displayed except the one-time raw token at rotation.</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} data-testid="bridge-diag-refresh">
          <RefreshCw className="w-3.5 h-3.5 mr-1" /> Refresh
        </Button>
      </div>

      {error && <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertTitle>Error</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {Object.keys(loadErrors).length > 0 && (
        <Alert variant="destructive" data-testid="bridge-diag-load-failures">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Some diagnostics could not be loaded</AlertTitle>
          <AlertDescription>
            <ul className="list-disc list-inside text-xs">
              {(Object.keys(loadErrors) as Section[]).map((k) => (
                <li key={k}>{SECTION_LABEL[k]}: {loadErrors[k]}</li>
              ))}
            </ul>
            <div className="text-xs mt-1">Those sections show nothing rather than earlier or empty results.</div>
          </AlertDescription>
        </Alert>
      )}
      {notice && <Alert><CheckCircle2 className="h-4 w-4" /><AlertTitle>Done</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert>}
      {rawToken && (
        <Alert className="border-warning/40">
          <KeyRound className="h-4 w-4" />
          <AlertTitle>New bridge token (shown once)</AlertTitle>
          <AlertDescription className="flex items-center gap-2 mt-1">
            <code className="text-xs break-all bg-card px-2 py-1 rounded" data-testid="raw-token">{rawToken}</code>
            <Button size="sm" variant="outline" onClick={() => { navigator.clipboard?.writeText(rawToken); }}><Copy className="w-3.5 h-3.5 mr-1" /> Copy</Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Connections + token lifecycle */}
      <Card>
        <CardHeader><CardTitle className="text-base">Bridges & token lifecycle</CardTitle><CardDescription>Masked connection list. Rotate keeps the old token valid during a bounded grace window; revoke kills it immediately.</CardDescription></CardHeader>
        <CardContent>
          {status.connections === "loading" && conns.length === 0 && <div className="text-sm text-txt-secondary">Loading…</div>}
          {status.connections === "failed" && <Unavailable what="Bridge list" testId="conns-unavailable" />}
          {status.connections === "loaded" && conns.length === 0 && <div className="text-sm text-txt-secondary">No bridges registered.</div>}
          <div className="space-y-2">
            {conns.map((c) => {
              const v = verdictById[c.id];
              return (
                <div key={c.id} className="rounded-md border border-border bg-card p-3" data-testid={`conn-row-${c.id}`}>
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold">{c.connectionName ?? `Connection ${c.id}`}</span>
                      <span className="text-xs text-txt-muted">user #{c.userId ?? "—"}</span>
                      {v ? livenessBadge(v.liveness, `liveness-${c.id}`)
                        : c.tokenRevokedAt != null || c.status === "revoked" ? livenessBadge("revoked", `liveness-${c.id}`)
                        // No verdict is not evidence the bridge is offline.
                        : <Badge variant="outline" className="text-txt-secondary" data-testid={`liveness-${c.id}`}>
                            {status.watchdog === "loaded" ? "NO WATCHDOG VERDICT" : "LIVENESS NOT CHECKED"}
                          </Badge>}
                      <Badge variant="outline" className={c.accountType === "live" || c.accountType === "real" ? "border-danger/40 text-danger" : ""}>{(c.accountType ?? "unknown").toUpperCase()}</Badge>
                      <Badge variant="outline">EA v{c.eaVersion ?? "?"}</Badge>
                      {c.graceWindowActive && <Badge variant="outline" className="border-warning/40 text-warning">grace token active</Badge>}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => rotate(c.id)} data-testid={`rotate-${c.id}`}><KeyRound className="w-3.5 h-3.5 mr-1" /> Rotate</Button>
                      <Button size="sm" variant="destructive" disabled={busy} onClick={() => revoke(c.id)} data-testid={`revoke-${c.id}`}><Ban className="w-3.5 h-3.5 mr-1" /> Revoke</Button>
                    </div>
                  </div>
                  <div className="text-xs text-txt-muted mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    <span>token …{c.tokenLast4 ?? "----"}</span>
                    <span>{c.broker ?? "broker —"} · {c.server ?? "server —"}</span>
                    <span>heartbeat age {c.heartbeatAgeSeconds === null ? "—" : `${c.heartbeatAgeSeconds}s`}</span>
                    {c.tokenRotatedAt && <span>rotated {new Date(c.tokenRotatedAt).toLocaleString()}</span>}
                    {c.graceWindowActive && c.previousTokenExpiresAt && <span className="text-warning">grace until {new Date(c.previousTokenExpiresAt).toLocaleString()}</span>}
                    {v && v.conditions.length > 0 && <span className="text-warning">{v.conditions.join(", ")}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Reconciliation: orphan positions, stale commands, duplicate bridges */}
      <Card data-testid="bridge-diag-reconciliation">
        <CardHeader>
          <CardTitle className="text-base">Reconciliation & command health</CardTitle>
          <CardDescription>Read-only detectors. Resolve from the Reconciliation Center — this view never auto-assigns ownership or closes anything.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Orphan broker positions */}
          <div>
            <div className="text-xs uppercase tracking-wider text-txt-secondary mb-1">Orphan broker positions</div>
            {status.issues !== "loaded" ? (
              status.issues === "failed" ? <Unavailable what="Reconciliation issues" testId="orphans-unavailable" />
                : <div className="text-xs text-txt-muted">Loading…</div>
            ) : reconGroups.orphans.length === 0 ? (
              <div className="text-xs text-txt-muted" data-testid="orphans-none">No orphan positions detected.</div>
            ) : (
              <div className="space-y-1">
                {reconGroups.orphans.map((i) => (
                  <div key={i.id} className="rounded-md border border-danger/40 bg-danger/5 p-2 text-xs" data-testid={`orphan-${i.id}`}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="border-danger/40 text-danger">{i.severity}</Badge>
                      <span className="font-medium">{i.symbol ?? "—"}</span>
                      <span className="text-txt-muted">ticket {i.brokerTicket ?? "—"} · user #{i.userId ?? "—"}</span>
                    </div>
                    <div className="text-txt-secondary mt-1">{i.reason}</div>
                    <div className="text-txt-muted">{i.recommendedAction}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Stale commands / heartbeats */}
          <div>
            <div className="text-xs uppercase tracking-wider text-txt-secondary mb-1">Stale commands & heartbeats</div>
            {status.issues !== "loaded" ? (
              status.issues === "failed" ? <Unavailable what="Reconciliation issues" testId="stale-unavailable" />
                : <div className="text-xs text-txt-muted">Loading…</div>
            ) : reconGroups.stale.length === 0 ? (
              <div className="text-xs text-txt-muted" data-testid="stale-none">No stale commands or heartbeats.</div>
            ) : (
              <div className="space-y-1">
                {reconGroups.stale.map((i) => (
                  <div key={i.id} className="rounded-md border border-warning/40 bg-warning/5 p-2 text-xs" data-testid={`stale-${i.id}`}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="border-warning/40 text-warning">{i.type}</Badge>
                      {i.symbol && <span className="font-medium">{i.symbol}</span>}
                      <span className="text-txt-muted">{i.commandId ? `cmd ${i.commandId}` : `conn #${i.bridgeConnectionId ?? "—"}`} · user #{i.userId ?? "—"}</span>
                    </div>
                    <div className="text-txt-secondary mt-1">{i.reason}</div>
                    <div className="text-txt-muted">{i.recommendedAction}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Duplicate / conflicting bridges */}
          <div>
            <div className="text-xs uppercase tracking-wider text-txt-secondary mb-1">Duplicate / conflicting bridges</div>
            {status.watchdog !== "loaded" ? (
              status.watchdog === "failed" ? <Unavailable what="Watchdog liveness" testId="duplicates-unavailable" />
                : <div className="text-xs text-txt-muted">Loading…</div>
            ) : reconGroups.duplicates.length === 0 ? (
              <div className="text-xs text-txt-muted" data-testid="duplicates-none">No duplicate-bridge conflicts detected.</div>
            ) : (
              <div className="space-y-1">
                {reconGroups.duplicates.map((v) => (
                  <div key={v.connectionId} className="rounded-md border border-danger/40 bg-danger/5 p-2 text-xs" data-testid={`duplicate-${v.connectionId}`}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="border-danger/40 text-danger">leader conflict</Badge>
                      <span className="font-medium">{v.connectionName ?? `Connection ${v.connectionId}`}</span>
                    </div>
                    <div className="text-txt-secondary mt-1">{v.summary}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {reconGroups.other.length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-wider text-txt-secondary mb-1">Other open issues</div>
              <div className="space-y-1">
                {reconGroups.other.map((i) => (
                  <div key={i.id} className="rounded-md border border-border bg-card p-2 text-xs" data-testid={`other-issue-${i.id}`}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline">{i.type}</Badge>
                      <span className="text-txt-muted">user #{i.userId ?? "—"}</span>
                    </div>
                    <div className="text-txt-secondary mt-1">{i.reason}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Symbol capabilities */}
      <Card>
        <CardHeader><CardTitle className="text-base">Broker symbol capabilities</CardTitle><CardDescription>EA-reported per-symbol rules. Stale rows (large age) mean the EA hasn't re-synced.</CardDescription></CardHeader>
        <CardContent>
          {status.symbols === "loading" && symbols.length === 0 && <div className="text-sm text-txt-secondary">Loading…</div>}
          {status.symbols === "failed" && <Unavailable what="Symbol capabilities" testId="symbols-unavailable" />}
          {status.symbols === "loaded" && symbols.length === 0 && <div className="text-sm text-txt-secondary">No symbol specs reported yet.</div>}
          {symbols.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-txt-secondary text-left">
                  <tr>
                    <th className="py-1 pr-3">user</th><th className="py-1 pr-3">symbol</th><th className="py-1 pr-3">broker sym</th>
                    <th className="py-1 pr-3">visible</th><th className="py-1 pr-3">tradable</th><th className="py-1 pr-3">market</th>
                    <th className="py-1 pr-3">min/step/max</th><th className="py-1 pr-3">spread</th><th className="py-1 pr-3">stops</th><th className="py-1 pr-3">age</th>
                  </tr>
                </thead>
                <tbody>
                  {symbols.map((s, i) => (
                    <tr key={`${s.userId}-${s.symbol}-${i}`} className="border-t border-border" data-testid={`symbol-row-${s.userId}-${s.symbol}`}>
                      <td className="py-1 pr-3 text-txt-muted">#{s.userId}</td>
                      <td className="py-1 pr-3 font-medium">{s.symbol}</td>
                      <td className="py-1 pr-3 text-txt-secondary">{s.brokerSymbol ?? "—"}</td>
                      <td className="py-1 pr-3">{s.visible ? "yes" : "no"}</td>
                      <td className="py-1 pr-3">{s.tradeAllowed ? "yes" : "no"}</td>
                      <td className="py-1 pr-3">{s.marketOpen === null ? "—" : s.marketOpen ? "open" : "closed"}</td>
                      <td className="py-1 pr-3 text-txt-secondary">{s.minVolume ?? "—"}/{s.volumeStep ?? "—"}/{s.maxVolume ?? "—"}</td>
                      <td className="py-1 pr-3">{s.spreadPoints ?? "—"}</td>
                      <td className="py-1 pr-3">{s.stopsLevelPoints ?? "—"}</td>
                      <td className={`py-1 pr-3 ${(s.reportedAgeSeconds ?? 0) > 300 ? "text-warning" : "text-txt-muted"}`}>{s.reportedAgeSeconds === null ? "—" : `${s.reportedAgeSeconds}s`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Retcode dictionary */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div><CardTitle className="text-base">MT5 retcode dictionary</CardTitle><CardDescription>Friendly explanations for broker return codes seen in command results.</CardDescription></div>
            <Input className="max-w-xs" placeholder="Filter by code / name / text" value={retcodeFilter} onChange={(e) => setRetcodeFilter(e.target.value)} data-testid="retcode-filter" />
          </div>
        </CardHeader>
        <CardContent>
          {status.retcodes === "failed" && <Unavailable what="Retcode dictionary" testId="retcodes-unavailable" />}
          {status.retcodes === "loaded" && filteredRetcodes.length === 0 && <div className="text-sm text-txt-secondary">No retcodes match.</div>}
          <div className="space-y-1">
            {filteredRetcodes.map((r) => (
              <div key={r.code} className="flex items-start gap-2 text-xs border-b border-border pb-1" data-testid={`retcode-${r.code}`}>
                <code className="text-warning w-12 shrink-0">{r.code}</code>
                <span className="font-medium w-48 shrink-0">{r.key}</span>
                <span className="text-txt-secondary flex-1">{r.friendly}</span>
                <Badge variant="outline" className={`shrink-0 ${r.success ? "border-success/40 text-success" : r.transient ? "border-warning/40 text-warning" : "border-border/40 text-txt-secondary"}`}>{r.success ? "success" : r.transient ? "transient" : "failure"}</Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function AdminBridgeDiagnosticsPage() {
  return (
    <AdminDiagnosticsGate pageTitle="Bridge Diagnostics" pageDescription="Bridge Diagnostics">
      <BridgeDiagnosticsInner />
    </AdminDiagnosticsGate>
  );
}
