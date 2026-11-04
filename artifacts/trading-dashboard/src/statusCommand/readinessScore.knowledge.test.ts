// Readiness score: an assistant-knowledge audit that was never supplied must
// not be reported as "Knowledge audit score: 100/100" with full marks.
// Status Command Center calls computeReadinessScore(ctx, checklist) with no
// knowledge score at all.
import { describe, expect, it } from "vitest";
import { collectRuntimeContext } from "@/assistant/runtimeContext";
import { computeReadinessScore } from "./readinessScore";

const ctx = collectRuntimeContext({ route: "/status-command-center" });
const section = (s: ReturnType<typeof computeReadinessScore>) =>
  s.sections.find((x) => x.id === "assistant-knowledge");

describe("readiness score — assistant knowledge section", () => {
  it("no knowledge score supplied → unscored and labelled as not measured", () => {
    const k = section(computeReadinessScore(ctx, []));
    expect(k).toBeDefined();
    expect(k?.score).toBe(0);
    expect(k?.level).toBe("unavailable");
    expect(k?.summary).not.toMatch(/100\/100/);
    expect(k?.summary).toMatch(/not (been )?(run|measured)/i);
  });

  it("a non-finite knowledge score is treated as not measured", () => {
    const k = section(computeReadinessScore(ctx, [], { knowledgeScore: Number.NaN }));
    expect(k?.score).toBe(0);
    expect(k?.level).toBe("unavailable");
  });

  it("a supplied knowledge score is reported as measured", () => {
    const k = section(computeReadinessScore(ctx, [], { knowledgeScore: 82 }));
    expect(k?.score).toBe(8);
    expect(k?.level).toBe("ready");
    expect(k?.summary).toBe("Knowledge audit score: 82/100.");
  });

  it("the unmeasured section still counts toward the 10-section, 0..100 total", () => {
    const s = computeReadinessScore(ctx, []);
    expect(s.sections).toHaveLength(10);
    expect(s.total).toBe(s.sections.reduce((a, x) => a + x.score, 0));
  });
});
