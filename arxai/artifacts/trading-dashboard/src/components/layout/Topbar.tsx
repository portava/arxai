import { mt5StatusReadOptions } from "@/hooks/readSharedAccountSummary";
import React from "react";
import { Link } from "wouter";
import { useGetMt5Status, useGetBotStatus, getGetMt5StatusQueryKey, getGetBotStatusQueryKey } from "@workspace/api-client-react";
import { SymbolPicker } from "./SymbolPicker";
import { NotificationBell } from "@/components/alerts/NotificationBell";
import { OneClickModeToggle } from "@/components/oneclick/OneClickModeToggle";
import { WifiOff, Lock, Zap, Plug } from "lucide-react";
import { getCurrentSession } from "@/lib/symbol-context";
import { safeDate } from "@/lib/safeFormat";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { StatusBadgeRow, type StatusPill } from "@/components/ui/StatusBadgeRow";
import { Menu } from "lucide-react";
import { ARXLogoMark, ARXWordmark } from "@/components/brand/ARXLogo";
import { useAllUnlocks } from "@/hooks/useFeatureUnlock";
import { useCurrentUser, useLogout } from "@/hooks/useCurrentUser";
import { useViewMode } from "@/hooks/useViewMode";
import { LogOut, User as UserIcon, ShieldCheck, Eye } from "lucide-react";

const CLOCK_WINDOW_LABEL = {
  ASIA: "Asia", LONDON: "London", NEW_YORK: "New York", OFF: "Outside reference windows",
};

// This estimate is a reference clock, never market/session evidence. Keep its
// timer inside the open details drawer rather than rerendering the chart shell.
function ClockSessionEstimate() {
  const [session, setSession] = React.useState(getCurrentSession);
  React.useEffect(() => {
    const refresh = () => setSession(getCurrentSession());
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return <>
    <DetailRow label="UTC clock window" value={`${CLOCK_WINDOW_LABEL[session]} (estimate)`} />
    <p className="text-muted-foreground">
      Fixed UTC-hour estimate only. It does not verify the selected market's session,
      opening hours, holidays, daylight-saving changes, or the chart's historical time.
    </p>
  </>;
}

const MODE_META = {
  MOCK: { tone: "neutral" as const, icon: WifiOff, label: "Mock" },
  DEMO: { tone: "info" as const, icon: Plug, label: "Demo" },
  LIVE_LOCKED: { tone: "warning" as const, icon: Lock, label: "Live Locked" },
  LIVE: { tone: "danger" as const, icon: Zap, label: "LIVE" },
  // /mt5/status modes for the user's own connection.
  NOT_CONNECTED: { tone: "neutral" as const, icon: WifiOff, label: "Not connected" },
  STALE: { tone: "warning" as const, icon: WifiOff, label: "Stale" },
} as const;
// Not a server mode: the user routes through the shared master bridge, so the
// own-connection mode (NOT_CONNECTED) does not describe their bridge.
const SHARED_MODE_META = { tone: "info" as const, icon: Plug, label: "Shared bridge" };
const UNKNOWN_MODE_META = { tone: "neutral" as const, icon: WifiOff, label: "Unknown" };
const CHECKING_MODE_META = { tone: "neutral" as const, icon: WifiOff, label: "Checking" };

type SharedBridgeView = { availability?: string; connected?: boolean; message?: string } | null;

/** " — last read HH:MM:SS" for a cached value whose latest poll failed ("" when the read time is unknown). */
function lastReadText(at: number | undefined): string {
  return at && at > 0 ? ` — last read ${new Date(at).toLocaleTimeString()}` : "";
}

/**
 * What the MT5 pill may say. `connected` on /mt5/status is the user's OWN
 * connection; a SHARED_MASTER user is routed through the master bridge,
 * reported separately as sharedMasterBridge (re-aged by the server). A failed
 * status request is unknown, never "OFF". When the latest poll failed, the
 * cached answer is not shown as current (React Query keeps it on error).
 */
function mt5BridgeView(mt5: any, loadFailed: boolean, refreshFailed = false, readAt?: number): {
  /** unknown: nothing current was read, so the legacy marker says "unknown", not "disconnected". */
  pill: string; tone: "success" | "warning" | "neutral"; connectedText: string; up: boolean; unknown?: boolean;
} {
  if (!mt5) {
    return loadFailed
      ? { pill: "Unknown", tone: "warning", connectedText: "could not be loaded", up: false }
      : { pill: "…", tone: "neutral", connectedText: "checking", up: false };
  }
  if (refreshFailed) {
    return { pill: "Not refreshed", tone: "warning", connectedText: `could not be refreshed${lastReadText(readAt)}`, up: false, unknown: true };
  }
  if (mt5.connected === true) return { pill: "ON", tone: "success", connectedText: "yes (your own EA)", up: true };
  if (mt5.route === "SHARED_MASTER") {
    const shared = (mt5.sharedMasterBridge ?? null) as SharedBridgeView;
    if (shared?.connected === true) return { pill: "ON", tone: "success", connectedText: "yes (shared MT5 bridge)", up: true };
    const a = shared?.availability;
    const word = a === "STALE" ? "Stale" : a === "RECONCILING" ? "Reconciling" : !a || a === "UNKNOWN" ? "Unknown" : "Unavailable";
    // UNKNOWN (or no availability at all): the shared bridge was not read, so
    // it is neither "no" nor "disconnected".
    if (word === "Unknown") {
      return { pill: word, tone: "warning", connectedText: "unknown — the shared MT5 bridge status could not be read", up: false, unknown: true };
    }
    return { pill: word, tone: "warning", connectedText: `no — shared MT5 bridge ${word.toLowerCase()}`, up: false };
  }
  // No own connection, and the server could not read whether the user routes
  // through the shared bridge: unknown, not a confirmed "no bridge".
  if (mt5.routeReadFailed === true) {
    return { pill: "Unknown", tone: "warning", connectedText: "unknown — whether you use the shared MT5 bridge could not be read", up: false, unknown: true };
  }
  return { pill: "OFF", tone: "neutral", connectedText: "no", up: false };
}

export function Topbar({ onMobileMenu }: { onMobileMenu?: React.ReactNode }) {
  const unlocks = useAllUnlocks();
  const { effectiveIsAdmin: viewerIsAdmin } = useViewMode();
  // Only poll MT5 / bot status once the user has unlocked those surfaces.
  // Fresh browser sessions get no leak of the global single-tenant state
  // (account, broker, mode, running flag) into the global header.
  const { data: mt5, isError: mt5Error, dataUpdatedAt: mt5ReadAt } = useGetMt5Status({
    query: {
      queryKey: getGetMt5StatusQueryKey(), ...mt5StatusReadOptions,
      refetchInterval: 5000,
      enabled: unlocks.mt5,
    },
  });
  const { data: bot, isError: botError, dataUpdatedAt: botReadAt } = useGetBotStatus({
    query: {
      queryKey: getGetBotStatusQueryKey(),
      refetchInterval: 5000,
      enabled: unlocks.simulator || unlocks.mt5,
    },
  });
  // The market session pill stays "Unverified" (the UTC clock estimate lives
  // in the drawer only), so no session is read here.
  const mt5LoadFailed = mt5Error === true && mt5 == null;
  // The latest poll failed but an older answer is cached: not current.
  const mt5RefreshFailed = mt5Error === true && mt5 != null;
  const botRefreshFailed = botError === true && bot != null;
  const modeMeta =
    !mt5 ? (mt5LoadFailed ? UNKNOWN_MODE_META : CHECKING_MODE_META)
    : mt5RefreshFailed ? UNKNOWN_MODE_META
    : mt5.route === "SHARED_MASTER" && !mt5.connected ? SHARED_MODE_META
    : mt5.routeReadFailed === true && !mt5.connected ? UNKNOWN_MODE_META
    : MODE_META[mt5.mode as keyof typeof MODE_META] ?? UNKNOWN_MODE_META;
  const ModeIcon = modeMeta.icon;

  return (
    <header className="relative h-14 border-b border-border bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
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
          mt5LoadFailed={mt5LoadFailed}
          mt5RefreshFailed={mt5RefreshFailed}
          mt5ReadAt={mt5ReadAt}
          bot={bot}
          botRefreshFailed={botRefreshFailed}
          botReadAt={botReadAt}
          unlocks={unlocks}
          viewerIsAdmin={viewerIsAdmin === true}
          modeLabel={modeMeta.label}
          modeTone={modeMeta.tone}
          ModeIcon={ModeIcon}
        />

        <div className="ml-auto flex items-center gap-1">
          <OneClickModeToggle />
          <ViewModeSwitch />
          <NotificationBell />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}

export function ViewModeSwitch() {
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
      {isAdminView ? <ShieldCheck className="w-4 h-4 text-amber-400" /> : <Eye className="w-4 h-4 text-sky-400" />}
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
  mt5LoadFailed: boolean;
  /** The latest MT5 poll failed; p.mt5 is the last answer read, at mt5ReadAt. */
  mt5RefreshFailed?: boolean;
  mt5ReadAt?: number;
  bot: any;
  /** The latest bot-status poll failed; p.bot is the last answer read, at botReadAt. */
  botRefreshFailed?: boolean;
  botReadAt?: number;
  unlocks: ReturnType<typeof useAllUnlocks>;
  /** The viewer sees the admin dashboard (and so the welcome checklist that turns MT5 on here). */
  viewerIsAdmin?: boolean;
  modeLabel: string;
  modeTone: "neutral" | "info" | "warning" | "danger";
  ModeIcon: React.ComponentType<{ className?: string }>;
};

function CompactStatusRow(p: CompactStatusRowProps) {
  const pills: StatusPill[] = [
    { id: "session", label: "Session", value: "Unverified", legacyTestId: "badge-session", tone: "neutral" },
  ];
  const bridge = mt5BridgeView(p.mt5, p.mt5LoadFailed, p.mt5RefreshFailed === true, p.mt5ReadAt);
  if (p.unlocks.mt5) {
    pills.push({ id: "mt5", label: "MT5", value: bridge.pill,
      legacyTestId: "badge-mt5-connection",
      tone: bridge.tone });
    pills.push({ id: "mode", label: "Mode", value: p.modeLabel,
      legacyTestId: "badge-mode",
      tone: p.modeTone === "danger" ? "danger" : p.modeTone === "warning" ? "warning" : "neutral" });
  }
  // GET /bot/status is the saved Bot Control preference (bot_settings). No
  // scanner, trading loop or execution path reads it, so it is shown as a
  // saved request in a neutral tone — never as a running or stopped engine.
  // When the latest poll failed, the cached request is not shown as current.
  // A query this header has disabled can still hand back an answer another
  // page (MT5 Bridge, Bot Control) left in the shared cache. Nothing here
  // refreshes it, so it is not shown at all while the header does not read it.
  const botPolled = p.unlocks.simulator || p.unlocks.mt5;
  const savedBot = botPolled && p.bot ? savedBotRequest(p.bot) : null;
  const mt5Read = p.unlocks.mt5 ? p.mt5 : null;
  if (savedBot) {
    pills.push({ id: "bot", label: "Bot (saved)",
      value: p.botRefreshFailed ? "Not refreshed" : savedBot,
      tone: p.botRefreshFailed ? "warning" : "neutral" });
  }

  const drawer = (
    <div className="space-y-3 text-xs">
      <DetailRow label="Market session" value="Unverified" />
      <ClockSessionEstimate />
      {p.unlocks.mt5 ? (
        <>
          <DetailRow label="MT5 mode" value={p.modeLabel} />
          <DetailRow label="MT5 connected" value={bridge.connectedText} />
        </>
      ) : (
        // The status query is disabled until MT5 is turned on for this header,
        // so nothing is being checked. Only the admin-only welcome checklist on
        // the dashboard turns it on; the "Connect MT5" buttons traders see open
        // My MT5 and do not change this header.
        <>
          <DetailRow label="MT5 status" value="not checked here" />
          <p className="text-[10px] text-muted-foreground" data-testid="topbar-mt5-not-checked">
            MT5 status is turned off in this header for your account in this browser, so nothing is read here.{" "}
            <a className="text-primary underline" href="/my-mt5">Open My MT5</a> for your bridge status.
            {p.viewerIsAdmin
              ? ' To show it here, press "Connect MT5" in the welcome checklist (Dashboard → System Health · Admin → Setup & readiness).'
              : null}
          </p>
        </>
      )}
      {(mt5Read?.accountSnapshot?.account ?? mt5Read?.account) != null && (
        <DetailRow label="Account" value={String(mt5Read?.accountSnapshot?.account ?? mt5Read?.account)} />
      )}
      {(mt5Read?.accountSnapshot?.broker ?? mt5Read?.broker) && (
        <DetailRow label="Broker" value={String(mt5Read?.accountSnapshot?.broker ?? mt5Read?.broker)} />
      )}
      {mt5Read?.lastHeartbeatAt && (
        <DetailRow
          label={p.mt5RefreshFailed ? "Last heartbeat (as of last read)" : "Last heartbeat"}
          value={new Date(mt5Read.lastHeartbeatAt as string).toLocaleTimeString()}
        />
      )}
      {savedBot && (
        <>
          <DetailRow
            label="Saved bot setting"
            value={p.botRefreshFailed ? `could not be refreshed${lastReadText(p.botReadAt)} (then: ${savedBot})` : savedBot}
          />
          {(p.bot as any).lastScanAt && (
            <DetailRow
              label={p.botRefreshFailed ? "Last scan recorded on this setting (as of last read)" : "Last scan recorded on this setting"}
              value={safeDate((p.bot as any).lastScanAt, "datetime", "unreadable time")}
            />
          )}
          <p className="text-[10px] text-muted-foreground" data-testid="topbar-bot-scope">
            A saved Bot Control preference: no scanner, trading loop or execution path reads it, so it does not show whether anything is running.
          </p>
        </>
      )}
      <div className="pt-2 border-t space-y-1">
        <Link className="block text-primary underline" href="/mt5-setup">MT5 setup &amp; bridge token →</Link>
        <Link className="block text-primary underline" href="/admin/operator-command-center">Operator dashboard →</Link>
        <Link className="block text-primary underline" href="/admin/diagnostics">Admin diagnostics →</Link>
        <Link className="block text-primary underline" href="/risk-command-center">Kill switch / risk controls →</Link>
      </div>
      <p className="text-[10px] text-muted-foreground pt-2 border-t">
        Live broker dispatch stays OFF unless an operator flips
        ARX_LIVE_BROKER_EXECUTION_ENABLED AND all 16 Phase B gates pass.
      </p>
    </div>
  );

  return (
    <div className="hidden md:block ml-2 min-w-0 max-w-md flex-shrink">
      <StatusBadgeRow pills={pills} drawer={drawer} testId="topbar-status-row" />
      {/* Legacy E2E selectors — preserved as hidden markers so existing tests
          targeting badge-session / badge-mt5-connection / badge-mode keep
          finding the same data in the DOM after the StatusBadgeRow refactor. */}
      <span className="sr-only" data-testid="badge-session">Unverified</span>
      {p.unlocks.mt5 && (
        <>
          <span className="sr-only" data-testid="badge-mt5-connection">{bridge.up ? "connected" : bridge.unknown || !p.mt5 ? "unknown" : "disconnected"}</span>
          <span className="sr-only" data-testid="badge-mode">{p.modeLabel}</span>
        </>
      )}
    </div>
  );
}

/** The saved Bot Control start / pause / stop request, worded as a request. */
function savedBotRequest(bot: { isRunning?: unknown; isPaused?: unknown }): string {
  return bot.isRunning === true ? (bot.isPaused === true ? "Pause requested" : "Start requested") : "Stop requested";
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
