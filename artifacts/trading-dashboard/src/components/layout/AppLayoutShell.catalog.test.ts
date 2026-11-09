import { describe, expect, it } from "vitest";
import {
  getDashboardNavigationGroups,
  getDashboardToolCatalog,
  shouldShowEmergencyStop,
} from "./AppLayout";

describe("shared shell navigation catalog", () => {
  it("keeps investor tools confined to investor navigation", () => {
    const role = { isAdmin: false, isApprovedTrader: true, isInvestor: true };
    const groups = getDashboardNavigationGroups("Eleanor", role);
    const routes = getDashboardToolCatalog("Eleanor", role).map(item => item.href);
    expect(groups.map(group => group.label)).toEqual(["Investor"]);
    expect(routes).toEqual(expect.arrayContaining(["/investor", "/my-account", "/settings", "/help"]));
    expect(routes).not.toContain("/market-scanner");
    expect(routes).not.toContain("/trade-command-room");
    expect(routes).not.toContain("/emergency");
  });

  it("keeps the emergency destination available to non-investors only", () => {
    expect(shouldShowEmergencyStop(false)).toBe(true);
    expect(shouldShowEmergencyStop(true)).toBe(false);
    const role = { isAdmin: false, isApprovedTrader: false, isInvestor: false };
    expect(getDashboardToolCatalog("Eleanor", role).some(item => item.href === "/emergency")).toBe(true);
  });

  it("preserves approved-only and admin-only role gates in All tools", () => {
    const pending = getDashboardToolCatalog("Eleanor", {
      isAdmin: false,
      isApprovedTrader: false,
      isInvestor: false,
    });
    const approved = getDashboardToolCatalog("Eleanor", {
      isAdmin: false,
      isApprovedTrader: true,
      isInvestor: false,
    });
    expect(pending.some(item => item.href === "/market-scanner")).toBe(false);
    expect(approved.some(item => item.href === "/market-scanner")).toBe(true);
    expect(pending.some(item => item.href === "/testing-control-center")).toBe(false);
  });
});
