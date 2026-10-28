import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Truth guard: the scanner and its signals are POLLED (useScannerTruth
 * refetches every 15 s) and every read carries its own Live / Delayed /
 * Stale / Historical verdict. Static navigation / knowledge copy — which the
 * command palette shows and Ruby repeats — must not assert "real-time"
 * unconditionally for those surfaces (or for the on-request AI co-pilot).
 *
 * "Realtime WebRTC" is the name of the voice transport, not a market-data
 * claim, so it is excluded; comments are excluded too.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const FILES = [
  "trading-dashboard/src/components/layout/AppLayout.tsx",
  "trading-dashboard/src/knowledge/routeKnowledge.ts",
  "api-server/src/lib/assistant/featureMap.ts",
];

function offendingLines(rel: string): string[] {
  const src = readFileSync(path.join(ROOT, rel), "utf8");
  return src
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter(({ line }) => /real[- ]?time/i.test(line) && !/realtime\s+webrtc/i.test(line))
    .map(({ line, n }) => `${rel}:${n}: ${line.trim().slice(0, 160)}`);
}

describe("static scanner / signal copy never claims real-time", () => {
  for (const rel of FILES) {
    it(`${rel} has no unconditional real-time claim`, () => {
      expect(offendingLines(rel)).toEqual([]);
    });
  }

  it("the scanner descriptions say how the data is refreshed", () => {
    const layout = readFileSync(path.join(ROOT, FILES[0]), "utf8");
    const scannerLine = layout.split("\n").find((l) => l.includes('"/market-scanner":')) ?? "";
    expect(scannerLine).toMatch(/poll/i);
    const featureMap = readFileSync(path.join(ROOT, FILES[2]), "utf8");
    const featureLine = featureMap.split("\n").find((l) => l.includes('key: "scanner"')) ?? "";
    expect(featureLine).toMatch(/poll/i);
  });
});
