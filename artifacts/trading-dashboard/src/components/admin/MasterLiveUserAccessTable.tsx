// Admin — Master Live User Access table
//
// Renders /api/admin/master-live/users with per-row Approve / Disable /
// Suspend / Risk-lock buttons (each requires a reason). Per-user toggle
// is server-rejected unless status=APPROVED, so the toggle is rendered
// disabled for non-approved rows. Audit drawer reads
// /api/admin/master-live/users/:userId/audit.
//
// SECURITY: only ADMIN/OWNER sessions reach these endpoints; the table
// itself renders no broker secrets — it joins userId + email + status
// + exposure + last-trade only.
import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ShieldCheck, ShieldOff, Pause, AlertTriangle, RefreshCw, History,
  ToggleRight, ToggleLeft, XCircle, Ban, Inbox,
} from "lucide-react";

type AccessStatus =
  | "NOT_APPROVED"
  | "PENDING_REQUEST"
  | "APPROVED"
  | "DENIED"
  | "SUSPENDED"
  | "DISABLED"
  | "REVOKED"
  | "RISK_LOCKED";

type UserRow = {
  userId: number;
  email: string;
  name: string | null;
  role: string;
  access: {
    status: AccessStatus;
    approvedForMasterLive: boolean;
    masterLiveTradingEnabled: boolean;
    approvedAt?: string | null;
    approvedBy?: number | null;
    disabledAt?: string | null;
    disabledBy?: number | null;
    allowedSymbols?: string[];
    maxLot?: number | null;
    dailyLossLimitUsd?: number | null;
    maxOpenPositions?: number | null;
    maxExposurePerSymbolLots?: number | null;
    requireStopLoss?: boolean;
    requireTakeProfit?: boolean;
    scannerLiveEnabled?: boolean;
    defaultExecutionRoute?: string | null;
    riskDisclosureAcceptedAt?: string | null;
    riskSettingsConfiguredAt?: string | null;
    liveBridgeRequestedAt?: string | null;
    liveBridgeRequestNote?: string | null;
    liveBridgeDeniedAt?: string | null;
    liveBridgeDeniedReason?: string | null;
    liveBridgeRevokedAt?: string | null;
    liveBridgeRevokedReason?: string | null;
    assignedRiskTemplateId?: number | null;
    assignedRiskTemplateName?: string | null;
  };
  // Task #737 follow-up — the SHARED resolver's separated readiness stages so
  // the queue can show Live Approved / Shared Bridge Approved / Full Live
  // Activation / Live Execution Active as DISTINCT statuses (display-only; the
  // backend resolver is the real gate). Optional for backward compatibility.
  liveState?: {
    approvedForLive: boolean;
    liveBridgeAssigned: boolean;
    executionActivated: boolean;
    executionReady: boolean;
    blockingReasonCode: string | null;
    blockingReason: string | null;
  };
  currentExposureLots: number;
  currentDailyPnlUsd: number;
  lastTradeAt: string | null;
};

// One small on/off chip per readiness stage. Display-only — never an action.
function LiveStageBadge({ label, on }: { label: string; on: boolean }) {
  return (
    <Badge
      className={
        on
          ? "bg-success/20 text-success"
          : "bg-muted text-txt-secondary"
      }
    >
      {on ? "✓ " : "• "}
      {label}
    </Badge>
  );
}

type AuditRow = {
  id: number; adminUserId: number; targetUserId: number;
  action: string; reason: string | null; createdAt: string;
  metadata: Record<string, unknown> | null;
};

const STATUS_COLORS: Record<AccessStatus, string> = {
  APPROVED: "bg-success/20 text-success",
  PENDING_REQUEST: "bg-warning/30 text-warning ring-1 ring-warning/60",
  NOT_APPROVED: "bg-muted text-txt-secondary",
  DENIED: "bg-danger/20 text-danger",
  DISABLED: "bg-warning/20 text-warning",
  SUSPENDED: "bg-danger/20 text-danger",
  REVOKED: "bg-danger/30 text-danger",
  RISK_LOCKED: "bg-premium/20 text-premium",
};

// Task #737 — four operational tabs. Classification is display-only; the
// backend resolver (buildApprovedTraderLiveState) is the real gate and
// hard-rejects bots/agents/system/investor regardless of what this UI shows.
type TabKey = "PENDING_HUMAN" | "APPROVED_LIVE" | "BLOCKED" | "BOTS_AI";

const BLOCKED_STATUSES: AccessStatus[] = [
  "DENIED", "REVOKED", "SUSPENDED", "DISABLED", "RISK_LOCKED",
];

function classifyRole(role: string): "BOT_AGENT" | "INVESTOR" | "HUMAN" {
  const r = (role ?? "").toUpperCase();
  if (r.includes("BOT") || r.includes("AGENT") || r.includes("SYSTEM")) return "BOT_AGENT";
  if (r.includes("INVESTOR")) return "INVESTOR";
  return "HUMAN";
}

export function MasterLiveUserAccessTable() {
  const [rows, setRows] = useState<UserRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [reasonByUser, setReasonByUser] = useState<Record<number, string>>({});
  const [auditUser, setAuditUser] = useState<number | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("PENDING_HUMAN");
  // Full Live Activation modal — single-user (userId set) or bulk (userId null).
  const [activation, setActivation] = useState<{ userId: number | null; email: string | null } | null>(null);

  async function load() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/admin/master-live/users", { credentials: "include" }).then((r) => r.json());
      if (r.ok) setRows(r.users ?? []);
      else setErr(r.error ?? "load failed");
    } finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);

  async function act(
    userId: number,
    path: string,
    body?: Record<string, unknown>,
    opts?: { confirmLabel?: string; requireReason?: boolean },
  ) {
    const reason = reasonByUser[userId] ?? "";
    if (opts?.requireReason && reason.trim().length === 0) {
      setErr(`A reason is required before you can ${opts.confirmLabel ?? path}.`);
      return;
    }
    if (opts?.confirmLabel) {
      const ok = window.confirm(`${opts.confirmLabel} user u${userId}?`);
      if (!ok) return;
    }
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/admin/master-live/users/${userId}/${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, ...body }),
      }).then((r) => r.json());
      if (!res.ok) {
        setErr(`${path}: ${res.message ?? res.error ?? "failed"}`);
      } else {
        setReasonByUser((m) => ({ ...m, [userId]: "" }));
        await load();
      }
    } finally { setBusy(false); }
  }

  const visibleRows = rows.filter((u) => {
    const kind = classifyRole(u.role);
    const s = u.access.status;
    if (tab === "BOTS_AI") return kind === "BOT_AGENT";
    // Investors and bots never appear in the human/blocked operational tabs.
    if (kind === "BOT_AGENT") return false;
    if (tab === "PENDING_HUMAN") return kind === "HUMAN" && s === "PENDING_REQUEST";
    if (tab === "APPROVED_LIVE") return s === "APPROVED";
    if (tab === "BLOCKED") return BLOCKED_STATUSES.includes(s);
    return false;
  });
  const tabCount = (k: TabKey) => rows.filter((u) => {
    const kind = classifyRole(u.role);
    const s = u.access.status;
    if (k === "BOTS_AI") return kind === "BOT_AGENT";
    if (kind === "BOT_AGENT") return false;
    if (k === "PENDING_HUMAN") return kind === "HUMAN" && s === "PENDING_REQUEST";
    if (k === "APPROVED_LIVE") return s === "APPROVED";
    if (k === "BLOCKED") return BLOCKED_STATUSES.includes(s);
    return false;
  }).length;
  const TAB_LABELS: Record<TabKey, string> = {
    PENDING_HUMAN: "Pending Human",
    APPROVED_LIVE: "Approved Live",
    BLOCKED: "Blocked",
    BOTS_AI: "Bots & AI Agents",
  };

  async function loadAudit(userId: number) {
    setAuditUser(userId);
    const r = await fetch(`/api/admin/master-live/users/${userId}/audit`, { credentials: "include" }).then((r) => r.json());
    if (r.ok) setAudit(r.audit ?? []); else setAudit([]);
  }

  return (
    <Card data-testid="card-master-live-user-access">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="w-4 h-4 text-success" />
          Master Live User Access
          <Badge variant="outline" className="ml-2 text-[10px]">server-enforced</Badge>
        </CardTitle>
        <CardDescription>
          Per-user approval gate for master live trading. New users default
          to <code className="font-mono">NOT_APPROVED</code>. Even with the
          master bridge connected, no user can place a master live trade
          without an explicit admin approval AND the per-user toggle on.
          Every action below is audit-logged.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 justify-between">
          <div className="flex items-center gap-2 text-xs flex-wrap">
            <Inbox className="w-3 h-3 text-warning" />
            <span className="text-muted-foreground">View:</span>
            {(["PENDING_HUMAN", "APPROVED_LIVE", "BLOCKED", "BOTS_AI"] as const).map((k) => {
              const c = tabCount(k);
              return (
                <Button
                  key={k}
                  size="sm"
                  variant={tab === k ? "default" : "outline"}
                  onClick={() => setTab(k)}
                  data-testid={`btn-tab-${k.toLowerCase()}`}
                  className="h-7 text-[11px]"
                >
                  {TAB_LABELS[k]}{c > 0 ? ` (${c})` : ""}
                </Button>
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            {tab === "APPROVED_LIVE" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setActivation({ userId: null, email: null })}
                disabled={busy}
                data-testid="btn-bulk-full-activation"
                className="h-7 text-[11px] border-success/50 text-success"
              >
                <ShieldCheck className="w-3 h-3 mr-1" /> Bulk Full Live Activation
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => void load()} disabled={busy}>
              <RefreshCw className="w-3 h-3 mr-1" /> Refresh
            </Button>
          </div>
        </div>
        {err && <div className="text-xs text-danger">{err}</div>}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-3">User</th>
                <th className="py-1 pr-3">Status</th>
                <th className="py-1 pr-3">Toggle</th>
                <th className="py-1 pr-3">Risk template</th>
                <th className="py-1 pr-3">Max lot</th>
                <th className="py-1 pr-3">Daily loss</th>
                <th className="py-1 pr-3">Max open</th>
                <th className="py-1 pr-3">Max/sym</th>
                <th className="py-1 pr-3">Exposure</th>
                <th className="py-1 pr-3">PnL (open)</th>
                <th className="py-1 pr-3">Last trade</th>
                <th className="py-1 pr-3">Reason</th>
                <th className="py-1 pr-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((u) => {
                const s = u.access.status;
                const isApproved = s === "APPROVED";
                const isPending = s === "PENDING_REQUEST";
                const tradingOn = u.access.masterLiveTradingEnabled;
                return (
                  <tr key={u.userId} className="border-t border-border/40" data-testid={`row-mla-${u.userId}`}>
                    <td className="py-2 pr-3">
                      <div className="font-mono">u{u.userId}</div>
                      <div className="text-[10px] text-muted-foreground truncate max-w-[180px]">{u.email}</div>
                      {isPending && u.access.liveBridgeRequestedAt && (
                        <div className="text-[10px] text-warning mt-1">
                          Requested {new Date(u.access.liveBridgeRequestedAt).toLocaleString()}
                        </div>
                      )}
                      {isPending && u.access.liveBridgeRequestNote && (
                        <div className="text-[10px] text-muted-foreground italic truncate max-w-[200px]" title={u.access.liveBridgeRequestNote}>
                          “{u.access.liveBridgeRequestNote}”
                        </div>
                      )}
                      {s === "DENIED" && u.access.liveBridgeDeniedReason && (
                        <div className="text-[10px] text-danger mt-1 truncate max-w-[200px]" title={u.access.liveBridgeDeniedReason}>
                          Denied: {u.access.liveBridgeDeniedReason}
                        </div>
                      )}
                      {s === "REVOKED" && u.access.liveBridgeRevokedReason && (
                        <div className="text-[10px] text-danger mt-1 truncate max-w-[200px]" title={u.access.liveBridgeRevokedReason}>
                          Revoked: {u.access.liveBridgeRevokedReason}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex flex-col gap-1">
                        <Badge className={STATUS_COLORS[s]}>{s.replace("_", " ")}</Badge>
                        {u.liveState && (
                          <div className="flex flex-wrap gap-1" data-testid={`live-stages-${u.userId}`}>
                            <LiveStageBadge label="Live Approved" on={u.liveState.approvedForLive} />
                            <LiveStageBadge label="Shared Bridge" on={u.liveState.liveBridgeAssigned} />
                            <LiveStageBadge label="Full Live Activation" on={u.liveState.executionActivated} />
                            <LiveStageBadge label="Execution Active" on={u.liveState.executionReady} />
                          </div>
                        )}
                        {u.liveState && !u.liveState.executionReady && u.liveState.blockingReason && (
                          <div className="text-[10px] text-warning/80" data-testid={`live-blocker-${u.userId}`}>
                            {u.liveState.blockingReason}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      <Button
                        size="sm"
                        variant={tradingOn ? "destructive" : "outline"}
                        disabled={busy || (!isApproved && !tradingOn)}
                        onClick={() => void act(u.userId, "toggle", { enabled: !tradingOn })}
                        data-testid={`btn-toggle-${u.userId}`}
                      >
                        {tradingOn
                          ? <><ToggleRight className="w-3 h-3 mr-1" />ON</>
                          : <><ToggleLeft className="w-3 h-3 mr-1" />OFF</>}
                      </Button>
                    </td>
                    <td className="py-2 pr-3 text-[11px]" data-testid={`cell-risk-template-${u.userId}`}>
                      {u.access.assignedRiskTemplateName ?? "—"}
                    </td>
                    <td className="py-2 pr-3 font-mono">{u.access.maxLot ?? "—"}</td>
                    <td className="py-2 pr-3 font-mono">{u.access.dailyLossLimitUsd ?? "—"}</td>
                    <td className="py-2 pr-3 font-mono" data-testid={`cell-max-open-${u.userId}`}>{u.access.maxOpenPositions ?? "—"}</td>
                    <td className="py-2 pr-3 font-mono" data-testid={`cell-max-exposure-${u.userId}`}>{u.access.maxExposurePerSymbolLots ?? "—"}</td>
                    <td className="py-2 pr-3 font-mono">{u.currentExposureLots.toFixed(2)}</td>
                    <td className={`py-2 pr-3 font-mono ${u.currentDailyPnlUsd >= 0 ? "text-success" : "text-danger"}`}>
                      {u.currentDailyPnlUsd.toFixed(2)}
                    </td>
                    <td className="py-2 pr-3 text-muted-foreground">
                      {u.lastTradeAt ? new Date(u.lastTradeAt).toLocaleString() : "—"}
                    </td>
                    <td className="py-2 pr-3">
                      <Input
                        placeholder="reason (required for audit)"
                        value={reasonByUser[u.userId] ?? ""}
                        onChange={(e) => setReasonByUser((m) => ({ ...m, [u.userId]: e.target.value }))}
                        className="h-7 text-xs w-44"
                        data-testid={`input-reason-${u.userId}`}
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex flex-wrap gap-1">
                        <Button
                          size="sm"
                          variant={isPending ? "default" : "outline"}
                          disabled={busy}
                          onClick={() => void act(u.userId, "approve", undefined, { confirmLabel: "Approve Live Bridge for" })}
                          data-testid={`btn-approve-${u.userId}`}
                          className={isPending ? "bg-success hover:bg-success text-white" : ""}
                        >
                          <ShieldCheck className="w-3 h-3 mr-1" />Approve
                        </Button>
                        {isApproved && classifyRole(u.role) === "HUMAN" && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => setActivation({ userId: u.userId, email: u.email })}
                            data-testid={`btn-full-activation-${u.userId}`}
                            className="border-success/50 text-success"
                          >
                            <ShieldCheck className="w-3 h-3 mr-1" />Full Live
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void act(u.userId, "deny", undefined, { confirmLabel: "Deny request from", requireReason: true })}
                          data-testid={`btn-deny-${u.userId}`}
                        >
                          <XCircle className="w-3 h-3 mr-1" />Deny
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || (s !== "APPROVED" && s !== "DISABLED" && s !== "SUSPENDED")}
                          onClick={() => void act(u.userId, "revoke", undefined, { confirmLabel: "Revoke live bridge access for", requireReason: true })}
                          data-testid={`btn-revoke-${u.userId}`}
                        >
                          <Ban className="w-3 h-3 mr-1" />Revoke
                        </Button>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(u.userId, "disable")} data-testid={`btn-disable-${u.userId}`}>
                          <ShieldOff className="w-3 h-3 mr-1" />Disable
                        </Button>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(u.userId, "suspend")} data-testid={`btn-suspend-${u.userId}`}>
                          <Pause className="w-3 h-3 mr-1" />Suspend
                        </Button>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(u.userId, "risk-lock")} data-testid={`btn-risk-lock-${u.userId}`}>
                          <AlertTriangle className="w-3 h-3 mr-1" />Risk-lock
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void loadAudit(u.userId)} data-testid={`btn-audit-${u.userId}`}>
                          <History className="w-3 h-3 mr-1" />Audit
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {visibleRows.length === 0 && (
                <tr><td colSpan={13} className="py-4 text-center text-muted-foreground">
                  {tab === "PENDING_HUMAN" ? "No pending live bridge requests." : "No users."}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        {auditUser != null && (
          <div className="mt-4 border-t border-border/40 pt-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium">Audit log for u{auditUser}</div>
              <Button size="sm" variant="ghost" onClick={() => { setAuditUser(null); setAudit([]); }}>close</Button>
            </div>
            {audit.length === 0
              ? <div className="text-xs text-muted-foreground">No audit rows.</div>
              : (
                <table className="w-full text-xs">
                  <thead className="text-left text-muted-foreground">
                    <tr><th>When</th><th>Admin</th><th>Action</th><th>Reason</th></tr>
                  </thead>
                  <tbody>
                    {audit.map((a) => (
                      <tr key={a.id} className="border-t border-border/40">
                        <td className="py-1 pr-3 text-muted-foreground">{new Date(a.createdAt).toLocaleString()}</td>
                        <td className="py-1 pr-3 font-mono">u{a.adminUserId}</td>
                        <td className="py-1 pr-3"><Badge variant="outline">{a.action}</Badge></td>
                        <td className="py-1 pr-3 text-muted-foreground">{a.reason ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </div>
        )}
        {activation && (
          <FullLiveActivationModal
            target={activation}
            onClose={() => setActivation(null)}
            onDone={() => { setActivation(null); void load(); }}
          />
        )}
        <LimitsEditor rows={rows} onSaved={() => void load()} />
        <div className="text-[11px] text-muted-foreground pt-2 border-t border-border/40">
          Server-side enforcement: hiding/disabling the toggle in this UI
          does NOT bypass the gate. The pipeline re-evaluates the per-user
          access row inside <code className="font-mono">dispatchLiveCommand</code>
          on every master live attempt. Per-user caps (max open positions,
          max exposure per symbol) are enforced BEFORE the 16-gate Phase B
          evaluator runs and emit standardized audit codes
          (<code className="font-mono">MAX_OPEN_POSITIONS_REACHED</code>,{" "}
          <code className="font-mono">MAX_EXPOSURE_PER_SYMBOL_REACHED</code>).
        </div>
      </CardContent>
    </Card>
  );
}

// Task #737 — Full Live Activation modal. Stands in for the trader's personal
// live-confirmation: requires the typed phrase "ENABLE LIVE TRADING" AND an
// explicit real-money acknowledgement. Single-user (target.userId set) calls
// /api/admin/traders/:userId/approve-live; bulk (userId null) calls
// /api/admin/traders/bulk-activate-approved-live. The backend re-validates the
// phrase + ack and never weakens any of the 18 Phase B dispatch gates.
const FULL_LIVE_PHRASE = "ENABLE LIVE TRADING";

function FullLiveActivationModal({
  target, onClose, onDone,
}: {
  target: { userId: number | null; email: string | null };
  onClose: () => void;
  onDone: () => void;
}) {
  const [phrase, setPhrase] = useState("");
  const [ack, setAck] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const isBulk = target.userId == null;
  const phraseOk = phrase === FULL_LIVE_PHRASE;
  const canSubmit = phraseOk && ack && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true); setMsg(null);
    try {
      const url = isBulk
        ? "/api/admin/traders/bulk-activate-approved-live"
        : `/api/admin/traders/${target.userId}/approve-live`;
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullLiveActivation: true,
          adminConfirmationPhrase: phrase,
          adminAcknowledgedRealMoneyExecution: true,
          reason: reason.trim() || undefined,
        }),
      }).then((r) => r.json());
      if (!res.ok) {
        setMsg(res.message ?? res.error ?? "Activation failed.");
        return;
      }
      onDone();
    } catch {
      setMsg("Activation request failed.");
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" data-testid="modal-full-live-activation">
      <div className="w-full max-w-md rounded-lg border border-success/40 bg-background p-4 space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-success" />
          <div className="text-sm font-semibold">
            {isBulk ? "Bulk Full Live Activation" : `Full Live Activation — u${target.userId}`}
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {isBulk
            ? "Enables real-money live execution for EVERY approved human trader on the shared bridge. This stands in for each trader's personal live-confirmation."
            : `Enables real-money live execution for ${target.email ?? `u${target.userId}`}. This stands in for the trader's personal live-confirmation.`}
          {" "}All 18 Phase B dispatch gates still apply on every order.
        </p>
        <label className="block text-xs">
          <span className="text-muted-foreground">Type <code className="font-mono text-success">{FULL_LIVE_PHRASE}</code> to confirm</span>
          <Input
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder={FULL_LIVE_PHRASE}
            className="h-8 mt-1 font-mono"
            data-testid="input-activation-phrase"
          />
        </label>
        <label className="flex items-start gap-2 text-[11px]">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            className="mt-0.5"
            data-testid="cb-activation-ack"
          />
          <span>I acknowledge this enables <strong>real-money live execution</strong>.</span>
        </label>
        <label className="block text-xs">
          <span className="text-muted-foreground">Reason (audit, optional)</span>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="why are you activating live execution"
            className="h-8 mt-1"
            data-testid="input-activation-reason"
          />
        </label>
        {msg && <div className="text-[11px] text-danger">{msg}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <Button size="sm" variant="ghost" onClick={onClose} disabled={busy} data-testid="btn-activation-cancel">Cancel</Button>
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={!canSubmit}
            data-testid="btn-activation-confirm"
            className="bg-success hover:bg-success text-white"
          >
            {isBulk ? "Activate all approved" : "Activate live"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Inline limits editor — apply maxOpenPositions / maxExposurePerSymbolLots
// per user. Mounting it next to the table keeps the existing flow
// unchanged while exposing the two new caps without rewriting the row UI.
function LimitsEditor({ rows, onSaved }: { rows: UserRow[]; onSaved: () => void }) {
  const [userId, setUserId] = useState<number | "">("");
  const [maxOpen, setMaxOpen] = useState<string>("");
  const [maxExp, setMaxExp] = useState<string>("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Tri-state: "" = leave unchanged, "CLEAR" = explicitly clear (send null),
  // otherwise the parsed number is sent. Explicit clear lets admins remove
  // a cap after setting one — empty string alone never clears.
  const [clearOpen, setClearOpen] = useState(false);
  const [clearExp, setClearExp] = useState(false);

  async function save() {
    if (userId === "") return;
    const wantsCapChange =
      clearOpen || clearExp || maxOpen !== "" || maxExp !== "";
    if (wantsCapChange && reason.trim().length === 0) {
      setMsg("Reason is required for cap changes (audit).");
      return;
    }
    setBusy(true); setMsg(null);
    try {
      const body: Record<string, unknown> = { reason };
      if (clearOpen) body.maxOpenPositions = null;
      else if (maxOpen !== "") body.maxOpenPositions = parseInt(maxOpen, 10);
      if (clearExp) body.maxExposurePerSymbolLots = null;
      else if (maxExp !== "") body.maxExposurePerSymbolLots = Number(maxExp);
      const r = await fetch(`/api/admin/master-live/users/${userId}/limits`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json());
      if (r.ok) {
        setMsg("Saved.");
        setMaxOpen(""); setMaxExp(""); setReason("");
        setClearOpen(false); setClearExp(false);
        onSaved();
      } else setMsg(`Save failed: ${r.error ?? "unknown"}`);
    } finally { setBusy(false); }
  }

  return (
    <div className="mt-3 border-t border-border/40 pt-3" data-testid="card-mla-limits-editor">
      <div className="text-sm font-medium mb-2">Per-user exposure caps</div>
      <div className="flex flex-wrap items-end gap-2 text-xs">
        <label className="flex flex-col">
          <span className="text-muted-foreground mb-1">User</span>
          <select
            className="h-7 rounded border bg-background px-2"
            value={userId}
            onChange={(e) => setUserId(e.target.value === "" ? "" : parseInt(e.target.value, 10))}
            data-testid="select-mla-user"
          >
            <option value="">— pick —</option>
            {rows.map((u) => (
              <option key={u.userId} value={u.userId}>u{u.userId} · {u.email}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col">
          <span className="text-muted-foreground mb-1">Max open positions</span>
          <Input
            className="h-7 w-32"
            type="number" min={1} step={1}
            value={maxOpen}
            disabled={clearOpen}
            onChange={(e) => setMaxOpen(e.target.value)}
            placeholder="leave blank = no change"
            data-testid="input-mla-max-open"
          />
          <label className="text-[10px] text-muted-foreground flex items-center gap-1 mt-1">
            <input type="checkbox" checked={clearOpen}
              onChange={(e) => { setClearOpen(e.target.checked); if (e.target.checked) setMaxOpen(""); }}
              data-testid="cb-mla-clear-open" /> clear (null)
          </label>
        </label>
        <label className="flex flex-col">
          <span className="text-muted-foreground mb-1">Max exposure/symbol (lots)</span>
          <Input
            className="h-7 w-32"
            type="number" min={0.01} step={0.01}
            value={maxExp}
            disabled={clearExp}
            onChange={(e) => setMaxExp(e.target.value)}
            placeholder="leave blank = no change"
            data-testid="input-mla-max-exposure"
          />
          <label className="text-[10px] text-muted-foreground flex items-center gap-1 mt-1">
            <input type="checkbox" checked={clearExp}
              onChange={(e) => { setClearExp(e.target.checked); if (e.target.checked) setMaxExp(""); }}
              data-testid="cb-mla-clear-exposure" /> clear (null)
          </label>
        </label>
        <label className="flex flex-col flex-1 min-w-[200px]">
          <span className="text-muted-foreground mb-1">Reason (audit) <span className="text-danger">*</span></span>
          <Input
            className="h-7"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="why are you changing these caps (required)"
            data-testid="input-mla-limits-reason"
          />
        </label>
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={busy || userId === "" || reason.trim().length === 0
            || (!clearOpen && !clearExp && maxOpen === "" && maxExp === "")}
          data-testid="btn-mla-save-limits"
        >
          Save caps
        </Button>
      </div>
      {msg && <div className="text-[11px] text-muted-foreground mt-1">{msg}</div>}
    </div>
  );
}
