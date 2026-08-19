// THEME G-CUT — the standalone /backtest surface is retired honestly.
//
// The page itself was already reduced to a redirect: Testing Lab owns
// backtesting and hosts the real, DB-persisted engine. What had NOT been
// retired was the app's own description of the route.
//
// `routeKnowledge` still advertised /backtest as "Upload candle CSV, run a
// backtest, see equity curve" — a page that no longer exists, describing a
// capability that was itself the fabrication being removed. The old form read
// the uploaded CSV into component state, ignored it, and submitted
// Math.random() `dummyCandles` to the backend, presenting invented results as
// though they came from the user's own historical data.
//
// That stale entry is live: it feeds the in-app assistant's route answers, so
// a user asking "what is backtesting?" was pointed at a redirect shell and
// told to upload a CSV.
//
// The redirect ROUTE is deliberately kept (Theme H: keep old routes as
// redirects, break nothing) — only the claim about it is corrected.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { ROUTE_KNOWLEDGE } from "./routeKnowledge";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

function read(rel: string): string {
  return readFileSync(resolve(SRC, rel), "utf8");
}

const backtestEntry = ROUTE_KNOWLEDGE.find((r) => r.route === "/backtest");
const testingLabEntry = ROUTE_KNOWLEDGE.find((r) => r.route === "/testing-lab");

describe("G-CUT — /backtest is described honestly", () => {
  it("still has a knowledge entry (the route still resolves)", () => {
    expect(backtestEntry).toBeDefined();
  });

  it("no longer claims a CSV upload the page cannot do", () => {
    expect(backtestEntry!.purpose).not.toMatch(/csv/i);
    expect(backtestEntry!.purpose).not.toMatch(/equity curve/i);
  });

  it("says it redirects and points at the owner of the feature", () => {
    expect(backtestEntry!.purpose).toMatch(/redirect/i);
    expect(backtestEntry!.related ?? []).toContain("/testing-lab");
  });

  it("Testing Lab no longer points back at the redirect shell", () => {
    expect(testingLabEntry).toBeDefined();
    expect(testingLabEntry!.related ?? []).not.toContain("/backtest");
  });

  it("the assistant sends a backtesting question to Testing Lab", () => {
    const qa = read("knowledge/_qa-test.ts");
    expect(qa).toMatch(/\{ q: "What is backtesting\?", route: "\/testing-lab" \}/);
  });
});

describe("G-CUT — nothing is broken by the retirement", () => {
  it("the redirect route is still registered so old links resolve", () => {
    const app = read("App.tsx");
    expect(app).toMatch(/<Route path="\/backtest"/);
  });

  it("the page still redirects to Testing Lab", () => {
    const page = read("pages/backtest.tsx");
    expect(page).toMatch(/navigate\("\/testing-lab", \{ replace: true \}\)/);
  });

  it("the page does not resurrect a client-side candle upload", () => {
    // Comments are stripped: the page's header deliberately DOCUMENTS the
    // Math.random()/dummyCandles leak it replaced, and that record should stay.
    const code = read("pages/backtest.tsx")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/Math\.random\(/);
    expect(code).not.toMatch(/dummyCandles/);
    expect(code).not.toMatch(/FileReader/);
  });
});
