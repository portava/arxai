import { walk, read, rel, reportResult, ROOT, type CheckResult } from "./_lib.js";
import { join } from "node:path";

// Leaf workspace packages must NOT import from each other.
// Allowed: imports from libs (@workspace/db, @workspace/domain, etc.).
// Forbidden: artifacts/<a> importing from artifacts/<b>; cross-artifact relative paths.
const LEAF_ARTIFACTS = ["api-server", "trading-dashboard", "mockup-sandbox"];

export function checkCrossArtifactImports(): CheckResult {
  const violations: string[] = [];
  for (const a of LEAF_ARTIFACTS) {
    const files = walk(join(ROOT, "artifacts", a, "src"));
    for (const f of files) {
      const src = read(f);
      for (const other of LEAF_ARTIFACTS) {
        if (other === a) continue;
        // forbid `@workspace/<other>` and any path that resolves to ../<other>/
        const pkgRe = new RegExp(`from\\s+["'\`]@workspace/${other}\\b`);
        const relRe = new RegExp(`from\\s+["'\`][^"'\`]*\\.\\./${other}/`);
        const lines = src.split("\n");
        lines.forEach((line, i) => {
          if (pkgRe.test(line) || relRe.test(line)) {
            violations.push(`${rel(f)}:${i + 1} → ${a} imports from ${other}: ${line.trim().slice(0, 120)}`);
          }
        });
      }
    }
  }
  return {
    name: "cross-artifact-imports",
    ok: violations.length === 0,
    violations,
    notes: [
      "Leaf artifacts (api-server, trading-dashboard, mockup-sandbox) must not import each other.",
      "Share via libs (lib/db, lib/domain, lib/api-zod, lib/api-client-react, lib/api-spec).",
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkCrossArtifactImports();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
