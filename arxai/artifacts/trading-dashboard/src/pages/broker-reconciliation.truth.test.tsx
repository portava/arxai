// Broker Reconciliation: a refused or failed read is an error, never zero
// counts; and the broker side the server never read (syncStatus DEFERRED,
// mt5Connected false) is not shown as "0 broker orders / 0 mismatches".
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const { default: BrokerReconciliationPage } = await import("./broker-reconciliation");

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: status >= 200 && status < 300, status, json: async () => body,
  }) as unknown as Response));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function valueOf(label: string): string {
  const el = screen.getByText(label);
  return el.nextElementSibling?.textContent ?? "";
}

describe("Broker Reconciliation truth", () => {
  it("a 403 is shown as an access error, not as zero counts", async () => {
    stubFetch(403, { ok: false, error: "ADMIN_OR_OWNER_REQUIRED", redirectTo: "/admin/reconciliation-center" });
    render(<BrokerReconciliationPage />);
    const err = await screen.findByTestId("recon-error");
    expect(err.textContent).toMatch(/admin or owner/i);
    expect(screen.queryByText("Broker orders")).toBeNull();
    expect(screen.queryByText("Mismatches")).toBeNull();
    expect(screen.queryByText(/syncStatus=unknown/)).toBeNull();
  });

  it("a network failure is shown as an error, not as zero counts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    render(<BrokerReconciliationPage />);
    const err = await screen.findByTestId("recon-error");
    expect(err.textContent).toMatch(/could not load/i);
    expect(screen.queryByText("Mismatches")).toBeNull();
  });

  it("the deferred broker side is 'not read', not 0, and does not promise it activates on connect", async () => {
    stubFetch(200, {
      mt5Connected: false, brokerOrders: [], brokerPositions: [], localOrders: 2, localPositions: 1,
      localLiveIntents: 0, mismatches: [], syncStatus: "DEFERRED",
      notice: "Broker reconciliation activates after MT5 bridge is connected.",
    });
    render(<BrokerReconciliationPage />);
    await screen.findByText("Broker orders");
    expect(valueOf("Broker orders")).toMatch(/not read/i);
    expect(valueOf("Broker positions")).toMatch(/not read/i);
    expect(valueOf("Mismatches")).toMatch(/not checked/i);
    expect(valueOf("Orders")).toBe("2");
    expect(screen.queryByText(/Activates once MT5 bridge is connected/)).toBeNull();
    expect(screen.queryByText("MT5 DEFERRED")).toBeNull();
    expect(screen.getByRole("link", { name: /Reconciliation Center/i }).getAttribute("href")).toContain("/admin/reconciliation-center");
  });
});
