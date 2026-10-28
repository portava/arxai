// Command Center Chat tab truth: a failed mentor read is shown as "could not
// load", never as "No mentor briefing yet" / "No recent conversations yet".
// The Chat tab shares the mentor query cache with /ai-mentor, so a failed read
// here must stay an error in that cache: it must not let AI Mentor believe the
// server said "no session" and auto-generate one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/components/scanner/SelectedMarketPanel", () => ({ SelectedMarketPanel: () => null }));
vi.mock("@/components/ruby/RubyAccountHealthStrip", () => ({ RubyAccountHealthStrip: () => null }));

const { default: AICommandCenterPage } = await import("./ai-command-center");
const { default: AiMentorPage } = await import("./ai-mentor");

type Route = { status: number; body: unknown };
let routes: { latest: Route; history: Route; post: Route };
let postCalls = 0;
let urls: string[] = [];

function jsonResponse({ status, body }: Route): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  postCalls = 0;
  urls = [];
  routes = {
    latest: { status: 200, body: { session: null, actionItems: [] } },
    history: { status: 200, body: { sessions: [] } },
    post: { status: 500, body: { error: "mentor generation failed" } },
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    if (url.startsWith("/api/mentor/sessions/latest")) return jsonResponse(routes.latest);
    if (url.startsWith("/api/mentor/sessions?")) return jsonResponse(routes.history);
    if (url === "/api/mentor/sessions" && init?.method === "POST") {
      postCalls += 1;
      return jsonResponse(routes.post);
    }
    return jsonResponse({ status: 404, body: { error: "not found" } });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

async function flush() {
  for (let i = 0; i < 10; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
}

describe("Command Center Chat tab mentor reads", () => {
  it("a failed latest-session read says it could not be loaded, not 'No mentor briefing yet'", async () => {
    routes.latest = { status: 500, body: { error: "x" } };
    render(<QueryClientProvider client={newClient()}><AICommandCenterPage /></QueryClientProvider>);
    await flush();
    expect(screen.queryByText(/No mentor briefing yet/)).toBeNull();
    expect(screen.getByTestId("chat-mentor-latest-error").textContent).toMatch(/could not load/i);
  });

  it("a failed history read says it could not be loaded, not 'No recent conversations yet'", async () => {
    routes.history = { status: 401, body: { error: "unauthorized" } };
    render(<QueryClientProvider client={newClient()}><AICommandCenterPage /></QueryClientProvider>);
    await flush();
    expect(screen.queryByText(/No recent conversations yet/)).toBeNull();
    expect(screen.getByTestId("chat-mentor-history-error").textContent).toMatch(/could not load/i);
  });

  it("a confirmed empty server answer still shows the empty states", async () => {
    render(<QueryClientProvider client={newClient()}><AICommandCenterPage /></QueryClientProvider>);
    await flush();
    expect(screen.getByText(/No mentor briefing yet/)).toBeTruthy();
    expect(screen.queryByTestId("chat-mentor-latest-error")).toBeNull();
  });

  it("a failed read on the Chat tab does not make AI Mentor auto-generate a session", async () => {
    routes.latest = { status: 500, body: { error: "x" } };
    const qc = newClient();
    const first = render(<QueryClientProvider client={qc}><AICommandCenterPage /></QueryClientProvider>);
    await flush();
    first.unmount();
    render(<QueryClientProvider client={qc}><AiMentorPage /></QueryClientProvider>);
    await flush();
    expect(postCalls).toBe(0);
    expect(screen.getByTestId("mentor-state").textContent).toMatch(/could not load/i);
  });

  it("each page's history page size has its own cache entry", async () => {
    const qc = newClient();
    const first = render(<QueryClientProvider client={qc}><AICommandCenterPage /></QueryClientProvider>);
    await flush();
    first.unmount();
    render(<QueryClientProvider client={qc}><AiMentorPage /></QueryClientProvider>);
    await flush();
    const keys = qc.getQueryCache().findAll({ queryKey: ["mentor-history"] }).map((q) => JSON.stringify(q.queryKey));
    expect(keys.length).toBe(2);
    expect(urls.some((u) => u.includes("/api/mentor/sessions?limit=10"))).toBe(true);
    expect(urls.some((u) => u.includes("/api/mentor/sessions?limit=20"))).toBe(true);
  });
});
