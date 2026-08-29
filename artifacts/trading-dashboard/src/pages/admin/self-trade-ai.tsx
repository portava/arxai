// Task #211 — /self-trade-ai (Self-Trade AI — Control Room, Foundation)
//
// OPERATOR-ONLY control room for the funded autonomous trading-agent fleet.
// FOUNDATION PHASE: schema + controls + observability ONLY. NO autonomous
// order execution exists yet — that arrives in later phases behind the
// existing 16-gate live pipeline, Risk Governor, allocation, and kill
// switches. Every agent reports EXECUTION_NOT_IMPLEMENTED until then.
//
// SAFETY: wrapped in AdminDiagnosticsGate (also blocks admin-previewing-as-user).
// The server independently requires an ADMIN/OWNER session on every endpoint
// and a trimmed reason (>=3 chars) on every mutation (fail-closed audit row).
// Nothing on this page places, modifies, or closes a real trade.
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageTabs, type PageTab } from "@/components/ui/PageTabs";
import { AdminDiagnosticsGate } from "@/components/admin/AdminDiagnosticsGate";
import { EmptyState } from "@/components/ss/States";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Bot, ShieldAlert, Wallet, SlidersHorizontal, ScrollText, Settings2,
  LayoutGrid, Plus, Activity, Trophy, Newspaper, Waves, Rocket,
} from "lucide-react";
import { STATUS_COLORS, type StatusTone } from "@/lib/design-tokens";
import { RubyReasoningBlock } from "@/components/ruby/RubyReasoningBlock";
import { buildReasoningFromSelfTrade } from "@/lib/rubyReasoningBlock";
import {
  useGetSelfTradeOverview,
  useGetSelfTradeAgents,
  useGetSelfTradeAgentById,
  useGetSelfTradeAgentLedger,
  useGetSelfTradeAllocations,
  useGetSelfTradeKillSwitches,
  useGetSelfTradeAudit,
  useAdminCreateSelfTradeAgent,
  useAdminFundSelfTradeAgent,
  useAdminDefundSelfTradeAgent,
  useAdminConfigureSelfTradeAgent,
  useAdminSetSelfTradeAutonomy,
  useAdminSetSelfTradeStatus,
  useAdminToggleSelfTradeKillSwitch,
  useGetSelfTradeDecisions,
  useGetSelfTradeVolatilityMatrix,
  useGetSelfTradeExecutions,
  useAdminRunSelfTradeAutonomousCycle,
  getGetSelfTradeExecutionsQueryKey,
  getGetSelfTradeOverviewQueryKey,
  getGetSelfTradeAgentsQueryKey,
  getGetSelfTradeAgentByIdQueryKey,
  getGetSelfTradeAgentLedgerQueryKey,
  getGetSelfTradeAllocationsQueryKey,
  getGetSelfTradeKillSwitchesQueryKey,
  getGetSelfTradeAuditQueryKey,
} from "@workspace/api-client-react";
import type {
  SelfTradeAgent, SelfTradeKillSwitch, SelfTradeAuditRow, SelfTradeAllocation,
  SelfTradeLedgerEntry, AdminConfigureSelfTradeAgentInput,
  SelfTradeDecision, SelfTradeVolatilityNode, SelfTradeVolatilityPair,
  SelfTradeExecution,
} from "@workspace/api-client-react";

const TEMPLATES = ["ALPHA", "BLAZE", "ATLAS", "NOVA", "TITAN"] as const;
type Template = (typeof TEMPLATES)[number];

const TEMPLATE_BLURB: Record<Template, { tag: string; desc: string; tone: StatusTone }> = {
  ALPHA: { tag: "Balanced core", desc: "Disciplined all-round profile — moderate risk, trend + structure bias.", tone: "info" },
  BLAZE: { tag: "Aggressive scalper", desc: "High-frequency intraday scalping with tight risk and extension goals.", tone: "danger" },
  ATLAS: { tag: "Conservative carry", desc: "Low-frequency, wider-stop swing posture for steady compounding.", tone: "success" },
  NOVA: { tag: "Breakout / momentum", desc: "Volatility-expansion and break-of-structure momentum capture.", tone: "premium" },
  TITAN: { tag: "Heavyweight trend", desc: "Larger-size trend continuation with strict daily loss governance.", tone: "warning" },
};

const STATUSES = ["UNFUNDED", "FUNDED_IDLE", "ACTIVE", "PAUSED", "STOPPED", "ARCHIVED"] as const;
const KILL_SCOPES = ["GLOBAL", "AGENT", "STRATEGY", "SYMBOL", "NEWS"] as const;
const NEWS_PERMISSIONS = ["BLOCK", "CAUTION", "ALLOW"] as const;

// Autonomy labels describe what `evaluateExecutionPermission` actually does.
// L2/L3/L4 all resolve to the same EXECUTE verdict; the only L3 distinction is
// that `livePositionManager` will manage an open position instead of merely
// alerting. L4 has no behaviour of its own — say so rather than implying a
// higher tier of authority exists.
const AUTONOMY_LEVEL_LABELS: Record<number, string> = {
  0: "Suggest only (never dispatched)",
  1: "Prepare draft (human confirms)",
  2: "Execute; position management alert-only",
  3: "Execute + autonomous position management",
  4: "Same as L3 (no added authority implemented)",
};

function statusTone(status: string): StatusTone {
  switch (status) {
    case "ACTIVE": return "success";
    case "FUNDED_IDLE": return "info";
    case "PAUSED": return "warning";
    case "STOPPED": return "danger";
    case "ARCHIVED": return "inactive";
    default: return "neutral";
  }
}

function Tone({ tone, children }: { tone: StatusTone; children: React.ReactNode }) {
  return <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[tone].badge}`}>{children}</span>;
}

function usd(n: number | null | undefined): string {
  const v = typeof n === "number" ? n : 0;
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function fmtTime(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

// ── Foundation banner (honest execution status) ──────────────────────────────
function FoundationBanner() {
  return (
    <Alert className="border-ruby/30 bg-ruby/5">
      <ShieldAlert className="h-4 w-4 text-ruby" />
      <AlertTitle>Foundation phase — observation &amp; control only</AlertTitle>
      <AlertDescription className="text-xs text-muted-foreground">
        Agents can be created, funded, configured, and governed here, but autonomous
        order execution is <span className="font-semibold text-foreground">not active yet</span>.
        When it ships, every agent order will route through the existing 16-gate live
        pipeline, Risk Governor, per-user allocation, and kill switches — nothing here
        bypasses any safety surface.
      </AlertDescription>
    </Alert>
  );
}

// Clean, on-brand empty state for the phase-gated tabs (no fabricated data).
function PhasePlaceholder({
  icon, title, phase, children,
}: { icon: React.ReactNode; title: string; phase: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <Alert className="border-ruby/30 bg-ruby/5">
        <ShieldAlert className="h-4 w-4 text-ruby" />
        <AlertTitle>{title} — arrives in {phase}</AlertTitle>
        <AlertDescription className="text-xs text-muted-foreground">{children}</AlertDescription>
      </Alert>
      <EmptyState title={`${title} not active yet`} description="No data is shown because this surface is built but not yet wired to a live engine. It will populate honestly once its phase ships — never with placeholder numbers." icon={icon} />
    </div>
  );
}

// ── Overview tab ─────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, tone = "neutral" }: { label: string; value: string; sub?: string; tone?: StatusTone }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`mt-1 text-2xl font-bold ${STATUS_COLORS[tone].text}`}>{value}</div>
        {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function OverviewTab() {
  const { data, isLoading, isError, refetch } = useGetSelfTradeOverview();
  if (isLoading) return <div className="py-10 text-center text-sm text-muted-foreground">Loading fleet overview…</div>;
  if (isError || !data) {
    return <EmptyState title="Couldn't load overview" description="The fleet overview endpoint failed." icon={<ShieldAlert className="h-8 w-8" />} action={{ label: "Retry", onClick: () => void refetch() }} />;
  }
  const byStatus = (data.byStatus ?? {}) as Record<string, number>;
  return (
    <div className="space-y-4">
      <FoundationBanner />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Total agents" value={String(data.totalAgents)} tone="info" />
        <StatCard label="Active" value={String(data.activeAgents)} tone="success" />
        <StatCard label="Funded" value={String(data.fundedAgents)} tone="premium" />
        <StatCard label="Allocated" value={usd(data.totalAllocated)} sub={`${usd(data.totalAvailable)} available`} />
        <StatCard label="Realized P&L" value={usd(data.totalRealizedPnl)} tone={data.totalRealizedPnl >= 0 ? "bullish" : "bearish"} />
        <StatCard label="Open P&L" value={usd(data.totalOpenPnl)} tone={data.totalOpenPnl >= 0 ? "bullish" : "bearish"} />
      </div>
      <Card>
        <CardHeader><CardTitle className="text-sm">Fleet by status</CardTitle></CardHeader>
        <CardContent>
          {Object.keys(byStatus).length === 0 ? (
            <p className="text-xs text-muted-foreground">No agents yet. Create one from the Settings tab.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {Object.entries(byStatus).map(([s, n]) => (
                <Tone key={s} tone={statusTone(s)}>{s}: {n}</Tone>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Per-agent control panel (used inside Agents tab) ─────────────────────────
function AgentDetailPanel({ agentId }: { agentId: number }) {
  const qc = useQueryClient();
  const { data: detail, isLoading } = useGetSelfTradeAgentById(agentId);
  const { data: ledgerResp } = useGetSelfTradeAgentLedger(agentId);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [autonomy, setAutonomy] = useState("0");
  const [status, setStatus] = useState<string>("");

  const fund = useAdminFundSelfTradeAgent();
  const defund = useAdminDefundSelfTradeAgent();
  const setAuto = useAdminSetSelfTradeAutonomy();
  const setStat = useAdminSetSelfTradeStatus();

  const busy = fund.isPending || defund.isPending || setAuto.isPending || setStat.isPending;

  function invalidate() {
    void qc.invalidateQueries({ queryKey: getGetSelfTradeOverviewQueryKey() });
    void qc.invalidateQueries({ queryKey: getGetSelfTradeAgentsQueryKey() });
    void qc.invalidateQueries({ queryKey: getGetSelfTradeAgentByIdQueryKey(agentId) });
    void qc.invalidateQueries({ queryKey: getGetSelfTradeAgentLedgerQueryKey(agentId) });
    void qc.invalidateQueries({ queryKey: getGetSelfTradeAllocationsQueryKey() });
    void qc.invalidateQueries({ queryKey: getGetSelfTradeAuditQueryKey() });
  }

  if (isLoading || !detail) return <div className="py-6 text-center text-xs text-muted-foreground">Loading agent…</div>;
  const agent = detail.agent;
  const ledger = detail.ledger;
  const entries = (ledgerResp?.entries ?? []) as SelfTradeLedgerEntry[];
  const reasonOk = reason.trim().length >= 3;
  const amt = Number(amount);
  const amtOk = Number.isFinite(amt) && amt > 0;
  const unfunded = !((ledger?.availableFunds ?? 0) > 0) && !((ledger?.allocatedFunds ?? 0) > 0);

  const mutErr = fund.error || defund.error || setAuto.error || setStat.error;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Status" value={agent.status} tone={statusTone(agent.status)} />
        <StatCard label="Autonomy" value={`L${agent.autonomyLevel}`} />
        <StatCard label="Allocated" value={usd(ledger?.allocatedFunds)} sub={`${usd(ledger?.availableFunds)} available`} />
        <StatCard label="Realized P&L" value={usd(ledger?.realizedPnl)} tone={(ledger?.realizedPnl ?? 0) >= 0 ? "bullish" : "bearish"} />
      </div>

      {unfunded && (
        <Alert className="border-warning/30 bg-warning/5">
          <ShieldAlert className="h-4 w-4 text-warning" />
          <AlertTitle>Unfunded</AlertTitle>
          <AlertDescription className="text-xs text-muted-foreground">This agent has no capital and cannot be activated for trading. Fund it first.</AlertDescription>
        </Alert>
      )}

      {mutErr && (
        <Alert variant="destructive"><AlertDescription className="text-xs">{(mutErr as Error)?.message ?? "Action failed. Check inputs and try again."}</AlertDescription></Alert>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-sm">Funding</CardTitle><CardDescription className="text-xs">Atomic, audited capital moves.</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <div><Label className="text-xs">Amount (USD)</Label><Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1000" inputMode="decimal" /></div>
              <div><Label className="text-xs">Reason</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why (≥3 chars)" /></div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" disabled={busy || !amtOk || !reasonOk}
                onClick={() => fund.mutate({ id: agentId, data: { amount: amt, reason: reason.trim() } }, { onSuccess: () => { setAmount(""); setReason(""); invalidate(); } })}>
                Fund
              </Button>
              <Button size="sm" variant="outline" disabled={busy || !amtOk || !reasonOk}
                onClick={() => defund.mutate({ id: agentId, data: { amount: amt, reason: reason.trim() } }, { onSuccess: () => { setAmount(""); setReason(""); invalidate(); } })}>
                Defund
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-sm">Governance</CardTitle><CardDescription className="text-xs">Reason required on every change.</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            <div><Label className="text-xs">Reason</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why (≥3 chars)" /></div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">Autonomy level</Label>
                <Select value={autonomy} onValueChange={setAutonomy}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{[0, 1, 2, 3, 4].map((l) => <SelectItem key={l} value={String(l)}>Level {l} · {AUTONOMY_LEVEL_LABELS[l]}</SelectItem>)}</SelectContent>
                </Select>
                <p className="mt-1 text-[11px] text-muted-foreground" data-testid="text-autonomy-level-truth">
                  L4 currently behaves exactly as L3 — no additional authority is
                  implemented behind it. Raising to L4 changes the recorded level
                  and nothing else.
                </p>
              </div>
              <div className="flex items-end">
                <Button size="sm" className="w-full" disabled={busy || !reasonOk}
                  onClick={() => setAuto.mutate({ id: agentId, data: { level: Number(autonomy), reason: reason.trim() } }, { onSuccess: () => { setReason(""); invalidate(); } })}>
                  Set autonomy
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">Status</Label>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>{STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="flex items-end">
                <Button size="sm" variant="outline" className="w-full" disabled={busy || !reasonOk || !status}
                  onClick={() => setStat.mutate({ id: agentId, data: { status: status as typeof STATUSES[number], reason: reason.trim() } }, { onSuccess: () => { setReason(""); invalidate(); } })}>
                  Apply status
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">Ledger history</CardTitle></CardHeader>
        <CardContent className="p-0">
          {entries.length === 0 ? (
            <p className="p-4 text-xs text-muted-foreground">No ledger entries yet.</p>
          ) : (
            <Table>
              <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Type</TableHead><TableHead className="text-right">Amount</TableHead><TableHead className="text-right">Balance</TableHead><TableHead>Reason</TableHead></TableRow></TableHeader>
              <TableBody>
                {entries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-xs">{fmtTime(e.createdAt)}</TableCell>
                    <TableCell className="text-xs">{e.entryType}</TableCell>
                    <TableCell className="text-right text-xs">{usd(e.amount)}</TableCell>
                    <TableCell className="text-right text-xs">{usd(e.balanceAfter)}</TableCell>
                    <TableCell className="max-w-[16rem] truncate text-xs text-muted-foreground">{e.reason ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Agents tab ───────────────────────────────────────────────────────────────
function AgentsTab() {
  const { data, isLoading, isError, refetch } = useGetSelfTradeAgents();
  const [selected, setSelected] = useState<number | null>(null);
  const agents = (data?.agents ?? []) as SelfTradeAgent[];
  if (isLoading) return <div className="py-10 text-center text-sm text-muted-foreground">Loading fleet…</div>;
  if (isError) return <EmptyState title="Couldn't load agents" icon={<ShieldAlert className="h-8 w-8" />} action={{ label: "Retry", onClick: () => void refetch() }} />;
  if (agents.length === 0) return <EmptyState title="No agents yet" description="Create your first agent from a profile template in the Settings tab." icon={<Bot className="h-8 w-8" />} />;

  if (selected != null) {
    const a = agents.find((x) => x.id === selected);
    return (
      <div className="space-y-3">
        <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>← Back to fleet</Button>
        <div className="text-lg font-semibold">{a?.name ?? `Agent #${selected}`}</div>
        <AgentDetailPanel agentId={selected} />
      </div>
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Template</TableHead><TableHead>Owner</TableHead><TableHead>Status</TableHead><TableHead>Autonomy</TableHead><TableHead>Mode</TableHead></TableRow></TableHeader>
          <TableBody>
            {agents.map((a) => (
              <TableRow key={a.id} className="cursor-pointer" onClick={() => setSelected(a.id)}>
                <TableCell className="font-medium">{a.name}</TableCell>
                <TableCell><Tone tone={TEMPLATE_BLURB[(a.profileTemplate as Template)]?.tone ?? "neutral"}>{a.profileTemplate}</Tone></TableCell>
                <TableCell className="text-xs text-muted-foreground">{a.ownerType}{a.ownerId ? ` #${a.ownerId}` : ""}</TableCell>
                <TableCell><Tone tone={statusTone(a.status)}>{a.status}</Tone></TableCell>
                <TableCell className="text-xs">L{a.autonomyLevel}</TableCell>
                <TableCell className="text-xs">{a.mode}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ── Allocations tab ──────────────────────────────────────────────────────────
function AllocationsTab() {
  const { data, isLoading, isError, refetch } = useGetSelfTradeAllocations();
  const rows = (data?.allocations ?? []) as SelfTradeAllocation[];
  if (isLoading) return <div className="py-10 text-center text-sm text-muted-foreground">Loading allocations…</div>;
  if (isError) return <EmptyState title="Couldn't load allocations" icon={<ShieldAlert className="h-8 w-8" />} action={{ label: "Retry", onClick: () => void refetch() }} />;
  if (rows.length === 0) return <EmptyState title="No allocations yet" description="Capital allocations to agents will appear here once agents are funded from a source slot." icon={<Wallet className="h-8 w-8" />} />;
  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader><TableRow><TableHead>Agent</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Status</TableHead><TableHead>Source</TableHead><TableHead>When</TableHead></TableRow></TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="text-xs">#{r.agentId}</TableCell>
                <TableCell className="text-right text-xs">{usd(r.amount)}</TableCell>
                <TableCell><Tone tone={r.status === "ACTIVE" ? "success" : "inactive"}>{r.status}</Tone></TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.sourceUserId ? `user #${r.sourceUserId}` : "operator"}</TableCell>
                <TableCell className="text-xs">{fmtTime(r.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ── Risk Rules tab (per-agent settings — EDITABLE) ───────────────────────────
function NumField({ label, value, onChange, step }: { label: string; value: string; onChange: (v: string) => void; step?: string }) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal" step={step} />
    </div>
  );
}

function csvToList(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function RiskRulesTab() {
  const qc = useQueryClient();
  const { data: agentsResp, isLoading } = useGetSelfTradeAgents();
  const agents = (agentsResp?.agents ?? []) as SelfTradeAgent[];
  const [agentId, setAgentId] = useState<number | null>(null);
  const effectiveId = agentId ?? agents[0]?.id ?? null;
  const { data: detail } = useGetSelfTradeAgentById(effectiveId ?? 0, {
    query: { enabled: effectiveId != null, queryKey: getGetSelfTradeAgentByIdQueryKey(effectiveId ?? 0) },
  });
  const configure = useAdminConfigureSelfTradeAgent();

  // Editable form state, hydrated from the agent's settings row.
  const [form, setForm] = useState({
    riskPerTradePct: "", maxLotPerTrade: "", maxConcurrentPositions: "",
    maxDailyLossUsd: "", maxWeeklyLossUsd: "", dailyProfitGoalUsd: "", weeklyProfitGoalUsd: "",
    dailyMinTrades: "", baseMaxTrades: "", extensionMaxTrades: "",
    allowedSymbols: "", allowedSessions: "", allowedStrategies: "",
    newsTradingPermission: "BLOCK" as (typeof NEWS_PERMISSIONS)[number],
    extensionEnabled: false, requireStopLoss: true,
  });
  const [reason, setReason] = useState("");

  const s = detail?.settings;
  useEffect(() => {
    if (!s) return;
    setForm({
      riskPerTradePct: String(s.riskPerTradePct ?? ""),
      maxLotPerTrade: String(s.maxLotPerTrade ?? ""),
      maxConcurrentPositions: String(s.maxConcurrentPositions ?? ""),
      maxDailyLossUsd: String(s.maxDailyLossUsd ?? ""),
      maxWeeklyLossUsd: String(s.maxWeeklyLossUsd ?? ""),
      dailyProfitGoalUsd: String(s.dailyProfitGoalUsd ?? ""),
      weeklyProfitGoalUsd: String(s.weeklyProfitGoalUsd ?? ""),
      dailyMinTrades: String(s.dailyMinTrades ?? ""),
      baseMaxTrades: String(s.baseMaxTrades ?? ""),
      extensionMaxTrades: String(s.extensionMaxTrades ?? ""),
      allowedSymbols: (s.allowedSymbols ?? []).join(", "),
      allowedSessions: (s.allowedSessions ?? []).join(", "),
      allowedStrategies: (s.allowedStrategies ?? []).join(", "),
      newsTradingPermission: (s.newsTradingPermission as (typeof NEWS_PERMISSIONS)[number]) ?? "BLOCK",
      extensionEnabled: Boolean(s.extensionEnabled),
      requireStopLoss: s.requireStopLoss !== false,
    });
  }, [s]);

  if (isLoading) return <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>;
  if (agents.length === 0) return <EmptyState title="No agents to configure" description="Risk rules are defined per agent. Create an agent first." icon={<SlidersHorizontal className="h-8 w-8" />} />;

  const reasonOk = reason.trim().length >= 3;
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));
  const numOrUndef = (v: string): number | undefined => (v.trim() === "" || Number.isNaN(Number(v)) ? undefined : Number(v));

  function save() {
    if (effectiveId == null || !reasonOk) return;
    const data: AdminConfigureSelfTradeAgentInput = {
      reason: reason.trim(),
      riskPerTradePct: numOrUndef(form.riskPerTradePct),
      maxLotPerTrade: numOrUndef(form.maxLotPerTrade),
      maxConcurrentPositions: numOrUndef(form.maxConcurrentPositions),
      maxDailyLossUsd: numOrUndef(form.maxDailyLossUsd),
      maxWeeklyLossUsd: numOrUndef(form.maxWeeklyLossUsd),
      dailyProfitGoalUsd: numOrUndef(form.dailyProfitGoalUsd),
      weeklyProfitGoalUsd: numOrUndef(form.weeklyProfitGoalUsd),
      dailyMinTrades: numOrUndef(form.dailyMinTrades),
      baseMaxTrades: numOrUndef(form.baseMaxTrades),
      extensionEnabled: form.extensionEnabled,
      extensionMaxTrades: numOrUndef(form.extensionMaxTrades),
      allowedSymbols: csvToList(form.allowedSymbols),
      allowedSessions: csvToList(form.allowedSessions),
      allowedStrategies: csvToList(form.allowedStrategies),
      newsTradingPermission: form.newsTradingPermission,
      requireStopLoss: form.requireStopLoss,
    };
    configure.mutate({ id: effectiveId, data }, {
      onSuccess: () => {
        setReason("");
        void qc.invalidateQueries({ queryKey: getGetSelfTradeAgentByIdQueryKey(effectiveId) });
        void qc.invalidateQueries({ queryKey: getGetSelfTradeAuditQueryKey() });
      },
    });
  }

  return (
    <div className="space-y-3">
      <div className="max-w-xs">
        <Label className="text-xs">Agent</Label>
        <Select value={String(effectiveId ?? "")} onValueChange={(v) => setAgentId(Number(v))}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>{agents.map((a) => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-sm">Risk rules &amp; permissions</CardTitle><CardDescription className="text-xs">Per-agent risk envelope, quotas, allowed surfaces, and news posture. Every save is reason-gated and audited.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          {!s ? <p className="text-xs text-muted-foreground">No settings row found for this agent.</p> : (
            <>
              <div className="grid gap-3 md:grid-cols-3">
                <NumField label="Risk per trade (%)" value={form.riskPerTradePct} onChange={(v) => set("riskPerTradePct", v)} />
                <NumField label="Max lot / trade" value={form.maxLotPerTrade} onChange={(v) => set("maxLotPerTrade", v)} />
                <NumField label="Max concurrent positions" value={form.maxConcurrentPositions} onChange={(v) => set("maxConcurrentPositions", v)} />
                <NumField label="Max daily loss (USD)" value={form.maxDailyLossUsd} onChange={(v) => set("maxDailyLossUsd", v)} />
                <NumField label="Max weekly loss (USD)" value={form.maxWeeklyLossUsd} onChange={(v) => set("maxWeeklyLossUsd", v)} />
                <div />
                <NumField label="Daily profit goal (USD)" value={form.dailyProfitGoalUsd} onChange={(v) => set("dailyProfitGoalUsd", v)} />
                <NumField label="Weekly profit goal (USD)" value={form.weeklyProfitGoalUsd} onChange={(v) => set("weeklyProfitGoalUsd", v)} />
                <div />
                <NumField label="Daily minimum trades" value={form.dailyMinTrades} onChange={(v) => set("dailyMinTrades", v)} />
                <NumField label="Base max trades" value={form.baseMaxTrades} onChange={(v) => set("baseMaxTrades", v)} />
                <NumField label="Extension max trades" value={form.extensionMaxTrades} onChange={(v) => set("extensionMaxTrades", v)} />
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <div><Label className="text-xs">Allowed symbols (comma-sep)</Label><Input value={form.allowedSymbols} onChange={(e) => set("allowedSymbols", e.target.value)} placeholder="EURUSD, XAUUSD" /></div>
                <div><Label className="text-xs">Allowed sessions (comma-sep)</Label><Input value={form.allowedSessions} onChange={(e) => set("allowedSessions", e.target.value)} placeholder="LONDON, NEWYORK" /></div>
                <div><Label className="text-xs">Allowed strategies (comma-sep)</Label><Input value={form.allowedStrategies} onChange={(e) => set("allowedStrategies", e.target.value)} placeholder="TREND, BOS" /></div>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <div>
                  <Label className="text-xs">News trading permission</Label>
                  <Select value={form.newsTradingPermission} onValueChange={(v) => set("newsTradingPermission", v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{NEWS_PERMISSIONS.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2 pt-5"><Switch checked={form.extensionEnabled} onCheckedChange={(v) => set("extensionEnabled", v)} /><Label className="text-xs">Extension enabled</Label></div>
                <div className="flex items-center gap-2 pt-5"><Switch checked={form.requireStopLoss} onCheckedChange={(v) => set("requireStopLoss", v)} /><Label className="text-xs">Require stop-loss</Label></div>
              </div>

              <div className="grid gap-2 md:grid-cols-[1fr_auto] md:items-end">
                <div><Label className="text-xs">Reason (audited, ≥3 chars)</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why" /></div>
                <Button size="sm" disabled={configure.isPending || !reasonOk} onClick={save}>Save risk rules</Button>
              </div>
              {configure.isError && <Alert variant="destructive"><AlertDescription className="text-xs">{(configure.error as Error)?.message ?? "Couldn't save. Check inputs and try again."}</AlertDescription></Alert>}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Kill switches (lives inside Settings) ────────────────────────────────────
function KillSwitchesSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useGetSelfTradeKillSwitches();
  const toggle = useAdminToggleSelfTradeKillSwitch();
  const [scope, setScope] = useState<typeof KILL_SCOPES[number]>("GLOBAL");
  const [scopeRef, setScopeRef] = useState("");
  const [reason, setReason] = useState("");
  const rows = (data?.killSwitches ?? []) as SelfTradeKillSwitch[];
  const reasonOk = reason.trim().length >= 3;

  function invalidate() {
    void qc.invalidateQueries({ queryKey: getGetSelfTradeKillSwitchesQueryKey() });
    void qc.invalidateQueries({ queryKey: getGetSelfTradeAuditQueryKey() });
  }
  function setEngaged(engaged: boolean, s = scope, ref = scopeRef) {
    if (!reasonOk) return;
    toggle.mutate({ data: { scope: s, scopeRef: ref || null, engaged, reason: reason.trim() } }, { onSuccess: () => { setReason(""); invalidate(); } });
  }

  return (
    <div className="space-y-3">
      <Card className="border-danger/30 bg-danger/5">
        <CardHeader><CardTitle className="text-sm text-danger">Kill switches</CardTitle><CardDescription className="text-xs">Immediately halts the targeted scope (global / per-agent / per-strategy / per-symbol / news). Reason required and audited.</CardDescription></CardHeader>
        <CardContent className="space-y-2">
          <div className="grid gap-2 md:grid-cols-3">
            <div>
              <Label className="text-xs">Scope</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as typeof KILL_SCOPES[number])}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{KILL_SCOPES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div><Label className="text-xs">Scope ref {scope === "GLOBAL" ? "(n/a)" : ""}</Label><Input value={scopeRef} onChange={(e) => setScopeRef(e.target.value)} disabled={scope === "GLOBAL"} placeholder={scope === "AGENT" ? "agent id / key" : scope === "SYMBOL" ? "EURUSD" : "ref"} /></div>
            <div><Label className="text-xs">Reason</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why (≥3 chars)" /></div>
          </div>
          <Button size="sm" variant="destructive" disabled={toggle.isPending || !reasonOk} onClick={() => setEngaged(true)}>Engage kill switch</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Switch state</CardTitle></CardHeader>
        <CardContent className="p-0">
          {isLoading ? <p className="p-4 text-xs text-muted-foreground">Loading…</p> : rows.length === 0 ? (
            <p className="p-4 text-xs text-muted-foreground">No kill switches recorded. Nothing is halted.</p>
          ) : (
            <Table>
              <TableHeader><TableRow><TableHead>Scope</TableHead><TableHead>Ref</TableHead><TableHead>State</TableHead><TableHead>Reason</TableHead><TableHead>Updated</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {rows.map((k) => (
                  <TableRow key={k.id}>
                    <TableCell className="text-xs font-medium">{k.scope}</TableCell>
                    <TableCell className="text-xs">{k.scopeRef ?? "—"}</TableCell>
                    <TableCell><Tone tone={k.engaged ? "danger" : "success"}>{k.engaged ? "ENGAGED" : "released"}</Tone></TableCell>
                    <TableCell className="max-w-[14rem] truncate text-xs text-muted-foreground">{k.reason ?? "—"}</TableCell>
                    <TableCell className="text-xs">{fmtTime(k.updatedAt)}</TableCell>
                    <TableCell className="text-right">
                      {k.engaged && (
                        <Button size="sm" variant="outline" disabled={toggle.isPending || !reasonOk}
                          onClick={() => setEngaged(false, k.scope as typeof KILL_SCOPES[number], k.scopeRef ?? "")}>Release</Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Audit tab ────────────────────────────────────────────────────────────────
function AuditTab() {
  const { data, isLoading, isError, refetch } = useGetSelfTradeAudit();
  const rows = (data?.rows ?? []) as SelfTradeAuditRow[];
  if (isLoading) return <div className="py-10 text-center text-sm text-muted-foreground">Loading audit log…</div>;
  if (isError) return <EmptyState title="Couldn't load audit log" icon={<ShieldAlert className="h-8 w-8" />} action={{ label: "Retry", onClick: () => void refetch() }} />;
  if (rows.length === 0) return <EmptyState title="No audit entries yet" description="Every fleet mutation writes a fail-closed audit row. They'll appear here." icon={<ScrollText className="h-8 w-8" />} />;
  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Event</TableHead><TableHead>Agent</TableHead><TableHead>Actor</TableHead><TableHead>Severity</TableHead><TableHead>Reason</TableHead></TableRow></TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="text-xs">{fmtTime(r.createdAt)}</TableCell>
                <TableCell className="text-xs font-medium">{r.eventType}</TableCell>
                <TableCell className="text-xs">{r.agentId ? `#${r.agentId}` : "—"}</TableCell>
                <TableCell className="text-xs">{r.actorRole ?? "—"}{r.actorUserId ? ` #${r.actorUserId}` : ""}</TableCell>
                <TableCell><Tone tone={r.severity === "WARNING" ? "warning" : r.severity === "CRITICAL" ? "danger" : "neutral"}>{r.severity}</Tone></TableCell>
                <TableCell className="max-w-[18rem] truncate text-xs text-muted-foreground">{r.reason ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ── Settings tab (create agent + kill switches) ──────────────────────────────
function SettingsTab() {
  const qc = useQueryClient();
  const create = useAdminCreateSelfTradeAgent();
  const [template, setTemplate] = useState<Template>("ALPHA");
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [description, setDescription] = useState("");
  const [ownerType, setOwnerType] = useState<"OPERATOR_FLEET" | "USER">("OPERATOR_FLEET");
  const [ownerId, setOwnerId] = useState("");

  const nameOk = name.trim().length >= 2;
  const reasonOk = reason.trim().length >= 3;
  const ownerOk = ownerType === "OPERATOR_FLEET" || (Number(ownerId) > 0);

  function submit() {
    if (!nameOk || !reasonOk || !ownerOk) return;
    create.mutate({
      data: {
        template, name: name.trim(),
        reason: reason.trim(),
        description: description.trim() || null,
        ownerType,
        ownerId: ownerType === "USER" ? Number(ownerId) : null,
      },
    }, {
      onSuccess: () => {
        setName(""); setReason(""); setDescription(""); setOwnerId("");
        void qc.invalidateQueries({ queryKey: getGetSelfTradeOverviewQueryKey() });
        void qc.invalidateQueries({ queryKey: getGetSelfTradeAgentsQueryKey() });
        void qc.invalidateQueries({ queryKey: getGetSelfTradeAuditQueryKey() });
      },
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-sm">Create an agent</CardTitle><CardDescription className="text-xs">Spin up a new fleet agent from a profile template.</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            <div><Label className="text-xs">Template</Label>
              <Select value={template} onValueChange={(v) => setTemplate(v as Template)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{TEMPLATES.map((t) => <SelectItem key={t} value={t}>{t} — {TEMPLATE_BLURB[t].tag}</SelectItem>)}</SelectContent>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">{TEMPLATE_BLURB[template].desc}</p>
            </div>
            <div><Label className="text-xs">Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Alpha One" /></div>
            <div><Label className="text-xs">Reason</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why (≥3 chars) — audited" /></div>
            <div><Label className="text-xs">Description (optional)</Label><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} /></div>
            <div className="grid grid-cols-2 gap-2">
              <div><Label className="text-xs">Owner</Label>
                <Select value={ownerType} onValueChange={(v) => setOwnerType(v as "OPERATOR_FLEET" | "USER")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="OPERATOR_FLEET">Operator fleet</SelectItem><SelectItem value="USER">User</SelectItem></SelectContent>
                </Select>
              </div>
              {ownerType === "USER" && <div><Label className="text-xs">Owner user id</Label><Input value={ownerId} onChange={(e) => setOwnerId(e.target.value)} inputMode="numeric" placeholder="123" /></div>}
            </div>
            {create.isError && <Alert variant="destructive"><AlertDescription className="text-xs">Couldn't create agent. Check inputs and try again.</AlertDescription></Alert>}
            <Button size="sm" disabled={create.isPending || !nameOk || !reasonOk || !ownerOk} onClick={submit}><Plus className="mr-1 h-4 w-4" />Create agent</Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">About the fleet</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-xs text-muted-foreground">
            <p>Agents are funded operator-owned (or per-user) trading bots. The foundation phase manages their lifecycle, capital ledger, risk envelope, autonomy, and kill switches.</p>
            <p>Autonomous execution is not active yet. When it ships, all orders route through the existing 16-gate live pipeline — this control room never bypasses a safety gate.</p>
          </CardContent>
        </Card>
      </div>
      <KillSwitchesSection />
    </div>
  );
}

// ── Live Decisions tab (SHADOW / decision-only) ──────────────────────────────
type DecisionCheckLike = { key?: string; label?: string; status?: string; detail?: string; blocking?: boolean };
type ThesisLike = {
  symbol?: string; side?: string; setup?: string; whyNow?: string[];
  entryZone?: { from: number; to: number } | null; stopLoss?: number;
  invalidation?: number | null; takeProfits?: { from: number; to: number }[];
  edge?: number; confidence?: number; newsRisk?: string;
};

function outcomeTone(outcome: string): StatusTone {
  switch (outcome) {
    case "APPROVED": return "success";
    case "APPROVED_REDUCED": return "premium";
    case "PREPARE_ONLY": return "info";
    case "WATCH_ONLY": return "info";
    case "WAIT": return "warning";
    case "DENIED": return "danger";
    case "BLOCKED": return "danger";
    case "ASSIGNED_TO_ANOTHER": return "inactive";
    default: return "neutral";
  }
}
function checkTone(status: string): StatusTone {
  switch (status) {
    case "PASS": return "success";
    case "WARN": return "warning";
    case "FAIL": return "danger";
    case "SKIP": return "inactive";
    default: return "neutral";
  }
}
function sideTone(side: string | null | undefined): StatusTone {
  if (side === "BUY") return "bullish";
  if (side === "SELL") return "bearish";
  return "neutral";
}
function num(n: number | null | undefined, digits = 2): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : "—";
}
function pct(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(2)}%` : "—";
}

function DecisionCard({ d }: { d: SelfTradeDecision }) {
  const checks = (d.checks ?? []) as DecisionCheckLike[];
  const thesis = (d.thesis ?? null) as ThesisLike | null;
  const blockingFail = checks.some((c) => c.status === "FAIL" && c.blocking);
  // ONE standardized, ALWAYS-VISIBLE Ruby Reasoning Block for the auto-bot's
  // proposed trade. The decision cycle is SHADOW / decision-only — the block
  // mirrors that honestly (blocked/denied -> NO TRADE) and grants NO execution
  // permission; this control room never bypasses a safety gate.
  const reasoning = buildReasoningFromSelfTrade({
    outcome: d.outcome,
    side: d.side,
    reason: d.reason,
    setup: d.setup,
    confidence: d.confidence,
    noTradeScore: d.noTradeScore,
    riskState: d.riskState,
    conflictState: d.conflictState,
    symbol: d.symbol,
    timeframe: d.timeframe,
    thesis,
    checks,
  });
  return (
    <Card className={blockingFail ? "border-danger/30" : undefined}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-sm">{d.agentKey} · {d.symbol}</CardTitle>
            <Tone tone="neutral">{d.timeframe}</Tone>
            {d.side && <Tone tone={sideTone(d.side)}>{d.side}</Tone>}
          </div>
          <Tone tone={outcomeTone(d.outcome)}>{d.outcome}</Tone>
        </div>
        <CardDescription className="text-xs">{d.reason}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <RubyReasoningBlock data={reasoning} testid="self-trade-reasoning" dense />
        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 md:grid-cols-6">
          <div><div className="text-muted-foreground">Setup</div><div className="font-medium">{d.setup}</div></div>
          <div><div className="text-muted-foreground">Setup score</div><div className="font-medium">{num(d.setupScore, 0)}</div></div>
          <div><div className="text-muted-foreground">Rank</div><div className="font-medium">{num(d.rankScore, 0)}</div></div>
          <div><div className="text-muted-foreground">Confidence</div><div className="font-medium">{num(d.confidence, 0)} → {num(d.confidenceDecayed, 0)}</div></div>
          <div><div className="text-muted-foreground">No-trade</div><div className="font-medium">{num(d.noTradeScore, 0)}</div></div>
          <div><div className="text-muted-foreground">Risk state</div><div className="font-medium">{d.riskState}</div></div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Tone tone="info">{d.plannedAction}</Tone>
          {d.conflictState && d.conflictState !== "NONE" && <Tone tone="warning">conflict: {d.conflictState}</Tone>}
          {d.ownerAgentKey && <span className="text-muted-foreground">owner: {d.ownerAgentKey}</span>}
          {d.setupExpiresAt && <span className="text-muted-foreground">expires {fmtTime(d.setupExpiresAt)}</span>}
        </div>

        {thesis && (
          <div className="rounded-md border bg-muted/30 p-2 text-xs">
            <div className="mb-1 font-medium">Thesis</div>
            {Array.isArray(thesis.whyNow) && thesis.whyNow.length > 0 && (
              <ul className="ml-4 list-disc space-y-0.5 text-muted-foreground">
                {thesis.whyNow.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
            <div className="mt-1.5 grid grid-cols-2 gap-1 sm:grid-cols-4">
              <div><span className="text-muted-foreground">Entry: </span>{thesis.entryZone ? `${num(thesis.entryZone.from, 5)}–${num(thesis.entryZone.to, 5)}` : "—"}</div>
              <div><span className="text-muted-foreground">Stop: </span>{num(thesis.stopLoss, 5)}</div>
              <div><span className="text-muted-foreground">Targets: </span>{thesis.takeProfits && thesis.takeProfits.length ? thesis.takeProfits.map((t) => num(t.to, 5)).join(", ") : "—"}</div>
              <div><span className="text-muted-foreground">Edge: </span>{num(thesis.edge, 0)}</div>
            </div>
          </div>
        )}

        <div className="space-y-1">
          {checks.map((c, i) => (
            <div key={c.key ?? i} className="flex items-start gap-2 text-xs">
              <span className="mt-0.5 shrink-0"><Tone tone={checkTone(c.status ?? "")}>{c.status ?? "—"}</Tone></span>
              <span className="shrink-0 font-medium">{c.label ?? c.key}</span>
              <span className="text-muted-foreground">{c.detail}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function LiveDecisionsTab() {
  const { data, isLoading, isError, refetch, isFetching } = useGetSelfTradeDecisions({
    query: { refetchInterval: 8000, queryKey: ["self-trade-ai", "decisions"] },
  });
  if (isLoading) return <div className="py-10 text-center text-sm text-muted-foreground">Running decision cycle…</div>;
  if (isError || !data) {
    return <EmptyState title="Couldn't run decision cycle" description="The decision endpoint failed." icon={<ShieldAlert className="h-8 w-8" />} action={{ label: "Retry", onClick: () => void refetch() }} />;
  }
  const decisions = (data.decisions ?? []) as SelfTradeDecision[];
  return (
    <div className="space-y-3">
      <Alert className="border-ruby/30 bg-ruby/5">
        <ShieldAlert className="h-4 w-4 text-ruby" />
        <AlertTitle>Shadow decisions — no orders placed</AlertTitle>
        <AlertDescription className="text-xs text-muted-foreground">
          Each refresh evaluates every funded / active agent against its allowed symbols through the
          ordered handshake pipeline, ranks the candidates, applies one-owner-per-trade conflict
          resolution, and persists the cycle for audit. This is a <span className="font-semibold text-foreground">decision-only</span> brain —
          no real order is ever placed here. Live execution arrives in a later phase behind the
          existing 16-gate live pipeline.
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Tone tone="info">{data.agentsEvaluated} agents</Tone>
        <Tone tone="neutral">{data.symbolsEvaluated} symbols</Tone>
        <Tone tone={data.governorStatus === "NORMAL" || data.governorStatus === "OK" ? "success" : data.governorStatus === "UNKNOWN" ? "inactive" : "warning"}>Governor: {data.governorStatus}</Tone>
        <Tone tone={data.handshakeReady ? "success" : "warning"}>Handshake: {data.handshakeReady ? "ready" : "degraded"}</Tone>
        <Tone tone={data.persisted ? "success" : "warning"}>{data.persisted ? "persisted" : "persist failed"}</Tone>
        <span className="text-muted-foreground">cycle {fmtTime(data.generatedAt)}{isFetching ? " · refreshing…" : ""}</span>
      </div>

      {data.contendedSymbols.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-muted-foreground">Contended:</span>
          {data.contendedSymbols.map((s) => <Tone key={s} tone="warning">{s}</Tone>)}
        </div>
      )}
      {data.notes.length > 0 && (
        <div className="space-y-0.5 text-xs text-muted-foreground">
          {data.notes.map((n, i) => <div key={i}>• {n}</div>)}
        </div>
      )}

      {decisions.length === 0 ? (
        <EmptyState
          title="No decisions this cycle"
          description="No funded / active agent produced a candidate. This is honest — agents with no clean setup, no allowed-symbol data, or no available funds simply produce nothing rather than a fabricated signal."
          icon={<Activity className="h-8 w-8" />}
        />
      ) : (
        <div className="space-y-3">
          {decisions.map((d) => <DecisionCard key={`${d.agentId}-${d.symbol}-${d.timeframe}`} d={d} />)}
        </div>
      )}
    </div>
  );
}

// ── Volatility Matrix tab (real candles only) ────────────────────────────────
function dirTone(direction: string): StatusTone {
  if (direction === "UP") return "bullish";
  if (direction === "DOWN") return "bearish";
  return "neutral";
}
function momentumTone(m: string): StatusTone {
  switch (m) {
    case "EXPANDING": return "premium";
    case "STEADY": return "info";
    case "COMPRESSING": return "warning";
    default: return "inactive";
  }
}

function VolatilityMatrixTab() {
  const { data, isLoading, isError, refetch, isFetching } = useGetSelfTradeVolatilityMatrix({
    query: { refetchInterval: 8000, queryKey: ["self-trade-ai", "volatility-matrix"] },
  });
  if (isLoading) return <div className="py-10 text-center text-sm text-muted-foreground">Building volatility matrix…</div>;
  if (isError || !data) {
    return <EmptyState title="Couldn't load volatility matrix" description="The volatility-matrix endpoint failed." icon={<ShieldAlert className="h-8 w-8" />} action={{ label: "Retry", onClick: () => void refetch() }} />;
  }
  const nodes = (data.nodes ?? []) as SelfTradeVolatilityNode[];
  const pairs = (data.pairs ?? []) as SelfTradeVolatilityPair[];
  const decoupled = (data.decoupledPairs ?? []) as SelfTradeVolatilityPair[];
  return (
    <div className="space-y-3">
      <Alert className="border-ruby/30 bg-ruby/5">
        <Waves className="h-4 w-4 text-ruby" />
        <AlertTitle>Volatility relationships — real candles only</AlertTitle>
        <AlertDescription className="text-xs text-muted-foreground">
          Per-symbol direction / momentum and pairwise correlation, lead-lag, and decoupling are
          computed from real candle series via the existing market-data router. Symbols with
          insufficient candles render an honest <span className="font-semibold text-foreground">blind</span> state — never a
          fabricated relationship. Decoupling fires an opposite-run alert into My Alerts.
          <span className="ml-1 text-muted-foreground">{isFetching ? "Refreshing…" : `Updated ${fmtTime(data.generatedAt)}`}</span>
        </AlertDescription>
      </Alert>

      {!data.hasData ? (
        <EmptyState
          title="No volatility data yet"
          description="No symbol in the synthetic family has enough real candles to compute a relationship. This stays blind until the feed provides sufficient history — it is never filled with placeholder values."
          icon={<Waves className="h-8 w-8" />}
        />
      ) : (
        <>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Per-symbol regime</CardTitle></CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader><TableRow><TableHead>Symbol</TableHead><TableHead>Direction</TableHead><TableHead>Momentum</TableHead><TableHead className="text-right">Change</TableHead><TableHead className="text-right">Volatility</TableHead><TableHead className="text-right">Samples</TableHead></TableRow></TableHeader>
                <TableBody>
                  {nodes.map((n) => (
                    <TableRow key={n.symbol}>
                      <TableCell className="text-xs font-medium">{n.displayName || n.symbol}</TableCell>
                      <TableCell>{n.hasSufficientData ? <Tone tone={dirTone(n.direction)}>{n.direction}</Tone> : <Tone tone="inactive">blind</Tone>}</TableCell>
                      <TableCell>{n.hasSufficientData ? <Tone tone={momentumTone(n.momentum)}>{n.momentum}</Tone> : <span className="text-xs text-muted-foreground">—</span>}</TableCell>
                      <TableCell className="text-right text-xs">{n.hasSufficientData ? pct(n.changePct) : "—"}</TableCell>
                      <TableCell className="text-right text-xs">{n.hasSufficientData ? (typeof n.volatilityPct === "number" ? `${n.volatilityPct.toFixed(2)}%` : "—") : "—"}</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">{n.sampleSize}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {decoupled.length > 0 && (
            <Card className="border-warning/30 bg-warning/5">
              <CardHeader className="pb-2"><CardTitle className="text-sm text-warning">Decoupled pairs</CardTitle><CardDescription className="text-xs">Historically correlated pairs now running opposite — alerted into My Alerts.</CardDescription></CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader><TableRow><TableHead>Pair</TableHead><TableHead className="text-right">Corr</TableHead><TableHead className="text-right">Recent</TableHead><TableHead>Leader</TableHead><TableHead className="text-right">Lag</TableHead><TableHead>Note</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {decoupled.map((p) => (
                      <TableRow key={`${p.symbolA}-${p.symbolB}`}>
                        <TableCell className="text-xs font-medium">{p.symbolA} / {p.symbolB}</TableCell>
                        <TableCell className="text-right text-xs">{num(p.correlation)}</TableCell>
                        <TableCell className="text-right text-xs">{num(p.recentCorrelation)}</TableCell>
                        <TableCell className="text-xs">{p.leader ?? "—"}</TableCell>
                        <TableCell className="text-right text-xs">{p.lagBars}</TableCell>
                        <TableCell className="max-w-[16rem] truncate text-xs text-muted-foreground">{p.note}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Pairwise correlation</CardTitle></CardHeader>
            <CardContent className="p-0">
              {pairs.length === 0 ? (
                <p className="p-4 text-xs text-muted-foreground">No pair has enough overlapping candles to correlate yet.</p>
              ) : (
                <Table>
                  <TableHeader><TableRow><TableHead>Pair</TableHead><TableHead className="text-right">Corr</TableHead><TableHead className="text-right">Recent</TableHead><TableHead>Leader</TableHead><TableHead className="text-right">Lag</TableHead><TableHead>State</TableHead><TableHead className="text-right">Samples</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {pairs.map((p) => (
                      <TableRow key={`${p.symbolA}-${p.symbolB}`}>
                        <TableCell className="text-xs font-medium">{p.symbolA} / {p.symbolB}</TableCell>
                        <TableCell className="text-right text-xs">{num(p.correlation)}</TableCell>
                        <TableCell className="text-right text-xs">{num(p.recentCorrelation)}</TableCell>
                        <TableCell className="text-xs">{p.leader ?? "—"}</TableCell>
                        <TableCell className="text-right text-xs">{p.lagBars}</TableCell>
                        <TableCell>{p.decoupled ? <Tone tone="warning">decoupled</Tone> : <Tone tone="success">coupled</Tone>}</TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground">{p.sampleSize}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// ── Autonomous Execution tab ─────────────────────────────────────────────────
function execStatusTone(status: string): StatusTone {
  switch (status) {
    case "FILLED": return "success";
    case "CLOSED": return "info";
    case "DISPATCHED": case "PENDING_TICKET": return "warning";
    case "REJECTED": case "BLOCKED": return "danger";
    case "EXPIRED": return "neutral";
    default: return "inactive";
  }
}

function isFill(e: SelfTradeExecution): boolean {
  // honest dispatch≠fill: a real fill requires a broker ticket AND a fill state.
  return !!e.brokerTicket && (e.status === "FILLED" || e.status === "CLOSED");
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function AutonomousExecutionTab() {
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch, isFetching } = useGetSelfTradeExecutions(undefined, {
    query: { refetchInterval: 8000, queryKey: getGetSelfTradeExecutionsQueryKey(undefined) },
  });
  const runCycle = useAdminRunSelfTradeAutonomousCycle();
  const [reason, setReason] = useState("");
  const reasonOk = reason.trim().length >= 3;

  const rows = (data?.executions ?? []) as SelfTradeExecution[];
  const counts = useMemo(() => {
    const today = todayKey();
    let dispatched = 0, filled = 0, closed = 0, blocked = 0, filledToday = 0;
    for (const e of rows) {
      if (e.status === "DISPATCHED" || e.status === "PENDING_TICKET") dispatched++;
      if (e.status === "FILLED") filled++;
      if (e.status === "CLOSED") closed++;
      if (e.status === "REJECTED" || e.status === "BLOCKED" || e.status === "EXPIRED") blocked++;
      if (isFill(e) && (e.filledAt ?? e.createdAt ?? "").slice(0, 10) === today) filledToday++;
    }
    return { dispatched, filled, closed, blocked, filledToday };
  }, [rows]);

  function invalidate() {
    void qc.invalidateQueries({ queryKey: getGetSelfTradeExecutionsQueryKey(undefined) });
    void qc.invalidateQueries({ queryKey: getGetSelfTradeAuditQueryKey() });
    void qc.invalidateQueries({ queryKey: getGetSelfTradeAgentsQueryKey() });
    void qc.invalidateQueries({ queryKey: getGetSelfTradeOverviewQueryKey() });
  }

  return (
    <div className="space-y-3">
      <Alert className="border-ruby/30 bg-ruby/5">
        <Rocket className="h-4 w-4 text-ruby" />
        <AlertTitle>Autonomous live execution</AlertTitle>
        <AlertDescription className="text-xs text-muted-foreground">
          Approved decisions from funded, <span className="font-semibold text-foreground">ACTIVE</span>, LIVE-mode agents with
          autonomy ≥ 2 are executed through the <span className="font-semibold text-foreground">existing</span> live pipeline
          (executeInstant → live draft → confirm → dispatch → 16-gate Phase B → master bridge). There is{" "}
          <span className="font-semibold text-foreground">no separate path and no gate bypass</span>. A row is only a real fill
          when it carries a broker ticket — <span className="font-semibold text-foreground">dispatch ≠ fill</span>.
        </AlertDescription>
      </Alert>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <StatCard label="Dispatched (pending)" value={String(counts.dispatched)} tone="warning" sub="awaiting broker ticket" />
        <StatCard label="Filled" value={String(counts.filled)} tone="success" sub="real broker ticket" />
        <StatCard label="Closed" value={String(counts.closed)} tone="info" />
        <StatCard label="Blocked / rejected" value={String(counts.blocked)} tone="danger" />
        <StatCard label="Real fills today" value={String(counts.filledToday)} tone="bullish" sub="counted from fills only" />
      </div>

      <Card className="border-ruby/20">
        <CardHeader>
          <CardTitle className="text-sm">Run autonomous cycle</CardTitle>
          <CardDescription className="text-xs">
            Admin-triggered, audited single cycle: evaluates approved decisions, executes the permitted
            ones through the gated pipeline, manages open agent positions, and reconciles ledger / positions
            from real fills. No always-on loop — every run is one controlled, reason-stamped action.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="grid gap-2 md:grid-cols-[1fr_auto] md:items-end">
            <div>
              <Label className="text-xs">Reason</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why this run (≥3 chars)" />
            </div>
            <Button
              size="sm"
              disabled={runCycle.isPending || !reasonOk}
              onClick={() =>
                runCycle.mutate(
                  { data: { reason: reason.trim() } },
                  { onSuccess: () => { setReason(""); invalidate(); } },
                )
              }
            >
              <Rocket className="mr-1 h-4 w-4" />
              {runCycle.isPending ? "Running cycle…" : "Run cycle"}
            </Button>
          </div>
          {runCycle.isError && (
            <p className="text-xs text-danger">
              Cycle failed. {(runCycle.error as { message?: string } | undefined)?.message ?? "The run-cycle endpoint refused."}
            </p>
          )}
          {runCycle.isSuccess && runCycle.data && (
            <div className="flex flex-wrap items-center gap-1 text-xs">
              <Tone tone="info">considered {runCycle.data.decisionsConsidered}</Tone>
              <Tone tone="success">filled {runCycle.data.reconciled.filled}</Tone>
              <Tone tone="warning">managed {runCycle.data.agentsManaged}</Tone>
              <Tone tone="neutral">modified {runCycle.data.positionsModified}</Tone>
              <Tone tone="info">closed {runCycle.data.positionsClosed}</Tone>
              <Tone tone="danger">rejected {runCycle.data.reconciled.rejected}</Tone>
              <span className="text-muted-foreground">cycle {runCycle.data.cycleId}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="text-sm">Execution feed</CardTitle>
            <CardDescription className="text-xs">
              Owner-isolated. Real lifecycle only — never a fabricated fill.{isFetching ? " · refreshing…" : ""}
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" disabled={isFetching} onClick={() => void refetch()}>Refresh</Button>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <p className="p-4 text-xs text-muted-foreground">Loading executions…</p>
          ) : isError ? (
            <div className="p-4">
              <EmptyState title="Couldn't load executions" description="The executions endpoint failed." icon={<ShieldAlert className="h-8 w-8" />} action={{ label: "Retry", onClick: () => void refetch() }} />
            </div>
          ) : rows.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="No executions yet"
                description="No agent has placed a live trade. This is honest — nothing is shown until a real decision is executed through the gated pipeline."
                icon={<Rocket className="h-8 w-8" />}
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>Symbol</TableHead>
                    <TableHead>Side</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Broker ticket</TableHead>
                    <TableHead className="text-right">Fill</TableHead>
                    <TableHead className="text-right">Realized</TableHead>
                    <TableHead>Note</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="text-xs">{fmtTime(e.createdAt)}</TableCell>
                      <TableCell className="text-xs font-medium">{e.agentKey || `#${e.agentId}`}</TableCell>
                      <TableCell className="text-xs">{e.symbol}</TableCell>
                      <TableCell className="text-xs">{e.side}</TableCell>
                      <TableCell>
                        <Tone tone={execStatusTone(e.status)}>{e.status}</Tone>
                        {!isFill(e) && (e.status === "DISPATCHED" || e.status === "PENDING_TICKET") && (
                          <span className="ml-1 text-[10px] text-warning/80">not a fill</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{e.brokerTicket ?? "—"}</TableCell>
                      <TableCell className="text-right text-xs">{e.fillPrice ?? "—"}</TableCell>
                      <TableCell className={`text-right text-xs ${e.realizedPnl != null ? (e.realizedPnl >= 0 ? "text-success" : "text-danger") : ""}`}>
                        {e.realizedPnl != null ? usd(e.realizedPnl) : "—"}
                      </TableCell>
                      <TableCell className="max-w-[14rem] truncate text-xs text-muted-foreground">{e.blockReason ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <KillSwitchesSection />
    </div>
  );
}

// ── Page shell ───────────────────────────────────────────────────────────────
function SelfTradeAiInner() {
  const tabs = useMemo<PageTab[]>(() => [
    { id: "overview", label: "Overview", icon: <LayoutGrid className="h-4 w-4" />, content: <OverviewTab /> },
    { id: "agents", label: "Agents", icon: <Bot className="h-4 w-4" />, content: <AgentsTab /> },
    { id: "allocations", label: "Allocations", icon: <Wallet className="h-4 w-4" />, content: <AllocationsTab /> },
    { id: "live-decisions", label: "Live Decisions", icon: <Activity className="h-4 w-4" />, content: <LiveDecisionsTab /> },
    { id: "autonomous-execution", label: "Autonomous Execution", icon: <Rocket className="h-4 w-4" />, content: <AutonomousExecutionTab /> },
    {
      id: "competition", label: "Competition", icon: <Trophy className="h-4 w-4" />, content: (
        <PhasePlaceholder icon={<Trophy className="h-8 w-8" />} title="Competition" phase="Phase 4 (scoring + reports)">
          Cross-agent leaderboards and competition scoring arrive with the learning/scoring phase. Rankings will be computed from real closed-trade outcomes only.
        </PhasePlaceholder>
      ),
    },
    {
      id: "news-mode", label: "News Mode", icon: <Newspaper className="h-4 w-4" />, content: (
        <PhasePlaceholder icon={<Newspaper className="h-8 w-8" />} title="News Mode" phase="Phase 4 (news engine)">
          The fleet-wide news/economic-calendar posture lives here once a connected calendar provider is wired. Per-agent news permission (Block / Caution / Allow) is already configurable today under <span className="font-semibold text-foreground">Risk Rules</span>.
        </PhasePlaceholder>
      ),
    },
    { id: "volatility-matrix", label: "Volatility Matrix", icon: <Waves className="h-4 w-4" />, content: <VolatilityMatrixTab /> },
    { id: "risk", label: "Risk Rules", icon: <SlidersHorizontal className="h-4 w-4" />, content: <RiskRulesTab /> },
    { id: "audit", label: "Audit Log", icon: <ScrollText className="h-4 w-4" />, content: <AuditTab /> },
    { id: "settings", label: "Settings", icon: <Settings2 className="h-4 w-4" />, content: <SettingsTab /> },
  ], []);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-3 md:p-6">
      <div className="flex items-center gap-3">
        <div className="rounded-xl bg-ruby/10 p-2"><Bot className="h-6 w-6 text-ruby" /></div>
        <div>
          <h1 className="text-xl font-bold">Self-Trade AI — Control Room</h1>
          <p className="text-xs text-muted-foreground">Funded autonomous trading-agent fleet · operator control &amp; observability</p>
        </div>
      </div>
      <PageTabs tabs={tabs} storageKey="self-trade-ai" />
    </div>
  );
}

export default function SelfTradeAiPage() {
  return (
    <AdminDiagnosticsGate
      pageTitle="Self-Trade AI — Control Room"
      pageDescription="Operator control room for the funded autonomous trading-agent fleet."
      userSafeMessage="This area is restricted to operators."
    >
      <SelfTradeAiInner />
    </AdminDiagnosticsGate>
  );
}
