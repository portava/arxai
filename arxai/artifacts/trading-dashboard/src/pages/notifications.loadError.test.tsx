import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

// Notification Center truth: a failed read is never shown as an empty list.
// refresh() used to call r.json() without checking r.ok and then set
// `n.notifications ?? []`, so a 401/500 or a network error read
// "No notifications yet." and hid the counts without saying why.

vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => ({ isLoading: false, isDemo: true }) }));
vi.mock("../components/PushSettingsCard", () => ({ default: () => null }));

const { default: Notifications } = await import("./notifications");

const counts = { total: 1, unread: 1, critical: 1, criticalUnread: 1, high: 0, warning: 0, info: 0, byType: {}, byStatus: {} };
const critical = {
  notificationId: "n1", type: "SAFETY", severity: "CRITICAL", status: "UNREAD",
  title: "Stop loss missing on EURUSD", message: "Add a stop.", sourceBuild: "guard",
  symbol: "EURUSD", recommendedAction: null, actionUrl: null, repeatCount: 1,
  snoozedUntil: null, createdAt: new Date().toISOString(),
};

type Reply = { ok: boolean; status: number; body: unknown } | "network";
let listReply: Reply;
let countsReply: Reply;

function stub() {
  vi.stubGlobal("fetch", vi.fn(async (u: string) => {
    const url = String(u);
    const reply: Reply = url.includes("/digest") ? { ok: true, status: 200, body: { digest: null } }
      : url.includes("/counts") ? countsReply
      : listReply;
    if (reply === "network") throw new TypeError("Failed to fetch");
    return { ok: reply.ok, status: reply.status, json: async () => reply.body };
  }));
}

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Notification Center — failed reads", () => {
  it("a 500 on the list says it could not be loaded, never 'No notifications yet.'", async () => {
    listReply = { ok: false, status: 500, body: { error: "list failed" } };
    countsReply = { ok: false, status: 500, body: { error: "counts failed" } };
    stub();
    render(<Notifications />);
    await flush();
    expect(screen.getByTestId("notifications-load-error").textContent).toMatch(/could not be loaded; this is not an empty list/);
    expect(screen.queryByText("No notifications yet.")).toBeNull();
    expect(screen.getByTestId("counts-load-error").textContent).toMatch(/could not be loaded/);
    expect(screen.queryByTestId("counts-panel")).toBeNull();
  });

  it("a network error is a load failure too", async () => {
    listReply = "network";
    countsReply = "network";
    stub();
    render(<Notifications />);
    await flush();
    expect(screen.getByTestId("notifications-load-error")).toBeTruthy();
    expect(screen.queryByText("No notifications yet.")).toBeNull();
  });

  it("an ok reply without a notifications array is not read as empty", async () => {
    listReply = { ok: true, status: 200, body: { error: "unexpected" } };
    countsReply = { ok: true, status: 200, body: { counts } };
    stub();
    render(<Notifications />);
    await flush();
    expect(screen.getByTestId("notifications-load-error")).toBeTruthy();
    expect(screen.queryByText("No notifications yet.")).toBeNull();
    expect(screen.getByTestId("counts-panel")).toBeTruthy();
  });

  it("a later failed refresh keeps the known CRITICAL alert and says the list is not current", async () => {
    listReply = { ok: true, status: 200, body: { notifications: [critical] } };
    countsReply = { ok: true, status: 200, body: { counts } };
    stub();
    render(<Notifications />);
    await flush();
    expect(screen.queryByTestId("notifications-load-error")).toBeNull();
    expect(screen.getByTestId("critical-safety-banner").textContent).toMatch(/Stop loss missing on EURUSD/);

    listReply = { ok: false, status: 503, body: {} };
    await act(async () => { screen.getByText("Refresh").click(); });
    await flush();
    expect(screen.getByTestId("notifications-load-error").textContent).toMatch(/could not be refreshed/);
    expect(screen.getByTestId("notifications-load-error").textContent).toMatch(/may not be current/);
    expect(screen.getByTestId("critical-safety-banner")).toBeTruthy();
  });

  it("an empty list from a good read still shows the empty state", async () => {
    listReply = { ok: true, status: 200, body: { notifications: [] } };
    countsReply = { ok: true, status: 200, body: { counts: { ...counts, total: 0, unread: 0, critical: 0, criticalUnread: 0 } } };
    stub();
    render(<Notifications />);
    await flush();
    expect(screen.getByText("No notifications yet.")).toBeTruthy();
    expect(screen.queryByTestId("notifications-load-error")).toBeNull();
    expect(screen.queryByTestId("counts-load-error")).toBeNull();
  });
});
