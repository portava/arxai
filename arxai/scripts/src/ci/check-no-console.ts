import { walk, read, rel, reportResult, ROOT, type CheckResult } from "./_lib.js";
import { join } from "node:path";

const SERVER_ROOTS = [
  join(ROOT, "artifacts/api-server/src"),
  join(ROOT, "lib/domain/src"),
];

const ALLOWLIST_SUBSTR = [
  "/seed/",
  "/build.mjs",
  "/tests/",
  "/scripts/",
  "/__tests__/",
];

const PATTERN = /\bconsole\.(log|info|warn|error|debug|trace)\b/;

export function checkNoConsole(): CheckResult {
  const violations: string[] = [];
  for (const root of SERVER_ROOTS) {
    const files = walk(root);
    for (const f of files) {
      if (ALLOWLIST_SUBSTR.some((s) => f.includes(s))) continue;
      const src = read(f);
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if (PATTERN.test(line) && !line.trim().startsWith("//") && !line.trim().startsWith("*")) {
          violations.push(`${rel(f)}:${i + 1} → ${line.trim().slice(0, 100)}`);
        }
      });
    }
  }
  return {
    name: "no-console-in-server",
    ok: violations.length === 0,
    violations,
    notes: ["Server code must use req.log or the singleton logger; never console.*"],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkNoConsole();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
