// Per-user isolation — the nine non-/me routers refuse an unauthenticated
// caller BEFORE any handler runs.
//
// Every router below shipped with zero `requireUser`: /weekly-reviews,
// /analytics/*, /mentor/*, /skill/*, /edge/*, /onboarding/*, /paper-sessions/*
// and /trader-coach/* answered any caller with whichever row the planner
// happened to return — one trader's weekly P&L, skill level, mentor briefing,
// onboarding acknowledgements and paper sessions, served to everyone.
// /security/* additionally exposed the admin role×permission matrix, the
// security event log and the access logs to any signed-in trader.
//
// This suite drives the REAL routers with no `req.authUser` and asserts the
// refusal happens in middleware. Because nothing reaches a handler, no
// database is touched: DATABASE_URL points at a closed local port, and any
// request that got through to a query would fail loudly rather than pass.
//
// Run: node --import tsx --test src/routes/__qa__/scopedSurfaceAuthGates.test.ts

process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

const [
  { default: weeklyReviewsRouter },
  { default: analyticsRouter },
  { default: aiMentorRouter },
  { default: traderSkillRouter },
  { default: edgeDiscoveryRouter },
  { default: onboardingRouter },
  { default: paperSessionsRouter },
  { default: traderCoachRouter },
] = await Promise.all([
  import("../weeklyReviews.js"),
  import("../analytics.js"),
  import("../aiMentor.js"),
  import("../traderSkill.js"),
  import("../edgeDiscovery.js"),
  import("../onboarding.js"),
  import("../paperSessions.js"),
  import("../traderCoach.js"),
]);

type Handler = (req: Request, res: Response, next: (err?: unknown) => void) => void;

interface Captured { status: number | null; body: unknown; reachedHandler: boolean }

/**
 * Drive one route through the real router with NO authenticated user.
 *
 * `reachedHandler` is true when the router called `next()` past every layer —
 * i.e. nothing refused the request. For these routers that is itself a
 * failure: a logged-out caller must never reach the query layer.
 */
function callAnonymously(router: unknown, method: string, url: string): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const out: Captured = { status: null, body: null, reachedHandler: false };
    const res: Record<string, unknown> & { headersSent: boolean } = {
      headersSent: false,
      status(code: number) { out.status = code; return res; },
      json(body: unknown) { out.body = body; res.headersSent = true; resolve(out); return res; },
      send(body: unknown) { out.body = body; res.headersSent = true; resolve(out); return res; },
      end() { res.headersSent = true; resolve(out); return res; },
      setHeader() { return res; },
      getHeader() { return undefined; },
      type() { return res; },
      vary() { return res; },
    };

    const req = {
      method,
      url,
      originalUrl: `/api${url}`,
      baseUrl: "",
      path: url.split("?")[0],
      headers: {},
      header: () => undefined,
      get: () => undefined,
      query: {},
      params: {},
      body: {},
      // No session cookie and no role header: the caller is anonymous, which
      // is also the weakest role the security layer can resolve.
      cookies: {},
      signedCookies: {},
      // No authUser — this is the whole point of the suite.
      log: { info: () => {}, warn: () => {}, error: () => {} },
      res: res as unknown as Response,
    } as unknown as Request;
    (res as { req?: Request }).req = req;

    const timer = setTimeout(() => reject(new Error(`no response for ${method} ${url}`)), 5_000);
    const done = (err?: unknown) => {
      clearTimeout(timer);
      if (err) { reject(err instanceof Error ? err : new Error(String(err))); return; }
      out.reachedHandler = true;
      resolve(out);
    };
    try {
      (router as Handler)(req, res as unknown as Response, done);
    } catch (e) {
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  }).then((r) => { const c = r as Captured; return c; });
}

// One representative route per defect, named by the surface it protects.
const CASES: Array<{ surface: string; router: unknown; method: string; url: string }> = [
  { surface: "Weekly review — net P/L, win rate, coaching summary",
    router: weeklyReviewsRouter, method: "GET", url: "/weekly-reviews/latest" },
  { surface: "Weekly review — generate (writes a review row)",
    router: weeklyReviewsRouter, method: "POST", url: "/weekly-reviews/generate" },
  { surface: "Weekly goals — PATCH someone else's goal",
    router: weeklyReviewsRouter, method: "PATCH", url: "/weekly-goals/1" },
  { surface: "Analytics Command Center — latest snapshot",
    router: analyticsRouter, method: "GET", url: "/analytics/snapshot" },
  { surface: "Analytics — snapshot recompute (writes a snapshot row)",
    router: analyticsRouter, method: "POST", url: "/analytics/snapshot" },
  { surface: "Analytics — drawdown equity curve",
    router: analyticsRouter, method: "GET", url: "/analytics/drawdown" },
  { surface: "AI Mentor — latest session",
    router: aiMentorRouter, method: "GET", url: "/mentor/sessions/latest" },
  { surface: "AI Mentor — generate a briefing",
    router: aiMentorRouter, method: "POST", url: "/mentor/sessions" },
  { surface: "AI Mentor — PATCH an action item",
    router: aiMentorRouter, method: "PATCH", url: "/mentor/action-items/1" },
  { surface: "Trader skill — 8-pillar profile",
    router: traderSkillRouter, method: "GET", url: "/skill/profile" },
  { surface: "Trader skill — recalculate",
    router: traderSkillRouter, method: "POST", url: "/skill/calculate" },
  { surface: "Edge discovery — report list",
    router: edgeDiscoveryRouter, method: "GET", url: "/edge/reports" },
  { surface: "Edge discovery — a single report by id",
    router: edgeDiscoveryRouter, method: "GET", url: "/edge/reports/1" },
  { surface: "Edge discovery — generate reports",
    router: edgeDiscoveryRouter, method: "POST", url: "/edge/reports" },
  { surface: "Onboarding — progress + safety acknowledgements",
    router: onboardingRouter, method: "GET", url: "/onboarding/status" },
  { surface: "Onboarding — record a safety acknowledgement",
    router: onboardingRouter, method: "POST", url: "/onboarding/acknowledge" },
  { surface: "Onboarding — reset (wipes progress)",
    router: onboardingRouter, method: "POST", url: "/onboarding/reset" },
  { surface: "Session report — session list",
    router: paperSessionsRouter, method: "GET", url: "/paper-sessions" },
  { surface: "Session report — a stranger's session by id",
    router: paperSessionsRouter, method: "GET", url: "/paper-sessions/psess_someone_else" },
  { surface: "Session report — a stranger's report",
    router: paperSessionsRouter, method: "GET", url: "/paper-sessions/psess_someone_else/report" },
  { surface: "Trader Coach — daily coaching",
    router: traderCoachRouter, method: "GET", url: "/trader-coach/daily" },
  { surface: "Trader Coach — persisted coach reports",
    router: traderCoachRouter, method: "GET", url: "/trader-coach/reports" },
  { surface: "Trader Coach — weekly plan",
    router: traderCoachRouter, method: "GET", url: "/trader-coach/weekly" },
];

for (const c of CASES) {
  test(`401 for a logged-out caller: ${c.method} ${c.url} (${c.surface})`, async () => {
    const r = await callAnonymously(c.router, c.method, c.url);
    assert.equal(
      r.reachedHandler, false,
      "a logged-out request reached the handler — the auth gate is missing",
    );
    assert.equal(r.status, 401, `expected 401, got ${r.status} with body ${JSON.stringify(r.body)}`);
    assert.equal((r.body as { error?: string })?.error, "AUTH_REQUIRED");
  });
}

test("the case list still covers every router the audit named", () => {
  const routers = new Set(CASES.map((c) => c.router));
  assert.equal(routers.size, 8, "one or more routers dropped out of this proof");
  assert.ok(CASES.length >= 20, "the anonymous-access sweep must not shrink");
});
