import { walk, read, rel, reportResult, ROOT, type CheckResult } from "./_lib.js";
import { dirname, join, resolve, relative } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";

// Detect circular import cycles inside lib/domain/src using a simple
// resolver (relative imports + .ts/.tsx + index files).
const DOMAIN_SRC = join(ROOT, "lib/domain/src");

function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // skip pkg imports
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base + ".ts",
    base + ".tsx",
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

export function checkDomainCircular(): CheckResult {
  const files = walk(DOMAIN_SRC);
  const graph = new Map<string, Set<string>>();
  const importRe = /from\s+["'`]([^"'`]+)["'`]/g;
  for (const f of files) {
    const src = read(f);
    const deps = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(src)) !== null) {
      const r = resolveImport(f, m[1]);
      if (r) deps.add(r);
    }
    graph.set(f, deps);
  }

  const cycles: string[] = [];
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const f of graph.keys()) color.set(f, WHITE);
  const path: string[] = [];

  function dfs(u: string): void {
    color.set(u, GRAY);
    path.push(u);
    const deps = graph.get(u);
    if (deps) {
      for (const v of deps) {
        const c = color.get(v) ?? WHITE;
        if (c === GRAY) {
          const idx = path.indexOf(v);
          const cycle = path.slice(idx).concat(v).map((p) => relative(DOMAIN_SRC, p));
          cycles.push(cycle.join(" → "));
        } else if (c === WHITE) {
          dfs(v);
        }
      }
    }
    color.set(u, BLACK);
    path.pop();
  }

  for (const f of graph.keys()) {
    if ((color.get(f) ?? WHITE) === WHITE) dfs(f);
  }

  // Dedupe cycles by canonical form (rotate to lexicographically-smallest start).
  const dedup = new Set<string>();
  for (const c of cycles) {
    const parts = c.split(" → ");
    parts.pop(); // remove trailing duplicate
    let minIdx = 0;
    for (let i = 1; i < parts.length; i++) {
      if (parts[i] < parts[minIdx]) minIdx = i;
    }
    const canonical = parts.slice(minIdx).concat(parts.slice(0, minIdx));
    dedup.add(canonical.join(" → ") + " → " + canonical[0]);
  }

  // Ratchet: known cycles snapshotted in known-domain-cycles.json are tolerated
  // as debt; new cycles fail the build. Shrinking the snapshot is encouraged.
  const allowlistPath = join(import.meta.dirname, "known-domain-cycles.json");
  let known = new Set<string>();
  if (existsSync(allowlistPath)) {
    try {
      const j = JSON.parse(readFileSync(allowlistPath, "utf8")) as { cycles?: string[] };
      known = new Set(j.cycles ?? []);
    } catch {
      /* ignore */
    }
  }

  const all = Array.from(dedup);
  const newCycles = all.filter((c) => !known.has(c));
  const stillKnown = all.filter((c) => known.has(c));
  const fixedKnown = Array.from(known).filter((c) => !dedup.has(c));

  const notes = [`Inspected ${files.length} files in lib/domain/src.`];
  if (stillKnown.length) notes.push(`${stillKnown.length} pre-existing cycle(s) tolerated via known-domain-cycles.json (debt).`);
  if (fixedKnown.length) notes.push(`${fixedKnown.length} known cycle(s) appear FIXED — please remove from known-domain-cycles.json.`);

  return {
    name: "domain-circular-deps",
    ok: newCycles.length === 0,
    violations: newCycles.map((c) => `NEW cycle: ${c}`),
    notes,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkDomainCircular();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
