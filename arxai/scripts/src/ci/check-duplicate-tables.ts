import { walk, read, rel, reportResult, ROOT, type CheckResult } from "./_lib.js";
import { join } from "node:path";

const SCHEMA_DIR = join(ROOT, "lib/db/src/schema");
const RE = /pgTable\s*\(\s*["'`]([^"'`]+)["'`]/g;

export function checkDuplicateTables(): CheckResult {
  const seen = new Map<string, string[]>();
  const files = walk(SCHEMA_DIR);
  for (const f of files) {
    const src = read(f);
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      let m: RegExpExecArray | null;
      const re = new RegExp(RE.source, "g");
      while ((m = re.exec(line)) !== null) {
        const name = m[1];
        const loc = `${rel(f)}:${i + 1}`;
        if (!seen.has(name)) seen.set(name, []);
        seen.get(name)!.push(loc);
      }
    });
  }
  const violations: string[] = [];
  for (const [name, locs] of seen) {
    if (locs.length > 1) {
      violations.push(`table "${name}" defined ${locs.length}× → ${locs.join(", ")}`);
    }
  }
  return {
    name: "duplicate-tables",
    ok: violations.length === 0,
    violations,
    notes: [`Inspected ${files.length} schema file(s); ${seen.size} unique table name(s).`],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkDuplicateTables();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
