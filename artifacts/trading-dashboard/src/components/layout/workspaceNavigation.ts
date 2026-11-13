export interface WorkspaceAccess {
  isInvestor: boolean;
  isAdmin: boolean;
  isApprovedTrader: boolean;
  isLoading: boolean;
}
export interface WorkspaceLink {
  href: string;
  label: string;
  routes?: readonly string[];
  adminOnly?: boolean;
}
export const TRADING_TABS: readonly WorkspaceLink[] = [
  {
    href: "/market-scanner",
    label: "Scanner",
    routes: ["/watchlists", "/market-heat-map"],
  },
  {
    href: "/live-chart",
    label: "Chart",
    routes: ["/trade-command-room", "/live-trading"],
  },
  {
    href: "/economic-calendar",
    label: "Calendar",
    routes: ["/trading-calendar", "/calendar"],
  },
  {
    href: "/journal",
    label: "Journal",
    routes: ["/scalp-journal", "/weekly-review"],
  },
  {
    href: "/my-trades",
    label: "Positions & Orders",
    routes: ["/positions", "/orders", "/trade-logs", "/live-intent-queue"],
  },
];
const INVESTOR_TABS: readonly WorkspaceLink[] = [
  { href: "/investor", label: "Portfolio" },
  { href: "/my-account", label: "Account" },
  { href: "/settings", label: "Settings" },
  { href: "/help", label: "Help" },
];
const PENDING_TABS: readonly WorkspaceLink[] = [
  { href: "/", label: "Overview" },
  { href: "/onboarding", label: "Get started" },
  { href: "/school", label: "Learn" },
  { href: "/my-account", label: "Account" },
];
export function workspaceTabs(
  access: WorkspaceAccess,
): readonly WorkspaceLink[] {
  if (access.isLoading) return [];
  if (access.isInvestor) return INVESTOR_TABS;
  return access.isAdmin || access.isApprovedTrader
    ? TRADING_TABS
    : PENDING_TABS;
}
export function workspaceTabForPath(
  path: string,
  tabs: readonly WorkspaceLink[],
): WorkspaceLink | undefined {
  const clean = path.split(/[?#]/)[0];
  return tabs.find((tab) =>
    [tab.href, ...(tab.routes || [])].some(
      (route) =>
        clean === route || (route !== "/" && clean.startsWith(route + "/")),
    ),
  );
}
export function workspaceSubnav(
  path: string,
  access: WorkspaceAccess,
): readonly WorkspaceLink[] {
  if (
    access.isLoading ||
    access.isInvestor ||
    (!access.isAdmin && !access.isApprovedTrader)
  )
    return [];
  const active = workspaceTabForPath(path, TRADING_TABS);
  const links: Record<string, readonly WorkspaceLink[]> = {
    "/live-chart": [
      { href: "/live-chart", label: "Chart & ticket" },
      { href: "/trade-command-room", label: "Trade command room" },
      { href: "/live-trading", label: "Live trading" },
    ],
    "/economic-calendar": [
      { href: "/economic-calendar", label: "Economic events" },
      { href: "/trading-calendar", label: "Trading calendar" },
    ],
    "/journal": [
      { href: "/journal", label: "My journal" },
      { href: "/scalp-journal", label: "Scalp journal" },
      { href: "/weekly-review", label: "Weekly review" },
    ],
    "/my-trades": [
      { href: "/my-trades", label: "Open positions" },
      { href: "/trade-logs", label: "Trade history" },
      { href: "/positions", label: "Position manager", adminOnly: true },
      { href: "/orders", label: "Order manager", adminOnly: true },
      { href: "/live-intent-queue", label: "Execution queue", adminOnly: true },
    ],
  };
  return (links[active?.href || ""] || []).filter(
    (link) => !link.adminOnly || access.isAdmin,
  );
}
