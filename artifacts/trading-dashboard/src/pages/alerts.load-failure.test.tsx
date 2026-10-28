import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// When GET /api/me/notifications fails (401/500/non-JSON) the alert inbox
// could not be read — unread critical alerts may exist. The page used to
// treat that as an empty inbox: System "Quiet", every count 0 and
// "No alerts right now. Ruby will notify you…".

vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: () => undefined }) }));
vi.mock("@workspace/api-client-react", () => ({ getGetAlertUnreadCountQueryKey: () => ["alerts-unread"] }));
vi.mock("wouter", () => ({ useLocation: () => ["/alerts", () => undefined] }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));

const { default: Alerts } = await import("./alerts");

function stub(status: number, body: string) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status >= 200 && status < 300, status, text: async () => body })));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("My Alerts — failed inbox read", () => {
  it("shows a load-failure state, not 'Quiet' or 'No alerts right now'", async () => {
    stub(500, JSON.stringify({ error: "boom" }));
    render(<Alerts />);
    expect((await screen.findAllByText(/could not be loaded/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText("Quiet")).toBeNull();
    expect(document.body.textContent).not.toMatch(/No alerts right now/);
    expect(document.body.textContent).not.toMatch(/Loading alerts/);
  });

  it("a non-JSON reply is also a failure", async () => {
    stub(200, "<html>proxy error</html>");
    render(<Alerts />);
    expect((await screen.findAllByText(/could not be loaded/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText("Quiet")).toBeNull();
  });

  it("an empty inbox that was read is still 'Quiet'", async () => {
    stub(200, JSON.stringify({ notifications: [] }));
    render(<Alerts />);
    await screen.findByText(/No alerts right now/);
    expect(screen.getByText("Quiet")).toBeTruthy();
    expect(screen.queryAllByText(/could not be loaded/i)).toHaveLength(0);
  });

  it("names the 200-row cap instead of calling the count 'All time'", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1, severity: "info", status: "read", title: `t${i}`, message: "m", createdAt: new Date().toISOString(),
    }));
    stub(200, JSON.stringify({ notifications: rows }));
    render(<Alerts />);
    await screen.findByText(/Newest 200/);
    expect(screen.queryByText("All time")).toBeNull();
  });
});
