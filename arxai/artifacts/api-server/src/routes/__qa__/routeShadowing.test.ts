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

// A route call written INSIDE another handler (a misplaced closing brace) is
// registered only when that handler runs, and again on every later call.
// GET /admin/investors/performance-batches once swallowed GET :id, POST
// /admin/investors and POST bulk-performance this way: all three answered 404
// after every restart until someone opened the batch list. This scanner
// tracks brace depth (skipping strings, template text and comments) and flags
// any router.<method>( call that is not at module top level.
export function findNestedRouteRegistrations(source: string): string[] {
  const out: string[] = [];
  let depth = 0, i = 0, line = 1;
  const tmpl: number[] = []; // brace depth at which each open template's ${ began
  const n = source.length;
  const skipString = (q: string) => {
    i++;
    while (i < n && source[i] !== q) { if (source[i] === "\\") i++; if (source[i] === "\n") line++; i++; }
    i++;
  };
  const skipTemplateText = () => {
    // at the char after ` or after a closing } of ${...}
    while (i < n) {
      const c = source[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "\n") line++;
      if (c === "`") { i++; return; }
      if (c === "$" && source[i + 1] === "{") { i += 2; tmpl.push(depth); depth++; return; }
      i++;
    }
  };
  while (i < n) {
    const c = source[i]!;
    if (c === "\n") { line++; i++; continue; }
    if (c === "/" && source[i + 1] === "/") { while (i < n && source[i] !== "\n") i++; continue; }
    if (c === "/" && source[i + 1] === "*") { i += 2; while (i < n && !(source[i] === "*" && source[i + 1] === "/")) { if (source[i] === "\n") line++; i++; } i += 2; continue; }
    if (c === '"' || c === "'") { skipString(c); continue; }
    if (c === "/") {
      // A regex literal where an expression starts: skip it (it may hold
      // quotes or braces, e.g. /don'?t/ or {3,20}).
      let k = i - 1; while (k >= 0 && /\s/.test(source[k]!)) k--;
      const prev = k >= 0 ? source[k]! : "";
      const prevWord = /(?:return|typeof|case|in|of)$/.test(source.slice(Math.max(0, k - 6), k + 1));
      // `x! / 2` is a TypeScript non-null assertion followed by division.
      const nonNull = prev === "!" && k > 0 && /[\w$)\]]/.test(source[k - 1]!);
      if (!nonNull && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || prevWord)) {
        i++;
        let inClass = false;
        while (i < n && source[i] !== "\n") {
          const ch = source[i]!;
          if (ch === "\\") { i += 2; continue; }
          if (ch === "[") inClass = true; else if (ch === "]") inClass = false;
          else if (ch === "/" && !inClass) break;
          i++;
        }
        i++;
        continue;
      }
    }
    if (c === "`") { i++; skipTemplateText(); continue; }
    if (c === "{") { depth++; i++; continue; }
    if (c === "}") {
      depth--; i++;
      if (tmpl.length && tmpl[tmpl.length - 1] === depth) { tmpl.pop(); skipTemplateText(); }
      continue;
    }
    if (c === "r" && source.startsWith("router.", i) && (i === 0 || !/[\w$.]/.test(source[i - 1]!))) {
      const m = /^router\.(get|post|put|patch|delete|all)\(\s*["']([^"']+)["']/.exec(source.slice(i, i + 200));
      if (m && depth !== 0) out.push(`${m[1]!.toUpperCase()} ${m[2]} (line ${line}) is registered inside a handler (depth ${depth})`);
    }
    i++;
  }
  return out;
}

test("nested-route detector flags a route registered inside another handler", () => {
  const src = 'router.get("/a", async (req, res) => {\n  res.json({ x: `t${1}`, y: /don\'?t{1,2}/.test("}"), z: n! / 2 });\nrouter.get("/b", (q, r) => {});\n});\nrouter.post("/c", h);\n';
  assert.deepEqual(findNestedRouteRegistrations(src), ["GET /b (line 3) is registered inside a handler (depth 1)"]);
});

test("no route file registers a route inside another handler", () => {
  const offenders: string[] = [];
  for (const f of readdirSync(ROUTES_DIR)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    for (const hit of findNestedRouteRegistrations(readFileSync(join(ROUTES_DIR, f), "utf8"))) offenders.push(`${f}: ${hit}`);
  }
  assert.deepEqual(offenders, []);
});
