// The /authority grant press must not be pre-filled or one-click.
//
// The first version of this page opened with maxLevel="3" and days="7" already
// in the boxes, and the level did not adapt to the selected ladder. Choosing
// "Self-trade agent autonomy level" (baseline 0, ladder max 4) and pressing
// without editing granted three levels above baseline that the user never
// chose — the same confident-default pattern admin/edge-capacity.tsx
// deliberately refuses ("a blank field can never be sent as a confident zero"),
// on a press that WIDENS authority.
//
// A grant only permits a later gated raise, so this is a deliberation step
// rather than a last line of defence. It is still a widening press.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const AUTHORITY_PAGE = {
  effective: [
    {
      kind: "MISSION_AUTOMATION_LEVEL",
      baseline: 2,
      ladderMax: 6,
      accountCeiling: 2,
      source: "BASELINE",
      expiresAt: null,
      reasons: ["No active grant; the conservative baseline applies."],
    },
    {
      kind: "AGENT_AUTONOMY_LEVEL",
      baseline: 0,
      ladderMax: 4,
      accountCeiling: 0,
      source: "BASELINE",
      expiresAt: null,
      reasons: [],
    },
  ],
  grants: [],
  maxGrantDurationMs: 30 * 24 * 60 * 60 * 1000,
  scopes: ["ACCOUNT", "MISSION"],
  note: "A grant permits a later explicit raise through the normal safety gates.",
};

const posts: Array<{ url: string; body: unknown }> = [];

beforeEach(() => {
  posts.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => AUTHORITY_PAGE } as unknown as Response;
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

import AuthorityPage from "./authority";

async function mount() {
  render(<AuthorityPage />);
  await screen.findByTestId("authority-grant-form");
}

function set(testId: string, value: string) {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

describe("/authority grant press", () => {
  it("opens with no level and no duration pre-filled", async () => {
    await mount();
    expect((screen.getByTestId("input-max-level") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("input-grant-days") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("input-grant-confirm") as HTMLInputElement).value).toBe("");
  });

  it("keeps the press disarmed until every field is chosen and the phrase is typed", async () => {
    await mount();
    const button = screen.getByTestId("button-create-grant") as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    set("input-max-level", "3");
    expect((screen.getByTestId("button-create-grant") as HTMLButtonElement).disabled).toBe(true);

    set("input-grant-days", "7");
    // Filled but unconfirmed: still disarmed. This is the click that used to
    // grant three levels above baseline with nothing typed at all.
    expect((screen.getByTestId("button-create-grant") as HTMLButtonElement).disabled).toBe(true);

    set("input-grant-confirm", "GRANT");
    expect((screen.getByTestId("button-create-grant") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the SELECTED ladder's own baseline and maximum, not a remembered one", async () => {
    await mount();
    expect(screen.getByTestId("max-level-ladder-context").textContent).toContain("baseline 2");
    expect(screen.getByTestId("max-level-ladder-context").textContent).toContain("ladder max 6");

    fireEvent.change(screen.getByTestId("select-authority-kind"), {
      target: { value: "AGENT_AUTONOMY_LEVEL" },
    });
    // Baseline 0, ladder max 4 — the numbers the old pre-filled "3" ignored.
    expect(screen.getByTestId("max-level-ladder-context").textContent).toContain("baseline 0");
    expect(screen.getByTestId("max-level-ladder-context").textContent).toContain("ladder max 4");
    // Switching ladders must not silently carry a level over as a default.
    expect((screen.getByTestId("input-max-level") as HTMLInputElement).value).toBe("");
  });

  it("sends exactly what was typed once armed", async () => {
    await mount();
    set("input-max-level", "4");
    set("input-grant-days", "2");
    set("input-grant-confirm", "GRANT");
    fireEvent.click(screen.getByTestId("button-create-grant"));

    await waitFor(() => expect(posts.length).toBe(1));
    const body = posts[0].body as Record<string, unknown>;
    expect(posts[0].url).toBe("/api/me/authority/grants");
    expect(body.kind).toBe("MISSION_AUTOMATION_LEVEL");
    expect(body.maxLevel).toBe(4);
    expect(typeof body.expiresAt).toBe("string");
  });
});
