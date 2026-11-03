// Trader Skill breakdown truth: a pillar with no evidence (no debriefs, no
// edge reports ...) was not measured. The server names those pillars; the
// card shows "no data" for them, never a measured-looking 0, and says they
// still count as 0 in the total. When the server could not check which
// pillars have evidence, the card says a 0 may mean no data.

import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { SkillBreakdownCard } from "./SkillBreakdownCard";
import type { TraderSkillProfile } from "./types";

const profile: TraderSkillProfile = {
  id: 1, skillLevel: "Beginner", totalScore: 25,
  disciplineScore: 0, executionScore: 0, riskScore: 100, emotionalControlScore: 0,
  consistencyScore: 0, planningScore: 0, reviewScore: 0, practiceScore: 80,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};

afterEach(() => cleanup());

function row(label: string): HTMLElement {
  const el = screen.getByText(label).closest("[data-pillar]");
  if (!el) throw new Error(`no row for ${label}`);
  return el as HTMLElement;
}

describe("SkillBreakdownCard — unmeasured pillars", () => {
  it("shows 'no data' for pillars with no evidence, and the measured 0 of review as 0", () => {
    render(<SkillBreakdownCard profile={profile} unmeasured={["discipline", "execution", "emotional", "consistency", "planning"]} />);
    expect(within(row("Discipline")).getByText(/no data/i)).toBeTruthy();
    expect(within(row("Discipline")).queryByText("0")).toBeNull();
    expect(within(row("Consistency")).getByText(/no data/i)).toBeTruthy();
    expect(within(row("Review cadence")).getByText("0")).toBeTruthy();
    expect(within(row("Practice")).getByText("80")).toBeTruthy();
    expect(screen.getByText(/count as 0 in the total/i)).toBeTruthy();
  });

  it("says a 0 may mean no data when the evidence could not be checked", () => {
    render(<SkillBreakdownCard profile={profile} unmeasured={null} />);
    expect(screen.getByText(/could not be checked/i)).toBeTruthy();
  });

  it("a pillar with a stored score above 0 is shown even if listed", () => {
    render(<SkillBreakdownCard profile={{ ...profile, disciplineScore: 40 }} unmeasured={["discipline"]} />);
    expect(within(row("Discipline")).getByText("40")).toBeTruthy();
  });
});
