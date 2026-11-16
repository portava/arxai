import { read, rel, reportResult, ROOT, walk, type CheckResult } from "./_lib.js";
import { basename, join } from "node:path";

// Router-level access-guard leak guard.
//
// THE FOOTGUN THIS CATCHES
// ------------------------
// Express runs a router's `router.use(<middleware>)` middleware for EVERY
// request that flows through that router — not just requests that match one of
// the router's own routes. When such a router is then mounted GLOBALLY with no
// path prefix (`router.use(<thatRouter>)` in routes/index.ts), the middleware
// effectively runs on every `/api/*` request and "leaks" onto unrelated later
// routers. We hit exactly this: three trade-execution routers attached
// `router.use(denyInvestorExecution)` at the router level while being mounted
// globally, so INVESTOR accounts got 403 on their own read-only portal routes.
//
// THE CORRECT PATTERN
// -------------------
// Attach access guards PER ROUTE, not at the router level:
//     router.post("/trade/place", denyInvestorExecution, handler);   // ✅ per-route
//     router.get("/me/trade-actions", denyInvestorExecution, handler); // ✅ per-route
// NOT:
//     router.use(denyInvestorExecution);   // ❌ router-level — leaks if mounted globally
//
// A router-level guard is ONLY safe if the router is mounted under a path
// prefix (e.g. `router.use("/paper/demo-execution", demoExecutionRouter)`),
// because then the guard is contained to that prefix. This guard therefore
// FAILS only when BOTH are true:
//   (a) a routes/*.ts file applies a tracked access guard at the router level
//       (`router.use(<guard>)` with no leading path string), AND
//   (b) that router is mounted in routes/index.ts globally (no path prefix).
//
// Static source scan (no app boot). Line comments are stripped first so a
// doc-comment example like the ones above can never trip the scan, and the
// detector runs a synthetic self-check so silent regex drift fails the build.

const API = join(ROOT, "artifacts/api-server/src");
const ROUTES_DIR = join(API, "routes");
const INDEX_FILE = join(ROUTES_DIR, "index.ts");

// Access guards that must be applied PER ROUTE, never at the router level on a
// globally-mounted router. Extend this list when adding a new identity/role
// veto guard that 403s a class of caller (it must still be per-route).
//
// Includes both identity/portal vetoes (`denyInvestorExecution`) and
// admin/role authentication guards (`requireUser`, `requireRole`). The same
// Express footgun applies to all of them: a `router.use(<guard>)` at the
// router level on a globally-mounted (no-prefix) router runs the guard on
// EVERY request and 403s unrelated routes. `requireRole` is a middleware
// factory (`requireRole("ADMIN", "OWNER")`); the detector matches the bare
// name inside the call expression, so the factory form is covered too.
const TRACKED_GUARDS = ["denyInvestorExecution", "requireUser", "requireRole"];

function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((l) => {
      const i = l.indexOf("//");
      return i >= 0 ? l.slice(0, i) : l;
    })
    .join("\n");
}

// Map a router import identifier -> the module base it was imported from, for
// both default and single-named imports off a relative "./" path.
function parseImports(indexSrc: string): Map<string, string> {
  const identToBase = new Map<string, string>();
  const defaultRe = /import\s+(\w+)\s+from\s+["']\.\/([\w./-]+?)(?:\.js)?["']/g;
  const namedRe = /import\s+\{\s*(\w+)\s*\}\s+from\s+["']\.\/([\w./-]+?)(?:\.js)?["']/g;
  for (const re of [defaultRe, namedRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(indexSrc))) {
      identToBase.set(m[1], basename(m[2]));
    }
  }
  return identToBase;
}

type MountInfo = { global: number; prefixed: number };

// For every `router.use(...)` in index.ts, record per mounted-router-identifier
// whether the mount had a leading path-string prefix or not.
function parseMounts(indexSrc: string): Map<string, MountInfo> {
  const mounts = new Map<string, MountInfo>();
  const useRe = /router\.use\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = useRe.exec(indexSrc))) {
    const args = m[1].trim();
    if (!args) continue;
    const startsWithString = /^["'`]/.test(args);
    // The router identifier is the LAST simple identifier argument.
    const parts = args.split(",").map((p) => p.trim());
    const last = parts[parts.length - 1];
    if (!/^\w+$/.test(last)) continue; // not a bare identifier mount
    const info = mounts.get(last) ?? { global: 0, prefixed: 0 };
    if (startsWithString) info.prefixed += 1;
    else info.global += 1;
    mounts.set(last, info);
  }
  return mounts;
}

// Does a route-file source apply a tracked guard at the ROUTER level?
// Router-level == a `.use(...)` call whose argument list does NOT start with a
// path string AND mentions a tracked guard. Per-route `.get/.post(... guard)`
// calls are intentionally NOT matched (that's the correct pattern).
function routerLevelGuardsIn(src: string): string[] {
  const found = new Set<string>();
  const useRe = /\.use\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = useRe.exec(src))) {
    const args = m[1].trim();
    if (!args) continue;
    if (/^["'`]/.test(args)) continue; // path-scoped use — contained, not a global leak
    for (const g of TRACKED_GUARDS) {
      if (new RegExp(`\\b${g}\\b`).test(args)) found.add(g);
    }
  }
  return [...found];
}

// Pure detector: given index.ts source and a set of {base, src} route files,
// return a violation string for every router that attaches a tracked guard at
// the router level AND is mounted globally (no path prefix) in index.ts.
export function detectGuardLeaks(
  indexSrc: string,
  files: Array<{ base: string; src: string }>,
): string[] {
  const violations: string[] = [];
  const identToBase = parseImports(indexSrc);
  const mounts = parseMounts(indexSrc);
  // base -> ident (reverse of identToBase).
  const baseToIdent = new Map<string, string>();
  for (const [ident, base] of identToBase) baseToIdent.set(base, ident);

  for (const f of files) {
    const guards = routerLevelGuardsIn(stripLineComments(f.src));
    if (guards.length === 0) continue;
    const ident = baseToIdent.get(f.base);
    if (!ident) continue; // file applies a router-level guard but isn't mounted — no global leak
    const info = mounts.get(ident);
    if (!info) continue; // not mounted via router.use — nothing to leak through
    if (info.global > 0) {
      violations.push(
        `routes/${f.base}.ts → applies "${guards.join(", ")}" at the router level ` +
          `(router.use(...)) while mounted globally with no path prefix in routes/index.ts ` +
          `(router.use(${ident})). This leaks the guard onto unrelated routes. ` +
          `Move it per-route (router.post(path, ${guards[0]}, handler)) or mount the router ` +
          `under a path prefix (router.use("/prefix", ${ident})).`,
      );
    }
  }
  return violations;
}

// Synthetic self-check: a globally-mounted router that applies the guard at the
// router level MUST be flagged; a path-prefixed one MUST NOT. If this drifts,
// the regexes silently stopped catching the footgun — fail the build loudly.
function selfCheck(): string[] {
  const problems: string[] = [];
  const synthIndex = [
    'import fakeLeakRouter from "./fakeLeak";',
    'import fakeSafeRouter from "./fakeSafe";',
    "router.use(fakeLeakRouter);",
    'router.use("/scoped", fakeSafeRouter);',
  ].join("\n");
  // Every tracked guard MUST be flagged when applied at the router level on a
  // globally-mounted router, and MUST NOT be flagged when the router is mounted
  // under a path prefix. Looping over TRACKED_GUARDS means adding a guard to the
  // list automatically extends the self-check. Each guard is exercised in both
  // the bare-identifier form (`router.use(requireUser)`) and the factory-call
  // form (`router.use(requireRole("ADMIN", "OWNER"))`) so middleware factories
  // are covered.
  for (const guard of TRACKED_GUARDS) {
    for (const src of [`router.use(${guard});`, `router.use(${guard}("ADMIN", "OWNER"));`]) {
      const synthFiles = [
        { base: "fakeLeak", src },
        { base: "fakeSafe", src },
      ];
      const v = detectGuardLeaks(synthIndex, synthFiles);
      if (!v.some((s) => s.includes("fakeLeak"))) {
        problems.push(
          `self-check: detector FAILED to flag a globally-mounted router-level "${guard}" leak (form: ${src})`,
        );
      }
      if (v.some((s) => s.includes("fakeSafe"))) {
        problems.push(
          `self-check: detector wrongly flagged a path-prefixed (safe) router-level "${guard}" (form: ${src})`,
        );
      }
    }
  }
  return problems;
}

export function checkRouterLevelAccessGuardLeak(): CheckResult {
  const violations: string[] = [];

  let indexSrc = "";
  try {
    indexSrc = stripLineComments(read(INDEX_FILE));
  } catch {
    violations.push(`${rel(INDEX_FILE)} → file missing`);
  }

  if (indexSrc) {
    const files = walk(ROUTES_DIR, { exts: [".ts"] })
      .filter((p) => p !== INDEX_FILE && !/\.(test|spec)\.ts$/.test(p))
      .map((p) => ({ base: basename(p, ".ts"), src: read(p) }));
    violations.push(...detectGuardLeaks(indexSrc, files));
  }

  violations.push(...selfCheck());

  return {
    name: "router-level-access-guard-leak",
    ok: violations.length === 0,
    violations,
    notes: [
      "Attach access guards (denyInvestorExecution, requireUser, requireRole) PER ROUTE, not at the router level.",
      "Router-level router.use(<guard>) is only safe if the router is mounted under a path prefix.",
      "A globally-mounted router (router.use(<router>) with no prefix) runs router-level middleware on EVERY request.",
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkRouterLevelAccessGuardLeak();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
