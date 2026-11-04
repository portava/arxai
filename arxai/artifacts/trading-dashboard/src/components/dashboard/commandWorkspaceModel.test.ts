import { describe, expect, it } from "vitest";
import { showSharedNavigation } from "@/components/layout/AppLayout";
import {
  applyWorkspacePreset, buildDashboardCatalog, dashboardPanelForTool, filterDashboardCatalog, toggleWorkspacePanel, WORKSPACE_PANEL_IDS,
} from "./commandWorkspaceModel";

describe("command workspace catalog and preferences", () => {
  it("searches route metadata by multiple tokens and aliases", () => {
    const catalog = buildDashboardCatalog("Ruby", { isAdmin: false, isApprovedTrader: true, isInvestor: false });
    expect(filterDashboardCatalog(catalog, "scanner signals").some(item => item.href === "/market-scanner")).toBe(true);
    expect(filterDashboardCatalog(catalog, "risk drawdown").some(item => item.href === "/risk-command-center")).toBe(true);
    expect(filterDashboardCatalog(catalog, "does not exist")).toEqual([]);
  });

  it("maps specialist tools onto matching workspace panels without changing route gates", () => {
    expect(dashboardPanelForTool("/market-scanner")).toBe("discovery");
    expect(dashboardPanelForTool("/live-chart")).toBe("chart");
    expect(dashboardPanelForTool("/market-heat-map")).toBe("heat");
    expect(dashboardPanelForTool("/economic-calendar")).toBe("intelligence");
    expect(dashboardPanelForTool("/ai-coach")).toBe("ruby");
    expect(dashboardPanelForTool("/risk-command-center")).toBe("risk");
    expect(dashboardPanelForTool("/positions")).toBe("positions");
    expect(dashboardPanelForTool("/trade-command-room")).toBe("order");
    expect(dashboardPanelForTool("/settings")).toBeNull();
    expect(WORKSPACE_PANEL_IDS).toContain("heat");
    expect(WORKSPACE_PANEL_IDS).toContain("clock");
    expect(WORKSPACE_PANEL_IDS).toContain("order");
  });

  it("keeps admin and approval gated routes out of regular catalogs", () => {
    const pending = buildDashboardCatalog("Ruby", { isAdmin: false, isApprovedTrader: false, isInvestor: false });
    expect(pending.some(item => item.href === "/market-scanner")).toBe(false);
    expect(pending.some(item => item.href === "/admin")).toBe(false);
    expect(buildDashboardCatalog("Ruby", { isAdmin: true, isApprovedTrader: false, isInvestor: false }).some(item => item.href === "/admin")).toBe(true);
    expect(buildDashboardCatalog("Ruby", { isAdmin: false, isApprovedTrader: false, isInvestor: true }).every(item => ["/investor", "/my-account", "/settings", "/help"].includes(item.href))).toBe(true);
  });

  it("suppresses shared navigation only on the root workspace", () => {
    expect(showSharedNavigation("/")).toBe(true);
    expect(showSharedNavigation("/market-scanner")).toBe(true);
    expect(showSharedNavigation("/trade-command-room")).toBe(true);
  });

  it("toggles collapse and pin state without touching other preferences", () => {
    const initial = { collapsed: [], pinned: [], preset: "Analyze" as const };
    const collapsed = toggleWorkspacePanel(initial, "chart", "collapse");
    expect(collapsed.collapsed).toEqual(["chart"]);
    expect(toggleWorkspacePanel(collapsed, "chart", "collapse").collapsed).toEqual([]);
    expect(toggleWorkspacePanel(initial, "chart", "pin").pinned).toEqual(["chart"]);
  });

  it("applies presets while retaining pinned preferences", () => {
    const trade = applyWorkspacePreset({ collapsed: [], pinned: ["ruby", "clock"], preset: "Analyze" as const }, "Trade");
    expect(trade.preset).toBe("Trade");
    expect(trade.pinned).toEqual(["ruby", "clock"]);
    expect(trade.collapsed).not.toContain("ruby");
    expect(trade.collapsed).not.toContain("clock");
    expect(trade.collapsed).not.toContain("heat");
    expect(trade.collapsed).not.toContain("risk");
    expect(trade.collapsed).not.toContain("order");
    const review = applyWorkspacePreset(trade, "Review");
    expect(review.collapsed).not.toContain("ruby");
    expect(review.collapsed).not.toContain("clock");
    expect(review.collapsed).toContain("order");
  });

  it("pins expand a panel and pinned panels cannot be collapsed", () => {
    const pinned = toggleWorkspacePanel({ collapsed: ["heat"], pinned: [], preset: "Analyze" as const }, "heat", "pin");
    expect(pinned).toEqual({ collapsed: [], pinned: ["heat"], preset: "Analyze" });
    expect(toggleWorkspacePanel(pinned, "heat", "collapse")).toEqual(pinned);
    expect(toggleWorkspacePanel(pinned, "heat", "pin").pinned).toEqual([]);
  });
});
