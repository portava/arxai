// Edge discovery: an unread or failed read is not an all-clear. "Nothing
// flagged.", "No strong edges yet", "Latest slices (0)" and "Generated 0
// slice(s)" only render when the server actually answered with that.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { default: EdgeDiscoveryPage } = await import("./edge-discovery");

type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown } | "pending";

function stubFetch(handler: Handler) {
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    const r = handler(String(url), init);
    if (r === "pending") return new Promise(() => {});
    return Promise.resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body });
  }));
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><EdgeDiscoveryPage /></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Edge discovery truth labels", () => {
  it("a 401 on every read shows an error, never 'Nothing flagged.' or 'Latest slices (0)'", async () => {
    stubFetch(() => ({ status: 401, body: { error: "unauthorized" } }));
    renderPage();
    await waitFor(() => expect(screen.getAllByText(/Could not load/).length).toBeGreaterThanOrEqual(3));
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Nothing flagged.");
    expect(text).not.toContain("No strong edges yet");
    expect(text).not.toContain("No reports yet");
    expect(text).not.toMatch(/slices \(0\)/);
    expect(text).toContain("unauthorized");
  });

  it("first paint (reads still pending) shows loading, not empty states", () => {
    stubFetch(() => "pending");
    renderPage();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Nothing flagged.");
    expect(text).not.toContain("No strong edges yet");
    expect(text).not.toContain("No reports yet");
    expect(text).not.toMatch(/slices \(0\)/);
    expect(screen.getAllByText(/Loading/).length).toBeGreaterThanOrEqual(3);
  });

  it("a failed Generate shows the error, not 'Generated 0 slice(s).'", async () => {
    stubFetch((_url, init) => init?.method === "POST"
      ? { status: 500, body: { error: "Failed to generate edge reports" } }
      : { status: 200, body: { reports: [] } });
    renderPage();
    await screen.findByText("Nothing flagged.");
    fireEvent.click(screen.getByText("Generate report"));
    await waitFor(() => expect(screen.getByTestId("edge-generate-error")).toBeTruthy());
    expect(screen.getByTestId("edge-generate-error").textContent).toContain("Failed to generate edge reports");
    expect(screen.queryByText(/Generated 0 slice/)).toBeNull();
  });

  it("a real empty answer still shows the honest empty states", async () => {
    stubFetch(() => ({ status: 200, body: { reports: [] } }));
    renderPage();
    await screen.findByText("Nothing flagged.");
    expect(screen.getByText(/No strong edges yet/)).toBeTruthy();
    expect(screen.getByText(/Latest slices \(0\)/)).toBeTruthy();
  });
});
