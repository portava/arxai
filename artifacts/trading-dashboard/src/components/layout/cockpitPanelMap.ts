export type WorkspacePanelKey =
  | "discovery"
  | "chart"
  | "heat"
  | "intelligence"
  | "clock"
  | "ruby"
  | "risk"
  | "order"
  | "positions";

export function cockpitPanelForRoute(href: string): WorkspacePanelKey | null {
  if (["/market-scanner", "/watchlists", "/sniper-watchlist"].includes(href)) return "discovery";
  if (href === "/live-chart") return "chart";
  if (href === "/market-heat-map") return "heat";
  if (["/economic-calendar", "/trading-calendar", "/market-health", "/news-risk", "/alerts"].includes(href)) return "intelligence";
  if (["/ai-command-center", "/ai-coach", "/scalp-journal"].includes(href)) return "ruby";
  if (["/risk-command-center", "/risk-settings"].includes(href)) return "risk";
  if (["/positions", "/my-trades"].includes(href)) return "positions";
  if (href === "/trade-command-room") return "order";
  return null;
}
