import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rowScore } from "./scannerRowScore";

describe("scanner row score", () => {
  it("reads `score`, the field the server emits", () => {
    expect(rowScore({ score: 64, confidenceScore: 64 })).toBe(64);
  });
  it("falls back to the deprecated confidenceScore alias from an older server", () => {
    expect(rowScore({ confidenceScore: 71 })).toBe(71);
    expect(rowScore({ score: null, confidenceScore: 71 })).toBe(71);
    expect(rowScore({ score: Number.NaN, confidenceScore: 71 })).toBe(71);
  });
  it("prefers `score` when the two ever differ", () => {
    expect(rowScore({ score: 0, confidenceScore: 88 })).toBe(0);
  });
  it("the scanner page renders the score through rowScore, labelled Score, not confidence", () => {
    const src = readFileSync(resolve(__dirname, "../pages/market-scanner.tsx"), "utf8");
    expect(src).toContain("const raw = rowScore(o);");
    expect(src).not.toMatch(/Math\.round\(o\.confidenceScore \* mult\)/);
    expect(src).toContain('<div className="text-muted-foreground">Score</div>');
  });
});
