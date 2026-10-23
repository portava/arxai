// Task #398 — /admin/bridge-v2-monitor
//
// OPERATOR-ONLY Bridge v2 monitor. Surfaces broker-truth TELEMETRY recorded by
// the v2 kernel: per-bridge readiness (connected, EA version, terminal, algo,
// read-only, live-armed, config version, last heartbeat, last quote/candle/
// trade-tx, command-whitelist, advisory safety-lock) plus per-stream transport
// integrity (last sequence, gaps/missed/duplicates) and a recent ingest trace.
//
// SAFETY:
// - Wrapped in AdminDiagnosticsGate (also blocks admin-previewing-as-user). The
//   server independently requires an ADMIN/OWNER session.
// - READ-ONLY observability. Nothing here dispatches, arms, or mutates a trade.
//   The safety-lock reason is advisory, NOT a gate.
// - Empty in steady state — the production bridge is v1.50 (not a v2 sensor), so
//   "No Bridge v2 telemetry yet" is the honest expected state here.
import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AdminDiagnosticsGate } from "@/components/admin/AdminDiagnosticsGate";
import type { BridgeV2AdminStatus } from "@workspace/api-client-react";
import {
  RefreshCw, CheckCircle2, XCircle, HelpCircle, Wifi, WifiOff, Lock, Activity,
} from "lucide-react";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
async function apiJson<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { credentials: "include" });
  return (await r.json()) as T;
}

type StatusResp = { ok: boolean; count: number; bridges: BridgeV2AdminStatus[] };
type StreamRow = {
  id: number; userId: number; bridgeConnectionId: number | null;
  messageType: string; streamKey: string; lastSequence: number | null;
  lastEventAt: string | null; totalAccepted: number; totalDuplicates: number;
  totalGaps: number; totalMissed: number; totalRejected: number; totalResets: number;
};
type StreamsResp = { ok: boolean; count: number; streams: StreamRow[] };
type TraceEvent = {
  id: number; userId: number; messageType: string; streamKey: string;
  sequence: number; sequenceVerdict: string; accepted: boolean;
  rejectReason: string | null; freshnessVerdict: string | null;
  transportLatencyMs: number | null; createdAt: string | null;
};
type TraceResp = {
  ok: boolean;
  summary: { total: number; accepted: number; duplicates: number; gaps: number; rejected: number };
  events: TraceEvent[];
};

function Tri({ v }: { v: boolean | null | undefined }) {
  if (v === null || v === undefined)
    return <span className="inline-flex items-center gap-1 text-txt-muted"><HelpCircle className="w-3.5 h-3.5" /> unknown</span>;
  return v
    ? <span className="inline-flex items-center gap-1 text-success"><CheckCircle2 className="w-3.5 h-3.5" /> yes</span>
    : <span className="inline-flex items-center gap-1 text-txt-secondary"><XCircle className="w-3.5 h-3.5" /> no</span>;
}

function freshnessBadge(f: BridgeV2AdminStatus["freshness"]) {
  const map: Record<string, string> = {
    LIVE: "border-success/40 text-success",
    STALE: "border-warning/40 text-warning",
    OFFLINE: "border-danger/40 text-danger",
    UNKNOWN: "border-border text-txt-secondary",
  };
  return <Badge variant="outline" className={map[f] ?? ""}>{f}</Badge>;
}

function ts(s: string | null | undefined): string {
  return s ? new Date(s).toLocaleString() : "—";
}

function BridgeV2MonitorInner() {
  const [status, setStatus] = useState<StatusResp | null>(null);
  const [streams, setStreams] = useState<StreamsResp | null>(null);
  const [trace, setTrace] = useState<TraceResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      setLoading(true);
      const [s, st, tr] = await Promise.all([
        apiJson<StatusResp>("/api/admin/bridge-v2/status"),
        apiJson<StreamsResp>("/api/admin/bridge-v2/streams"),
        apiJson<TraceResp>("/api/admin/bridge-v2/trace?limit=50"),
      ]);
      if (!s.ok) throw new Error("Failed to load Bridge v2 status");
      setStatus(s);
      setStreams(st.ok ? st : null);
      setTrace(tr.ok ? tr : null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load Bridge v2 monitor");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 10000);
    return () => clearInterval(id);
  }, []);

  const hasData = (status?.bridges.length ?? 0) > 0 || (streams?.streams.length ?? 0) > 0;

  return (
    <div className="max-w-7xl mx-auto p-4 space-y-4" data-testid="admin-bridge-v2-monitor">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Activity className="w-5 h-5 text-success" /> Bridge v2 Monitor
          </h1>
          <p className="text-sm text-txt-secondary">
            Operator-only view of Bridge v2 broker-truth telemetry. Read-only — does not arm,
            dispatch, or change any execution state. Empty until a v2 EA is connected.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} data-testid="bridge-v2-refresh">
          <RefreshCw className="w-3.5 h-3.5 mr-1" /> Refresh
        </Button>
      </div>

      {trace && (
        <div className="flex gap-2 flex-wrap text-sm">
          <Badge variant="outline">Bridges: {status?.count ?? 0}</Badge>
          <Badge variant="outline">Trace window: {trace.summary.total}</Badge>
          <Badge variant="outline" className="border-success/40 text-success">Accepted: {trace.summary.accepted}</Badge>
          <Badge variant="outline" className="border-warning/40 text-warning">Duplicates: {trace.summary.duplicates}</Badge>
          <Badge variant="outline" className="border-warning/40 text-warning">Gaps: {trace.summary.gaps}</Badge>
          <Badge variant="outline" className="border-danger/40 text-danger">Rejected: {trace.summary.rejected}</Badge>
        </div>
      )}

      {loading && !status && <Card><CardContent className="p-6 text-sm text-txt-secondary">Loading Bridge v2 telemetry…</CardContent></Card>}
      {error && <Card><CardContent className="p-6 text-sm text-danger">{error}</CardContent></Card>}
      {status && !hasData && !loading && (
        <Card><CardContent className="p-6 text-sm text-txt-secondary" data-testid="bridge-v2-empty">
          No Bridge v2 telemetry yet. The production bridge runs v1.50 (snapshot/poll), which is not a
          v2 event sensor — this monitor populates once a v2 EA starts pushing broker-truth events.
        </CardContent></Card>
      )}

      {status?.bridges.map((b) => (
        <Card key={`${b.userId}-${b.bridgeConnectionId ?? "null"}`} data-testid={`bridge-v2-row-${b.userId}`}>
          <CardHeader>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  {b.connected ? <Wifi className="w-4 h-4 text-success" /> : <WifiOff className="w-4 h-4 text-txt-secondary" />}
                  Bridge user #{b.userId}
                  <span className="text-xs text-txt-muted">conn {b.bridgeConnectionId ?? "—"}</span>
                </CardTitle>
                <CardDescription>
                  EA v{b.eaVersion ?? "?"} · {(b.accountType ?? "unknown").toUpperCase()} · last heartbeat {ts(b.lastHeartbeatAt)}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {freshnessBadge(b.freshness)}
                <Badge variant="outline" className={b.accountType === "live" || b.accountType === "real" ? "border-danger/40 text-danger" : ""}>
                  {(b.accountType ?? "unknown").toUpperCase()}
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {b.safetyLockReason && (
              <div className="rounded-md border border-warning/40 bg-warning/5 p-2 text-xs text-warning inline-flex items-center gap-1" data-testid={`bridge-v2-lock-${b.userId}`}>
                <Lock className="w-3.5 h-3.5" /> {b.safetyLockReason} (advisory — not an execution gate)
              </div>
            )}

            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <div className="text-xs uppercase tracking-wider text-txt-secondary">Readiness</div>
                <div className="flex justify-between"><span className="text-txt-secondary">Heartbeat age</span><span className={(b.heartbeatAgeSeconds ?? 999) > 15 ? "text-warning" : ""}>{b.heartbeatAgeSeconds == null ? "—" : `${b.heartbeatAgeSeconds}s`}</span></div>
                <div className="flex justify-between"><span className="text-txt-secondary">Terminal connected</span><Tri v={b.terminalConnected} /></div>
                <div className="flex justify-between"><span className="text-txt-secondary">AlgoTrading allowed</span><Tri v={b.algoTradingAllowed} /></div>
                <div className="flex justify-between"><span className="text-txt-secondary">EnableLiveExecution</span><Tri v={b.enableLiveExecution} /></div>
                <div className="flex justify-between"><span className="text-txt-secondary">ReadOnlyMode</span><Tri v={b.readOnlyMode} /></div>
              </div>

              <div className="space-y-1.5">
                <div className="text-xs uppercase tracking-wider text-txt-secondary">Remote config & channel</div>
                <div className="flex justify-between"><span className="text-txt-secondary">Config version</span><span>{b.configVersion ?? "—"}</span></div>
                <div className="flex justify-between"><span className="text-txt-secondary">Last acked version</span><span>{b.lastAckedConfigVersion ?? "—"}</span></div>
                <div className="flex justify-between"><span className="text-txt-secondary">Execution served</span><Tri v={b.executionAllowedServed} /></div>
                <div className="flex justify-between"><span className="text-txt-secondary">Pending commands</span><span>{b.pendingCommandCount}</span></div>
                <div className="flex justify-between"><span className="text-txt-secondary">Open positions</span><span>{b.openPositionsCount ?? "—"}</span></div>
              </div>

              <div className="space-y-1.5">
                <div className="text-xs uppercase tracking-wider text-txt-secondary">Feed truth</div>
                <div className="flex justify-between"><span className="text-txt-secondary">Last quote</span><span>{ts(b.lastQuoteAt)}</span></div>
                <div className="flex justify-between"><span className="text-txt-secondary">Last candle</span><span>{ts(b.lastCandleAt)}</span></div>
                <div className="flex justify-between"><span className="text-txt-secondary">Last trade tx</span><span>{ts(b.lastTradeTransactionAt)}</span></div>
                <div className="flex justify-between"><span className="text-txt-secondary">Last account snap</span><span>{ts(b.lastAccountSnapshotAt)}</span></div>
                <div className="flex justify-between"><span className="text-txt-secondary">Account equity</span><span>{b.accountEquity == null ? "—" : `${b.accountEquity} ${b.accountCurrency ?? ""}`}</span></div>
              </div>
            </div>

            <div className="grid sm:grid-cols-3 lg:grid-cols-6 gap-2 text-xs">
              <div className="rounded-md border border-border p-2"><div className="text-txt-secondary">Last seq</div><div className="text-base">{b.lastSequence ?? "—"}</div></div>
              <div className="rounded-md border border-border p-2"><div className="text-txt-secondary">Accepted</div><div className="text-base">{b.totalAccepted}</div></div>
              <div className="rounded-md border border-border p-2"><div className="text-txt-secondary">Duplicates</div><div className="text-base">{b.totalDuplicates}</div></div>
              <div className="rounded-md border border-border p-2"><div className="text-txt-secondary">Gaps</div><div className={`text-base ${b.totalGaps > 0 ? "text-warning" : ""}`}>{b.totalGaps}</div></div>
              <div className="rounded-md border border-border p-2"><div className="text-txt-secondary">Missed</div><div className={`text-base ${b.totalMissed > 0 ? "text-warning" : ""}`}>{b.totalMissed}</div></div>
              <div className="rounded-md border border-border p-2"><div className="text-txt-secondary">Rejected</div><div className={`text-base ${b.totalRejected > 0 ? "text-danger" : ""}`}>{b.totalRejected}</div></div>
            </div>
          </CardContent>
        </Card>
      ))}

      {streams && streams.streams.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Per-stream integrity</CardTitle></CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-txt-secondary border-b border-border">
                <tr><th className="text-left p-2">User</th><th className="text-left p-2">Type</th><th className="text-left p-2">Stream</th><th className="text-right p-2">Last seq</th><th className="text-right p-2">Gaps</th><th className="text-right p-2">Missed</th><th className="text-right p-2">Dupes</th><th className="text-left p-2">Last event</th></tr>
              </thead>
              <tbody>
                {streams.streams.map((s) => (
                  <tr key={s.id} className="border-b border-border/50">
                    <td className="p-2">#{s.userId}</td>
                    <td className="p-2">{s.messageType}</td>
                    <td className="p-2 text-txt-muted">{s.streamKey}</td>
                    <td className="p-2 text-right">{s.lastSequence ?? "—"}</td>
                    <td className={`p-2 text-right ${s.totalGaps > 0 ? "text-warning" : ""}`}>{s.totalGaps}</td>
                    <td className={`p-2 text-right ${s.totalMissed > 0 ? "text-warning" : ""}`}>{s.totalMissed}</td>
                    <td className="p-2 text-right">{s.totalDuplicates}</td>
                    <td className="p-2 text-txt-muted">{ts(s.lastEventAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {trace && trace.events.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Recent ingest trace</CardTitle></CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-txt-secondary border-b border-border">
                <tr><th className="text-left p-2">User</th><th className="text-left p-2">Type</th><th className="text-right p-2">Seq</th><th className="text-left p-2">Verdict</th><th className="text-left p-2">Accepted</th><th className="text-right p-2">Latency</th><th className="text-left p-2">When</th></tr>
              </thead>
              <tbody>
                {trace.events.map((e) => (
                  <tr key={e.id} className="border-b border-border/50">
                    <td className="p-2">#{e.userId}</td>
                    <td className="p-2">{e.messageType}</td>
                    <td className="p-2 text-right">{e.sequence}</td>
                    <td className={`p-2 ${e.sequenceVerdict === "GAP" ? "text-warning" : ""}`}>{e.sequenceVerdict}</td>
                    <td className="p-2">{e.accepted ? <span className="text-success">yes</span> : <span className="text-danger">{e.rejectReason ?? "no"}</span>}</td>
                    <td className="p-2 text-right">{e.transportLatencyMs == null ? "—" : `${e.transportLatencyMs}ms`}</td>
                    <td className="p-2 text-txt-muted">{ts(e.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function AdminBridgeV2MonitorPage() {
  return (
    <AdminDiagnosticsGate pageTitle="Bridge v2 Monitor" pageDescription="Bridge v2 Monitor">
      <BridgeV2MonitorInner />
    </AdminDiagnosticsGate>
  );
}
