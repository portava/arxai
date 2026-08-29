// RANK 74 — the guard that keeps DECLARED_ROUTES honest.
//
// The Knowledge Console's route-coverage card used to be fed ROUTE_KNOWLEDGE's
// own route list, so `missing` was always empty and the card always read N/N
// green — a perfect score it could not fail — while 59 of App.tsx's 183
// declared routes had no knowledge entry at all. The operator's only coverage
// dashboard was structurally incapable of reporting the gap it existed to find.
//
// The console is a browser bundle and cannot read App.tsx at runtime, so the
// route list is a checked-in constant. THIS TEST is what makes that acceptable:
// the moment App.tsx gains or loses a <Route>, the constant is stale and the
// build fails, naming exactly which paths drifted. Without it the constant
// would just be a second, quieter fabrication.
//
// It also asserts the coverage number is a REAL number — i.e. that some
// declared routes are genuinely uncovered — so a future change cannot restore
// the always-green card by accident.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DECLARED_ROUTES } from "./declaredRoutes";
import { ROUTE_KNOWLEDGE, resolveRoute } from "./routeKnowledge";
import { routeCoverage } from "./coverage";

const HERE = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(resolve(HERE, "../App.tsx"), "utf8");

function routesInApp(): string[] {
  return [...new Set([...appSrc.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]))].sort();
}

describe("DECLARED_ROUTES matches App.tsx", () => {
  it("has not drifted", () => {
    const actual = routesInApp();
    const declared = [...DECLARED_ROUTES];
    const added = actual.filter((r) => !declared.includes(r));
    const removed = declared.filter((r) => !actual.includes(r));
    expect(
      { added, removed },
      "src/knowledge/declaredRoutes.ts is out of date with App.tsx — regenerate it",
    ).toEqual({ added: [], removed: [] });
  });

  it("is a substantial, sorted, duplicate-free list", () => {
    expect(DECLARED_ROUTES.length).toBeGreaterThan(100);
    expect(new Set(DECLARED_ROUTES).size).toBe(DECLARED_ROUTES.length);
    expect([...DECLARED_ROUTES]).toEqual([...DECLARED_ROUTES].sort());
  });
});

describe("the coverage card can now actually fail", () => {
  it("real coverage is measured against App.tsx, not against the registry itself", () => {
    const selfReferential = routeCoverage(ROUTE_KNOWLEDGE.map((r) => r.route));
    const real = routeCoverage([...DECLARED_ROUTES]);

    // The old call could not report a gap, by construction.
    expect(selfReferential.missing).toEqual([]);
    // The real one does — and that is the point. If this ever becomes 0, the
    // registry genuinely covers every route and this assertion should be
    // changed deliberately, not silently.
    expect(real.total).toBe(DECLARED_ROUTES.length);
    expect(real.missing.length).toBeGreaterThan(0);
    expect(real.covered).toBeLessThan(real.total);
  });

  it("the console feeds the real list in", () => {
    const console_ = readFileSync(resolve(HERE, "../pages/assistant-knowledge-console.tsx"), "utf8");
    expect(console_).toMatch(/routeCoverage\(\[\.\.\.DECLARED_ROUTES\]\)/);
    expect(console_).not.toMatch(/routeCoverage\(ROUTE_KNOWLEDGE\.map/);
  });
});

describe("RANK 74 — the fabricated route descriptions are gone", () => {
  const entry = (route: string) => ROUTE_KNOWLEDGE.find((r) => r.route === route);

  it("/ai-readiness-score is not sold as per-setup trade confidence", () => {
    const e = entry("/ai-readiness-score");
    expect(e).toBeDefined();
    expect(e!.purpose).not.toMatch(/confidence that the current setup is trade-worthy/i);
    expect(`${e!.purpose} ${e!.safety ?? ""}`).toMatch(/NOT a per-setup confidence score/i);
  });

  it("/ai-decisions does not promise a decision audit trail", () => {
    const e = entry("/ai-decisions");
    expect(e!.purpose).not.toMatch(/Audit trail of every AI decision/i);
    expect(e!.purpose).toMatch(/alias/i);
  });

  it("aliases that share one page say so", () => {
    // /ai-decisions + /ai-autopilot → LiveAiAutoTestPage;
    // /charts → LiveChartPage; /audit-vault + /safety-logs → AuditLog.
    for (const route of ["/ai-decisions", "/ai-autopilot", "/charts", "/audit-vault", "/safety-logs"]) {
      const e = entry(route);
      expect(e, `${route} must have an entry`).toBeDefined();
      expect(`${e!.title} ${e!.purpose}`, `${route} must be described as an alias`).toMatch(/alias/i);
    }
  });

  it("the shared pages really are shared in App.tsx", () => {
    // Non-vacuous: prove the aliasing this test asserts is real.
    expect(appSrc).toMatch(/<Route path="\/ai-decisions" component=\{LiveAiAutoTestPage\}/);
    expect(appSrc).toMatch(/<Route path="\/ai-autopilot" component=\{LiveAiAutoTestPage\}/);
    expect(appSrc).toMatch(/<Route path="\/charts" component=\{LiveChartPage\}/);
    expect(appSrc).toMatch(/<Route path="\/safety-logs">\{\(\) => <AuditLog \/>\}/);
  });

  it("no route entry still claims live trading is disabled outright", () => {
    for (const r of ROUTE_KNOWLEDGE) {
      const text = `${r.purpose} ${r.safety ?? ""}`;
      expect(text, `${r.route} still asserts live trading is disabled`).not.toMatch(
        /LIVE TRADING DISABLED|PAPER[_ ]ONLY|live trading is disabled/i,
      );
    }
  });

  it("every `related` route still resolves", () => {
    const broken: string[] = [];
    for (const r of ROUTE_KNOWLEDGE) {
      for (const rel of r.related ?? []) if (!resolveRoute(rel)) broken.push(`${r.route} → ${rel}`);
    }
    expect(broken, `route knowledge has unresolvable related links: ${broken.join(", ")}`).toEqual([]);
  });
});
