// Admin Hub — one organized command center for all OWNER/admin tools.
//
// This page does NOT replace or rebuild any existing admin page. It is a
// clean, tabbed front door that deep-links to every existing admin route so
// operators have one organized place to work from instead of a long scattered
// menu. Every linked route remains independently registered in App.tsx and
// reachable by direct URL.
//
// Access: this page lives under the /admin prefix, so RouteAccessGuard already
// requires an effective-admin session (investors, normal users, logged-out,
// and admin-previewing-as-user are all blocked before this renders). The
// AdminDiagnosticsGate wrapper is defence-in-depth for the preview-as-user
// case and keeps the hub consistent with the other operator surfaces.

import { ReactNode } from "react";
import { Link } from "wouter";
import { useAssistantName } from "@/lib/assistant-name";
import {
  LayoutDashboard,
  Users,
  Ticket,
  Lock,
  Zap,
  Plug,
  Download,
  ScrollText,
  Brain,
  Activity,
  ChevronRight,
} from "lucide-react";
import { PageTabs, type PageTab } from "@/components/ui/PageTabs";
import { AdminDiagnosticsGate } from "@/components/admin/AdminDiagnosticsGate";

type AdminLink = { href: string; label: string; desc: string };
type AdminGroup = { heading?: string; links: AdminLink[] };
type AdminTabDef = {
  id: string;
  label: string;
  icon: ReactNode;
  intro?: string;
  groups: AdminGroup[];
};

// Every href below maps to a route already registered in App.tsx. No route is
// created or removed here — this is navigation/organization only.
const ADMIN_TABS: AdminTabDef[] = [
  {
    id: "overview",
    label: "Overview",
    icon: <LayoutDashboard className="h-4 w-4" />,
    intro:
      "Quick access to the controls operators reach for most. Each card opens the full tool.",
    groups: [
      {
        heading: "Critical controls",
        links: [
          { href: "/admin/operator-command-center", label: "Operator Command Center", desc: "System, bridge, safety and approval summary" },
          { href: "/admin/trading-control", label: "Live Trading Control", desc: "Live trading status, approvals and safety switches" },
          { href: "/emergency", label: "Emergency Stop", desc: "Stop all trading activity immediately" },
          { href: "/admin/system-health", label: "System Health", desc: "Live service, database and safety status" },
        ],
      },
      {
        heading: "Recent activity",
        links: [
          { href: "/admin/audit-center", label: "Audit Log Center", desc: "Recent admin actions and safety events" },
          { href: "/admin-control", label: "Admin Activity & Safe Actions", desc: "Run safe maintenance actions and review the action log" },
        ],
      },
    ],
  },
  {
    id: "users",
    label: "Users",
    icon: <Users className="h-4 w-4" />,
    intro: "Manage accounts, roles and investor relationships.",
    groups: [
      {
        links: [
          { href: "/admin/fund-control-center", label: "Fund Control Center", desc: "Unified pools, broker mirror, capital queue and fee policy" },
          { href: "/admin/user-control-center", label: "User Control Center", desc: "Directory, account status, roles and access" },
          { href: "/admin/investors", label: "Investor Management", desc: "View-only investor accounts and statements" },
          { href: "/admin/allocations", label: "Allocations", desc: "Capital allocation across accounts" },
        ],
      },
    ],
  },
  {
    id: "invites",
    label: "Invites",
    icon: <Ticket className="h-4 w-4" />,
    intro: "Invitation-only signup and beta access controls.",
    groups: [
      {
        links: [
          { href: "/admin/beta-control", label: "Beta & Invite Control", desc: "Invite codes, approvals and signup access" },
          { href: "/admin/beta-readiness", label: "Beta Readiness", desc: "Readiness checks before opening access" },
        ],
      },
    ],
  },
  {
    id: "permissions",
    label: "Permissions",
    icon: <Lock className="h-4 w-4" />,
    intro: "Role rules, approvals and account restrictions.",
    groups: [
      {
        links: [
          { href: "/admin/permissions", label: "Role Permissions", desc: "Role-based access and admin access rules" },
          { href: "/admin/user-control-center", label: "Live Access Approvals", desc: "Per-user live trading approval toggles" },
          { href: "/admin/security-status", label: "Security Status", desc: "Access and safety posture overview" },
        ],
      },
    ],
  },
  {
    id: "live-controls",
    label: "Live Controls",
    icon: <Zap className="h-4 w-4" />,
    intro:
      "Live trading enablement, approvals and the owner verification cycle. Safety gates always apply.",
    groups: [
      {
        links: [
          { href: "/admin/trading-control", label: "Live Trading Control", desc: "Live status, approvals and safety switches" },
          { href: "/admin/master-bridge", label: "Master Bridge", desc: "Shared live account and approval controls" },
          { href: "/admin/final-live-test", label: "Owner Live Test Cycle", desc: "Single verification open/close cycle" },
          { href: "/admin/live-test-readiness", label: "Live Test Readiness", desc: "Pre-test readiness and disclosure status" },
          { href: "/admin/live-shared", label: "Live Shared Account", desc: "Shared live account state" },
          { href: "/admin/live-shared/activation", label: "Live Shared Activation", desc: "Activate the shared live account" },
          { href: "/admin/one-click-controls", label: "One-Click Controls", desc: "Grant / revoke shared-bridge one-click trading permission" },
          { href: "/emergency", label: "Emergency Stop", desc: "Stop all trading immediately" },
        ],
      },
    ],
  },
  {
    id: "bridge",
    label: "Bridge / MT5 / Deriv",
    icon: <Plug className="h-4 w-4" />,
    intro: "Bridge, EA and market-feed connection health.",
    groups: [
      {
        links: [
          { href: "/admin/bridge-diagnostics", label: "Bridge Diagnostics", desc: "Bridge connection and command-queue status" },
          { href: "/admin/ea-health", label: "EA Health", desc: "Expert Advisor connection and heartbeat" },
          { href: "/admin/bridge-v2-monitor", label: "Bridge v2 Monitor", desc: "Bridge v2 broker-truth telemetry and transport integrity" },
          { href: "/admin/deriv-health", label: "Deriv Health", desc: "Deriv account and feed status" },
          { href: "/admin/provider-health", label: "Market Data Health", desc: "Data provider routing and status" },
          { href: "/admin/master-bridge", label: "Master Bridge", desc: "Master bridge state and approvals" },
          { href: "/admin/reconciliation-center", label: "Reconciliation Center", desc: "Position and fill reconciliation" },
        ],
      },
    ],
  },
  {
    id: "ea-download",
    label: "EA Download",
    icon: <Download className="h-4 w-4" />,
    intro: "Expert Advisor versions, downloads and setup status.",
    groups: [
      {
        links: [
          { href: "/admin/ea-updates", label: "EA Updates & Download", desc: "Latest EA version, download and update channel" },
          { href: "/admin/ea-health", label: "EA Connection Status", desc: "Confirm the EA is connected after install" },
        ],
      },
    ],
  },
  {
    id: "execution-logs",
    label: "Execution Logs",
    icon: <ScrollText className="h-4 w-4" />,
    intro:
      "Order, fill and reconciliation records. No simulated or assumed outcomes — only recorded results.",
    groups: [
      {
        links: [
          { href: "/admin/audit-center", label: "Audit Log Center", desc: "Order, dispatch and safety event log" },
          { href: "/audit-vault", label: "Audit Vault", desc: "Full audit record archive" },
          { href: "/safety-logs", label: "Safety Logs", desc: "Safety-relevant event history" },
          { href: "/admin/reconciliation-center", label: "P/L & Fill Review", desc: "Fill, close-fill and P/L reconciliation" },
          { href: "/admin/data-management", label: "Data Management", desc: "Records and data maintenance" },
        ],
      },
    ],
  },
  {
    id: "ai-intelligence",
    label: "AI Intelligence",
    icon: <Brain className="h-4 w-4" />,
    intro: "Strategy intelligence, learning and assistant configuration.",
    groups: [
      {
        links: [
          { href: "/trading-intelligence", label: "Trading Intelligence", desc: "Strategy scoring and intelligence overview" },
          { href: "/admin/chart-brain-benchmark", label: "Chart Brain Benchmark", desc: "Real receipt/outcome/governance scorecard" },
          { href: "/admin/agent-ecosystem", label: "Agent Ecosystem", desc: "Advisory agent team, family tree, household reports" },
          { href: "/self-trade-ai", label: "Self-Trade AI", desc: "Funded autonomous trading-agent fleet — control room" },
          { href: "/admin/ruby-quality", label: "Ruby Signal Quality", desc: "Outcome learning, missed-opportunity replay and audited tuning" },
          { href: "/admin/ai-fix-agent", label: "Backend Fix Agent", desc: "Advisory Claude diagnosis and dry-run patch proposals for backend errors" },
          { href: "/admin/timing-brain-snapshots", label: "Timing Brain Snapshots", desc: "Persisted heat-snapshot history per symbol — grade, entry permission, heat" },
          { href: "/admin/learning-versions", label: "Learning Versions", desc: "Learning model versions and lifecycle" },
          { href: "/learning", label: "Learning Center", desc: "Learning progress and history" },
          { href: "/brain", label: "Brain Analysis", desc: "Decision and reasoning analysis" },
          { href: "/admin/ruby-voice", label: "Ruby Voice Settings", desc: "Assistant voice configuration" },
        ],
      },
    ],
  },
  {
    id: "qa-health",
    label: "QA / Health",
    icon: <Activity className="h-4 w-4" />,
    intro: "System health, readiness checks and quality validation.",
    groups: [
      {
        heading: "Health & readiness",
        links: [
          { href: "/admin/system-health", label: "System Health", desc: "Service, database and safety status" },
          { href: "/admin/system-cohesion", label: "System Cohesion", desc: "AACI cohesion scores, handshakes, conflicts and learning health" },
          { href: "/admin/handshake-monitor", label: "System Handshake Monitor", desc: "Advisory cross-layer readiness check-ins" },
          { href: "/admin/launch-readiness", label: "Launch Readiness", desc: "Go-live readiness checklist" },
          { href: "/admin/beta-readiness", label: "Beta Readiness", desc: "Beta access readiness checks" },
          { href: "/admin/security-status", label: "Security Status", desc: "Security posture overview" },
        ],
      },
      {
        heading: "Diagnostics & QA",
        links: [
          { href: "/admin/issues", label: "Issue Tracker", desc: "Reported issues and feedback" },
          { href: "/admin/diagnostics", label: "Diagnostics Export", desc: "Export diagnostic snapshots" },
          { href: "/testing-control-center", label: "Testing Control", desc: "Test session controls" },
        ],
      },
    ],
  },
];

// Flat list of every route the Admin Hub deep-links to. Exported so the
// link-drift test can assert each one still resolves to a real route in
// App.tsx (and stays admin-gated). Keep this derived from ADMIN_TABS — never
// hand-maintain a second copy.
export const ADMIN_HUB_HREFS: readonly string[] = Array.from(
  new Set(ADMIN_TABS.flatMap((t) => t.groups.flatMap((g) => g.links.map((l) => l.href)))),
);

function LinkCard({ link }: { link: AdminLink }) {
  const { name } = useAssistantName();
  return (
    <Link href={link.href}>
      <a
        className="group flex items-start justify-between gap-3 rounded-lg bg-muted/40 p-3 transition-colors hover:bg-muted/70"
        data-testid={`admin-hub-link-${link.href.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`}
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">{link.label.replace(/Ruby/g, name)}</span>
          <span className="mt-0.5 block text-xs text-txt-muted">{link.desc}</span>
        </span>
        <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-txt-muted transition-colors group-hover:text-primary" aria-hidden="true" />
      </a>
    </Link>
  );
}

function TabBody({ tab }: { tab: AdminTabDef }) {
  return (
    <div className="space-y-6">
      {tab.intro && <p className="text-sm text-muted-foreground">{tab.intro}</p>}
      {tab.groups.map((group, gi) => (
        <div key={gi} className="rounded-xl border border-card-border bg-card p-6 shadow-sm">
          {group.heading && (
            <h3 className="mb-4 text-base font-semibold tracking-tight text-foreground">{group.heading}</h3>
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {group.links.map((l) => (
              <LinkCard key={l.href + l.label} link={l} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function AdminHubPage() {
  const tabs: PageTab[] = ADMIN_TABS.map((t) => ({
    id: t.id,
    label: t.label,
    icon: t.icon,
    content: <TabBody tab={t} />,
  }));

  return (
    <AdminDiagnosticsGate
      pageTitle="Admin Hub"
      pageDescription="The Admin Hub"
      userSafeMessage="This is the operator control hub. Your account does not require any action here."
    >
      <div className="mx-auto w-full max-w-[1280px] space-y-6" data-testid="page-admin-hub">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
            <LayoutDashboard className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Admin Hub</h1>
            <p className="text-sm text-muted-foreground">
              One organized place for every operator and OWNER control. Choose a section below.
            </p>
          </div>
        </div>
        <PageTabs tabs={tabs} storageKey="admin-hub" defaultTab="overview" />
      </div>
    </AdminDiagnosticsGate>
  );
}
