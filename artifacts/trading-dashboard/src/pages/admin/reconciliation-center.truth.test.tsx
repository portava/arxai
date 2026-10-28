import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdminReconciliationCenter from "./reconciliation-center";

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
async function settle() {
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const empty = {
  ok: true, issues: [], total: 0,
  countsBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
  countsByType: {}, computedAt: "2026-10-28T11:00:00.000Z",
};

describe("Reconciliation Center load failures", () => {
  it("a 500 {ok:false} is 'could not be loaded', never 'total 0' / 'No open reconciliation issues.'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ok: false, error: "reconciliation_failed" }, 500)));
    render(<AdminReconciliationCenter />); await settle();
    expect(screen.queryByText("No open reconciliation issues.")).toBeNull();
    expect(screen.queryByText(/total 0/)).toBeNull();
    expect(screen.queryByText(/critical 0/)).toBeNull();
    const card = screen.getByTestId("card-reconciliation-load-error");
    expect(card.textContent).toContain("could not be loaded");
    expect(card.textContent).toContain("reconciliation_failed");
  });

  it("a network rejection is an error, not 'Loading…' forever, and Retry recovers", async () => {
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(response(empty));
    vi.stubGlobal("fetch", fetchFn);
    render(<AdminReconciliationCenter />); await settle();
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.getByTestId("card-reconciliation-load-error").textContent).toContain("Failed to fetch");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(screen.queryByTestId("card-reconciliation-load-error")).toBeNull();
    expect(screen.getByText("No open reconciliation issues.")).toBeTruthy();
  });
});

describe("Reconciliation Center actions name the issue and show what was recorded", () => {
  const orphan = {
    id: "a".repeat(32), naturalKey: "pos:55", type: "ORPHAN_BROKER_POSITION", severity: "critical",
    userId: 7, bridgeConnectionId: 41, commandId: null, brokerTicket: "123", symbol: "XAUUSD",
    status: "OPEN_AT_BROKER", reason: "Open broker position has no matching arx_live_commands row.",
    recommendedAction: "Link or resolve.", createdAt: null, updatedAt: null,
    metadata: { brokerAbsentSnapshotCount: 0 }, lastAction: null,
  };
  const list = (issues: unknown[]) => ({ ...empty, issues, total: issues.length, actionsReadable: true });

  it("Dismiss on an ORPHAN_BROKER_POSITION posts the issue's naturalKey 'pos:<id>'", async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return response({ ok: true, action: "RECONCILIATION_ISSUE_DISMISSED", issueId: orphan.id });
      return response(list([orphan]));
    });
    vi.stubGlobal("fetch", fetchFn);
    vi.spyOn(window, "prompt").mockReturnValue("known test position");
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<AdminReconciliationCenter />); await settle();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await settle();
    const post = fetchFn.mock.calls.find((c) => c[1]?.method === "POST")!;
    expect(String(post[0])).toBe(`/api/admin/reconciliation-center/issues/${orphan.id}/dismiss`);
    const body = JSON.parse(String(post[1]!.body));
    expect(body.naturalKey).toBe("pos:55");
    expect(body.type).toBe("ORPHAN_BROKER_POSITION");
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("an issue without a usable key is refused here, not posted with an empty key", async () => {
    const noKey = { ...orphan, naturalKey: undefined };
    const fetchFn = vi.fn(async () => response(list([noKey])));
    vi.stubGlobal("fetch", fetchFn);
    vi.spyOn(window, "prompt").mockReturnValue("known test position");
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<AdminReconciliationCenter />); await settle();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await settle();
    expect(fetchFn.mock.calls.some((c) => (c as unknown[])[1] && ((c as unknown[])[1] as RequestInit).method === "POST")).toBe(false);
    expect(String(alertSpy.mock.calls[0]?.[0])).toContain("without its action key");
  });

  it("a dismissed issue shows its recorded action and that it is still detected", async () => {
    const dismissed = {
      ...orphan,
      lastAction: { action: "RECONCILIATION_ISSUE_DISMISSED", at: "2026-10-28T11:00:00.000Z", adminId: 3, reason: "known test position" },
    };
    vi.stubGlobal("fetch", vi.fn(async () => response(list([dismissed]))));
    render(<AdminReconciliationCenter />); await settle();
    const line = screen.getByTestId(`text-issue-last-action-${orphan.id}`).textContent ?? "";
    expect(line).toContain("Dismissed by admin #3");
    expect(line).toContain("still detected");
    expect(screen.getByTestId("text-reconciliation-actions-note").textContent).toContain("None of them changes, fixes or hides the issue");
    expect(screen.queryByText("Open issues")).toBeNull();
  });
});
