// Demo account card — "No active account." (and the create form, whose POST
// deactivates the user's current account) may only follow a confirmed 404.
// A 503 means the account exists but could not be valued; any other failure
// means it could not be loaded. Neither is "no account".
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PaperAccountCard } from "./PaperAccountCard";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><PaperAccountCard /></QueryClientProvider>);
}

describe("PaperAccountCard read states", () => {
  it("503 valuation unavailable: the account exists, no 'No active account' and no create form", async () => {
    mount(503, { error: "Paper account valuation unavailable: a current real quote is required", simulated: true });
    const state = await screen.findByTestId("paper-account-unavailable");
    expect(state.textContent).toContain("a current real quote is required");
    expect(state.textContent).toMatch(/could not be valued/i);
    expect(screen.queryByText("No active account.")).toBeNull();
    expect(screen.queryByText("Create demo account")).toBeNull();
  });

  it("500: could not be loaded, no create form", async () => {
    mount(500, { error: "Failed" });
    const state = await screen.findByTestId("paper-account-unavailable");
    expect(state.textContent).toMatch(/could not be loaded/i);
    expect(screen.queryByText("No active account.")).toBeNull();
    expect(screen.queryByText("Create demo account")).toBeNull();
  });

  it("a confirmed 404 still offers to create one", async () => {
    mount(404, { error: "No active paper account" });
    await screen.findByText("No active account.");
    expect(screen.getByText("Create demo account")).toBeTruthy();
  });

  it("while loading it does not offer to create one", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><PaperAccountCard /></QueryClientProvider>);
    expect(screen.queryByText("No active account.")).toBeNull();
    expect(screen.queryByText("Create demo account")).toBeNull();
  });
});
