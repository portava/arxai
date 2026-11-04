import { getDashboardToolCatalog } from "@/components/layout/AppLayout";
import { cockpitPanelForRoute } from "@/components/layout/cockpitPanelMap";

export type WorkspacePreset = "Analyze" | "Trade" | "Review";
export type WorkspaceTool = { href: string; label: string; group: string; aliases?: string[]; description?: string };
export type CatalogRole = { isAdmin: boolean; isApprovedTrader: boolean; isInvestor: boolean };
export const WORKSPACE_PANEL_IDS = ["discovery", "chart", "heat", "intelligence", "clock", "ruby", "risk", "order", "positions"] as const;
export type WorkspacePanelId = typeof WORKSPACE_PANEL_IDS[number];

export function buildDashboardCatalog(name: string, role: CatalogRole): WorkspaceTool[] {
  return getDashboardToolCatalog(name, role);
}

export function filterDashboardCatalog(catalog: WorkspaceTool[], query: string): WorkspaceTool[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return catalog;
  return catalog.filter(tool => {
    const content = [tool.label, tool.group, tool.href, ...(tool.aliases ?? [])].join(" ").toLowerCase();
    return tokens.every(token => content.includes(token));
  });
}

export function dashboardPanelForTool(href: string): WorkspacePanelId | null {
  return cockpitPanelForRoute(href);
}

export function applyWorkspacePreset<T extends { collapsed: string[]; pinned: string[]; railed?: string[]; peek?: string; preset: WorkspacePreset }>(current: T, preset: WorkspacePreset): T {
  const visible: Record<WorkspacePreset, string[]> = {
    Analyze: ["discovery", "chart", "heat", "intelligence", "clock", "ruby", "risk"],
    Trade: ["discovery", "chart", "heat", "clock", "risk", "order", "positions"],
    Review: ["chart", "heat", "clock", "ruby", "intelligence", "positions"],
  };
  return {
    ...current, preset,
    collapsed: WORKSPACE_PANEL_IDS.filter(id => !visible[preset].includes(id) && !current.pinned.includes(id)),
    railed: [...WORKSPACE_PANEL_IDS.filter(id => !visible[preset].includes(id) && !current.pinned.includes(id)),
      ...(!current.pinned.includes("chart-details") ? ["chart-details"] : [])],
    peek: undefined,
  };
}

export function toggleWorkspacePanel<T extends { collapsed: string[]; pinned: string[]; railed?: string[]; peek?: string }>(
  current: T, id: string, action: "collapse" | "pin",
): T {
  const field = action === "collapse" ? "collapsed" : "pinned";
  const values = current[field];
  if (action === "collapse" && current.pinned.includes(id)) return current;
  if (action === "pin" && values.includes(id)) {
    return { ...current, pinned: values.filter(value => value !== id) };
  }
  if (action === "pin") {
    return { ...current, pinned: [...values, id], collapsed: current.collapsed.filter(value => value !== id),
      ...(current.railed ? { railed: current.railed.filter(value => value !== id) } : {}) };
  }
  return { ...current, [field]: values.includes(id) ? values.filter(value => value !== id) : [...values, id] };
}
