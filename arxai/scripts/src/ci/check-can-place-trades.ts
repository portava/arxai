import { walk, read, rel, reportResult, ROOT, type CheckResult } from "./_lib.js";
import { join } from "node:path";

const ROOTS = [
  join(ROOT, "artifacts/api-server/src"),
  join(ROOT, "lib/domain/src"),
  join(ROOT, "lib/api-spec"),
];

// Match canPlaceTrades:true (with any whitespace) — never allowed.
// Tolerate canPlaceTrades:false / canPlaceTrades: false / "canPlaceTrades": false / canPlaceTrades: false as const
const VIOLATION = /canPlaceTrades\s*[:=]\s*true\b/;

export function checkCanPlaceTrades(): CheckResult {
  const violations: string[] = [];
  for (const root of ROOTS) {
    const files = walk(root, { exts: [".ts", ".tsx", ".yaml", ".yml", ".json"] });
    for (const f of files) {
      if (f.includes("/generated/")) continue;
      const src = read(f);
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if (VIOLATION.test(line)) {
          violations.push(`${rel(f)}:${i + 1} → ${line.trim().slice(0, 120)}`);
        }
      });
    }
  }
  return {
    name: "can-place-trades-invariant",
    ok: violations.length === 0,
    violations,
    notes: [
      "Inviolable invariant: canPlaceTrades must always be false in advisory APIs.",
      "If you need a literal type, use `false as const`.",
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkCanPlaceTrades();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
