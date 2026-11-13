import { describe, it, expect } from "vitest";
import {
  workspaceTabs,
  workspaceSubnav,
  workspaceTabForPath,
  TRADING_TABS,
  type WorkspaceAccess,
} from "./workspaceNavigation";
import {
  isNormalUserAllowedPath,
  isInvestorAllowedPath,
  isPendingTraderAllowedPath,
} from "@/lib/routeAccess";
const approved: WorkspaceAccess = {
  isInvestor: false,
  isAdmin: false,
  isApprovedTrader: true,
  isLoading: false,
};
describe("workspace navigation preserves account access", () => {
  it("approved traders have the five requested sections on existing product routes", () => {
    const tabs = workspaceTabs(approved);
    expect(tabs.map((t) => t.label)).toEqual([
      "Scanner",
      "Chart",
      "Calendar",
      "Journal",
      "Positions & Orders",
    ]);
    expect(tabs.every((t) => isNormalUserAllowedPath(t.href))).toBe(true);
    expect(tabs.at(-1)?.href).toBe("/my-trades");
  });
  it("unresolved identity exposes no trading navigation", () => {
    expect(workspaceTabs({ ...approved, isLoading: true })).toEqual([]);
    expect(
      workspaceSubnav("/my-trades", { ...approved, isLoading: true }),
    ).toEqual([]);
  });
  it("pending traders remain within the existing pending allowlist", () => {
    const tabs = workspaceTabs({ ...approved, isApprovedTrader: false });
    expect(tabs.length).toBeGreaterThan(0);
    expect(tabs.every((t) => isPendingTraderAllowedPath(t.href))).toBe(true);
    expect(
      workspaceSubnav("/orders", { ...approved, isApprovedTrader: false }),
    ).toEqual([]);
  });
  it("investor containment takes priority over trader/admin flags", () => {
    const access = { ...approved, isInvestor: true, isAdmin: true };
    expect(
      workspaceTabs(access).every((t) => isInvestorAllowedPath(t.href)),
    ).toBe(true);
    expect(workspaceSubnav("/live-chart", access)).toEqual([]);
  });
  it("operator-only order and queue tools are absent for approved non-admin users", () => {
    const links = workspaceSubnav("/my-trades", approved);
    expect(links.map((l) => l.href)).toEqual(["/my-trades", "/trade-logs"]);
    expect(
      workspaceSubnav("/my-trades", { ...approved, isAdmin: true }).map(
        (l) => l.href,
      ),
    ).toContain("/orders");
  });
  it("all ordinary secondary links remain on the normal-user allowlist", () => {
    for (const tab of TRADING_TABS)
      expect(
        workspaceSubnav(tab.href, approved).every((link) =>
          isNormalUserAllowedPath(link.href),
        ),
      ).toBe(true);
  });
  it("related routes and query parameters keep their parent section highlighted", () => {
    expect(
      workspaceTabForPath("/scalp-journal?symbol=V75", TRADING_TABS)?.label,
    ).toBe("Journal");
    expect(
      workspaceTabForPath("/my-trades/trade-42", TRADING_TABS)?.label,
    ).toBe("Positions & Orders");
    expect(
      workspaceTabForPath("/trade-command-room", TRADING_TABS)?.label,
    ).toBe("Chart");
    expect(
      workspaceTabForPath("/journal-unknown", TRADING_TABS),
    ).toBeUndefined();
  });
});
