// Trader Skill truth: when profile calculation fails the page says so. It
// never shows "Building your first profile…" while nothing is being built, and
// it does not loop POST /skill/calculate after a failure. A failed history or
// suggestions read says it could not be loaded, never "No level changes yet."
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/components/traderSkill", () => ({
  SkillLevelBadge: () => <span />,
  SkillBreakdownCard: () => null,
  LevelProgressMeter: () => null,
  NextLevelRequirementsCard: () => <div data-testid="next-level-card" />,
}));

const { default: TraderSkillPage } = await import("./trader-skill");

type Route = { status: number; body: unknown };
let routes: Record<"profile" | "post" | "history" | "suggestions", Route>;
let postCalls = 0;

const PROFILE = { skillLevel: "Beginner", totalScore: 40, updatedAt: "2026-10-28T10:00:00.000Z" };

function jsonResponse({ status, body }: Route): Response {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => text } as unknown as Response;
}

beforeEach(() => {
  postCalls = 0;
  routes = {
    profile: { status: 200, body: { profile: null } },
    post: { status: 500, body: { error: "Failed to calculate skill profile" } },
    history: { status: 200, body: { history: [] } },
    suggestions: { status: 200, body: { suggestions: [] } },
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/skill/calculate" && init?.method === "POST") {
      postCalls += 1;
      return jsonResponse(routes.post);
    }
    if (url === "/api/skill/profile") return jsonResponse(routes.profile);
    if (url === "/api/skill/history") return jsonResponse(routes.history);
    if (url === "/api/skill/suggestions") return jsonResponse(routes.suggestions);
    return jsonResponse({ status: 404, body: { error: "not found" } });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><TraderSkillPage /></QueryClientProvider>);
}

async function flush() {
  for (let i = 0; i < 10; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
}

describe("Trader Skill failure states", () => {
  it("a failed first calculation is attempted once and says it could not be calculated", async () => {
    renderPage();
    await flush();
    expect(postCalls).toBe(1);
    expect(screen.queryByText(/Building your first profile/)).toBeNull();
    const state = screen.getByTestId("skill-profile-state").textContent ?? "";
    expect(state).toMatch(/could not be calculated/i);
    expect(state).toContain("Failed to calculate skill profile");
  });

  it("a failed profile read is an error, not 'building' and not an auto-POST", async () => {
    routes.profile = { status: 401, body: { error: "unauthorized" } };
    renderPage();
    await flush();
    expect(postCalls).toBe(0);
    expect(screen.queryByText(/Building your first profile/)).toBeNull();
    expect(screen.getByTestId("skill-profile-state").textContent).toMatch(/could not load/i);
  });

  it("failed history and suggestions reads say they could not be loaded", async () => {
    routes.profile = { status: 200, body: { profile: PROFILE } };
    routes.history = { status: 500, body: { error: "x" } };
    routes.suggestions = { status: 500, body: { error: "x" } };
    renderPage();
    await flush();
    expect(postCalls).toBe(0);
    expect(screen.queryByText(/No level changes yet/)).toBeNull();
    expect(screen.queryByTestId("next-level-card")).toBeNull();
    expect(screen.getAllByText(/could not be loaded/i).length).toBe(2);
  });
});

// Regression: React Query keeps the last good profile when a reload fails.
// After a successful Recalculate the profile reload returned 500, and the page
// showed the previous profile with no notice that the reload failed.
describe("Trader Skill when a profile reload fails", () => {
  it("a successful recalculation whose profile reload fails says the profile shown is the earlier one", async () => {
    routes.profile = { status: 200, body: { profile: { ...PROFILE, id: 7 } } };
    routes.post = { status: 200, body: { profile: { ...PROFILE, id: 8, updatedAt: "2026-11-03T09:00:00.000Z" } } };
    renderPage();
    await flush();
    expect(screen.queryByTestId("skill-profile-reload-failed")).toBeNull();

    routes.profile = { status: 500, body: { error: "Failed to load skill profile" } };
    await act(async () => { screen.getByText("Recalculate").click(); });
    await flush();
    expect(postCalls).toBe(1);
    const notice = screen.getByTestId("skill-profile-reload-failed");
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toMatch(/could not be loaded/i);
    expect(notice.textContent).toContain("Failed to load skill profile");
    expect(notice.textContent).toContain(new Date(PROFILE.updatedAt).toLocaleString());
    expect(notice.textContent).toMatch(/not the one just calculated/);
  });
});
