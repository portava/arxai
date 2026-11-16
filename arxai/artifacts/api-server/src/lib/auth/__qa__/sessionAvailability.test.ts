import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

// Import only the real boundaries. Session storage is an offline fixture, so
// these tests neither load a DB client nor read credentials or user accounts.
let lookup: "valid" | "missing" | "unavailable" = "valid";
let lookupCalls = 0;
mock.module("../userSessions.js", {
  namedExports: {
    USER_SESSION_COOKIE: "fixture_session",
    findUserBySessionToken: async () => {
      lookupCalls++;
      if (lookup === "unavailable") throw new Error("offline storage outage fixture");
      return lookup === "valid" ? { id: 1, role: "USER" } : null;
    },
  },
});
const { attachAuthUser, requireUser } = await import("../middleware.js");
const { requireAuthOrPublic } = await import("../globalGate.js");

beforeEach(() => { lookup = "valid"; lookupCalls = 0; });

function request(path = "/me", hasCookie = true, method = "GET") {
  return { path, method, cookies: hasCookie ? { fixture_session: "inert-fixture" } : {} } as unknown as Request;
}

function response() {
  const result = { status: 0, body: undefined as unknown, cookieWrites: 0, allowed: false };
  let done!: () => void;
  const settled = new Promise<void>((resolve) => { done = resolve; });
  const res = {
    status(code: number) { result.status = code; return this; },
    json(body: unknown) { result.body = body; done(); return this; },
    cookie() { result.cookieWrites++; return this; },
    clearCookie() { result.cookieWrites++; return this; },
  } as unknown as Response;
  const next = () => { result.allowed = true; done(); };
  return { result, res, next, settled };
}

async function throughGlobal(req = request()) {
  const outcome = response();
  await attachAuthUser(req, outcome.res, () => {});
  requireAuthOrPublic(req, outcome.res, outcome.next);
  await outcome.settled;
  return { ...outcome.result, req };
}

test("a verified session reaches private routes", async () => {
  const result = await throughGlobal();
  assert.equal(result.allowed, true);
  assert.equal(result.req.authUser?.id, 1);
  assert.equal(result.cookieWrites, 0);
});

test("no cookie and confirmed missing/revoked sessions remain 401", async () => {
  for (const hasCookie of [false, true]) {
    lookup = "missing";
    const result = await throughGlobal(request("/me", hasCookie));
    assert.equal(result.allowed, false);
    assert.equal(result.status, 401);
    assert.equal((result.body as { error: string }).error, "AUTH_REQUIRED");
    assert.equal(result.cookieWrites, 0);
  }
  assert.equal(lookupCalls, 1, "an absent cookie must not trigger storage access");
});

test("a session lookup outage denies every private route with recoverable 503, without changing cookies", async () => {
  lookup = "unavailable";
  for (const path of ["/me", "/me/trades/instant", "/admin/trading"]) {
    const result = await throughGlobal(request(path));
    assert.equal(result.allowed, false);
    assert.equal(result.req.authUser, undefined);
    assert.equal(result.status, 503);
    assert.equal((result.body as { error: string }).error, "SESSION_CHECK_UNAVAILABLE");
    assert.equal(result.cookieWrites, 0);
  }
});

test("public health, login, bridge-auth routes and preflight still reach their own handlers during an outage", async () => {
  lookup = "unavailable";
  for (const [path, method] of [["/healthz", "GET"], ["/auth/login", "POST"], ["/mt5/sync-quotes", "POST"], ["/me", "OPTIONS"]]) {
    const result = await throughGlobal(request(path, true, method));
    assert.equal(result.allowed, true);
    assert.equal(result.req.authUser, undefined);
    assert.equal(result.cookieWrites, 0);
  }
});

test("standalone requireUser distinguishes an outage from a revoked session", async () => {
  for (const state of ["unavailable", "missing", "valid"] as const) {
    lookup = state;
    const outcome = response();
    requireUser(request(), outcome.res, outcome.next);
    await outcome.settled;
    assert.equal(outcome.result.allowed, state === "valid");
    assert.equal(outcome.result.status, state === "valid" ? 0 : state === "missing" ? 401 : 503);
    assert.equal(outcome.result.cookieWrites, 0);
  }
});

test("requireUser honors a failed upstream check without retrying storage or granting access", async () => {
  lookup = "unavailable";
  const req = request();
  const outcome = response();
  await attachAuthUser(req, outcome.res, () => {});
  requireUser(req, outcome.res, outcome.next);
  await outcome.settled;
  assert.equal(lookupCalls, 1);
  assert.equal(outcome.result.allowed, false);
  assert.equal(outcome.result.status, 503);
});

test("the unchanged fixture session works on the next request after storage recovers", async () => {
  lookup = "unavailable";
  assert.equal((await throughGlobal()).status, 503);
  lookup = "valid";
  const result = await throughGlobal();
  assert.equal(result.allowed, true);
  assert.equal(result.req.authUser?.id, 1);
  assert.equal(result.cookieWrites, 0);
});
