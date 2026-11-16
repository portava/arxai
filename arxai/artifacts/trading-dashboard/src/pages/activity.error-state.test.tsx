import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// /api/me/activity answering 401/500 means the timeline could not be read.
// The page used to show "No activity yet — Your timeline will populate…"
// because it never checked q.isError.

const { default: Activity } = await import("./activity");

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><Activity /></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Activity timeline — failed read", () => {
  it("shows an error state instead of 'No activity yet'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    renderPage();
    await screen.findByText(/could not be loaded/i);
    expect(screen.queryByText("No activity yet")).toBeNull();
  });

  it("an empty timeline that was read still says 'No activity yet'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ events: [], isEmpty: true }) })));
    renderPage();
    await screen.findByText("No activity yet");
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  });
});
