// AI Mentor: when session generation fails the page says so. It never shows
// "Building your first mentor session…" while nothing is being built, and it
// does not loop POST /mentor/sessions after a failure.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/components/aiMentor", () => ({
  DailyMentorBriefingCard: () => <div data-testid="briefing" />,
  MentorActionItems: () => <div data-testid="action-items" />,
  MentorWarningCard: () => null,
  MentorHistory: () => <div data-testid="history" />,
}));

const { default: AiMentorPage } = await import("./ai-mentor");

type Route = { status: number; body: unknown };
let routes: { latest: Route; history: Route; post: Route };
let postCalls = 0;

function jsonResponse({ status, body }: Route): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  postCalls = 0;
  routes = {
    latest: { status: 200, body: { session: null, actionItems: [] } },
    history: { status: 200, body: { sessions: [] } },
    post: { status: 500, body: { error: "mentor generation failed" } },
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
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

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><AiMentorPage /></QueryClientProvider>);
}

async function flush() {
  for (let i = 0; i < 10; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
}

describe("AI Mentor failure states", () => {
  it("a failed auto-generation surfaces an error and is attempted once", async () => {
    renderPage();
    await flush();
    expect(postCalls).toBe(1);
    expect(screen.queryByText(/Building your first mentor session/)).toBeNull();
    expect(screen.getByTestId("mentor-state").textContent).toMatch(/could not be generated/i);
    expect(screen.getByTestId("mentor-state").textContent).toContain("mentor generation failed");
  });

  it("an unauthorised latest-session read is an error, not 'building' and not an auto-POST", async () => {
    routes.latest = { status: 401, body: { error: "unauthorized" } };
    renderPage();
    await flush();
    expect(postCalls).toBe(0);
    expect(screen.queryByText(/Building your first mentor session/)).toBeNull();
    expect(screen.getByTestId("mentor-state").textContent).toMatch(/could not load/i);
  });

  it("a generation that succeeds but still leaves no session does not loop", async () => {
    routes.post = { status: 200, body: { session: null } };
    renderPage();
    await flush();
    expect(postCalls).toBe(1);
    expect(screen.queryByText(/Building your first mentor session/)).toBeNull();
  });
});
