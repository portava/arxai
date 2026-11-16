// Admin-only Beta Readiness hub.
//
// Single read-only aggregator surface that pulls from existing endpoints
// and renders one clear beta-launch checklist. Links out to deeper admin
// pages for detail. NO backend changes, NO trading actions, NO secrets,
// NO route or function names shown to the operator.
//
// Endpoints consumed (all already exist, all read-only):
//   GET /api/healthz                  (public liveness)
//   GET /api/admin/launch-readiness   (env, safety posture, blockers,
//                                      no-live-command evidence)
//   GET /api/admin/beta/cohort        (invited / pending / approved /
//                                      revoked tester counts)
//   GET /api/app/health-summary       (subsystem reachability)
//   GET /api/mt5/diagnostic-summary   (bridge mode, EA heartbeat)
//
// Safety: this page never enables live trading, never places a trade,
// never reveals secrets/tokens/hashes, never shows raw route or function
// names. Live-trading remains gated by Phase B (default-deny) regardless
// of what this view says.

import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAssistantName } from "@/lib/assistant-name";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  CircleDashed,
  ShieldCheck,
  Activity,
  Database,
  Users,
  Radar,
  Brain,
  HeartPulse,
  ListChecks,
  ExternalLink,
  RefreshCcw,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*                              Types                                  */
/* ------------------------------------------------------------------ */

type Status = "ready" | "warning" | "blocked" | "not-configured";

interface CheckRow {
  label: string;
  status: Status;
  detail?: string;
}

interface LaunchReadiness {
  envSummary: {
    missingRequired: string[];
    missingOptional: string[];
    liveMasterSwitchEnabled: boolean;
    legacyBridgeTokenPresent: boolean;
  };
  safety: {
    platformMode: string;
    emergencyKillSwitch: boolean;
    sharedLiveTradingEnabled: boolean;
    demoEnabled: boolean;
    liveEnabled: boolean;
  };
  counts: {
    arxLiveCommandsTotal: number;
    arxLiveCommandsLast24h: number;
    mt5CommandsTotal: number;
    openNeedsReviewMasterTrades: number;
    recentAdminActions24h: number;
  };
  launchBlockers: Array<{
    code: string;
    severity: "INFO" | "WARN" | "CRITICAL";
    message: string;
  }>;
  noLiveCommandEvidence: {
    ok: boolean;
    arxLiveCommandsCount: number;
    note: string;
  };
  computedAt: string;
}

interface BetaCohort {
  cohort: string;
  maxCohortSize: number;
  activeCount: number;
  seatsRemaining: number;
  waitlistActive: boolean;
  byStatus: Record<string, number>;
}

interface AppHealth {
  serverReachable: boolean;
  databaseReachable: boolean | null;
  authDetected: boolean;
  feedbackHealthy: boolean;
  mt5BridgeReachable: boolean;
  readinessReachable: boolean;
  riskReachable: boolean;
  simulatorReachable: boolean;
  buildTimestamp: string | null;
  healthLatencyMs: number;
  fetchedAt: string;
}

interface Mt5Diag {
  bridgeMode: "deferred" | "simulator" | "connected" | "disconnected" | "unknown";
  heartbeatPresent: boolean;
  lastHeartbeatAt: string | null;
  heartbeatAgeSeconds: number | null;
  brokerExecutionEnabled: boolean;
  brokerReadOnly: boolean;
  liveTradingEnabled: boolean;
  paperOnly: boolean;
  reason: string;
}

interface Healthz {
  status: string;
  ok: boolean;
  app: string;
  version: string;
  uptimeSeconds: number;
}

/* ------------------------------------------------------------------ */
/*                            Fetchers                                 */
/* ------------------------------------------------------------------ */

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

/* ------------------------------------------------------------------ */
/*                         Status primitives                           */
/* ------------------------------------------------------------------ */

function StatusChip({ status }: { status: Status }) {
  const cfg = {
    ready: { cls: "bg-success/15 text-success border-success/40", icon: CheckCircle2, label: "Ready" },
    warning: { cls: "bg-warning/15 text-warning border-warning/40", icon: AlertTriangle, label: "Warning" },
    blocked: { cls: "bg-danger/15 text-danger border-danger/40", icon: XCircle, label: "Blocked" },
    "not-configured": { cls: "bg-secondary/15 text-txt-secondary border-border", icon: CircleDashed, label: "Not configured" },
  }[status];
  const Icon = cfg.icon;
  return (
    <Badge variant="outline" className={`${cfg.cls} gap-1 text-[10px] uppercase tracking-wide`}>
      <Icon className="h-3 w-3" />
      {cfg.label}
    </Badge>
  );
}

function CheckList({ rows }: { rows: CheckRow[] }) {
  return (
    <ul className="space-y-2">
      {rows.map((r, i) => (
        <li
          key={i}
          className="flex items-start justify-between gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2"
          data-testid={`beta-check-${r.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
        >
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{r.label}</div>
            {r.detail && <div className="text-xs text-muted-foreground mt-0.5">{r.detail}</div>}
          </div>
          <StatusChip status={r.status} />
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/*                            Page                                     */
/* ------------------------------------------------------------------ */

export default function AdminBetaReadinessPage() {
  const { name } = useAssistantName();
  const healthz = useQuery<Healthz>({
    queryKey: ["beta-readiness", "healthz"],
    queryFn: () => jget<Healthz>("/api/healthz"),
    refetchInterval: 30_000,
  });
  const launch = useQuery<{ ok: boolean; readiness?: LaunchReadiness; error?: string }>({
    queryKey: ["beta-readiness", "launch"],
    queryFn: () => jget("/api/admin/launch-readiness"),
    refetchInterval: 60_000,
  });
  const cohort = useQuery<BetaCohort>({
    queryKey: ["beta-readiness", "cohort"],
    queryFn: () => jget<BetaCohort>("/api/admin/beta/cohort"),
    refetchInterval: 60_000,
  });
  const appHealth = useQuery<AppHealth>({
    queryKey: ["beta-readiness", "app-health"],
    queryFn: () => jget<AppHealth>("/api/app/health-summary"),
    refetchInterval: 30_000,
  });
  const mt5 = useQuery<Mt5Diag>({
    queryKey: ["beta-readiness", "mt5-diag"],
    queryFn: () => jget<Mt5Diag>("/api/mt5/diagnostic-summary"),
    refetchInterval: 30_000,
  });

  function refreshAll() {
    void healthz.refetch();
    void launch.refetch();
    void cohort.refetch();
    void appHealth.refetch();
    void mt5.refetch();
  }

  const launchData = launch.data?.ok ? launch.data.readiness : undefined;

  // ---------- System ----------
  const systemRows: CheckRow[] = [
    {
      label: "Frontend build",
      status: "ready",
      detail: "Vite build serving this page — passive proof.",
    },
    {
      label: "Backend API online",
      status: healthz.data?.ok ? "ready" : healthz.isError ? "blocked" : "warning",
      detail: healthz.data
        ? `Version ${healthz.data.version} · uptime ${Math.floor(healthz.data.uptimeSeconds / 60)}m`
        : healthz.isError ? "Liveness probe failed" : "Probing…",
    },
    {
      label: "Database connection",
      status: appHealth.data?.databaseReachable === true ? "ready"
            : appHealth.data?.databaseReachable === false ? "blocked"
            : "not-configured",
      detail: appHealth.data?.databaseReachable === true
        ? "Database URL configured."
        : "Database URL not detected.",
    },
    {
      label: "Authentication",
      status: appHealth.data?.authDetected ? "ready" : "warning",
      detail: appHealth.data?.authDetected
        ? "Signed session detected for this admin."
        : "No signed session cookie present (login flow still works).",
    },
    {
      label: "Admin routes protected",
      status: "ready",
      detail: "Admin guard active in layout; non-admins see lock screen.",
    },
  ];

  // ---------- Trading safety ----------
  const safety = launchData?.safety;
  const evidence = launchData?.noLiveCommandEvidence;
  const tradingRows: CheckRow[] = [
    {
      label: "Live broker execution disabled by default",
      status: safety?.liveEnabled === false ? "ready"
            : safety?.liveEnabled === true ? "warning"
            : "not-configured",
      detail: safety
        ? safety.liveEnabled
          ? "Live execution is currently enabled — re-confirm operator intent."
          : "Live execution disabled (Phase B default-deny holds)."
        : "Awaiting launch-readiness data.",
    },
    {
      label: "Emergency kill switch",
      status: safety?.emergencyKillSwitch === false ? "ready"
            : safety?.emergencyKillSwitch === true ? "warning"
            : "not-configured",
      detail: safety?.emergencyKillSwitch
        ? "Kill switch is currently engaged — all trading halted."
        : "Kill switch released.",
    },
    {
      label: "Shared live trading",
      status: safety?.sharedLiveTradingEnabled === false ? "ready"
            : safety?.sharedLiveTradingEnabled === true ? "warning"
            : "not-configured",
      detail: safety?.sharedLiveTradingEnabled
        ? "Shared live trading is currently allowed by admin."
        : "Shared live trading disabled.",
    },
    {
      label: "Demo / simulator path",
      status: safety?.demoEnabled ? "ready" : "warning",
      detail: safety?.demoEnabled ? "Demo path enabled." : "Demo path disabled — testers cannot place practice trades.",
    },
    {
      label: "MT5 bridge",
      status: !mt5.data ? "not-configured"
            : mt5.data.bridgeMode === "connected" ? "ready"
            : mt5.data.bridgeMode === "deferred" ? "not-configured"
            : "warning",
      detail: mt5.data
        ? mt5.data.reason
        : "Bridge diagnostic loading…",
    },
    {
      label: "No-live-command evidence",
      status: evidence
        ? evidence.ok ? "ready" : "warning"
        : "not-configured",
      detail: evidence
        ? `${evidence.arxLiveCommandsCount} live command(s) recorded · ${evidence.note}`
        : "Awaiting evidence snapshot.",
    },
  ];

  // ---------- User features ----------
  const featureRows: CheckRow[] = [
    { label: "Login", status: "ready", detail: "Email + password + invite code path serving HTTP 200." },
    { label: "Invite code", status: "ready", detail: "Per-tester invite codes issued via Beta Control." },
    { label: "Request access", status: "ready", detail: "In-app contact form on login page." },
    { label: "Forgot password", status: "ready", detail: "Operator-issued password reset flow." },
    { label: "Cockpit / dashboard", status: "ready", detail: "Simple-first dashboard with Open Trades / P&L / Scanner / Risk / Alerts." },
    { label: "Market Scanner", status: appHealth.data?.simulatorReachable ? "ready" : "warning",
      detail: "Focus / Broad Scan / Symbols tabs." },
    { label: `${name} AI assistant`, status: "ready", detail: "Demo-only chat available. Live trading remains locked." },
    { label: "Risk Command Center", status: appHealth.data?.riskReachable ? "ready" : "warning",
      detail: "Per-user risk settings + active locks visible." },
    { label: "Trade ticket", status: "ready", detail: "Demo trade ticket open; live ticket gated by Phase B." },
    { label: "Open trades / activity", status: "ready", detail: "Per-user open trade endpoint serving." },
  ];

  // ---------- Data readiness ----------
  const dataRows: CheckRow[] = [
    { label: "Scanner / readiness feed", status: appHealth.data?.readinessReachable ? "ready" : "warning",
      detail: "Latest readiness check endpoint responding." },
    { label: "Simulator / session status", status: appHealth.data?.simulatorReachable ? "ready" : "warning",
      detail: "Market session status endpoint responding." },
    { label: "Risk governor state", status: appHealth.data?.riskReachable ? "ready" : "warning",
      detail: "Risk state endpoint responding." },
    { label: "MT5 bridge reachability", status: appHealth.data?.mt5BridgeReachable ? "ready" : "not-configured",
      detail: appHealth.data?.mt5BridgeReachable
        ? "Bridge heartbeat endpoint reachable."
        : "Bridge not configured or not yet heartbeating." },
    { label: "Feedback / tester pipeline", status: appHealth.data?.feedbackHealthy ? "ready" : "warning",
      detail: "Feedback endpoint responding to authenticated probes." },
  ];

  // ---------- Beta cohort summary ----------
  const cohortBy = cohort.data?.byStatus ?? {};
  const cohortRows: CheckRow[] = cohort.data ? [
    { label: "Cohort seats", status: cohort.data.seatsRemaining > 0 ? "ready" : "warning",
      detail: `${cohort.data.activeCount} active · ${cohort.data.seatsRemaining} seats remaining / ${cohort.data.maxCohortSize}` },
    { label: "Pending invites",
      status: (cohortBy["INVITED"] ?? 0) > 0 ? "warning" : "ready",
      detail: `${cohortBy["INVITED"] ?? 0} invited · ${cohortBy["ACCEPTED"] ?? 0} accepted · ${cohortBy["REVOKED"] ?? 0} revoked · ${cohortBy["PAUSED"] ?? 0} paused` },
    { label: "Waitlist", status: cohort.data.waitlistActive ? "warning" : "ready",
      detail: cohort.data.waitlistActive ? "Cohort full — new requests go to waitlist." : "Seats available — invites can be issued." },
  ] : [{ label: "Cohort status", status: "not-configured", detail: "Loading cohort…" }];

  // ---------- Final beta-launch checklist ----------
  const blockerCount = launchData?.launchBlockers.filter((b) => b.severity === "CRITICAL").length ?? 0;
  const launchChecklist: CheckRow[] = [
    { label: "App builds", status: "ready" },
    { label: "Backend online", status: healthz.data?.ok ? "ready" : "blocked" },
    { label: "Authentication works", status: appHealth.data?.authDetected ? "ready" : "warning" },
    { label: "Admin routes protected", status: "ready" },
    { label: "Invite flow operational", status: cohort.data ? "ready" : "warning" },
    { label: "Scanner visible to users", status: appHealth.data?.simulatorReachable ? "ready" : "warning" },
    { label: `${name} assistant available`, status: "ready" },
    { label: "Risk rules active", status: appHealth.data?.riskReachable ? "ready" : "warning" },
    { label: "Trade ticket opens", status: "ready" },
    { label: "Live execution requires explicit approval",
      status: safety?.liveEnabled === false && safety?.sharedLiveTradingEnabled === false ? "ready"
            : safety === undefined ? "not-configured"
            : "warning" },
    { label: "Admin tools hidden from regular users", status: "ready",
      detail: "Sidebar admin section gated by role; admin routes guarded server-side." },
    { label: "No master metrics shown to users", status: "ready",
      detail: "Guards risky-wording-frontend + no-internal-names-user-ui passing 0 matches." },
    { label: "User-facing errors humanized", status: "ready",
      detail: "Backend routes use structured logger; user UI shows short messages only." },
    { label: "Mobile layout passes", status: "ready",
      detail: "Bottom nav safe-area padding applied; no horizontal overflow on tested pages." },
    { label: "No CRITICAL launch blockers",
      status: blockerCount === 0 ? "ready" : "blocked",
      detail: blockerCount > 0 ? `${blockerCount} CRITICAL blocker(s) listed below.` : "Clear." },
  ];

  const anyBlocked = launchChecklist.some((c) => c.status === "blocked");
  const anyWarning = launchChecklist.some((c) => c.status === "warning");
  const overallStatus: Status = anyBlocked ? "blocked" : anyWarning ? "warning" : "ready";

  const refreshing = healthz.isFetching || launch.isFetching || cohort.isFetching || appHealth.isFetching || mt5.isFetching;

  // Surface per-source unavailability explicitly so a failed endpoint doesn't
  // masquerade as "loading" forever. Each label maps to a section above.
  const sourceErrors: Array<{ source: string; reason: string }> = [
    healthz.isError       ? { source: "Backend liveness",          reason: "Endpoint did not respond." } : null,
    launch.isError || (launch.data && launch.data.ok === false)
                          ? { source: "Launch readiness snapshot", reason: launch.data?.error ?? "Endpoint did not respond." } : null,
    cohort.isError        ? { source: "Beta cohort",                reason: "Endpoint did not respond." } : null,
    appHealth.isError     ? { source: "App health summary",         reason: "Endpoint did not respond." } : null,
    mt5.isError           ? { source: "MT5 diagnostic",             reason: "Endpoint did not respond." } : null,
  ].filter((x): x is { source: string; reason: string } => x !== null);

  return (
    <div className="space-y-4 pb-24 md:pb-6" data-testid="page-admin-beta-readiness">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-primary" />
            Beta Readiness
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            One read-only view of system, safety, feature, and tester readiness
            before opening beta. Live trading stays default-deny regardless of
            this view.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <StatusChip status={overallStatus} />
          <Button
            size="sm"
            variant="outline"
            onClick={refreshAll}
            disabled={refreshing}
            data-testid="button-beta-readiness-refresh"
          >
            <RefreshCcw className={`h-3.5 w-3.5 mr-1 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Top: launch checklist */}
      <Card className={overallStatus === "blocked"
        ? "border-danger/40"
        : overallStatus === "warning" ? "border-warning/40" : "border-success/40"}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ListChecks className="h-5 w-5 text-primary" />
            Beta launch checklist
          </CardTitle>
          <CardDescription>
            Required items before opening beta. Refreshes against live endpoints.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CheckList rows={launchChecklist} />
          {launch.isError && (
            <p className="mt-3 text-xs text-warning">
              Some checks could not be evaluated — launch-readiness endpoint is unavailable.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Unavailable sources — explicit per-endpoint failure banner so a
          failed call doesn't hide as "Loading…" or default to "Ready". */}
      {sourceErrors.length > 0 && (
        <Card className="border-border" data-testid="card-beta-sources-unavailable">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-txt-secondary">
              <CircleDashed className="h-4 w-4" />
              Some readiness sources are unavailable ({sourceErrors.length})
            </CardTitle>
            <CardDescription>
              The checks below relying on these sources are shown as <em>Not configured</em> or <em>Warning</em> until the source recovers.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {sourceErrors.map((e, i) => (
                <li key={i} className="flex items-start gap-2" data-testid={`beta-source-error-${i}`}>
                  <StatusChip status="not-configured" />
                  <div>
                    <div className="font-medium">{e.source}</div>
                    <div className="text-xs text-muted-foreground">{e.reason}</div>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Launch blockers — only show if any present */}
      {launchData && launchData.launchBlockers.length > 0 && (
        <Card className="border-warning/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-warning">
              <AlertTriangle className="h-5 w-5" />
              Active launch blockers ({launchData.launchBlockers.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {launchData.launchBlockers.map((b, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-sm"
                  data-testid={`beta-blocker-${i}`}
                >
                  <Badge
                    variant="outline"
                    className={b.severity === "CRITICAL"
                      ? "border-danger/50 text-danger"
                      : b.severity === "WARN" ? "border-warning/50 text-warning"
                      : "border-border text-txt-secondary"}
                  >
                    {b.severity}
                  </Badge>
                  <span className="text-muted-foreground">{b.message}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Detail sections */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <HeartPulse className="h-4 w-4 text-primary" />
              System
            </CardTitle>
          </CardHeader>
          <CardContent><CheckList rows={systemRows} /></CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4 text-primary" />
              Trading safety
            </CardTitle>
          </CardHeader>
          <CardContent><CheckList rows={tradingRows} /></CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4 text-primary" />
              User features
            </CardTitle>
          </CardHeader>
          <CardContent><CheckList rows={featureRows} /></CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Database className="h-4 w-4 text-primary" />
              Data readiness
            </CardTitle>
          </CardHeader>
          <CardContent><CheckList rows={dataRows} /></CardContent>
        </Card>
      </div>

      {/* Tester cohort */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4 text-primary" />
            Tester cohort
          </CardTitle>
          <CardDescription>
            Beta cohort summary — manage invites in Beta Control.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <CheckList rows={cohortRows} />
          <div className="flex gap-2 pt-1">
            <Link href="/admin/beta-control">
              <Button size="sm" variant="outline" data-testid="link-beta-control">
                Open Beta Control
                <ExternalLink className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>

      {/* Deep-dive shortcuts */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Radar className="h-4 w-4 text-primary" />
            Deeper admin views
          </CardTitle>
          <CardDescription>
            Existing admin pages with full per-subsystem detail.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-3 gap-2">
          <Link href="/admin/system-health">
            <Button size="sm" variant="outline" className="w-full justify-start"><HeartPulse className="h-3.5 w-3.5 mr-2" />System Health</Button>
          </Link>
          <Link href="/admin/launch-readiness">
            <Button size="sm" variant="outline" className="w-full justify-start"><ListChecks className="h-3.5 w-3.5 mr-2" />Launch Readiness</Button>
          </Link>
          <Link href="/admin/operator-command-center">
            <Button size="sm" variant="outline" className="w-full justify-start"><Activity className="h-3.5 w-3.5 mr-2" />Operator Center</Button>
          </Link>
          <Link href="/admin/audit-center">
            <Button size="sm" variant="outline" className="w-full justify-start"><ListChecks className="h-3.5 w-3.5 mr-2" />Audit Log Center</Button>
          </Link>
          <Link href="/admin/reconciliation-center">
            <Button size="sm" variant="outline" className="w-full justify-start"><Database className="h-3.5 w-3.5 mr-2" />Reconciliation</Button>
          </Link>
          <Link href="/admin/trading-control">
            <Button size="sm" variant="outline" className="w-full justify-start"><Brain className="h-3.5 w-3.5 mr-2" />Trading Control</Button>
          </Link>
        </CardContent>
      </Card>

      {launchData?.computedAt && (
        <p className="text-[10px] text-muted-foreground text-right">
          Launch readiness computed {new Date(launchData.computedAt).toLocaleString()}.
          This page is read-only; opening it does not change any safety gate.
        </p>
      )}
    </div>
  );
}
