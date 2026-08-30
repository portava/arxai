// The @workspace/markets barrel is reachable from the BROWSER bundle:
// artifacts/trading-dashboard/src/lib/symbolRegistry.ts imports it. Anything
// the barrel re-exports is therefore shipped to the client.
//
// The defect this guards: the C8 work added lib/markets/src/dailySeries, whose
// fingerprint.ts imports node:crypto for a content hash, and re-exported it
// from this barrel. Vite externalises node builtins for the browser, so the
// dashboard died on load with 'Module "node:crypto" has been externalized for
// browser compatibility' — a whole-app crash, from one re-export line.
//
// dailySeries still exists; it is reached at "@workspace/markets/daily-series"
// by server code only. This test fails if a Node-only import becomes reachable
// from the browser barrel again, by any path.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../../lib/markets/src");

// Builtins that Vite externalises. If one of these is reachable from the
// barrel, the client bundle breaks at runtime, not at build time.
// Verification 2026-08-30 widened both regexes: the original matched only
// double-quoted `from "..."` forms, so a single-quoted import, a bare
// side-effect `import "node:x"`, or a dynamic `import("fs")` slid past the
// guard while crashing the browser exactly the same way.
const NODE_ONLY =
  /(?:from\s+|import\s+|import\s*\(\s*)["'](node:[a-z_/]+|fs|path|crypto|os|child_process|net|tls|http|https|worker_threads)["']/;

/** Follow every relative re-export/import from the barrel, transitively. */
function reachableFromBarrel(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (file: string) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    out.push(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:from\s+|import\s+|import\s*\(\s*)["'](\.[^"']*)["']/g)) {
      const spec = m[1]!.replace(/\.js$/, "");
      for (const cand of [`${spec}.ts`, `${spec}/index.ts`]) {
        const p = resolve(dirname(file), cand);
        if (existsSync(p)) { walk(p); break; }
      }
    }
  };
  walk(resolve(SRC, "index.ts"));
  return out;
}

describe("@workspace/markets barrel stays browser-safe", () => {
  test("no module reachable from the barrel imports a Node builtin", () => {
    const offenders: string[] = [];
    for (const file of reachableFromBarrel()) {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      const hit = NODE_ONLY.exec(code);
      if (hit) offenders.push(`${file.slice(SRC.length + 1)} imports ${hit[1]}`);
    }
    assert.deepEqual(
      offenders,
      [],
      "these are shipped to the browser via the barrel and will crash the dashboard on load:\n  " +
        offenders.join("\n  "),
    );
  });

  test("the walk actually inspected the barrel's graph", () => {
    // A silently-empty walk would make the check above vacuously green.
    const files = reachableFromBarrel();
    assert.ok(files.length >= 5, `only ${files.length} module(s) reachable — the walk is not resolving imports`);
  });

  test("dailySeries is still shipped, just not through the barrel", () => {
    assert.ok(existsSync(resolve(SRC, "dailySeries/index.ts")), "the module must still exist");
    const barrel = readFileSync(resolve(SRC, "index.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(barrel, /dailySeries/, "the barrel must not re-export dailySeries");
    const pkg = JSON.parse(readFileSync(resolve(SRC, "..", "package.json"), "utf8"));
    assert.equal(
      pkg.exports?.["./daily-series"],
      "./src/dailySeries/index.ts",
      "server code reaches it at @workspace/markets/daily-series — that subpath must stay published",
    );
  });
});
