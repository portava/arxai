import React from "react";
import { Link } from "wouter";
import { useGetMt5Status, useGetBotStatus, getGetMt5StatusQueryKey, getGetBotStatusQueryKey } from "@workspace/api-client-react";
import { SymbolPicker } from "./SymbolPicker";
import { NotificationBell } from "@/components/alerts/NotificationBell";
import { WifiOff, Lock, Zap, Plug, Globe2, Sun, Moon, CloudMoon } from "lucide-react";
import { getCurrentSession } from "@/lib/symbol-context";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { StatusBadgeRow, type StatusPill } from "@/components/ui/StatusBadgeRow";
import { Menu } from "lucide-react";
import { ARXLogoMark, ARXWordmark } from "@/components/brand/ARXLogo";
import { useAllUnlocks } from "@/hooks/useFeatureUnlock";
import { useCurrentUser, useLogout } from "@/hooks/useCurrentUser";
import { useViewMode } from "@/hooks/useViewMode";
import { useTraderTier } from "@/hooks/useTraderTier";
import { LogOut, User as UserIcon, ShieldCheck, Eye } from "lucide-react";

const SESSION_META = {
  ASIA: { tone: "info" as const, icon: Moon, label: "Asia" },
  LONDON: { tone: "warning" as const, icon: CloudMoon, label: "London" },
  NEW_YORK: { tone: "bullish" as const, icon: Sun, label: "New York" },
  OFF: { tone: "neutral" as const, icon: Globe2, label: "Off" },
};

const MODE_META = {
  MOCK: { tone: "neutral" as const, icon: WifiOff, label: "Mock" },
  DEMO: { tone: "info" as const, icon: Plug, label: "Demo" },
  LIVE_LOCKED: { tone: "warning" as const, icon: Lock, label: "Live Locked" },
  LIVE: { tone: "danger" as const, icon: Zap, label: "LIVE" },
} as const;

export function Topbar({ onMobileMenu }: { onMobileMenu?: React.ReactNode }) {
  const unlocks = useAllUnlocks();
  const { effectiveIsAdmin } = useViewMode();
  const { isApprovedTrader } = useTraderTier();
  // Only poll MT5 / bot status once the user has unlocked those surfaces.
  // Fresh browser sessions get no leak of the global single-tenant state
  // (account, broker, mode, running flag) into the global header.
  const { data: mt5 } = useGetMt5Status({
    query: {
      queryKey: getGetMt5StatusQueryKey(),
      refetchInterval: 5000,
      enabled: unlocks.mt5,
    },
  });
  const { data: bot } = useGetBotStatus({
    query: {
      queryKey: getGetBotStatusQueryKey(),
      refetchInterval: 5000,
      enabled: unlocks.simulator || unlocks.mt5,
    },
  });
  const session = getCurrentSession();
  const sessionMeta = SESSION_META[session];
  const modeMeta = (mt5 && MODE_META[mt5.mode as keyof typeof MODE_META]) || MODE_META.MOCK;
  const SessionIcon = sessionMeta.icon;
  const ModeIcon = modeMeta.icon;

  return (
    <header className="sticky top-0 z-30 h-14 border-b border-border bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
      <div className="h-full px-3 md:px-6 flex items-center gap-3">
        {onMobileMenu}
        <div className="md:hidden flex items-center gap-2 mr-1" data-testid="topbar-mobile-brand">
          <ARXLogoMark size="sm" mode="dark" />
          <ARXWordmark size="sm" mode="dark" />
        </div>

        {/* Active symbol picker */}
        <div className="flex items-center gap-2">
          <span className="hidden lg:inline text-[10px] uppercase tracking-widest text-muted-foreground">Symbol</span>
          <SymbolPicker />
        </div>

        {/* Compact status row — pills are visible inline on desktop and the
            full row is also tappable to open a Sheet with detailed status
            (EA heartbeat, bridge mode, broker/server, feed status, etc).
            Per-user isolation still enforced server-side. */}
        <CompactStatusRow
          mt5={mt5}
          bot={bot}
          unlocks={unlocks}
          sessionLabel={sessionMeta.label}
          sessionTone={sessionMeta.tone}
          modeLabel={modeMeta.label}
          modeTone={modeMeta.tone}
          SessionIcon={SessionIcon}
          ModeIcon={ModeIcon}
          isAdmin={effectiveIsAdmin}
          isApprovedTrader={effectiveIsAdmin || isApprovedTrader}
        />

        <div className="ml-auto flex items-center gap-1">
          <ViewModeSwitch />
          <NotificationBell />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}

function ViewModeSwitch() {
  const { canToggle, viewMode, setViewMode } = useViewMode();
  if (!canToggle) return null;
  const isAdminView = viewMode === "admin";
  const next = isAdminView ? "user" : "admin";
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => setViewMode(next)}
      data-testid="button-viewmode-toggle"
      aria-label={isAdminView ? "Switch to User view" : "Switch back to Admin view"}
      title={isAdminView ? "Currently in Admin view — tap to preview as a regular user" : "Currently in User view — tap to return to Admin view"}
      className="min-h-[44px] h-11 px-3 text-xs gap-1.5 touch-manipulation"
    >
      {isAdminView ? <ShieldCheck className="w-4 h-4 text-warning" /> : <Eye className="w-4 h-4 text-ruby" />}
      <span>{isAdminView ? "Admin" : "User"}</span>
    </Button>
  );
}

function UserMenu() {
  const { user } = useCurrentUser();
  const logout = useLogout();
  if (!user) return null;
  const label = user.name || user.email;
  return (
    <div className="flex items-center gap-2 ml-1 pl-2 border-l border-border">
      <div className="hidden sm:flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="text-current-user">
        <UserIcon className="w-3.5 h-3.5" />
        <span className="max-w-[140px] truncate">{label}</span>
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => logout.mutate()}
        disabled={logout.isPending}
        data-testid="button-logout"
        title="Sign out"
        aria-label="Sign out"
      >
        <LogOut className="w-4 h-4" />
      </Button>
    </div>
  );
}

type CompactStatusRowProps = {
  mt5: any;
  bot: any;
  unlocks: ReturnType<typeof useAllUnlocks>;
  sessionLabel: string;
  sessionTone: "info" | "warning" | "bullish" | "neutral";
  modeLabel: string;
  modeTone: "neutral" | "info" | "warning" | "danger";
  SessionIcon: React.ComponentType<{ className?: string }>;
  ModeIcon: React.ComponentType<{ className?: string }>;
  /** Operator links in the status drawer render for admin/owner sessions only. */
  isAdmin: boolean;
  /**
   * /mt5-setup and /risk-command-center are on the APPROVED trader allowlist
   * only. Rendering them to a pending trader produced a silent redirect home —
   * the same dead-end class as the two broken operator links below.
   */
  isApprovedTrader: boolean;
};

function CompactStatusRow(p: CompactStatusRowProps) {
  const pills: StatusPill[] = [
    { id: "session", label: "Sess", value: p.sessionLabel, legacyTestId: "badge-session",
      tone: p.sessionTone === "bullish" ? "success" : p.sessionTone === "warning" ? "warning" : p.sessionTone === "info" ? "neutral" : "neutral" },
  ];
  if (p.unlocks.mt5) {
    pills.push({ id: "mt5", label: "MT5", value: p.mt5?.connected ? "ON" : "OFF",
      legacyTestId: "badge-mt5-connection",
      tone: p.mt5?.connected ? "success" : "neutral" });
    pills.push({ id: "mode", label: "Mode", value: p.modeLabel,
      legacyTestId: "badge-mode",
      tone: p.modeTone === "danger" ? "danger" : p.modeTone === "warning" ? "warning" : "neutral" });
  }
  if ((p.unlocks.simulator || p.unlocks.mt5) && p.bot) {
    pills.push({ id: "bot", label: "Bot",
      value: p.bot.isRunning ? (p.bot.isPaused ? "Paused" : "Running") : "Stopped",
      tone: p.bot.isRunning ? (p.bot.isPaused ? "warning" : "success") : "neutral" });
  }

  const drawer = (
    <div className="space-y-3 text-xs">
      <DetailRow label="Trading session" value={p.sessionLabel} />
      <DetailRow label="MT5 mode" value={p.modeLabel} />
      <DetailRow label="MT5 connected" value={p.mt5?.connected ? "yes" : "no"} />
      {(p.mt5?.accountSnapshot?.account ?? p.mt5?.account) != null && (
        <DetailRow label="Account" value={String(p.mt5?.accountSnapshot?.account ?? p.mt5?.account)} />
      )}
      {(p.mt5?.accountSnapshot?.broker ?? p.mt5?.broker) && (
        <DetailRow label="Broker" value={String(p.mt5?.accountSnapshot?.broker ?? p.mt5?.broker)} />
      )}
      {p.mt5?.lastHeartbeatAt && <DetailRow label="Last heartbeat" value={new Date(p.mt5.lastHeartbeatAt as string).toLocaleTimeString()} />}
      {p.bot && (
        <>
          <DetailRow label="Bot state" value={p.bot.isRunning ? (p.bot.isPaused ? "Paused" : "Running") : "Stopped"} />
          {(p.bot as any).lastScanAt && <DetailRow label="Last scan" value={new Date((p.bot as any).lastScanAt).toLocaleTimeString()} />}
        </>
      )}
      {/* RANK 76: two of these four links had never worked.
          `/operator-dashboard` is declared by no <Route> anywhere in the app
          (the real page is /admin/operator-command-center) and
          `/admin-diagnostics` was missing the slash (/admin/diagnostics). Both
          were also plain <a href> in a wouter SPA, so clicking them triggered a
          full page reload onto a 404 for an admin, or a bounce back to the
          cockpit for anyone else. They are wouter <Link>s now, aimed at the
          real routes, and the two operator links only render for an admin —
          neither path is on any human-trader allowlist, so showing them to a
          trader could only ever produce a silent redirect.
          Pinned by inAppHrefAllowlist.test.ts. */}
      <div className="pt-2 border-t space-y-1">
        {p.isApprovedTrader && (
          <>
            <Link className="block text-primary underline" href="/mt5-setup">MT5 setup &amp; bridge token →</Link>
            <Link className="block text-primary underline" href="/risk-command-center">Kill switch / risk controls →</Link>
          </>
        )}
        {p.isAdmin && (
          <>
            <Link className="block text-primary underline" href="/admin/operator-command-center">Operator command center →</Link>
            <Link className="block text-primary underline" href="/admin/diagnostics">Admin diagnostics →</Link>
          </>
        )}
      </div>
      {/* The gate count here said 16; the Phase B evaluator has been a 23-gate
          evaluator since the foundation gates landed
          (livePhaseBDispatchGate.ts). The env-var literal is admin-only
          information (meUnifiedMode.ts keeps `envExpectedLiteral` inside
          adminDiagnostics for exactly this reason), so a trader now gets the
          same fact without the operator switch name. */}
      <p className="text-[10px] text-muted-foreground pt-2 border-t">
        {p.isAdmin
          ? "Live broker dispatch stays OFF unless an operator arms the master switch AND all 23 Phase B gates pass."
          : "Live broker dispatch stays OFF unless your operator has armed it AND every Phase B safety gate passes."}
      </p>
    </div>
  );

  return (
    <div className="hidden md:block ml-2 min-w-0 max-w-md flex-shrink">
      <StatusBadgeRow pills={pills} drawer={drawer} testId="topbar-status-row" />
      {/* Legacy E2E selectors — preserved as hidden markers so existing tests
          targeting badge-session / badge-mt5-connection / badge-mode keep
          finding the same data in the DOM after the StatusBadgeRow refactor. */}
      <span className="sr-only" data-testid="badge-session">{p.sessionLabel}</span>
      {p.unlocks.mt5 && (
        <>
          <span className="sr-only" data-testid="badge-mt5-connection">{p.mt5?.connected ? "connected" : "disconnected"}</span>
          <span className="sr-only" data-testid="badge-mode">{p.modeLabel}</span>
        </>
      )}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center border-b border-border/40 pb-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

export function MobileMenuTrigger({ children }: { children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="md:hidden" data-testid="button-mobile-menu">
          <Menu />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="p-0 w-72 border-sidebar-border">
        {children(() => setOpen(false))}
      </SheetContent>
    </Sheet>
  );
}
