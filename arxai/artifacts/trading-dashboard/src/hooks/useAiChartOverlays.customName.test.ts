import { describe, it, expect } from "vitest";
import { buildRubyOverlays, type RubyReadSummary } from "./useAiChartOverlays";
import { DEFAULT_ASSISTANT_NAME } from "@/lib/assistant-name";

/**
 * Custom assistant-name builder proof (Task #644).
 *
 * `buildRubyOverlays` is a pure copy builder that stamps the assistant's
 * display name into chart-overlay labels. Task #640 parameterized it with an
 * `assistantName` argument (default = DEFAULT_ASSISTANT_NAME). This test locks
 * that a supplied custom name flows into the output labels, and that omitting
 * it falls back to the default — so a regression that drops the parameter or
 * re-hardcodes the name is caught.
 *
 * Display-only: this exercises label text, not AI logic, safety, or execution.
 */

const read: RubyReadSummary = {
  bias: "up",
  confidence: "high",
  supportZone: "1.1000 – 1.1010",
  resistanceZone: "1.2000 – 1.2010",
  dataQuality: "ok",
};

describe("buildRubyOverlays stamps the assistant display name into overlay labels", () => {
  it("uses a supplied custom name in support/resistance labels", () => {
    const overlays = buildRubyOverlays(read, "EURUSD", "Nova");
    const labels = overlays.map((o) => o.label);

    expect(labels).toContain("Nova support");
    expect(labels).toContain("Nova resistance");
    // The default name must not appear when a custom name is supplied.
    expect(labels.some((l) => l.includes(DEFAULT_ASSISTANT_NAME))).toBe(false);
  });

  it("falls back to the default name when none is supplied", () => {
    const overlays = buildRubyOverlays(read, "EURUSD");
    const labels = overlays.map((o) => o.label);

    expect(labels).toContain(`${DEFAULT_ASSISTANT_NAME} support`);
    expect(labels).toContain(`${DEFAULT_ASSISTANT_NAME} resistance`);
  });
});
