import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// The Notification Center promises "We never show other users'
// notifications". Its "Latest digest" panel used to render whatever
// /api/notifications/digest returned — the persisted all-users digest, with
// other users' critical alert titles. The panel now shows only a digest the
// server marks as the caller's own (scope "USER") and says so.

vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => ({ isLoading: false, isDemo: true }) }));
vi.mock("../components/PushSettingsCard", () => ({ default: () => null }));

const { default: Notifications } = await import("./notifications");

const base = {
  rangeStart: new Date(Date.now() - 86_400_000).toISOString(), rangeEnd: new Date().toISOString(),
  totalNotifications: 3, criticalCount: 2, warningCount: 1, tradeCount: 2, learningCount: 0, safetyCount: 1,
  summary: { topCritical: [{ id: "b1", title: "User two margin call" }] },
};

function stub(digest: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (u: string) => {
    const url = String(u);
    const body = url.includes("/digest") ? { digest }
      : url.includes("/counts") ? { counts: null }
      : { notifications: [] };
    return { ok: true, json: async () => body };
  }));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Notification Center digest panel scope", () => {
  it("does not render a digest that is not marked as the caller's own", async () => {
    stub({ ...base, digestId: "digest_global" });
    render(<Notifications />);
    await screen.findByText("No notifications yet.");
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("digest-panel")).toBeNull();
    expect(document.body.textContent).not.toMatch(/User two margin call/);
  });

  it("labels the caller's own digest as theirs", async () => {
    stub({ ...base, scope: "USER", digestId: null, totalNotifications: 1, summary: { topCritical: [{ id: "a1", title: "Stop hit" }] } });
    render(<Notifications />);
    const panel = await screen.findByTestId("digest-panel");
    expect(panel.textContent).toMatch(/Your notifications/);
    expect(panel.textContent).not.toMatch(/digest_/);
    expect(panel.textContent).toMatch(/Total: 1/);
  });
});
