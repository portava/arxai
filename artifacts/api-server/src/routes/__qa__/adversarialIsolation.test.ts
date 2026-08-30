// Capability #48 — adversarial isolation suite: synthetic-user route walker.
//
// Isolation was a PER-ROUTE CONVENTION (every handler remembers to scope by
// req.authUser.id) verified only by scattered per-surface tests. This suite
// walks the REAL root router's ENTIRE route inventory and proves the three
// central default-deny layers hold for every registered surface:
//
//   1. ANONYMOUS DEFAULT-DENY — every route not on the public allowlist
//      refuses an unauthenticated caller with 401 (the global auth gate).
//      ANY route reachable anonymously that is not in the PUBLIC manifest
//      below goes RED — adding a new public route requires updating the
//      manifest here, deliberately.
//   2. ADMIN NAMESPACE DENY — a synthetic non-admin USER (and an INVESTOR)
//      receives 403 on EVERY /admin* route (product-role gate).
//   3. INVESTOR WRITE DENY — a synthetic INVESTOR receives 403 on EVERY
//      state-changing route except the two allow-listed self-service paths
//      (auth/session + the intent-only allocation preference).
//
// All three layers refuse BEFORE any handler runs, so this suite needs no
// database: DATABASE_URL is a dummy and any request that reached a real
// handler would error loudly rather than pass the assertions.
//
// The walker FAILS LOUDLY if enumeration degrades (route count floor, or a
// nested mount whose prefix it cannot resolve) — a silently-empty walk can
// never masquerade as a green isolation proof.
//
// Run: node --import tsx --test src/routes/__qa__/adversarialIsolation.test.ts

process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";
// Importing the FULL root router pulls in modules whose integration clients
// insist on env at import time. These are inert dummies pointing at a closed
// local port — every assertion in this suite is decided by middleware BEFORE
// any handler (or client) could run, so no request ever reaches them.
process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] ??= "http://127.0.0.1:1/qa-dummy";
process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ??= "qa-dummy-not-a-key";
process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"] ??= "http://127.0.0.1:1/qa-dummy";
process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"] ??= "qa-dummy-not-a-key";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const { default: apiRouter } = await import("../index.js");

// ── Synthetic users ─────────────────────────────────────────────────────────
type SyntheticUser = { id: number; role: string; email: string } | null;
let currentUser: SyntheticUser = null;

const SYNTH_TRADER = { id: 990001, role: "USER", email: "synthetic-trader@qa.local" };
const SYNTH_INVESTOR = { id: 990002, role: "INVESTOR", email: "synthetic-investor@qa.local" };

let server: Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (currentUser) {
      // Synthetic users carry only the fields the middleware layers read
      // (id, role); the full User row shape is irrelevant before a handler.
      (req as unknown as { authUser?: SyntheticUser }).authUser = currentUser;
    }
    next();
  });
  app.use("/api", apiRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── Route walker ────────────────────────────────────────────────────────────
interface RouteEntry { method: string; path: string }

// Static mount prefixes used by routes/index.ts (`router.use("<prefix>", r)`).
// A nested-router layer whose regexp resolves to none of these makes the walk
// FAIL — under-enumeration must never look like a passing isolation proof.
const KNOWN_MOUNT_PREFIXES = ["/paper/demo-execution", "/paper"] as const;

function mountPrefixOf(layer: { regexp?: RegExp & { fast_slash?: boolean } }): string {
  const re = layer.regexp;
  if (!re || re.fast_slash === true || re.source === "^\\/?$" || re.source === "(?:)") return "";
  // A bare "/" mount also matches everything at zero depth:
  if (re.test("/") && re.test("/zz-any-path")) return "";
  for (const candidate of KNOWN_MOUNT_PREFIXES) {
    if (re.test(candidate)) return candidate;
  }
  throw new Error(
    `route walker cannot resolve a mount prefix (regexp: ${re.source}). `
    + "Add the new mount prefix to KNOWN_MOUNT_PREFIXES so enumeration stays complete.",
  );
}

function walk(
  stack: ReadonlyArray<Record<string, unknown>>,
  prefix: string,
  out: RouteEntry[],
): void {
  for (const layer of stack) {
    const route = layer["route"] as
      | { path: string | string[]; methods: Record<string, boolean> }
      | undefined;
    if (route) {
      const paths = Array.isArray(route.path) ? route.path : [route.path];
      for (const p of paths) {
        for (const m of Object.keys(route.methods)) {
          if (m === "_all") continue;
          out.push({ method: m.toUpperCase(), path: prefix + p });
        }
      }
      continue;
    }
    const handle = layer["handle"] as { stack?: ReadonlyArray<Record<string, unknown>> } | undefined;
    if (handle?.stack) {
      walk(handle.stack, prefix + mountPrefixOf(layer as { regexp?: RegExp }), out);
    }
  }
}

const routerStack = (apiRouter as unknown as { stack: ReadonlyArray<Record<string, unknown>> }).stack;
const allRoutes: RouteEntry[] = [];
walk(routerStack, "", allRoutes);

/** Substitute path params/wildcards with synthetic values. */
function concretePath(p: string): string {
  return p
    .replace(/:[A-Za-z0-9_]+\?/g, "1")
    .replace(/:[A-Za-z0-9_]+/g, "1")
    .replace(/\*[A-Za-z0-9_]*/g, "x")
    .replace(/\(\.\*\)/g, "x");
}

// ── PUBLIC manifest — must mirror lib/auth/globalGate.ts exactly ────────────
const PUBLIC_EXACT = new Set<string>([
  "/healthz", "/health", "/version",
  "/mt5/heartbeat", "/mt5/commands", "/mt5/command-result", "/mt5/sync-account",
  "/mt5/sync-positions", "/mt5/sync-positions-per-user",
  "/mt5/positions-snapshot", "/mt5/pending-snapshot",
  "/mt5/sync-candles", "/mt5/sync-quotes", "/mt5/candles/ingest",
  "/mt5/demo-commands-poll", "/mt5/demo-command-result", "/mt5/execution-result",
  "/mt5/live-commands-poll", "/mt5/live-command-result", "/mt5/sync-live-positions",
  "/mt5/remote-config", "/mt5/update-check", "/mt5/update-report",
  "/bridge/v2/ingest", "/bridge/v2/config", "/bridge/v2/commands",
  "/webhooks/tradingview",
  // #28 — the independent protection watchdog is a separate PROCESS with no
  // user session by design; it authenticates with its own bearer token inside
  // the handler and fails closed when that env is unset.
  "/watchdog/alerts",
]);
const PUBLIC_PREFIXES = ["/health/", "/auth/", "/auth", "/release/", "/release"] as const;

function isPublicPath(p: string): boolean {
  if (PUBLIC_EXACT.has(p)) return true;
  return PUBLIC_PREFIXES.some((pre) => p === pre || p.startsWith(pre));
}

function isAdminNamespacePath(p: string): boolean {
  return p === "/admin" || p.startsWith("/admin/") || p.startsWith("/admin-");
}

const METHODS_TO_DRIVE = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

async function drive(method: string, path: string): Promise<number> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "GET" ? undefined : "{}",
  });
  // Drain so keep-alive sockets recycle cleanly.
  await res.arrayBuffer().catch(() => undefined);
  return res.status;
}

// ── 0. Enumeration sanity ───────────────────────────────────────────────────
test("route walker enumerates the full surface (loud floor)", () => {
  assert.ok(
    allRoutes.length >= 300,
    `expected >=300 registered routes, walked only ${allRoutes.length} — the walker degraded`,
  );
  const admin = allRoutes.filter((r) => isAdminNamespacePath(r.path));
  assert.ok(admin.length >= 50, `expected >=50 admin routes, got ${admin.length}`);
});

// ── 1. Anonymous default-deny across EVERY non-public route ─────────────────
test("ANONYMOUS: every non-public route refuses with 401 (default-deny)", async () => {
  currentUser = null;
  const failures: string[] = [];
  let driven = 0;
  for (const r of allRoutes) {
    if (!METHODS_TO_DRIVE.has(r.method)) continue;
    const p = concretePath(r.path);
    if (isPublicPath(p)) continue; // classified public — manifest-mirrored
    driven++;
    const status = await drive(r.method, p);
    if (status !== 401) failures.push(`${r.method} ${p} → ${status} (expected 401)`);
  }
  assert.ok(driven >= 250, `anonymous walk drove only ${driven} routes — suspicious`);
  assert.deepEqual(
    failures,
    [],
    `routes reachable without authentication (or mis-refusing):\n${failures.join("\n")}`,
  );
});

// ── 2. Non-admin roles refused on the entire /admin* namespace ──────────────
for (const [label, user] of [
  ["USER (trader)", SYNTH_TRADER],
  ["INVESTOR", SYNTH_INVESTOR],
] as const) {
  test(`${label}: every /admin* route refuses with 403`, async () => {
    currentUser = user;
    try {
      const failures: string[] = [];
      let driven = 0;
      for (const r of allRoutes) {
        if (!METHODS_TO_DRIVE.has(r.method)) continue;
        const p = concretePath(r.path);
        if (!isAdminNamespacePath(p)) continue;
        driven++;
        const status = await drive(r.method, p);
        if (status !== 403) failures.push(`${r.method} ${p} → ${status} (expected 403)`);
      }
      assert.ok(driven >= 50, `admin walk drove only ${driven} routes — suspicious`);
      assert.deepEqual(
        failures,
        [],
        `admin routes reachable by ${label}:\n${failures.join("\n")}`,
      );
    } finally {
      currentUser = null;
    }
  });
}

// ── 3. INVESTOR write-deny on every state-changing route ────────────────────
test("INVESTOR: every mutation outside the self-service allowlist refuses with 403", async () => {
  currentUser = SYNTH_INVESTOR;
  try {
    const failures: string[] = [];
    let driven = 0;
    for (const r of allRoutes) {
      if (!METHODS_TO_DRIVE.has(r.method) || r.method === "GET") continue;
      const p = concretePath(r.path);
      // The ONLY investor-permitted writes: auth/session endpoints (sign-out
      // must always work) and the intent-only allocation preference. Driving
      // those would reach real handlers (and the dummy DB), so they are
      // asserted by their own suites; everything else must 403 HERE.
      if (p === "/auth" || p.startsWith("/auth/")) continue;
      if (p === "/me/investor/allocation") continue;
      driven++;
      const status = await drive(r.method, p);
      if (status !== 403) failures.push(`${r.method} ${p} → ${status} (expected 403)`);
    }
    assert.ok(driven >= 150, `investor mutation walk drove only ${driven} routes — suspicious`);
    assert.deepEqual(
      failures,
      [],
      `mutations reachable by an INVESTOR:\n${failures.join("\n")}`,
    );
  } finally {
    currentUser = null;
  }
});

// ── 4. The public manifest itself stays pinned to globalGate.ts ─────────────
test("PUBLIC manifest mirrors lib/auth/globalGate.ts (drift alarm)", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const gateSource = readFileSync(
    fileURLToPath(new URL("../../lib/auth/globalGate.ts", import.meta.url)),
    "utf8",
  );
  for (const p of PUBLIC_EXACT) {
    assert.ok(gateSource.includes(`"${p}"`), `manifest path ${p} missing from globalGate.ts`);
  }
  // Every quoted exact path in the gate source must be in the manifest too —
  // a new public route added to the gate without updating this suite is RED.
  const exactBlock = gateSource.split("PUBLIC_EXACT")[1]?.split("]);")[0] ?? "";
  const quoted = [...exactBlock.matchAll(/"(\/[^"]+)"/g)].map((m) => m[1]);
  for (const p of quoted) {
    assert.ok(PUBLIC_EXACT.has(p), `globalGate.ts public path ${p} not mirrored in this suite`);
  }
});
