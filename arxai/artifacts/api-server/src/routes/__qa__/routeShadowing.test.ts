// Express matches routes in registration order, so a param route such as
// GET /admin/investors/:id registered before GET /admin/investors/performance-batches
// swallows the literal path (it answered 400 BAD_ID and the admin Investors
// page could not list performance batches). This guard scans every router
// file and fails when a param route is registered before a literal route of
// the same method and shape in the same file.
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
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
// uses lexical function scope to reject request-time registration while allowing
// a factory that constructs and returns its own router before requests arrive.
export function findNestedRouteRegistrations(source: string): string[] {
  const tree = ts.createSourceFile("routes.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const routeCall = (node: ts.Node): node is ts.CallExpression => ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === "router"
    && ["get", "post", "put", "patch", "delete", "all"].includes(node.expression.name.text);
  const functionScope = (node: ts.Node) => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);
  const isRouterFactory = (fn: ts.Node): boolean => {
    let declaresRouter = false, returnsRouter = false;
    const visit = (node: ts.Node) => {
      if (node !== fn && functionScope(node)) return;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "router"
        && node.initializer && ts.isCallExpression(node.initializer)
        && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "Router") declaresRouter = true;
      if (ts.isReturnStatement(node) && node.expression && ts.isIdentifier(node.expression)
        && node.expression.text === "router") returnsRouter = true;
      ts.forEachChild(node, visit);
    };
    visit(fn);
    return declaresRouter && returnsRouter;
  };
  const visit = (node: ts.Node) => {
    if (routeCall(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      const functions: ts.Node[] = [];
      let withinRouteHandler = false;
      for (let parent = node.parent; parent && parent !== tree; parent = parent.parent) {
        if (functionScope(parent)) functions.push(parent);
        if (routeCall(parent)) withinRouteHandler = true;
      }
      // A local router constructed and returned by a factory is registered at
      // factory invocation. A registration in a request callback (including a
      // nested factory there) is still forbidden.
      if (withinRouteHandler || (functions.length > 0 && !(functions.length === 1 && isRouterFactory(functions[0]!)))) {
        const expression = node.expression as ts.PropertyAccessExpression;
        const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
        out.push(`${expression.name.text.toUpperCase()} ${node.arguments[0].text} (line ${line}) is registered inside a handler (depth ${functions.length})`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
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


test("router factories register their own local router without a request-time mutation", () => {
  for (const start of ["function createRouter()", "const createRouter = () =>"]) {
    const src = `${start} { const router = Router(); router.get("/a", (req, res) => { res.json({text: "router.get ignored"}); }); return router; }`;
    assert.deepEqual(findNestedRouteRegistrations(src), []);
  }
});

test("a factory does not hide registrations nested in its request callback or helper", () => {
  const inHandler = 'function createRouter() { const router = Router(); router.get("/a", () => { router.post("/late", h); }); return router; }';
  assert.match(findNestedRouteRegistrations(inHandler)[0]!, /POST \/late/);
  const inHelper = 'function createRouter() { const router = Router(); function later() { router.post("/late", h); } return router; }';
  assert.match(findNestedRouteRegistrations(inHelper)[0]!, /POST \/late/);
  const nestedFactory = 'router.get("/a", () => { const router = Router(); router.post("/late", h); return router; });';
  assert.match(findNestedRouteRegistrations(nestedFactory)[0]!, /POST \/late/);
});
