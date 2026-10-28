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
