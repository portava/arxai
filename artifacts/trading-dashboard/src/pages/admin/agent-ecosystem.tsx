// Task #91 — /admin/agent-ecosystem (Agent Ecosystem Layer 4 dashboard)
//
// OPERATOR-ONLY window into the advisory agent ecosystem. Consumes the existing
// audited /api/admin/agent-ecosystem/* endpoints (Layers 1-3) plus the new
// Layer 4 Household Report endpoints. Surfaces:
//   - Overview: population, immune scan, household recommendations + seed
//   - Family Tree: Ruby → departments → agents, accountability
//   - Agents: registry table + per-agent detail + audited lifecycle controls
//     (approve shadow-exit, immune-system actions) — every mutation reason-gated
//   - Creation Requests: factory queue + approve/reject decision (reason-gated)
//   - Household Reports: generate (audited) + browse the persisted daily report,
//     including Ruby's plain-English summary
//   - Constitution: the read-only governing rules
//
// SAFETY: ADVISORY / OBSERVATION ONLY. Nothing here trades, gates, slows, or
// blocks any live/demo path or the 16-gate live pipeline. Wrapped in
// AdminDiagnosticsGate (also blocks admin-previewing-as-user). The server
// independently requires an ADMIN/OWNER session on every endpoint and a trimmed
// reason (>=3 chars) on every mutation (fail-closed audit row).
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageTabs, type PageTab } from "@/components/ui/PageTabs";
import { AdminDiagnosticsGate } from "@/components/admin/AdminDiagnosticsGate";
import { useAssistantName } from "@/lib/assistant-name";
import {
  RefreshCw, AlertTriangle, CheckCircle2, Network, Users, GitBranch,
  FileText, ScrollText, ShieldAlert, Sparkles,
} from "lucide-react";

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
const EP = "/api/admin/agent-ecosystem";

// ── Shared types (mirror the endpoint payloads) ──────────────────────────────
type Agent = {
  id: number; agentKey: string; name: string; department: string; isCore: boolean;
  currentRank: string; currentStatus: string; currentMode: string; creationRightLevel: string;
  authorityWeight: number; trustScore: number; qualityScore: number; speedScore: number;
  protectionScore: number; usefulnessScore: number; calibrationScore: number;
  liveInfluenceAllowed: boolean; canCreateAgents: boolean; parentAgentKey: string | null;
};
type FamilyNode = {
  agentKey: string; name: string; department: string; rank: string; status: string;
  isCore: boolean; children: FamilyNode[];
};
type FamilyTree = {
  rootKey: string; root: FamilyNode | null;
  departments: { department: string; agentCount: number; departmentScore: number }[];
  parentAccountability: { agentKey: string; name: string; childCount: number; accountabilityScore?: number }[];
};
type Population = {
  totalAgents: number; anyOverCap: boolean;
  byDepartment: { department: string; activeCount: number; traineeCount: number; totalCount: number; overActiveCap: boolean; overTraineeCap: boolean }[];
};
type ImmuneScan = {
  findings: { agentKey?: string; anomalyType: string; severity: string; detail: string; recommendedAction?: string }[];
  countsBySeverity: Record<string, number>;
  hasImmediateRestriction: boolean;
};
type Recommendation = { agentKey: string; name: string; action: string; reason: string };
type CreationRequest = {
  id: number; proposedName: string; proposedDepartment: string; purpose: string;
  status: string; createdAt: string | null;
};
type HouseholdReportListItem = {
  reportId: string; reportDate: string; headline: string; totalAgents: number; rubySummary: string;
};
type SurfaceFinding = { symbol: string; surface: string; detail: string };
type HouseholdReportBody = {
  reportDate: string;
  totals: { totalAgents: number; active: number; shadow: number; learningCamp: number; restricted: number; shutdownRecommended: number; avgTrust: number; avgQuality: number; avgSpeed: number };
  bestAgent: { name: string; department: string; composite: number } | null;
  weakestAgent: { name: string; department: string; composite: number } | null;
  newAgents: { name: string; department: string }[];
  promotions: { agentName: string; reason: string | null }[];
  demotions: { agentName: string; reason: string | null }[];
  learningCampIn: { agentName: string; reason: string | null }[];
  learningCampOut: { agentName: string; returnStatus: string }[];
  creationRequests: { proposedName: string; proposedDepartment: string; status: string }[];
  badTradesBlocked: SurfaceFinding[];
  qualityTradesFound: SurfaceFinding[];
  noTradeWins: SurfaceFinding[];
  scannerNoiseFiltered: SurfaceFinding[];
  stepBacksSavedSpeed: SurfaceFinding[];
  agentsThatSlowedSystem: SurfaceFinding[];
  departmentPerformance: { department: string; agentCount: number; avgQuality: number; avgTrust: number; avgSpeed: number }[];
  bloatWarnings: string[];
  speedWarnings: string[];
  whatTheSystemLearned: string[];
  recommendedAdminActions: Recommendation[];
};
type HouseholdReportView = HouseholdReportListItem & { body: HouseholdReportBody | null };
type GovernanceTraceRow = {
  id: number; actionId: string; actionType: string; userId: number | null; role: string | null;
  symbol: string | null; timeframe: string | null; activeMode: string;
  agentsRequested: string; agentsAllowedToRun: string; agentsBlocked: string;
  agentsThatSteppedBack: string; finalGovernanceDecision: string;
  rubySummaryUsed: boolean; riskVetoUsed: boolean; disagreementCourtUsed: boolean;
  predictionLocked: boolean; reviewCreated: boolean; noTradeRewardCreated: boolean;
  speedCostMs: number; totalGovernanceRuntimeMs: number;
  liveExecutionBlockedByAi: boolean; errorSummary: string | null; createdAt: string | null;
};
// Count entries in a JSON-text array column without throwing on malformed rows.
function jsonLen(raw: string | null | undefined): number {
  if (!raw) return 0;
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.length : 0; } catch { return 0; }
}

function statusBadge(s: string) {
  const map: Record<string, string> = {
    ACTIVE: "border-success/40 text-success",
    SHADOW: "border-border text-txt-secondary",
    WARNING: "border-warning/40 text-warning",
    PROBATION: "border-warning/40 text-warning",
    RESTRICTED: "border-danger/40 text-danger",
    QUARANTINED: "border-danger/40 text-danger",
    LEARNING_CAMP: "border-primary/40 text-primary",
    RETIRED: "border-border text-txt-muted",
    ARCHIVED: "border-border text-txt-muted",
    SHUTDOWN_RECOMMENDED: "border-danger/50 text-danger",
  };
  return <Badge variant="outline" className={map[s] ?? "border-border text-txt-secondary"}>{s}</Badge>;
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-background/40 p-3">
      <div className="text-xs text-txt-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold text-foreground">{value}</div>
    </div>
  );
}

function Section({ title, items, render }: { title: string; items: unknown[]; render: (x: any, i: number) => React.ReactNode }) {
  return (
    <div>
      <div className="text-sm font-medium text-txt-secondary">{title} <span className="text-txt-muted">({items.length})</span></div>
      {items.length === 0
        ? <div className="mt-1 text-xs text-txt-muted">None today.</div>
        : <ul className="mt-1 space-y-1 text-xs text-txt-secondary">{items.map(render)}</ul>}
    </div>
  );
}

function EcosystemInner() {
  const { name } = useAssistantName();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tree, setTree] = useState<FamilyTree | null>(null);
  const [population, setPopulation] = useState<Population | null>(null);
  const [immune, setImmune] = useState<ImmuneScan | null>(null);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [requests, setRequests] = useState<CreationRequest[]>([]);
  const [reports, setReports] = useState<HouseholdReportListItem[]>([]);
  const [openReport, setOpenReport] = useState<HouseholdReportView | null>(null);
  const [constitution, setConstitution] = useState<unknown>(null);
  const [reportSearch, setReportSearch] = useState("");
  const [traceLog, setTraceLog] = useState<GovernanceTraceRow[]>([]);
  const [traceActionFilter, setTraceActionFilter] = useState("");
  const [traceOffset, setTraceOffset] = useState(0);
  const [traceLoading, setTraceLoading] = useState(false);
  const TRACE_PAGE = 50;

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [a, t, p, im, rec, cr, rep, con] = await Promise.all([
        apiJson<{ agents: Agent[] }>(`${EP}/agents`),
        apiJson<{ tree: FamilyTree }>(`${EP}/family-tree`),
        apiJson<{ report: Population }>(`${EP}/population`),
        apiJson<{ scan: ImmuneScan }>(`${EP}/immune-scan`),
        apiJson<{ recommendations: Recommendation[] }>(`${EP}/household-recommendations`),
        apiJson<{ requests: CreationRequest[] }>(`${EP}/creation-requests`),
        apiJson<{ reports: HouseholdReportListItem[] }>(`${EP}/household-reports?limit=60`),
        apiJson<{ constitution: unknown }>(`${EP}/constitution`),
      ]);
      if (a.ok) setAgents(a.agents ?? []);
      if (t.ok) setTree(t.tree ?? null);
      if (p.ok) setPopulation(p.report ?? null);
      if (im.ok) setImmune(im.scan ?? null);
      if (rec.ok) setRecommendations(rec.recommendations ?? []);
      if (cr.ok) setRequests(cr.requests ?? []);
      if (rep.ok) setReports(rep.reports ?? []);
      if (con.ok) setConstitution(con.constitution ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load agent ecosystem");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTraceLog = useCallback(async (offset: number, actionType: string) => {
    try {
      setTraceLoading(true);
      const qs = new URLSearchParams({ limit: String(TRACE_PAGE), offset: String(offset) });
      if (actionType.trim()) qs.set("actionType", actionType.trim());
      const r = await apiJson<{ traces: GovernanceTraceRow[] }>(`${EP}/governance-trace-log?${qs.toString()}`);
      if (r.ok) { setTraceLog(r.traces ?? []); setTraceOffset(offset); }
      else setError(r.error || "Failed to load governance trace log.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load governance trace log");
    } finally {
      setTraceLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadTraceLog(0, ""); }, [loadTraceLog]);

  function flash(msg: string) { setNotice(msg); setError(null); window.setTimeout(() => setNotice(null), 4000); }

  // A reason-gated mutation helper: prompts, posts, reloads.
  async function mutate(path: string, body: Record<string, unknown>, successMsg: string, promptLabel = "Reason (audited, ≥3 chars):") {
    const reason = window.prompt(promptLabel);
    if (reason == null) return;
    if (reason.trim().length < 3) { setError("A reason of at least 3 characters is required."); return; }
    try {
      setBusy(true);
      const r = await apiJson<{ ok?: boolean; error?: string }>(path, {
        method: "POST", body: JSON.stringify({ ...body, reason: reason.trim() }),
      });
      if (!r.ok) { setError(r.error || "Action failed."); return; }
      flash(successMsg);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  async function generateReport() {
    const reason = window.prompt("Reason for generating today's report (audited, ≥3 chars):");
    if (reason == null) return;
    try {
      setBusy(true);
      const r = await apiJson<{ ok?: boolean; reportId?: string; error?: string }>(`${EP}/household-reports/generate`, {
        method: "POST", body: JSON.stringify({ reason: reason.trim() || "generate daily household report" }),
      });
      if (!r.ok) { setError(r.error || "Generate failed."); return; }
      flash("Household report generated.");
      const refreshed = await apiJson<{ reports: HouseholdReportListItem[] }>(`${EP}/household-reports?limit=60`);
      if (refreshed.ok) setReports(refreshed.reports ?? []);
      if (r.reportId) await openReportById(r.reportId);
    } finally {
      setBusy(false);
    }
  }

  async function searchReports() {
    const q = reportSearch.trim();
    const r = await apiJson<{ reports: HouseholdReportListItem[] }>(`${EP}/household-reports?limit=60${q ? `&search=${encodeURIComponent(q)}` : ""}`);
    if (r.ok) setReports(r.reports ?? []);
  }

  async function openReportById(reportId: string) {
    const r = await apiJson<{ report: HouseholdReportView }>(`${EP}/household-reports/${encodeURIComponent(reportId)}`);
    if (r.ok && r.report) setOpenReport(r.report);
    else setError(r.error || "Report not found.");
  }

  const selected = useMemo(() => agents.find((a) => a.agentKey === selectedKey) ?? null, [agents, selectedKey]);
  const pendingRequests = useMemo(() => requests.filter((r) => r.status === "PROPOSED"), [requests]);

  // ── Tab: Overview ──────────────────────────────────────────────────────────
  const overviewTab = (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total agents" value={population?.totalAgents ?? agents.length} />
        <Stat label="Active" value={agents.filter((a) => a.currentStatus === "ACTIVE").length} />
        <Stat label="Shadow" value={agents.filter((a) => a.currentStatus === "SHADOW").length} />
        <Stat label="Departments" value={tree?.departments.length ?? 0} />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Ecosystem health</CardTitle>
            <CardDescription>Immune scan + population caps. Observation only.</CardDescription>
          </div>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => mutate(`${EP}/seed`, {}, "Core agents seeded.")}>
            <Sparkles className="mr-1 h-3.5 w-3.5" /> Seed core agents
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {immune && (
            <div className="flex flex-wrap gap-2 text-xs">
              {Object.entries(immune.countsBySeverity).map(([sev, n]) => (
                <Badge key={sev} variant="outline" className="border-border text-txt-secondary">{sev}: {n}</Badge>
              ))}
              {immune.hasImmediateRestriction && (
                <Badge variant="outline" className="border-danger/40 text-danger">Immediate restriction flagged</Badge>
              )}
            </div>
          )}
          {immune && immune.findings.length > 0 ? (
            <ul className="space-y-1 text-xs text-txt-secondary">
              {immune.findings.slice(0, 12).map((f, i) => (
                <li key={i} className="flex gap-2">
                  <Badge variant="outline" className="border-warning/40 text-warning">{f.severity}</Badge>
                  <span className="text-txt-muted">{f.anomalyType}</span>
                  <span>{f.detail}</span>
                </li>
              ))}
            </ul>
          ) : <div className="text-xs text-txt-muted">No anomalies detected.</div>}
          {population?.anyOverCap && (
            <Alert><AlertTriangle className="h-4 w-4" /><AlertTitle>Population over cap</AlertTitle>
              <AlertDescription>One or more departments exceed their active/trainee cap — review for bloat.</AlertDescription></Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Team operations</CardTitle>
          <CardDescription>Audited maintenance runs. Observation/correction only — never a live-execution gate.</CardDescription></CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy}
            onClick={() => mutate(`${EP}/resolve-outcomes`, {}, "Pending predictions scored.")}>
            Score pending predictions
          </Button>
          <Button size="sm" variant="outline" disabled={busy}
            onClick={() => mutate(`${EP}/run-promotion`, {}, "Promotion board run complete.")}>
            Run promotion board
          </Button>
          <Button size="sm" variant="outline" disabled={busy}
            onClick={() => mutate(`${EP}/factory/freeze`, { frozen: true }, "Agent factory frozen.")}>
            Freeze factory
          </Button>
          <Button size="sm" variant="outline" disabled={busy}
            onClick={() => mutate(`${EP}/factory/freeze`, { frozen: false }, "Agent factory resumed.")}>
            Resume factory
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Recommended admin actions</CardTitle>
          <CardDescription>Aggregated from recent governance reviews. Suggestions only — you decide.</CardDescription></CardHeader>
        <CardContent>
          {recommendations.length === 0 ? <div className="text-xs text-txt-muted">No recommendations right now.</div> : (
            <ul className="space-y-1 text-xs text-txt-secondary">
              {recommendations.map((r, i) => (
                <li key={i} className="flex flex-wrap gap-2">
                  <Badge variant="outline" className="border-primary/40 text-primary">{r.action}</Badge>
                  <span className="text-foreground">{r.name}</span><span>— {r.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );

  // ── Tab: Family Tree ───────────────────────────────────────────────────────
  function renderNode(n: FamilyNode, depth: number): React.ReactNode {
    return (
      <div key={n.agentKey} style={{ marginLeft: depth * 16 }} className="py-0.5">
        <span className="text-foreground">{n.name}</span>
        <span className="ml-2 text-xs text-txt-muted">{n.department} · {n.rank}</span>
        {n.isCore && <Badge variant="outline" className="ml-2 border-premium/40 text-premium">core</Badge>}
        <span className="ml-2">{statusBadge(n.status)}</span>
        {n.children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  }
  const treeTab = (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">Family tree</CardTitle>
          <CardDescription>{name} → departments → agents. Parents are accountable for their children.</CardDescription></CardHeader>
        <CardContent>
          {tree?.root ? renderNode(tree.root, 0) : <div className="text-xs text-txt-muted">No tree yet — seed core agents.</div>}
        </CardContent>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Departments</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-1 text-xs text-txt-secondary">
              {(tree?.departments ?? []).map((d) => (
                <li key={d.department} className="flex justify-between"><span>{d.department}</span>
                  <span className="text-txt-muted">{d.agentCount} agents · score {Math.round(d.departmentScore)}</span></li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Parent accountability</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-1 text-xs text-txt-secondary">
              {(tree?.parentAccountability ?? []).map((p) => (
                <li key={p.agentKey} className="flex justify-between"><span>{p.name}</span>
                  <span className="text-txt-muted">{p.childCount} children</span></li>
              ))}
              {(tree?.parentAccountability ?? []).length === 0 && <li className="text-txt-muted">No parents with children yet.</li>}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );

  // ── Tab: Agents ────────────────────────────────────────────────────────────
  const IMMUNE_ACTIONS = ["QUARANTINE", "LEARNING_CAMP", "REDUCE_AUTHORITY", "ON_DEMAND_ONLY", "REMOVE_CREATION_RIGHTS", "RETIRE", "ARCHIVE"] as const;
  const agentsTab = (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader><CardTitle className="text-base">Agent registry <span className="text-txt-muted">({agents.length})</span></CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-txt-muted"><tr>
              <th className="py-1 pr-2">Name</th><th className="pr-2">Dept</th><th className="pr-2">Status</th>
              <th className="pr-2">Mode</th><th className="pr-2">Auth</th><th className="pr-2">Trust</th>
            </tr></thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.agentKey}
                  className={`cursor-pointer border-t border-border hover:bg-card ${selectedKey === a.agentKey ? "bg-card" : ""}`}
                  onClick={() => setSelectedKey(a.agentKey)} data-testid={`agent-row-${a.agentKey}`}>
                  <td className="py-1 pr-2 text-foreground">{a.name}{a.isCore && <span className="ml-1 text-premium">★</span>}</td>
                  <td className="pr-2 text-txt-muted">{a.department}</td>
                  <td className="pr-2">{statusBadge(a.currentStatus)}</td>
                  <td className="pr-2 text-txt-muted">{a.currentMode}</td>
                  <td className="pr-2 text-txt-secondary">{a.authorityWeight.toFixed(2)}</td>
                  <td className="pr-2 text-txt-secondary">{Math.round(a.trustScore)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Agent detail</CardTitle>
          <CardDescription>{selected ? selected.name : "Select an agent."}</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          {!selected ? <div className="text-xs text-txt-muted">Click a row to inspect and manage an agent.</div> : (
            <>
              <div className="flex flex-wrap gap-2 text-xs">
                {statusBadge(selected.currentStatus)}
                <Badge variant="outline" className="border-border text-txt-secondary">{selected.currentRank}</Badge>
                <Badge variant="outline" className="border-border text-txt-secondary">{selected.currentMode}</Badge>
                {selected.isCore && <Badge variant="outline" className="border-premium/40 text-premium">core</Badge>}
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                {([["Trust", selected.trustScore], ["Quality", selected.qualityScore], ["Speed", selected.speedScore],
                  ["Protect", selected.protectionScore], ["Useful", selected.usefulnessScore], ["Calib", selected.calibrationScore]] as const).map(([l, v]) => (
                  <div key={l} className="rounded border border-border p-2"><div className="text-txt-muted">{l}</div><div className="text-foreground">{Math.round(v)}</div></div>
                ))}
              </div>
              <div className="text-xs text-txt-muted">Authority weight: <span className="text-foreground">{selected.authorityWeight.toFixed(2)}</span> · Live influence: {selected.liveInfluenceAllowed ? "yes" : "no"}</div>

              {(selected.currentMode === "SHADOW" || selected.currentStatus === "SHADOW") && (
                <Button size="sm" disabled={busy} className="w-full"
                  onClick={() => mutate(`${EP}/agents/${encodeURIComponent(selected.agentKey)}/activate`, { mode: "SUPERVISED" }, `${selected.name} approved to leave Shadow Mode.`)}>
                  <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Approve shadow-exit (supervised)
                </Button>
              )}

              <div>
                <Label className="text-xs text-txt-muted">Immune-system action</Label>
                <div className="mt-1 grid grid-cols-2 gap-1">
                  {IMMUNE_ACTIONS.map((act) => {
                    const destructive = ["RETIRE", "ARCHIVE", "REMOVE_CREATION_RIGHTS", "LEARNING_CAMP"].includes(act);
                    const blocked = selected.isCore && destructive;
                    return (
                      <Button key={act} size="sm" variant="outline" disabled={busy || blocked}
                        title={blocked ? "Core agents are protected from this action" : undefined}
                        onClick={() => mutate(`${EP}/immune/apply`, { agentKey: selected.agentKey, action: act }, `Applied ${act} to ${selected.name}.`)}>
                        {act}
                      </Button>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );

  // ── Tab: Creation Requests ─────────────────────────────────────────────────
  const requestsTab = (
    <Card>
      <CardHeader><CardTitle className="text-base">Creation requests <span className="text-txt-muted">({requests.length}, {pendingRequests.length} pending)</span></CardTitle>
        <CardDescription>New agents always start in Shadow Mode at 0% authority once approved.</CardDescription></CardHeader>
      <CardContent className="overflow-x-auto">
        {requests.length === 0 ? <div className="text-xs text-txt-muted">No creation requests.</div> : (
          <table className="w-full text-left text-xs">
            <thead className="text-txt-muted"><tr><th className="py-1 pr-2">Proposed</th><th className="pr-2">Dept</th><th className="pr-2">Purpose</th><th className="pr-2">Status</th><th>Decision</th></tr></thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="py-1 pr-2 text-foreground">{r.proposedName}</td>
                  <td className="pr-2 text-txt-muted">{r.proposedDepartment}</td>
                  <td className="pr-2 text-txt-secondary">{r.purpose}</td>
                  <td className="pr-2">{statusBadge(r.status)}</td>
                  <td className="space-x-1">
                    {r.status === "PROPOSED" ? (
                      <>
                        <Button size="sm" variant="outline" disabled={busy}
                          onClick={() => mutate(`${EP}/creation-requests/${r.id}/decision`, { decision: "APPROVE" }, `Approved ${r.proposedName} (starts in Shadow Mode).`)}>Approve</Button>
                        <Button size="sm" variant="outline" disabled={busy}
                          onClick={() => mutate(`${EP}/creation-requests/${r.id}/decision`, { decision: "REJECT" }, `Rejected ${r.proposedName}.`)}>Reject</Button>
                      </>
                    ) : <span className="text-txt-muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );

  // ── Tab: Household Reports ─────────────────────────────────────────────────
  const reportsTab = (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div><CardTitle className="text-base">Daily household report</CardTitle>
            <CardDescription>A persisted point-in-time picture of the team. Generating refreshes today's report.</CardDescription></div>
          <Button size="sm" disabled={busy} onClick={generateReport}><Sparkles className="mr-1 h-3.5 w-3.5" /> Generate today</Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input value={reportSearch} onChange={(e) => setReportSearch(e.target.value)} placeholder="Search by date or headline…" className="h-8 text-xs" />
            <Button size="sm" variant="outline" onClick={searchReports}>Search</Button>
          </div>
          {reports.length === 0 ? <div className="text-xs text-txt-muted">No reports yet — generate today's.</div> : (
            <ul className="space-y-1">
              {reports.map((r) => (
                <li key={r.reportId}>
                  <button className={`w-full rounded border border-border px-3 py-2 text-left hover:bg-card ${openReport?.reportId === r.reportId ? "bg-card" : ""}`}
                    onClick={() => openReportById(r.reportId)} data-testid={`report-${r.reportDate}`}>
                    <div className="flex justify-between text-xs"><span className="font-medium text-foreground">{r.reportDate}</span><span className="text-txt-muted">{r.totalAgents} agents</span></div>
                    <div className="text-xs text-txt-muted">{r.headline}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {openReport && (
        <Card>
          <CardHeader><CardTitle className="text-base">Report — {openReport.reportDate}</CardTitle>
            <CardDescription>{openReport.headline}</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <Alert>
              <Sparkles className="h-4 w-4" />
              <AlertTitle>In plain English ({name})</AlertTitle>
              <AlertDescription className="text-txt-secondary">{openReport.rubySummary}</AlertDescription>
            </Alert>
            {openReport.body && (() => {
              const b = openReport.body;
              return (
                <>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Stat label="Total agents" value={b.totals.totalAgents} />
                    <Stat label="Active" value={b.totals.active} />
                    <Stat label="Avg trust" value={b.totals.avgTrust} />
                    <Stat label="Avg quality" value={b.totals.avgQuality} />
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded border border-border p-3 text-xs">
                      <div className="text-txt-muted">Best performer</div>
                      <div className="text-foreground">{b.bestAgent ? `${b.bestAgent.name} (${b.bestAgent.composite})` : "—"}</div>
                      <div className="mt-2 text-txt-muted">Weakest</div>
                      <div className="text-foreground">{b.weakestAgent ? `${b.weakestAgent.name} (${b.weakestAgent.composite})` : "—"}</div>
                    </div>
                    <div className="rounded border border-border p-3">
                      <Section title="What the system learned" items={b.whatTheSystemLearned} render={(x, i) => <li key={i}>{x as string}</li>} />
                    </div>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <Section title="Promotions" items={b.promotions} render={(x, i) => <li key={i}>{x.agentName}{x.reason ? ` — ${x.reason}` : ""}</li>} />
                    <Section title="Step-backs / demotions" items={b.demotions} render={(x, i) => <li key={i}>{x.agentName}{x.reason ? ` — ${x.reason}` : ""}</li>} />
                    <Section title="Entered learning camp" items={b.learningCampIn} render={(x, i) => <li key={i}>{x.agentName}</li>} />
                    <Section title="Graduated learning camp" items={b.learningCampOut} render={(x, i) => <li key={i}>{x.agentName}</li>} />
                    <Section title="New agents (shadow, 0% authority)" items={b.newAgents} render={(x, i) => <li key={i}>{x.name} · {x.department}</li>} />
                    <Section title="Creation requests" items={b.creationRequests} render={(x, i) => <li key={i}>{x.proposedName} · {x.proposedDepartment} ({x.status})</li>} />
                    <Section title="Weak setups steered away from" items={b.badTradesBlocked} render={(x, i) => <li key={i}>{x.symbol} ({x.surface}) — {x.detail}</li>} />
                    <Section title="Quality setups surfaced" items={b.qualityTradesFound} render={(x, i) => <li key={i}>{x.symbol} ({x.surface}) — {x.detail}</li>} />
                    <Section title="Noisy alerts filtered" items={b.scannerNoiseFiltered} render={(x, i) => <li key={i}>{x.symbol} ({x.surface}) — {x.detail}</li>} />
                    <Section title="Step-backs that saved speed" items={b.stepBacksSavedSpeed} render={(x, i) => <li key={i}>{x.symbol} ({x.surface}) — {x.detail}</li>} />
                    <Section title="No-trade wins" items={b.noTradeWins} render={(x, i) => <li key={i}>{x.symbol} ({x.surface}) — {x.detail}</li>} />
                    <Section title="Agents that slowed the desk" items={b.agentsThatSlowedSystem} render={(x, i) => <li key={i}>{x.symbol} ({x.surface}) — {x.detail}</li>} />
                  </div>
                  {(b.bloatWarnings.length > 0 || b.speedWarnings.length > 0) && (
                    <div className="grid gap-3 md:grid-cols-2">
                      <Section title="Bloat warnings" items={b.bloatWarnings} render={(x, i) => <li key={i}>{x as string}</li>} />
                      <Section title="Speed warnings" items={b.speedWarnings} render={(x, i) => <li key={i}>{x as string}</li>} />
                    </div>
                  )}
                  <div>
                    <Section title="Recommended admin actions" items={b.recommendedAdminActions}
                      render={(x, i) => <li key={i}><span className="text-primary">{x.action}</span> · {x.name} — {x.reason}</li>} />
                  </div>
                </>
              );
            })()}
          </CardContent>
        </Card>
      )}
    </div>
  );

  // ── Tab: Constitution ──────────────────────────────────────────────────────
  const constitutionTab = (
    <Card>
      <CardHeader><CardTitle className="text-base">Constitution</CardTitle>
        <CardDescription>The read-only governing rules of the agent ecosystem.</CardDescription></CardHeader>
      <CardContent>
        <pre className="max-h-[60vh] overflow-auto rounded bg-background/40 p-3 text-xs text-txt-secondary">
          {constitution ? JSON.stringify(constitution, null, 2) : "—"}
        </pre>
      </CardContent>
    </Card>
  );

  // ── Tab: Governance Trace Log ──────────────────────────────────────────────
  const traceLogTab = (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base">Governance trace log <span className="text-txt-muted">({traceLog.length})</span></CardTitle>
          <CardDescription>
            Durable, persisted proof that governance was actually involved in real
            actions (scanner / {name} / scalp). Observation only — never gates a trade.
            Every live row must read <span className="text-success">AI-blocked live: no</span>.
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" disabled={traceLoading} onClick={() => void loadTraceLog(traceOffset, traceActionFilter)}>
          <RefreshCw className={`mr-1 h-3.5 w-3.5 ${traceLoading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Input value={traceActionFilter} onChange={(e) => setTraceActionFilter(e.target.value)}
            placeholder="Filter by action type (e.g. SCANNER_SCAN)…" className="h-8 max-w-xs text-xs" />
          <Button size="sm" variant="outline" disabled={traceLoading} onClick={() => void loadTraceLog(0, traceActionFilter)}>Apply</Button>
          {traceActionFilter && (
            <Button size="sm" variant="ghost" disabled={traceLoading} onClick={() => { setTraceActionFilter(""); void loadTraceLog(0, ""); }}>Clear</Button>
          )}
        </div>
        {traceLog.length === 0 ? <div className="text-xs text-txt-muted">No persisted governance traces yet — run a scan, {name} read, or scalp read.</div> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-txt-muted"><tr>
                <th className="py-1 pr-2">When</th><th className="pr-2">Action</th><th className="pr-2">Mode</th>
                <th className="pr-2">Symbol</th><th className="pr-2">Req/Allow/Block/Step</th>
                <th className="pr-2">Decision</th><th className="pr-2">Flags</th><th className="pr-2">ms</th>
                <th className="pr-2">AI-blocked live</th>
              </tr></thead>
              <tbody>
                {traceLog.map((t) => (
                  <tr key={t.id} className="border-t border-border" data-testid={`trace-row-${t.id}`}>
                    <td className="py-1 pr-2 text-txt-muted">{t.createdAt ? new Date(t.createdAt).toLocaleString() : "—"}</td>
                    <td className="pr-2 text-foreground">{t.actionType}</td>
                    <td className="pr-2 text-txt-secondary">{t.activeMode}</td>
                    <td className="pr-2 text-txt-secondary">{t.symbol ?? "—"}{t.timeframe ? ` · ${t.timeframe}` : ""}</td>
                    <td className="pr-2 text-txt-secondary">{jsonLen(t.agentsRequested)}/{jsonLen(t.agentsAllowedToRun)}/{jsonLen(t.agentsBlocked)}/{jsonLen(t.agentsThatSteppedBack)}</td>
                    <td className="pr-2 text-txt-secondary">{t.finalGovernanceDecision}</td>
                    <td className="pr-2">
                      <div className="flex flex-wrap gap-1">
                        {t.riskVetoUsed && <Badge variant="outline" className="border-danger/40 text-danger">risk-veto</Badge>}
                        {t.disagreementCourtUsed && <Badge variant="outline" className="border-warning/40 text-warning">court</Badge>}
                        {t.rubySummaryUsed && <Badge variant="outline" className="border-primary/40 text-primary">ruby</Badge>}
                        {t.predictionLocked && <Badge variant="outline" className="border-premium/40 text-premium">predict</Badge>}
                      </div>
                    </td>
                    <td className="pr-2 text-txt-muted">{t.totalGovernanceRuntimeMs}</td>
                    <td className="pr-2">
                      <Badge variant="outline" className={t.liveExecutionBlockedByAi ? "border-danger/50 text-danger" : "border-success/40 text-success"}>
                        {t.liveExecutionBlockedByAi ? "yes" : "no"}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center justify-between pt-1">
          <Button size="sm" variant="outline" disabled={traceLoading || traceOffset === 0}
            onClick={() => void loadTraceLog(Math.max(0, traceOffset - TRACE_PAGE), traceActionFilter)}>Previous</Button>
          <span className="text-xs text-txt-muted">Rows {traceOffset + 1}–{traceOffset + traceLog.length}</span>
          <Button size="sm" variant="outline" disabled={traceLoading || traceLog.length < TRACE_PAGE}
            onClick={() => void loadTraceLog(traceOffset + TRACE_PAGE, traceActionFilter)}>Next</Button>
        </div>
      </CardContent>
    </Card>
  );

  const tabs: PageTab[] = [
    { id: "overview", label: "Overview", icon: <Network className="h-4 w-4" />, content: overviewTab },
    { id: "tree", label: "Family Tree", icon: <GitBranch className="h-4 w-4" />, content: treeTab },
    { id: "agents", label: "Agents", icon: <Users className="h-4 w-4" />, content: agentsTab },
    { id: "requests", label: "Creation Requests", icon: <ShieldAlert className="h-4 w-4" />, content: requestsTab },
    { id: "reports", label: "Household Reports", icon: <FileText className="h-4 w-4" />, content: reportsTab },
    { id: "trace-log", label: "Trace Log", icon: <ScrollText className="h-4 w-4" />, content: traceLogTab },
    { id: "constitution", label: "Constitution", icon: <ScrollText className="h-4 w-4" />, content: constitutionTab },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Agent Ecosystem</h1>
          <p className="text-sm text-txt-muted">Advisory / observation only — never gates, slows, or blocks any trade.</p>
        </div>
        <Button size="sm" variant="outline" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {error && <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertTitle>Error</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {notice && <Alert><CheckCircle2 className="h-4 w-4" /><AlertTitle>Done</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert>}

      <PageTabs tabs={tabs} storageKey="admin-agent-ecosystem" />
    </div>
  );
}

export default function AdminAgentEcosystemPage() {
  return (
    <AdminDiagnosticsGate pageTitle="Agent Ecosystem">
      <EcosystemInner />
    </AdminDiagnosticsGate>
  );
}
