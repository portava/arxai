// Express matches routes in registration order, so a param route such as
// GET /admin/investors/:id registered before GET /admin/investors/performance-batches
// swallows the literal path (it answered 400 BAD_ID and the admin Investors
// page could not list performance batches). This guard scans every router
// file and fails when a param route is registered before a literal route of
// the same method and shape in the same file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE_RX = /router\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g;

export function findShadowedRoutes(source: string): string[] {
  const routes = [...source.matchAll(ROUTE_RX)].map((m) => ({
    method: m[1],
    path: m[2],
    line: source.slice(0, m.index).split("\n").length,
  }));
  const out: string[] = [];
  routes.forEach((r1, i) => {
    const a = r1.path.replace(/^\/|\/$/g, "").split("/");
    if (!a.some((s) => s.startsWith(":"))) return;
    for (const r2 of routes.slice(i + 1)) {
      if (r2.method !== r1.method || r2.path === r1.path) continue;
      const b = r2.path.replace(/^\/|\/$/g, "").split("/");
      if (a.length !== b.length) continue;
      const covers = a.every((x, k) => x === b[k] || (x.startsWith(":") && !b[k].startsWith(":")));
      const literalUnderParam = a.some((x, k) => x.startsWith(":") && !b[k].startsWith(":"));
      if (covers && literalUnderParam) {
        out.push(`${r1.method.toUpperCase()} ${r1.path} (line ${r1.line}) shadows ${r2.path} (line ${r2.line})`);
      }
    }
  });
  return out;
}

test("detector flags a param route registered before a literal sibling", () => {
  // Fixture text is assembled so the repo's route-collision guard, which greps
  // every file under routes/, does not read these lines as real routes.
  const r = ["rou", "ter"].join("");
  const src = `${r}.get("/a/:id", h);\n${r}.get("/a/list", h);\n${r}.post("/a/list", h);`;
  assert.deepEqual(findShadowedRoutes(src), ["GET /a/:id (line 1) shadows /a/list (line 2)"]);
  assert.deepEqual(findShadowedRoutes(`${r}.get("/a/list", h);\n${r}.get("/a/:id", h);`), []);
});

test("no router file registers a param route before a literal route it would swallow", () => {
  const problems: string[] = [];
  for (const f of readdirSync(ROUTES_DIR).filter((n) => n.endsWith(".ts")).sort()) {
    for (const p of findShadowedRoutes(readFileSync(join(ROUTES_DIR, f), "utf8"))) problems.push(`${f}: ${p}`);
  }
  assert.deepEqual(problems, []);
});
