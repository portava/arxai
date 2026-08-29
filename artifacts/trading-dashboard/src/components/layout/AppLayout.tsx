import React, { useEffect, useMemo, useState, lazy, Suspense } from "react";
import { Link, useLocation } from "wouter";
import {
  Activity, Bot, Shield,
  AlertOctagon, Brain, BookOpen, Settings, FlaskConical, Sparkles,
  ChevronLeft, ChevronRight, ChevronDown, Target, FileText, Bell, Heart, Lock, Database, ShieldAlert,
  ListChecks, Briefcase, GitMerge, HelpCircle, User, Users, Crosshair,
  ScrollText, Trophy, Eye, Gauge, NotebookPen, BarChart3,
  Plug, LineChart, Award, ShieldCheck, Search, X, Zap, Wallet, LayoutGrid, Banknote,
  Thermometer, GraduationCap, Flag,
  Calendar as CalendarIcon,
  type LucideIcon,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Topbar, MobileMenuTrigger } from "./Topbar";
import { MobileBottomNav } from "./MobileBottomNav";
import { Footer } from "./Footer";
import { ARXLogoMark, ARXBrandLockup } from "@/components/brand/ARXLogo";
import { FloatingActionPanel } from "@/components/trading/FloatingActionPanel";
import { SafetyHeader } from "@/components/ss/SafetyHeader";
import { LiveModeBadge } from "@/components/live/LiveModeBadge";
import NotificationCenter from "@/components/NotificationCenter";
import { CommandPalette } from "./CommandPalette";
import { cn } from "@/lib/utils";
import { useAssistantName } from "@/lib/assistant-name";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useViewMode } from "@/hooks/useViewMode";
import { useProductRole } from "@/hooks/useProductRole";
import { useTraderTier } from "@/hooks/useTraderTier";
import { RouteAccessGuard } from "./RouteAccessGuard";

// Lazy-load the Ruby assistant panel (voice / realtime-WebRTC / TTS stack) so
// its large module graph stays OUT of every page's first-paint critical path.
// The panel is collapsed by default; its floating trigger button appears a
// beat after first paint once the chunk has streamed in. This is the single
// biggest first-paint win because AppLayout mounts on every route.
const ArxAssistantLivePanel = lazy(() =>
  import("@/components/help/ArxAssistantLivePanel").then((m) => ({
    default: m.ArxAssistantLivePanel,
  })),
);

interface NavItem { href: string; label: string; icon: LucideIcon; className?: string; adminOnly?: boolean; approvedOnly?: boolean; aliases?: string[]; description?: string; }
interface NavGroup { label: string; items: NavItem[]; defaultOpen?: boolean; adminOnly?: boolean; approvedOnly?: boolean; }

// Curated aliases / descriptions for the menu search so users can find
// pages by intent ("demo", "ruby", "scanner") not just exact labels.
const buildSearchAliases = (name: string): Record<string, { aliases?: string[]; description?: string }> => ({
  "/": { aliases: ["home", "cockpit", "overview"], description: "Live overview of P&L, account, signals" },
  "/live-chart": { aliases: ["chart", "market", "candles", "ohlc"], description: "Live OHLC chart with overlays" },
  "/trade-command-room": { aliases: ["trade", "order", "ticket", "execute", "buy", "sell"], description: "Compose and review AI trade setups" },
  "/watchlists": { aliases: ["symbols", "favorites"], description: "Your tracked symbols" },
  "/mt5-bridge": { aliases: ["mt5", "metatrader", "bridge", "ea", "demo bridge", "broker"], description: "MT5 demo bridge status, positions, and demo dispatch" },
  "/mt5-setup": { aliases: ["mt5 setup", "demo setup", "bridge wizard", "ea install", "demo execution", "demo positions"], description: "MT5 bridge setup wizard + demo execution + open demo positions" },
  "/my-trades": { aliases: ["trades", "live trades"], description: "Your currently open trades" },
  "/action-center": { aliases: ["actions", "approvals"], description: "Pending actions requiring your confirmation" },
  "/sniper-watchlist": { aliases: ["sniper", "watchlist"], description: "High-conviction entry candidates" },
  "/positions": { aliases: ["positions", "oms"], description: "Positions and order management" },
  "/trade-logs": { aliases: ["history", "trade history", "logs", "past trades"], description: "Full trade history with filters" },
  "/risk-command-center": { aliases: ["risk", "drawdown", "exposure", "risk manager"], description: "Risk governor, limits, kill switch" },
  "/risk-settings": { aliases: ["risk settings", "risk governor", "limits"], description: "Configure risk limits and guards" },
  "/live-intent-queue": { aliases: ["queue", "intent", "execution"], description: "Live intent and execution queue" },
  "/journal": { aliases: ["journal", "notes", "diary"], description: "Your trading journal" },
  "/scalp-journal": { aliases: ["scalp journal", "ruby journal", "scalp history", "scalp lessons", "after action review", "market lessons"], description: `${name}'s scalp journal, after-action reviews, and per-market lessons` },
  "/trading-calendar": { aliases: ["calendar", "events"], description: "Trading day calendar" },
  "/performance-scorecard": { aliases: ["scorecard", "win loss", "performance"], description: "Win/loss report and breakdown" },
  "/analytics": { aliases: ["analytics", "stats", "account analytics"], description: "Account analytics dashboard" },
  "/ai-readiness-score": { aliases: ["readiness", "ai score"], description: "Admin: shadow-mode readiness score (not per-user)" },
  "/ai-coach": { aliases: ["ai", "ruby", "assistant", "coach", "chat", "help me"], description: `${name} — your ARX trading assistant` },
  "/market-scanner": { aliases: ["scanner", "entry sniper", "signals", "alerts"], description: "Real-time market scanner with confidence scores" },
  "/trade-grader": { aliases: ["grader", "review trade", "trade review"], description: "Grade and review your trades" },
  "/market-heat-map": { aliases: ["heat", "heat map", "timing", "heat score", "ruby timing", "market timing", "sessions", "news heat", "broad flow", "danger windows"], description: "Market heat map: heat scores, session windows, news heat, broad flow" },
  "/market-health": { aliases: ["bias", "market bias", "health"], description: "Market regime and bias indicators" },
  "/strategy-lab": { aliases: ["strategy", "lab", "backtest builder"], description: "Build, edit, and test strategies" },
  "/settings": { aliases: ["settings", "config", "preferences"], description: "App settings and preferences" },
  "/admin-control": { aliases: ["profile", "account", "me"], description: "Your profile and account controls" },
  "/notifications": { aliases: ["notifications", "alerts", "bell"], description: "Notifications center" },
  "/help": { aliases: ["help", "support", "faq"], description: "Help and documentation" },
  "/emergency": { aliases: ["emergency", "stop", "panic", "kill switch"], description: "Emergency stop — halts all trading" },
  "/autopilot-control-center": { aliases: ["autopilot", "auto", "bot"], description: "Autopilot control center" },
  "/testing-lab": { aliases: ["testing lab", "backtest", "backtesting", "forward test", "forward testing", "strategy testing", "history test", "comparison", "shadow mode", "tournament", "strategy promotion"], description: "Backtest, forward test, compare, and review strategy results (admin: shadow / tournament / promotion tabs)" },
  "/economic-calendar": { aliases: ["calendar", "economic calendar", "news", "events", "news risk", "risk news"], description: "Economic calendar with the News Risk tab" },
  "/prop-firm-mode": { aliases: ["prop firm", "challenge", "ftmo"], description: "Prop firm mode rules" },
  "/orders": { aliases: ["order ticket", "manual trade", "ticket"], description: "Manual order ticket" },
  "/broker-readonly": { aliases: ["broker", "broker readonly"], description: "Broker connection (read-only)" },
});

// Build E — Premium navigation: 9 primary sections, flat (no group labels).
// Secondary pages remain reachable by direct URL but are not exposed in nav,
// matching the user directive "archive or hide duplicate pages only if safe."
// Build QQ — simplified navigation. Primary group is the Cockpit + paper
// session workflow. Secondary pages remain reachable by direct URL.
// App Shell 4.0 — simplified, user-first nav per Nov-2025 nav spec.
//
// • Primary Tools first (8 most-used surfaces).
// • Account & Control second (account, history, settings, help).
// • Power features preserved under collapsible groups so nothing is lost.
// • Admin-only routes live in the Admin group (adminOnly: true) which only
//   renders for OWNER/ADMIN sessions. Regular users never see admin items
//   in the side menu (backend route guards still authoritative).
// • Every existing route from the previous nav remains reachable here.
const buildNavGroups = (name: string): NavGroup[] => [
  // ── NORMAL-USER NAVIGATION ──────────────────────────────────────────────
  // ARX product-scope pruning: normal users see only the focused trading
  // command center (Cockpit · Scanner/Trade · Ruby · Risk · Account). Every
  // other surface lives in the adminOnly groups below — still fully reachable
  // by direct URL and by OWNER/ADMIN sessions; nothing is deleted, and backend
  // route guards remain authoritative.
  // ── Essentials — visible to EVERY human trader (pending + approved). ──
  // The reduced, non-execution menu a pending/unapproved trader sees: get
  // started, watch ARX status, learn. Account/Settings/Help live in their own
  // always-visible group below. Approved traders + admins see this too.
  {
    label: "Essentials",
    items: [
      { href: "/",                      label: "Cockpit",        icon: Target },
      { href: "/status-command-center", label: "ARX Status",     icon: Sparkles },
      { href: "/onboarding",            label: "Onboarding",     icon: Sparkles },
      { href: "/school", label: "Trading School", icon: GraduationCap, aliases: ["learn", "school", "course", "education", "lessons"], description: `Learn trading step by step with ${name}` },
    ],
  },
  // ── Primary trading — APPROVED (live / shared-bridge) traders only. ──
  // Execution / scanner / chart-trading / positions surfaces. Hidden AND
  // route-blocked for pending traders; admins always see it.
  {
    label: "Primary",
    approvedOnly: true,
    items: [
      { href: "/market-scanner",      label: "Market Scanner", icon: Search },
      { href: "/trade-command-room",  label: "Trade",          icon: Crosshair },
      { href: "/live-trading",        label: "Live Trading",   icon: Zap },
      { href: "/ai-command-center",   label: `${name} (AI)`,      icon: Brain },
      { href: "/my-trades",           label: "Open Trades",    icon: Briefcase },
      // Simulator OMS surface — every mutation in routes/oms.ts is
      // requireAdmin. The per-user trade surface is Open Trades above.
      { href: "/positions",           label: "Positions",      icon: Briefcase, adminOnly: true },
      { href: "/risk-command-center", label: "Risk",           icon: Shield },
      { href: "/profit-missions",     label: "Profit Mission", icon: Flag },
      { href: "/alerts",              label: "Alerts",         icon: Bell },
    ],
  },
  {
    label: "Markets & Tools",
    defaultOpen: false,
    approvedOnly: true,
    items: [
      { href: "/live-chart",        label: "Live Market Chart", icon: Activity },
      { href: "/watchlists",        label: "Watchlist",         icon: Eye },
      // Manual Ticket backs onto requireAdmin-only mutations (oms.ts order
      // routes).
      { href: "/orders",            label: "Manual Ticket",     icon: ListChecks, adminOnly: true },
      { href: "/mt5-setup",         label: "MT5 Setup",         icon: Plug },
      { href: "/market-heat-map",   label: "Market Heat Map",   icon: Thermometer },
      // News Risk is a tab of the Economic Calendar now (item E). Its old
      // adminOnly flag was a leftover from the retired simulator CRUD — the
      // folded surface reads only ungated endpoints, so no admin gate here.
      { href: "/economic-calendar", label: "Economic Calendar", icon: CalendarIcon },
    ],
  },
  {
    label: "Performance & History",
    defaultOpen: false,
    approvedOnly: true,
    items: [
      { href: "/performance-scorecard", label: "Win/Loss Report",   icon: Trophy },
      { href: "/analytics",             label: "Account Analytics", icon: BarChart3 },
      { href: "/trade-logs",            label: "Trade History",     icon: ScrollText },
      { href: "/journal",               label: "Journal",           icon: NotebookPen },
      { href: "/scalp-journal",         label: "Scalp Journal",     icon: BookOpen },
    ],
  },
  // Account & Control — visible to EVERY human trader (pending + approved).
  {
    label: "Account & Control",
    defaultOpen: false,
    items: [
      { href: "/my-account", label: "Account",  icon: Wallet },
      { href: "/settings",   label: "Settings", icon: Settings },
      { href: "/help",       label: "Help",     icon: HelpCircle },
    ],
  },
  // ── ADVANCED / POWER SURFACES (adminOnly — hidden from normal-user nav) ──
  {
    label: "Advanced Trading",
    defaultOpen: false,
    adminOnly: true,
    items: [
      { href: "/sniper-watchlist",      label: "Sniper Watchlist",      icon: Crosshair, adminOnly: true },
      { href: "/action-center",         label: "Action Center",         icon: ShieldCheck, adminOnly: true },
      { href: "/live-intent-queue",     label: "Execution Center",      icon: ListChecks, adminOnly: true },
      { href: "/mt5-bridge",            label: "MT5 Bridge",            icon: Plug, adminOnly: true },
      { href: "/broker-reconciliation", label: "Broker Reconciliation", icon: GitMerge, adminOnly: true },
      { href: "/live-trading-control",  label: "Live Trading Control",  icon: ShieldCheck, adminOnly: true },
      { href: "/live-shared",           label: "Live Shared",           icon: Activity, adminOnly: true },
      { href: "/live-manual",           label: "Live Manual Tester",    icon: Target, adminOnly: true },
      { href: "/live-ai-assist",        label: "Live AI Assist",        icon: Brain, adminOnly: true },
      { href: "/live-ai-auto-test",     label: "Live AI Auto Tester",   icon: Sparkles, adminOnly: true },
    ],
  },
  {
    label: "Advanced AI & Strategy",
    defaultOpen: false,
    approvedOnly: true,
    items: [
      { href: "/ai-coach",                 label: "AI Coach",               icon: Brain },
      { href: "/trade-grader",             label: "Trade Review",           icon: Award },
      { href: "/market-health",            label: "Market Bias",            icon: LineChart },
      { href: "/strategy-lab",             label: "Strategy Lab",           icon: FlaskConical },
      { href: "/autopilot-control-center", label: "Autopilot",              icon: Bot, adminOnly: true },
      // Shadow Mode / Strategy Tournament / Strategy Promotion are Testing Lab
      // tabs now (item C) — one entry, admin-only tab triggers inside the page.
      { href: "/shadow-journal",           label: "Shadow Journal",         icon: NotebookPen, adminOnly: true },
      { href: "/testing-lab",              label: "Testing Lab",            icon: FlaskConical },
      { href: "/market-replay",            label: "Market Replay",          icon: FlaskConical, adminOnly: true },
      { href: "/confidence-calibration",   label: "Confidence Calibration", icon: Gauge, adminOnly: true  },
      { href: "/brain",                    label: "Brain Analysis",         icon: Brain },
      { href: "/edge-discovery",           label: "Edge Discovery",         icon: Sparkles },
      { href: "/trader-skill",             label: "Trader Skill",           icon: Trophy },
      { href: "/ai-readiness-score",       label: "Discipline Score",       icon: Gauge, adminOnly: true  },
      { href: "/trading-intelligence",     label: "Trading Intelligence",   icon: Brain },
      { href: "/weekly-review",            label: "Weekly Review",          icon: FileText },
      { href: "/trade-plan-builder",       label: "Trade Plan Builder",     icon: NotebookPen },
      { href: "/post-trade-debriefs",      label: "Post-Trade Debriefs",    icon: NotebookPen },
    ],
  },
  {
    label: "Advanced Risk & Data",
    defaultOpen: false,
    adminOnly: true,
    items: [
      { href: "/risk-settings",  label: "Risk Governor",  icon: Shield, adminOnly: true },
      { href: "/risk-profile",   label: "Risk Profile",   icon: Shield, adminOnly: true },
      { href: "/risk-events",    label: "Risk Events",    icon: ScrollText, adminOnly: true },
      { href: "/data-quality",   label: "Data Quality",   icon: Database, adminOnly: true },
    ],
  },
  {
    label: "Records & System",
    defaultOpen: false,
    adminOnly: true,
    items: [
      { href: "/audit-vault",           label: "Audit Vault",     icon: FileText, adminOnly: true },
      { href: "/safety-logs",           label: "Safety Logs",     icon: FileText, adminOnly: true },
      { href: "/notifications",         label: "Notifications",   icon: Bell, adminOnly: true },
      { href: "/admin-control",         label: "Profile",         icon: User, adminOnly: true },
      { href: "/release-status",        label: "Release Status",  icon: Sparkles, adminOnly: true },
      { href: "/release-notes",         label: "Release Notes",   icon: FileText, adminOnly: true },
      { href: "/feedback-center",       label: "Feedback Center", icon: BookOpen, adminOnly: true },
    ],
  },
  {
    label: "Admin",
    defaultOpen: false,
    adminOnly: true,
    // Slimmed to the Admin Hub plus a few high-priority shortcuts. Every other
    // admin tool now lives behind the Admin Hub tabs (/admin) and stays
    // reachable by direct URL — no page or route was removed. See
    // pages/admin/admin-hub.tsx for the full tabbed tool index.
    items: [
      { href: "/admin/cockpit",            label: "Admin Cockpit",        icon: Gauge,       adminOnly: true },
      { href: "/admin",                    label: "Admin Hub",            icon: LayoutGrid,  adminOnly: true },
      { href: "/self-trade-ai",            label: "Self-Trade AI",        icon: Bot,         adminOnly: true },
      { href: "/admin/fund-control-center", label: "Fund Control Center", icon: Banknote,    adminOnly: true },
      { href: "/admin/users",              label: "Users & Accounts",     icon: Users,       adminOnly: true },
      { href: "/admin/trading-control",    label: "Live Controls",        icon: ShieldCheck, adminOnly: true },
      { href: "/admin/bridge-diagnostics", label: "Bridge / MT5 / Deriv", icon: Plug,        adminOnly: true },
      { href: "/admin/system-health",      label: "QA / Health",          icon: Activity,    adminOnly: true },
    ],
  },
  {
    label: "",
    items: [{ href: "/emergency", label: "Emergency Stop", icon: AlertOctagon, className: "text-destructive hover:text-destructive" }],
  },
];

// Minimal nav for INVESTOR accounts (Task #71). Investors are view-only and
// confined to the Investor Portal + universal account/help surfaces; they never
// see trading, scanner, or admin items. RouteAccessGuard enforces containment.
const INVESTOR_NAV_GROUPS: NavGroup[] = [
  {
    label: "Investor",
    items: [
      { href: "/investor",   label: "Investor Portal", icon: ShieldCheck },
      { href: "/my-account", label: "Account",         icon: Wallet },
      { href: "/settings",   label: "Settings",        icon: Settings },
      { href: "/help",       label: "Help",            icon: HelpCircle },
    ],
  },
];

const GROUP_KEY = (label: string) => `arx.nav.group.${label || "_root"}`;
function isGroupOpen(label: string, defaultOpen: boolean): boolean {
  if (typeof window === "undefined") return defaultOpen;
  const v = localStorage.getItem(GROUP_KEY(label));
  if (v === null) return defaultOpen;
  return v === "1";
}

const RECENT_KEY = "arx.nav.recent.v1";
function readRecent(): string[] {
  if (typeof localStorage === "undefined") return [];
  try { const v = localStorage.getItem(RECENT_KEY); return v ? (JSON.parse(v) as string[]).slice(0, 5) : []; } catch { return []; }
}
function pushRecent(href: string) {
  if (typeof localStorage === "undefined") return;
  try {
    const cur = readRecent().filter((h) => h !== href);
    cur.unshift(href);
    localStorage.setItem(RECENT_KEY, JSON.stringify(cur.slice(0, 5)));
  } catch { /* noop */ }
}

export function SidebarContent({ collapsed = false, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const [location, setLocation] = useLocation();
  const { user } = useCurrentUser();
  const { effectiveIsAdmin: isAdmin } = useViewMode();
  const { isInvestor } = useProductRole();
  const { isApprovedTrader } = useTraderTier();
  const { name } = useAssistantName();
  void user;

  // A nav item / group is visible when the role gate (adminOnly) passes AND the
  // two-tier approval gate (approvedOnly) passes. Admins bypass both. Pending /
  // unapproved / loading-approval traders never see approvedOnly surfaces.
  const canSee = (entry: { adminOnly?: boolean; approvedOnly?: boolean }) =>
    (!entry.adminOnly || isAdmin) &&
    (!entry.approvedOnly || isAdmin || isApprovedTrader);
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>(() => readRecent());

  // Investor accounts get a minimal, view-only nav; everyone else uses the
  // full product nav (admin items pruned for non-admins below).
  const navGroups = isInvestor ? INVESTOR_NAV_GROUPS : buildNavGroups(name);

  // Flat searchable index built from the active nav groups + aliases.
  const searchIndex = useMemo(() => {
    const searchAliases = buildSearchAliases(name);
    const out: Array<{ item: NavItem; group: string; haystack: string }> = [];
    for (const g of navGroups) {
      for (const it of g.items) {
        const meta = searchAliases[it.href] ?? {};
        const hay = [
          it.label,
          g.label,
          it.href,
          meta.description ?? "",
          ...(meta.aliases ?? []),
        ].join(" ").toLowerCase();
        out.push({
          item: { ...it, aliases: meta.aliases, description: meta.description },
          group: g.label,
          haystack: hay,
        });
      }
    }
    return out;
  }, [navGroups, name]);

  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q) return [];
    const toks = q.split(/\s+/).filter(Boolean);
    return searchIndex
      .filter(({ item }) => canSee(item))
      .filter(({ haystack }) => toks.every((t) => haystack.includes(t)))
      .slice(0, 12);
  }, [q, searchIndex, isAdmin, isApprovedTrader]);

  function recentItems(): Array<{ item: NavItem; group: string }> {
    return recent
      .map((href) => searchIndex.find((s) => s.item.href === href))
      .filter((v): v is { item: NavItem; group: string; haystack: string } => Boolean(v))
      .filter(({ item }) => canSee(item))
      .slice(0, 5);
  }

  function navigate(href: string) {
    pushRecent(href);
    setRecent(readRecent());
    setQuery("");
    setLocation(href);
    onNavigate?.();
  }

  // Per-group expand/collapse state (only meaningful when not collapsed).
  const [openMap, setOpenMap] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const g of navGroups) {
      const def = g.defaultOpen !== false; // default: open unless explicitly false
      init[g.label] = isGroupOpen(g.label, def);
    }
    return init;
  });
  function toggleGroup(label: string) {
    setOpenMap((m) => {
      const next = !m[label];
      try { localStorage.setItem(GROUP_KEY(label), next ? "1" : "0"); } catch { /* noop */ }
      return { ...m, [label]: next };
    });
  }
  return (
    <div className="flex flex-col h-full bg-sidebar border-r border-sidebar-border">
      <div className={cn("border-b border-sidebar-border flex items-center gap-3 shrink-0", collapsed ? "p-3 justify-center" : "p-4 md:p-5")} data-testid="sidebar-brand">
        {collapsed ? (
          <ARXLogoMark size="md" mode="dark" title="ARX AI — Analyze. Risk. eXecute." />
        ) : (
          <ARXBrandLockup mode="dark" size="md" />
        )}
      </div>
      {!collapsed && (
        <div className="px-3 pt-3 pb-2 border-b border-sidebar-border space-y-2 shrink-0" data-testid="sidebar-search">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-sidebar-foreground/40" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search ARX…"
              aria-label="Search ARX menu"
              className="h-8 pl-8 pr-7 text-xs bg-sidebar-accent/30 border-sidebar-border text-sidebar-foreground placeholder:text-sidebar-foreground/40"
              data-testid="input-sidebar-search"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-sidebar-foreground/50 hover:text-sidebar-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {!q && recentItems().length > 0 && (
            <div className="flex flex-wrap gap-1">
              {recentItems().map(({ item }) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.href}
                    type="button"
                    onClick={() => navigate(item.href)}
                    className="inline-flex items-center gap-1 rounded-full border border-sidebar-border bg-sidebar-accent/30 px-2 py-0.5 text-[10px] text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                    data-testid={`sidebar-recent-${item.href.replace(/\//g, "-") || "home"}`}
                  >
                    <Icon size={10} />
                    {item.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      {q && !collapsed && (
        <div className="flex-1 overflow-y-auto p-2" data-testid="sidebar-search-results">
          {results.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-sidebar-foreground/50" data-testid="sidebar-search-empty">
              No results found for “{query.trim()}”.
            </div>
          ) : (
            <div className="space-y-0.5">
              {results.map(({ item, group }) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.href}
                    type="button"
                    onClick={() => navigate(item.href)}
                    className="w-full flex items-start gap-2 rounded-md px-2.5 py-2 text-left text-sidebar-foreground/85 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
                    data-testid={`sidebar-result-${item.href.replace(/\//g, "-") || "home"}`}
                  >
                    <Icon size={14} className="mt-0.5 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-[13px] font-medium leading-tight truncate">{item.label}</span>
                        <span className="text-[9px] uppercase tracking-wider text-sidebar-foreground/40 shrink-0">{group}</span>
                      </div>
                      {item.description && (
                        <div className="text-[10px] text-sidebar-foreground/55 truncate">{item.description}</div>
                      )}
                      <div className="text-[9px] text-sidebar-foreground/35 font-mono truncate">{item.href}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      <nav className={cn("flex-1 overflow-y-auto", collapsed ? "p-2 space-y-1" : "p-3 space-y-3", q && !collapsed && "hidden")}>
        {navGroups.map((group, gi) => {
          if (!canSee(group)) return null;
          const visibleItems = group.items.filter((it) => canSee(it));
          if (visibleItems.length === 0) return null;
          const open = collapsed || openMap[group.label] !== false;
          return (
          <div key={`${group.label}-${gi}`}>
            {!collapsed && group.label && (
              <button
                type="button"
                onClick={() => toggleGroup(group.label)}
                className="w-full flex items-center justify-between text-[9px] font-bold uppercase tracking-[0.18em] text-sidebar-foreground/35 px-3 mb-1.5 hover:text-sidebar-foreground/70"
                data-testid={`nav-group-${group.label.toLowerCase().replace(/\s+/g, "-")}`}
                aria-expanded={open}
              >
                <span>{group.label}</span>
                <ChevronDown size={10} className={cn("transition-transform", open ? "" : "-rotate-90")} />
              </button>
            )}
            {open && (
            <div className="space-y-0.5">
              {visibleItems.map((item) => {
                const Icon = item.icon;
                const isActive = location === item.href;
                const button = (
                  <Button
                    variant="ghost"
                    className={cn(
                      "w-full text-[13px] font-medium transition-colors",
                      collapsed ? "h-10 justify-center px-0" : "justify-start gap-2.5 rounded-md px-3 py-1.5 h-8",
                      isActive
                        ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold"
                        : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                      item.className
                    )}
                    data-testid={`nav-${item.href.replace(/\//g, "-") || "home"}`}
                  >
                    <Icon size={collapsed ? 18 : 15} className={isActive ? "text-primary" : ""} />
                    {!collapsed && item.label}
                  </Button>
                );
                return (
                  <Link key={item.href} href={item.href} className="block" onClick={() => { pushRecent(item.href); setRecent(readRecent()); onNavigate?.(); }}>
                    {collapsed ? (
                      <Tooltip>
                        <TooltipTrigger asChild>{button}</TooltipTrigger>
                        <TooltipContent side="right">{item.label}</TooltipContent>
                      </Tooltip>
                    ) : button}
                  </Link>
                );
              })}
            </div>
            )}
          </div>
          );
        })}
      </nav>
      {!collapsed && (
        <div className="p-3 border-t border-sidebar-border text-[10px] text-sidebar-foreground/45 leading-relaxed shrink-0">
          <p className="font-semibold mb-1 text-sidebar-foreground/60">⚠ RISK NOTICE</p>
          <p>Live trading platform. AI analysis and signals are for informational purposes only. Trade responsibly.</p>
        </div>
      )}
    </div>
  );
}

const COLLAPSE_KEY = "highroll.sidebarCollapsed";


export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const hideGlobalHeader = location === "/" || location === "/trade-command-room";
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  });

  useEffect(() => {
    document.documentElement.classList.add("dark");
    localStorage.setItem("theme", "dark");
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      return next;
    });
  };

  return (
    <div className="min-h-screen flex bg-background text-foreground font-sans overflow-x-clip">
      {/* SS — skip-to-content link for keyboard/screen-reader users */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-primary focus:text-primary-foreground focus:px-3 focus:py-1.5 focus:rounded-md focus:text-sm focus:font-semibold"
      >
        Skip to main content
      </a>
      {/* Desktop sidebar (collapsible) */}
      <aside className={cn("hidden md:block shrink-0 sticky top-0 h-screen relative transition-all duration-200", collapsed ? "w-16" : "w-60")}>
        <SidebarContent collapsed={collapsed} />
        <button
          onClick={toggleCollapsed}
          className="absolute -right-3 top-20 z-20 w-6 h-6 rounded-full bg-card border border-border shadow-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-primary transition-colors"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          data-testid="button-sidebar-collapse"
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>
      </aside>

      {/* Main column */}
      <div className="flex-1 min-w-0 flex flex-col">
        {!hideGlobalHeader && (
        <Topbar
          onMobileMenu={
            <MobileMenuTrigger>
              {(close) => <SidebarContent onNavigate={close} />}
            </MobileMenuTrigger>
          }
        />
        )}
        {/* T025 — single compact status row: one LIVE chip (left) + alerts
            bell (right). The full-width billboard banner (mode label + user
            message + "Real money risk") was removed; live mode and any
            blocked/kill-switch state now surface only through the compact
            LiveModeBadge chip, whose tooltip carries the longer detail. */}
        {!hideGlobalHeader && (
        <div className="flex items-center justify-between gap-2 px-4 py-1 border-b border-zinc-900 bg-zinc-950/60">
          <LiveModeBadge />
          <NotificationCenter />
        </div>
        )}
        {/* Legacy SS safety header — kept for operator-facing context until
            Phase 3 ships and the broker placement layer replaces it. */}
        {!hideGlobalHeader && <SafetyHeader />}
        <main id="main-content" className="flex-1 min-w-0 overflow-y-auto overflow-x-clip pb-24 md:pb-0 pb-[max(6rem,calc(env(safe-area-inset-bottom)+5rem))] md:pb-[unset]" tabIndex={-1}>
          <div className="min-w-0 p-3 sm:p-4 md:p-6 max-w-[1600px] mx-auto w-full">
            <RouteAccessGuard>{children}</RouteAccessGuard>
          </div>
          <Footer />
        </main>
      </div>

      {/* Mobile bottom nav + universal floating action panel */}
      <MobileBottomNav />
      <FloatingActionPanel />
      <CommandPalette />
      <Suspense fallback={null}>
        <ArxAssistantLivePanel />
      </Suspense>
    </div>
  );
}
