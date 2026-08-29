import { useEffect, useState, useCallback } from "react";
import { AlertTriangle, ShieldAlert, ShieldCheck, ShieldOff, RefreshCw } from "lucide-react";
import { SharedMasterUnattributedPanel } from "@/components/sharedMaster/SharedMasterUnattributedPanel";
import { GovernancePanel } from "@/components/admin/GovernancePanel";

type Settings = {
  id: number;
  platformMode: "OFF" | "SIMULATED" | "DEMO" | "LIVE";
  emergencyKillSwitch: boolean;
  killSwitchEngagedAt: string | null;
  killSwitchReason: string | null;
  updatedAt: string;
  accountRoutingMode?: "USER_OWNED_MT5" | "SHARED_MASTER_MT5";
  sharedDemoConnectionId?: number | null;
  sharedLiveConnectionId?: number | null;
  sharedLiveTradingEnabled?: boolean;
  sharedMasterNettingMode?: boolean;
};

type SharedMasterCandidate = {
  connectionId: number; ownerUserId: number;
  connectionName: string | null; brokerName: string | null;
  accountType: string; accountNumberMasked: string | null;
  status: string | null; lastHeartbeat: string | null;
};
type SharedMasterRegistered = {
  id: number; connectionId: number; accountType: string;
  brokerName: string | null; accountNumberMasked: string | null;
  status: string; isActive: boolean;
};
type SharedMastersResp = {
  ok: boolean;
  activeDemoConnectionId: number | null;
  activeLiveConnectionId: number | null;
  sharedLiveTradingEnabled: boolean;
  candidates: SharedMasterCandidate[];
  registered: SharedMasterRegistered[];
};
type VirtualAccountRow = {
  id: number; userId: number; routingMode: string;
  sharedMasterAccountId: number | null; accountType: string;
  virtualBalance: number; virtualEquity: number; virtualPnl: number;
  status: string;
};

type UserRow = {
  id: number;
  email: string;
  name: string | null;
  role: string;
  permissions: null | {
    tradingMode: "DISABLED" | "SIMULATED" | "DEMO" | "LIVE";
    demoEnabled: boolean;
    liveApproved: boolean;
    liveEnabled: boolean;
    suspended: boolean;
    suspensionReason: string | null;
    accountRoutingOverride?: string;
  };
};

type AuditEvent = {
  id: number;
  userId?: number | null;
  adminId?: number | null;
  adminRole?: string;
  action?: string;
  symbol?: string;
  side?: string;
  status?: string;
  rejectionReason?: string | null;
  mode?: string;
  createdAt: string;
};

type ExecutionHealthRow = {
  id: number; userId: number; actionType: string; status: string;
  symbol: string | null; requestedMode: string;
  mt5OrderTicket: string | null; mt5PositionTicket: string | null;
  fillPrice: number | null; slippage: number | null; filledLotSize: number | null;
  brokerMessage: string | null; errorCode: string | null;
  rejectionReason: string | null; executedAt: string | null; createdAt: string;
};
type ExecutionHealthResp = {
  ok: boolean;
  recent: ExecutionHealthRow[];
  metrics: { sampleSize: number; executed: number; rejected: number; failed: number; stuck: number; rejectionRate: number };
};

const ADMIN_HEADERS: HeadersInit = { "x-security-role": "ADMIN", "Content-Type": "application/json" };

async function api<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const r = await fetch(path, { credentials: "include", ...init, headers: { ...ADMIN_HEADERS, ...(init?.headers ?? {}) } });
    if (!r.ok) return null;
    return await r.json() as T;
  } catch { return null; }
}

export default function AdminTradingControlPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [trades, setTrades] = useState<AuditEvent[]>([]);
  const [admins, setAdmins] = useState<AuditEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shared, setShared] = useState<SharedMastersResp | null>(null);
  const [virtuals, setVirtuals] = useState<VirtualAccountRow[]>([]);
  const [attribution, setAttribution] = useState<AuditEvent[]>([]);
  const [executionHealth, setExecutionHealth] = useState<ExecutionHealthResp | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    const [s, u, t, a, sm, va, at, eh] = await Promise.all([
      api<{ ok: boolean; settings: Settings }>("/api/admin/trading/settings"),
      api<{ ok: boolean; users: UserRow[] }>("/api/admin/users"),
      api<{ ok: boolean; events: AuditEvent[] }>("/api/admin/audit/trades?limit=50"),
      api<{ ok: boolean; events: AuditEvent[] }>("/api/admin/audit/admin-actions?limit=50"),
      api<SharedMastersResp>("/api/admin/shared-masters"),
      api<{ ok: boolean; accounts: VirtualAccountRow[] }>("/api/admin/virtual-accounts"),
      api<{ ok: boolean; events: AuditEvent[] }>("/api/admin/audit/attribution?limit=50"),
      api<ExecutionHealthResp>("/api/admin/trading/execution-health"),
    ]);
    if (s?.settings) setSettings(s.settings);
    if (u?.users) setUsers(u.users);
    if (t?.events) setTrades(t.events);
    if (a?.events) setAdmins(a.events);
    if (sm) setShared(sm);
    if (va?.accounts) setVirtuals(va.accounts);
    if (at?.events) setAttribution(at.events);
    if (eh?.ok) setExecutionHealth(eh);
    if (!s) setError("Unable to load settings — admin role required.");
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  async function setMode(next: Settings["platformMode"]) {
    const reason = window.prompt(`Reason for switching platform mode to ${next}?`, "");
    if (!reason || reason.trim().length < 4) return;
    setBusy(true);
    await api("/api/admin/trading/mode", { method: "POST", body: JSON.stringify({ platformMode: next, reason }) });
    await reload(); setBusy(false);
  }

  async function killSwitch(engage: boolean) {
    const reason = window.prompt(engage ? "Reason for engaging emergency kill switch?" : "Reason for releasing emergency kill switch?", "");
    if (!reason || reason.trim().length < 4) return;
    setBusy(true);
    await api(engage ? "/api/admin/trading/emergency-kill" : "/api/admin/trading/reset-kill",
      { method: "POST", body: JSON.stringify({ reason }) });
    await reload(); setBusy(false);
  }

  async function setUserPermission(userId: number, patch: Record<string, unknown>) {
    const reason = window.prompt("Reason for change?", "");
    if (!reason || reason.trim().length < 4) return;
    setBusy(true);
    await api(`/api/admin/users/${userId}/permissions`, { method: "POST", body: JSON.stringify({ ...patch, reason }) });
    await reload(); setBusy(false);
  }

  async function setRoutingMode(next: "USER_OWNED_MT5" | "SHARED_MASTER_MT5") {
    const reason = window.prompt(`Reason for switching account routing to ${next}? Affects NEW orders only.`, "");
    if (!reason || reason.trim().length < 4) return;
    setBusy(true);
    await api("/api/admin/trading/routing-mode", { method: "POST", body: JSON.stringify({ accountRoutingMode: next, reason }) });
    await reload(); setBusy(false);
  }
  async function setSharedMaster(connectionId: number, accountType: "demo" | "live", isActive: boolean) {
    const reason = window.prompt(`Reason for ${isActive ? "selecting" : "unselecting"} this connection as the shared ${accountType} master?`, "");
    if (!reason || reason.trim().length < 4) return;
    setBusy(true);
    await api("/api/admin/trading/shared-master", {
      method: "POST",
      body: JSON.stringify({ connectionId, accountType, isActive, reason }),
    });
    await reload(); setBusy(false);
  }
  async function toggleSharedLive(enabled: boolean) {
    const reason = window.prompt(
      enabled ? "Reason for ENABLING shared LIVE trading (real money, separate from setting a master)?"
              : "Reason for DISABLING shared LIVE trading?", "");
    if (!reason || reason.trim().length < 4) return;
    setBusy(true);
    await api("/api/admin/trading/shared-live-enabled", {
      method: "POST",
      body: JSON.stringify({ enabled, reason }),
    });
    await reload(); setBusy(false);
  }
  async function setUserRoutingOverride(userId: number, value: "inherit" | "USER_OWNED_MT5" | "SHARED_MASTER_MT5") {
    const reason = window.prompt(`Reason for setting routing override to ${value}?`, "");
    if (!reason || reason.trim().length < 4) return;
    setBusy(true);
    await api(`/api/admin/users/${userId}/routing-override`, {
      method: "POST",
      body: JSON.stringify({ accountRoutingOverride: value, reason }),
    });
    await reload(); setBusy(false);
  }

  const demoCount = users.filter((u) => u.permissions?.tradingMode === "DEMO").length;
  const liveCount = users.filter((u) => u.permissions?.tradingMode === "LIVE").length;
  const suspendedCount = users.filter((u) => u.permissions?.suspended).length;

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-5 pb-32 md:pb-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Admin Trading Control</h1>
          <p className="text-sm text-txt-secondary">Phase 3 master switch. Changes here take effect within 15 seconds for every user.</p>
        </div>
        <button onClick={reload} disabled={busy} className="inline-flex items-center gap-2 px-3 py-1.5 rounded border border-border hover:bg-secondary text-sm">
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {error ? <div className="rounded border border-danger/40 bg-danger/10 text-danger p-3 text-sm">{error}</div> : null}

      {/* T019 — Admin Risk/Governance (owner/admin app-added restrictions) */}
      <section className="rounded-lg border border-border bg-background p-4">
        <h2 className="text-lg font-semibold mb-3">Risk &amp; Governance</h2>
        <p className="text-sm text-txt-secondary mb-3">
          App-added trading restrictions for this owner/admin account. Default OFF.
          Permanent technical, security, and broker-truth checks always apply.
        </p>
        <GovernancePanel />
      </section>

      {/* Mode + emergency stop */}
      <section className="rounded-lg border border-border bg-background p-4">
        <h2 className="text-lg font-semibold mb-3">Platform mode</h2>
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-sm">Current:&nbsp;
            <span className={`font-bold ${settings?.platformMode === "LIVE" ? "text-danger" :
              settings?.platformMode === "DEMO" ? "text-success" :
              settings?.platformMode === "SIMULATED" ? "text-primary" : "text-txt-secondary"}`}>
              {settings?.platformMode ?? "—"}
            </span>
          </div>
          {(["OFF", "SIMULATED", "DEMO", "LIVE"] as const).map((m) => (
            <button key={m} disabled={busy || settings?.platformMode === m}
              onClick={() => setMode(m)}
              className={`px-3 py-1.5 rounded text-sm border ${
                m === "LIVE" ? "border-danger/40 hover:bg-danger/10" :
                m === "DEMO" ? "border-success/40 hover:bg-success/10" :
                m === "SIMULATED" ? "border-primary/40 hover:bg-primary/10" :
                "border-border hover:bg-secondary/80"} disabled:opacity-50`}>
              {m === "OFF" ? "Trading Off" :
               m === "SIMULATED" ? "Simulator" :
               m === "DEMO" ? "Demo Trading" : "Live Trading"}
            </button>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div className="text-sm flex items-center gap-2">
            <ShieldAlert className="w-4 h-4" />
            Emergency stop:
            <span className={`font-bold ${settings?.emergencyKillSwitch ? "text-danger" : "text-success"}`}>
              {settings?.emergencyKillSwitch ? "ENGAGED" : "Released"}
            </span>
            {settings?.killSwitchReason ? <span className="text-txt-secondary italic">— {settings.killSwitchReason}</span> : null}
          </div>
          <button disabled={busy} onClick={() => killSwitch(true)}
            className="px-3 py-1.5 rounded text-sm border border-danger/50 bg-danger/10 text-danger hover:bg-danger/20 disabled:opacity-50">
            Engage emergency stop
          </button>
          <button disabled={busy || !settings?.emergencyKillSwitch} onClick={() => killSwitch(false)}
            className="px-3 py-1.5 rounded text-sm border border-success/40 hover:bg-success/10 disabled:opacity-50">
            Release emergency stop
          </button>
        </div>
      </section>

      {/* Phase 3.5 — Account routing */}
      <section className="rounded-lg border border-border bg-background p-4">
        <h2 className="text-lg font-semibold mb-3">Account routing</h2>
        <p className="text-xs text-txt-secondary mb-3">
          USER_OWNED_MT5 — every user trades through their own broker connection.
          SHARED_MASTER_MT5 — all eligible users route through one admin-controlled
          master account (ARX keeps virtual per-user ledgers). Switching affects
          NEW orders only; live shared trading additionally requires the explicit
          owner flag below.
        </p>
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="text-sm">Current:&nbsp;
            <span className={`font-bold ${settings?.accountRoutingMode === "SHARED_MASTER_MT5" ? "text-warning" : "text-success"}`}>
              {settings?.accountRoutingMode ?? "USER_OWNED_MT5"}
            </span>
          </div>
          {(["USER_OWNED_MT5", "SHARED_MASTER_MT5"] as const).map((m) => (
            <button key={m} disabled={busy || settings?.accountRoutingMode === m}
              onClick={() => setRoutingMode(m)}
              className={`px-3 py-1.5 rounded text-sm border ${
                m === "SHARED_MASTER_MT5" ? "border-warning/40 hover:bg-warning/10" :
                "border-success/40 hover:bg-success/10"} disabled:opacity-50`}>
              {m}
            </button>
          ))}
          <div className="ml-4 text-sm flex items-center gap-2">
            <ShieldAlert className="w-4 h-4" />
            Shared LIVE trading:
            <span className={`font-bold ${settings?.sharedLiveTradingEnabled ? "text-danger" : "text-txt-secondary"}`}>
              {settings?.sharedLiveTradingEnabled ? "ENABLED (OWNER)" : "Disabled"}
            </span>
            <button disabled={busy || !settings?.sharedLiveConnectionId}
              onClick={() => toggleSharedLive(!settings?.sharedLiveTradingEnabled)}
              className="px-2 py-0.5 rounded text-xs border border-danger/40 hover:bg-danger/10 disabled:opacity-30">
              {settings?.sharedLiveTradingEnabled ? "Disable" : "Enable"}
            </button>
          </div>
        </div>

        <div className="text-sm font-semibold mb-2">Master account candidates (admin/owner MT5 connections)</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-txt-secondary">
              <tr>
                <th className="py-1 pr-3">Conn</th><th className="py-1 pr-3">Owner</th>
                <th className="py-1 pr-3">Broker</th><th className="py-1 pr-3">Account</th>
                <th className="py-1 pr-3">Type</th><th className="py-1 pr-3">Status</th>
                <th className="py-1 pr-3">Active for</th>
                <th className="py-1 pr-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(shared?.candidates ?? []).length === 0 ? (
                <tr><td colSpan={8} className="py-2 text-txt-muted">No admin/owner MT5 connections registered.</td></tr>
              ) : null}
              {(shared?.candidates ?? []).map((c) => {
                const isActiveDemo = shared?.activeDemoConnectionId === c.connectionId;
                const isActiveLive = shared?.activeLiveConnectionId === c.connectionId;
                return (
                  <tr key={c.connectionId} className="border-t border-border">
                    <td className="py-1 pr-3">#{c.connectionId}</td>
                    <td className="py-1 pr-3">user#{c.ownerUserId}</td>
                    <td className="py-1 pr-3">{c.brokerName ?? "—"}</td>
                    <td className="py-1 pr-3">{c.accountNumberMasked ?? "—"}</td>
                    <td className="py-1 pr-3">{c.accountType}</td>
                    <td className="py-1 pr-3">{c.status ?? "—"}</td>
                    <td className="py-1 pr-3 space-x-1">
                      {isActiveDemo ? <span className="text-success">DEMO</span> : null}
                      {isActiveLive ? <span className="text-danger">LIVE</span> : null}
                      {!isActiveDemo && !isActiveLive ? <span className="text-txt-muted">—</span> : null}
                    </td>
                    <td className="py-1 pr-3 space-x-1">
                      {String(c.accountType).toLowerCase() === "demo" ? (
                        <button disabled={busy} onClick={() => setSharedMaster(c.connectionId, "demo", !isActiveDemo)}
                          className="px-2 py-0.5 rounded border border-success/40 hover:bg-success/10">
                          {isActiveDemo ? "Unset demo" : "Set as demo master"}
                        </button>
                      ) : null}
                      {["live", "real"].includes(String(c.accountType).toLowerCase()) ? (
                        <button disabled={busy} onClick={() => setSharedMaster(c.connectionId, "live", !isActiveLive)}
                          className="px-2 py-0.5 rounded border border-danger/40 hover:bg-danger/10">
                          {isActiveLive ? "Unset live" : "Set as live master"}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Counts */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Total users" value={users.length} icon={<ShieldCheck className="w-4 h-4" />} />
        <Stat label="Demo enabled" value={demoCount} icon={<ShieldCheck className="w-4 h-4 text-success" />} />
        <Stat label="Live approved" value={liveCount} icon={<ShieldAlert className="w-4 h-4 text-danger" />} />
        <Stat label="Suspended" value={suspendedCount} icon={<ShieldOff className="w-4 h-4 text-warning" />} />
      </section>

      {/* User table */}
      <section className="rounded-lg border border-border bg-background p-4">
        <h2 className="text-lg font-semibold mb-3">Users</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-txt-secondary">
              <tr><th className="py-2 pr-3">ID</th><th className="py-2 pr-3">Email</th>
                <th className="py-2 pr-3">Mode</th><th className="py-2 pr-3">Demo</th>
                <th className="py-2 pr-3">Live approved</th><th className="py-2 pr-3">Suspended</th>
                <th className="py-2 pr-3">Routing</th>
                <th className="py-2 pr-3">Actions</th></tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const p = u.permissions;
                return (
                  <tr key={u.id} className="border-t border-border">
                    <td className="py-2 pr-3">{u.id}</td>
                    <td className="py-2 pr-3">{u.email}</td>
                    <td className="py-2 pr-3">{p?.tradingMode ?? "DISABLED"}</td>
                    <td className="py-2 pr-3">{p?.demoEnabled ? "✓" : "—"}</td>
                    <td className="py-2 pr-3">{p?.liveApproved ? "✓" : "—"}</td>
                    <td className="py-2 pr-3">{p?.suspended ? "Yes" : "No"}</td>
                    <td className="py-2 pr-3">
                      <select
                        value={String(p?.accountRoutingOverride ?? "inherit")}
                        onChange={(e) => setUserRoutingOverride(u.id,
                          e.target.value as "inherit" | "USER_OWNED_MT5" | "SHARED_MASTER_MT5")}
                        disabled={busy}
                        className="bg-card border border-border rounded px-1 py-0.5 text-xs">
                        <option value="inherit">inherit</option>
                        <option value="USER_OWNED_MT5">USER_OWNED_MT5</option>
                        <option value="SHARED_MASTER_MT5">SHARED_MASTER_MT5</option>
                      </select>
                    </td>
                    <td className="py-2 pr-3 space-x-1">
                      <button onClick={() => setUserPermission(u.id, { tradingMode: "DEMO", demoEnabled: true, suspended: false })}
                        className="px-2 py-0.5 rounded border border-success/40 hover:bg-success/10 text-xs">Enable demo</button>
                      <button onClick={() => setUserPermission(u.id, { tradingMode: "LIVE", liveEnabled: true, liveApproved: true, suspended: false })}
                        className="px-2 py-0.5 rounded border border-danger/40 hover:bg-danger/10 text-xs">Approve live</button>
                      <button onClick={() => setUserPermission(u.id, { suspended: true })}
                        className="px-2 py-0.5 rounded border border-warning/40 hover:bg-warning/10 text-xs">Suspend</button>
                      <button onClick={() => setUserPermission(u.id, { suspended: false })}
                        className="px-2 py-0.5 rounded border border-border hover:bg-secondary/80 text-xs">Reinstate</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Virtual accounts (Phase 3.5) */}
      <section className="rounded-lg border border-border bg-background p-4">
        <h2 className="text-lg font-semibold mb-2">Virtual trading accounts (shared-master ledger)</h2>
        <p className="text-xs text-txt-secondary mb-2">
          One row per user × master × demo/live. Real broker P&amp;L is attributed
          back into these rows; the master credentials are never exposed.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-txt-secondary">
              <tr><th className="py-1 pr-3">ID</th><th className="py-1 pr-3">User</th>
                <th className="py-1 pr-3">Routing</th><th className="py-1 pr-3">Master</th>
                <th className="py-1 pr-3">Type</th><th className="py-1 pr-3">Balance</th>
                <th className="py-1 pr-3">Equity</th><th className="py-1 pr-3">P&amp;L</th>
                <th className="py-1 pr-3">Status</th></tr>
            </thead>
            <tbody>
              {virtuals.length === 0 ? (
                <tr><td colSpan={9} className="py-2 text-txt-muted">No virtual accounts yet.</td></tr>
              ) : null}
              {virtuals.map((v) => (
                <tr key={v.id} className="border-t border-border">
                  <td className="py-1 pr-3">#{v.id}</td>
                  <td className="py-1 pr-3">user#{v.userId}</td>
                  <td className="py-1 pr-3">{v.routingMode}</td>
                  <td className="py-1 pr-3">{v.sharedMasterAccountId ?? "—"}</td>
                  <td className="py-1 pr-3">{v.accountType}</td>
                  <td className="py-1 pr-3">{Number(v.virtualBalance ?? 0).toFixed(2)}</td>
                  <td className="py-1 pr-3">{Number(v.virtualEquity ?? 0).toFixed(2)}</td>
                  <td className="py-1 pr-3">{Number(v.virtualPnl ?? 0).toFixed(2)}</td>
                  <td className="py-1 pr-3">{v.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Phase UX9 — Execution health */}
      <section className="rounded-lg border border-border bg-background p-4" data-testid="card-execution-health">
        <h2 className="text-lg font-semibold mb-3">Execution Health</h2>
        {!executionHealth ? (
          <div className="text-xs text-txt-muted">No execution data yet.</div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-3">
              <Stat label="Sample size" value={executionHealth.metrics.sampleSize} icon={<ShieldCheck className="w-3 h-3" />} />
              <Stat label="Executed" value={executionHealth.metrics.executed} icon={<ShieldCheck className="w-3 h-3" />} />
              <Stat label="Rejected" value={executionHealth.metrics.rejected} icon={<ShieldAlert className="w-3 h-3" />} />
              <Stat label="Failed" value={executionHealth.metrics.failed} icon={<ShieldOff className="w-3 h-3" />} />
              <Stat label="Stuck" value={executionHealth.metrics.stuck} icon={<AlertTriangle className="w-3 h-3" />} />
            </div>
            <div className="text-xs mb-2" data-testid="text-rejection-rate">
              Rejection rate: <span className={executionHealth.metrics.rejectionRate > 0.2 ? "text-danger font-bold" : "text-txt-secondary"}>
                {(executionHealth.metrics.rejectionRate * 100).toFixed(1)}%
              </span>
            </div>
            <div className="max-h-80 overflow-y-auto text-xs font-mono space-y-1">
              {executionHealth.recent.length === 0 ? <div className="text-txt-muted">No results.</div> :
                executionHealth.recent.map((r) => (
                  <div key={r.id} className="border-b border-border/50 py-1" data-testid={`row-exec-${r.id}`}>
                    <span className="text-txt-muted">{new Date(r.createdAt).toLocaleString()}</span>{" — "}
                    <span>#{r.id} u#{r.userId} {r.symbol ?? "—"} {r.actionType} {r.requestedMode}</span>
                    {" → "}<span className={r.status === "executed" ? "text-success" : (r.status === "rejected" || r.status === "failed") ? "text-danger" : "text-txt-secondary"}>{r.status}</span>
                    {r.mt5PositionTicket && <span className="text-txt-muted"> ticket={r.mt5PositionTicket}</span>}
                    {r.fillPrice != null && <span className="text-txt-muted"> fill={r.fillPrice}</span>}
                    {r.slippage != null && <span className="text-txt-muted"> slip={r.slippage}</span>}
                    {r.errorCode && <span className="text-danger"> [{r.errorCode}]</span>}
                    {r.rejectionReason && <span className="text-danger"> {r.rejectionReason}</span>}
                  </div>
                ))}
            </div>
          </>
        )}
      </section>

      {/* Shared Master — Unattributed queue (P0-3 review surface) */}
      <SharedMasterUnattributedPanel />

      {/* Audit logs */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <AuditPanel title="Trade command audit" rows={trades} fmt={(e) =>
          `${e.symbol ?? "—"} ${e.side ?? ""} ${e.mode ?? ""} → ${e.status}${e.rejectionReason ? ` (${e.rejectionReason})` : ""}`} />
        <AuditPanel title="Admin action audit" rows={admins} fmt={(e) =>
          `${e.adminRole ?? ""} ${e.action ?? "?"}${e.userId ? ` user#${e.userId}` : ""}`} />
        <AuditPanel title="Shared trade attribution" rows={attribution} fmt={(e) => {
          const r = e as unknown as { symbol?: string; side?: string; userId?: number; status?: string; mt5PositionTicket?: string | null };
          return `${r.symbol ?? "—"} ${r.side ?? ""} user#${r.userId ?? "?"} → ${r.status ?? "?"}${r.mt5PositionTicket ? ` ticket=${r.mt5PositionTicket}` : ""}`;
        }} />
      </section>
    </div>
  );
}

function Stat({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="flex items-center gap-2 text-xs text-txt-secondary">{icon}{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  );
}

function AuditPanel({ title, rows, fmt }: { title: string; rows: AuditEvent[]; fmt: (e: AuditEvent) => string }) {
  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <h2 className="text-lg font-semibold mb-2 flex items-center gap-2"><AlertTriangle className="w-4 h-4" />{title}</h2>
      <div className="max-h-80 overflow-y-auto text-xs font-mono space-y-1">
        {rows.length === 0 ? <div className="text-txt-muted">No events.</div> :
          rows.map((e) => (
            <div key={e.id} className="border-b border-border/50 py-1">
              <span className="text-txt-muted">{new Date(e.createdAt).toLocaleString()}</span>
              {" — "}{fmt(e)}
            </div>
          ))}
      </div>
    </div>
  );
}
