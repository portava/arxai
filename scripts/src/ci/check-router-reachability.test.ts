// Fixtures for the router-reachability guard.
//
// A guard is only worth its runtime if it FAILS on the thing it claims to
// catch. These fixtures pin the three parsers and the reachability predicate
// against the exact shapes the real tree contains — including the two that
// previously fooled a naive substring scan: a template-literal call site with
// an interpolated path segment, and a justification line whose reason is an
// empty gesture.

import {
  parseMountedModules,
  parseRoutePaths,
  parseJustifications,
  pathIsReferenced,
  checkRouterReachability,
  JUSTIFICATION_CATEGORIES,
} from "./check-router-reachability.js";

export {};

type Case = { name: string; run: () => boolean };

const cases: Case[] = [
  // ── parseMountedModules ───────────────────────────────────────────────────
  {
    name: "picks up a default import with a .js extension",
    run: () => parseMountedModules(`import meAuthorityRouter from "./meAuthority.js";`).includes("meAuthority"),
  },
  {
    name: "picks up a named import without an extension",
    run: () => parseMountedModules(`import { adminRubyQualityRouter } from "./adminRubyQuality";`).includes("adminRubyQuality"),
  },
  {
    name: "ignores a package import",
    run: () => parseMountedModules(`import { Router } from "express";`).length === 0,
  },

  // ── parseRoutePaths ───────────────────────────────────────────────────────
  {
    name: "collects every verb",
    run: () => {
      const p = parseRoutePaths(`
        router.get("/a", h); router.post('/b', h);
        router.put(\`/c\`, h); router.patch("/d", h); router.delete("/e", h);
      `);
      return ["/a", "/b", "/c", "/d", "/e"].every((x) => p.includes(x));
    },
  },
  {
    name: "a router that only composes other routers registers no path",
    run: () => parseRoutePaths(`router.use(otherRouter);`).length === 0,
  },

  // ── pathIsReferenced ──────────────────────────────────────────────────────
  {
    name: "a plain fetch call site counts as a consumer",
    run: () => pathIsReferenced("/me/authority", [`fetch("/api/me/authority", { credentials: "include" })`]),
  },
  {
    name: "a template-literal call site with an interpolated segment counts",
    run: () => pathIsReferenced(
      "/admin/learning/edges/:id/capacity",
      ["await call(`/api/admin/learning/edges/${num(edgeId)}/capacity`, { method: \"POST\" });"],
    ),
  },
  {
    name: "a DIFFERENT path under the same prefix does NOT count",
    run: () => !pathIsReferenced("/me/authority/grants", [`fetch("/api/me/positions/control")`]),
  },
  {
    name: "an unreferenced path is not reachable",
    run: () => !pathIsReferenced("/ecosystem/contribution-score", [`fetch("/api/me/authority")`]),
  },
  {
    name: "a bare mount tells us nothing and is treated as reachable",
    run: () => pathIsReferenced("/", []),
  },

  // ── parseJustifications ───────────────────────────────────────────────────
  {
    name: "parses an em-dash entry",
    run: () => {
      const m = parseJustifications("- `mt5Live` — EA_BRIDGE: polled by the Expert Advisor.");
      return m.get("mt5Live")?.category === "EA_BRIDGE";
    },
  },
  {
    name: "parses a hyphen entry",
    run: () => parseJustifications("- `foo` - CI_ONLY: driven by the QA lane only.").get("foo")?.category === "CI_ONLY",
  },
  {
    name: "prose that merely mentions a module is not a justification",
    run: () => parseJustifications("We should look at `ecosystem` some day.").size === 0,
  },
  {
    name: "NOT_DELIVERED is an allowed category",
    run: () => (JUSTIFICATION_CATEGORIES as readonly string[]).includes("NOT_DELIVERED"),
  },

  // ── the live tree ─────────────────────────────────────────────────────────
  {
    name: "the guard passes against the current tree",
    run: () => checkRouterReachability().ok,
  },
  {
    name: "the guard actually inspected a real number of routers (not vacuous)",
    run: () => {
      const notes = checkRouterReachability().notes ?? [];
      const line = notes.find((n) => n.startsWith("route modules with handlers:"));
      const n = Number(line?.split(":")[1]?.trim() ?? "0");
      return n > 100;
    },
  },
];

let failed = 0;
for (const c of cases) {
  let ok = false;
  try { ok = c.run(); } catch { ok = false; }
  if (!ok) failed += 1;
  // eslint-disable-next-line no-console
  console.log(`${ok ? "PASS" : "FAIL"} ${c.name}`);
}
// eslint-disable-next-line no-console
console.log(`\n${cases.length - failed}/${cases.length} router-reachability fixtures passed`);
process.exit(failed === 0 ? 0 : 1);
