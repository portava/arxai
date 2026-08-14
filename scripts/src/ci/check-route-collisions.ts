import { walk, read, rel, reportResult, ROOT, type CheckResult } from "./_lib.js";
import { join } from "node:path";

const ROUTES_DIR = join(ROOT, "artifacts/api-server/src/routes");
const RE = /router\.(get|post|put|patch|delete|all|head|options)\s*\(\s*["'`]([^"'`]+)["'`]/g;

export function checkRouteCollisions(): CheckResult {
  const seen = new Map<string, string[]>(); // key: METHOD path, val: file:line
  const files = walk(ROUTES_DIR);
  for (const f of files) {
    const src = read(f);
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      let m: RegExpExecArray | null;
      const lineRe = new RegExp(RE.source, "g");
      while ((m = lineRe.exec(line)) !== null) {
        const key = `${m[1].toUpperCase()} ${m[2]}`;
        const loc = `${rel(f)}:${i + 1}`;
        if (!seen.has(key)) seen.set(key, []);
        seen.get(key)!.push(loc);
      }
    });
  }
  const violations: string[] = [];
  for (const [key, locs] of seen) {
    if (locs.length > 1) {
      violations.push(`${key} registered ${locs.length}× → ${locs.join(", ")}`);
    }
  }
  return {
    name: "route-collisions",
    ok: violations.length === 0,
    violations,
    notes: [`Inspected ${files.length} route file(s); ${seen.size} unique (method,path) pairs.`],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkRouteCollisions();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
