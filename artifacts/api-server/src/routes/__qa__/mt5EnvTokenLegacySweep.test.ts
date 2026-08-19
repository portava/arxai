// Prodready 2026-08-19 — MT5_BRIDGE_TOKEN legacy sweep + system-health gates.
//
// Two production-readiness findings pinned so they can never reopen:
//
// 1. EA auth is per-user only (bridgeAuthPerUserOnly rejects the server-wide
//    MT5_BRIDGE_TOKEN env value on every EA endpoint), yet several
//    diagnostic/readiness surfaces still derived "bridge token configured"
//    booleans from process.env["MT5_BRIDGE_TOKEN"]. Those surfaces now derive
//    from per-user connection state (anyActiveUserBridgeTokenExists /
//    userHasActiveBridgeToken in lib/broker/secrets.ts). The ONLY remaining
//    process.env read of the token in the swept files is the hard-deny
//    rejection check inside bridgeAuthPerUserOnly, plus the presence-only
//    `set:` metadata in secrets.ts (which now marks the key LEGACY,
//    required:false).
//
// 2. routes/systemHealth.ts exposed unauthenticated writers: POST
//    /system-health/demo and /admin-control/demo seeded rows, /audit/export
//    logged actor "ADMIN" unverified, and every /admin-control action
//    endpoint audited actor "ADMIN" without any role check. All are now
//    behind the same local requireAdmin gate Round A added to /audit/demo.
//
// Offline by construction: @workspace/db module init needs a DATABASE_URL, so
// a dummy unroutable value is set first (established pattern — see
// src/lib/live/__qa__/emergencyKillSwitchPreGate.test.ts). The gate tests
// exercise ONLY the 403 fail-closed path, which returns before any DB query.
//
// Run: node --import tsx --test --test-force-exit \
//   src/routes/__qa__/mt5EnvTokenLegacySweep.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { evaluatePermission } from "@workspace/domain/safety-permission";

const { default: systemHealthRouter } = await import("../systemHealth.js");
const { describeRequiredSecrets } = await import("../../lib/broker/secrets.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../..");
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

const ENV_TOKEN_READ = /process\.env(?:\.MT5_BRIDGE_TOKEN|\[["']MT5_BRIDGE_TOKEN["']\])/g;
const count = (src: string): number => (src.match(ENV_TOKEN_READ) ?? []).length;

// ── 1. Legacy env-token sweep ───────────────────────────────────────────────

describe("swept surfaces no longer read process.env MT5_BRIDGE_TOKEN", () => {
  for (const rel of [
    "artifacts/api-server/src/lib/assistant/featureMap.ts",
    "artifacts/api-server/src/routes/permission.ts",
    "artifacts/api-server/src/routes/meFirstRunReadiness.ts",
    "artifacts/api-server/src/routes/meMarketData.ts",
    "artifacts/api-server/src/routes/broker.ts",
    "lib/domain/src/safety-permission/evaluate.ts",
  ]) {
    it(`${rel} has zero env reads of the token`, () => {
      assert.equal(count(read(rel)), 0, `expected no process.env MT5_BRIDGE_TOKEN reads in ${rel}`);
    });
  }

  it("mt5.ts keeps EXACTLY ONE env read — the bridgeAuthPerUserOnly hard-deny", () => {
    const src = read("artifacts/api-server/src/routes/mt5.ts");
    assert.equal(count(src), 1, "only the rejection check may read the env token");
    assert.ok(src.includes("const sysToken = process.env.MT5_BRIDGE_TOKEN;"),
      "the single remaining read must be the system-token hard-deny");
  });

  it("secrets.ts keeps only the presence-only `set:` metadata read", () => {
    const src = read("artifacts/api-server/src/lib/broker/secrets.ts");
    assert.equal(count(src), 1);
    assert.ok(src.includes("set: !!process.env.MT5_BRIDGE_TOKEN"));
  });
});

describe("secrets registry marks the env token LEGACY-FORBIDDEN", () => {
  it("MT5_BRIDGE_TOKEN is required:false with a legacy-forbidden description", () => {
    const entry = describeRequiredSecrets("mt5").find((r) => r.key === "MT5_BRIDGE_TOKEN");
    assert.ok(entry, "key stays listed so operators get an explicit do-not-use signal");
    assert.equal(entry.required, false);
    assert.match(entry.description, /LEGACY/);
    assert.match(entry.description, /per-user/i);
  });
});

describe("permission verdict copy points at the per-user token", () => {
  it("INFO_BROKER_MISSING no longer prescribes the env var", () => {
    const verdict = evaluatePermission({
      operationalMode: "OBSERVE_ONLY",
      killSwitchEngaged: false,
      mt5LinkHealth: "DOWN",
      liveAllowed: false,
      maxDailyLossPct: 5,
      maxTradesPerDay: 10,
      stopAfterLosingStreak: 3,
      maxLotSize: 1,
      cooldownAfterLossMinutes: 15,
      liveLocked: false,
      todaysTradesCount: 0,
      todaysLossPct: 0,
      consecutiveLosses: 0,
      activeLocks: [],
      brokerCredentialsConfigured: false,
    });
    const info = verdict.reasons.find((r) => r.code === "INFO_BROKER_MISSING");
    assert.ok(info, "INFO reason still emitted when link DOWN and no credentials");
    assert.ok(!info.message.includes("MT5_BRIDGE_TOKEN"), "message must not name the rejected env var");
    assert.match(info.message, /per-user bridge token/);
  });
});

// ── 2. system-health admin gates fail closed ────────────────────────────────

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: unknown, res: unknown) => unknown }> } };

function postHandler(path: string): (req: unknown, res: unknown) => unknown {
  const stack = (systemHealthRouter as unknown as { stack: Layer[] }).stack;
  const layer = stack.find((l) => l.route?.path === path && !!l.route?.methods["post"]);
  assert.ok(layer?.route, `POST ${path} must be mounted`);
  const h = layer.route.stack[layer.route.stack.length - 1]?.handle;
  assert.ok(h, `POST ${path} must have a handler`);
  return h;
}

function fakeReq(role: string | null) {
  return {
    authUser: role ? { id: 1, role } : undefined,
    body: {},
    query: {},
    params: {},
    ip: "127.0.0.1",
    get: () => undefined,
    log: { info() {}, warn() {}, error() {} },
  };
}

function fakeRes() {
  const captured = { statusCode: 200, body: null as Record<string, unknown> | null };
  const res = {
    status(code: number) { captured.statusCode = code; return res; },
    json(body: Record<string, unknown>) { captured.body = body; return res; },
  };
  return { res, captured };
}

const GATED_POSTS = [
  "/system-health/demo",
  "/audit/export",
  "/audit/demo",
  "/admin-control/action",
  "/admin-control/demo",
  "/admin-control/emergency-watch-only",
  "/admin-control/stop-autopilot",
  "/admin-control/rebuild-performance",
  "/admin-control/generate-coach-report",
  "/admin-control/generate-notification-digest",
  "/admin-control/export-health-report",
  "/admin-control/export-audit-report",
];

describe("system-health writers reject before touching anything", () => {
  for (const path of GATED_POSTS) {
    it(`POST ${path} → 403 with no session`, async () => {
      const { res, captured } = fakeRes();
      await postHandler(path)(fakeReq(null), res);
      assert.equal(captured.statusCode, 403);
      assert.equal(captured.body?.["error"], "ADMIN_OR_OWNER_REQUIRED");
    });

    it(`POST ${path} → 403 for role USER`, async () => {
      const { res, captured } = fakeRes();
      await postHandler(path)(fakeReq("USER"), res);
      assert.equal(captured.statusCode, 403);
      assert.equal(captured.body?.["error"], "ADMIN_OR_OWNER_REQUIRED");
    });
  }
});
