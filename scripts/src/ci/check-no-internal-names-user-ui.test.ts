// Regression suite for the no-internal-names-user-ui CI guard, focused on
// the Task #809 assistant-name ("Ruby" → resolver) leak scan.
//
// Two things are proven here:
//   1. The live repo is clean — `checkNoInternalNamesUserUi().ok` is true.
//   2. The scan is NOT vacuous — `findAssistantNameLeaksInSource` flags a
//      real user-facing "Ruby" and stays silent on comments, glued
//      identifiers, and deliberate name-swap lines. `stripComments`
//      neutralizes comments while preserving line/column positions.
//
// Pure source analysis — no network, DB, or filesystem writes.

import {
  checkNoInternalNamesUserUi,
  findAssistantNameLeaksInSource,
  isAssistantScanExcluded,
  stripComments,
} from "./check-no-internal-names-user-ui.js";

export {};

type Case = { name: string; src: string; expected: number };

// findAssistantNameLeaksInSource(path, src) → each case asserts the leak count.
const leakCases: Case[] = [
  // ── Must be flagged (genuine user-facing copy) ──────────────────────────────
  { name: 'double-quoted string literal', src: `const s = "Ask Ruby anything";`, expected: 1 },
  { name: 'single-quoted string literal', src: `const s = 'Ruby is thinking';`, expected: 1 },
  { name: 'template literal text', src: "const s = `Hi from Ruby`;", expected: 1 },
  { name: "JSX text node", src: `<p>Talk to Ruby</p>`, expected: 1 },
  { name: "two leaks on separate lines", src: `const a = "Ruby";\nconst b = "Ruby";`, expected: 2 },

  // ── Must stay clean ─────────────────────────────────────────────────────────
  { name: "line comment", src: `// Ruby lives here`, expected: 0 },
  { name: "block comment", src: `/* Ruby internal note */`, expected: 0 },
  { name: "trailing line comment after code", src: `const x = 1; // Ruby`, expected: 0 },
  { name: "glued identifier RubyState", src: `type RubyState = { on: boolean };`, expected: 0 },
  { name: "glued identifier allowRuby", src: `const allowRuby = true;`, expected: 0 },
  { name: "snake event source ruby_recommendation", src: `const e = "ruby_recommendation";`, expected: 0 },
  { name: "lowercase ruby word", src: `const s = "the ruby gem";`, expected: 0 },
  { name: "name-swap replace line", src: `const out = template.replace(/Ruby/g, name);`, expected: 0 },
  { name: "import specifier", src: `import { RubyState } from "./ruby.js";`, expected: 0 },
];

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  const label = ok ? "PASS" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`  ${label}  ${name}${detail ? ` — ${detail}` : ""}`);
}

console.log("\nno-internal-names-user-ui guard — assistant-name regression suite");

// 1. Pure-function leak detection.
for (const c of leakCases) {
  const hits = findAssistantNameLeaksInSource("synthetic.ts", c.src);
  const ok = hits.length === c.expected;
  record(
    c.name,
    ok,
    ok ? `${hits.length} leak(s)` : `expected ${c.expected}, got ${hits.length}: ${hits.join(" | ")}`,
  );
}

// 2. stripComments preserves length and neutralizes only comments.
{
  const src = `const a = "Ruby"; // Ruby comment`;
  const stripped = stripComments(src);
  const lenOk = stripped.length === src.length;
  record("stripComments preserves length", lenOk, `${stripped.length} vs ${src.length}`);
  const keepsString = stripped.includes('"Ruby"');
  record("stripComments keeps string content", keepsString);
  const dropsComment = !/\/\/ Ruby comment/.test(stripped) && !stripped.includes("Ruby comment");
  record("stripComments neutralizes trailing comment", dropsComment);
}

// 3. Column is reported against the (position-preserving) stripped line.
{
  const src = `  const s = "Ruby";`;
  const [hit] = findAssistantNameLeaksInSource("p.ts", src);
  const col = Number(hit?.split(":")[2]);
  // "Ruby" opens after `  const s = "` → 0-based index 13 → 1-based col 14.
  record("reports 1-based column", col === 14, `col=${col}`);
}

// 4. The admin/operator/dev library allowlist excludes exactly the intended
//    files, and does NOT over-exclude genuine user-facing library copy.
{
  const excluded = [
    "artifacts/api-server/src/lib/chart/benchmarkScore.ts",
    "artifacts/api-server/src/lib/startup/envChecklist.ts",
    "artifacts/api-server/src/lib/governance/effectiveGovernance.ts",
    "artifacts/api-server/src/lib/live/operatorFundedPilotConfig.ts",
    "artifacts/api-server/src/lib/assistant/parseTradeCommand.ts",
    "lib/domain/src/aaci/conflicts.ts",
    "lib/domain/src/aaci/types.ts",
    "lib/domain/src/agent-system/constitution/agentConstitution.ts",
    "lib/domain/src/agent-system/coreAgents.ts",
    "lib/domain/src/handshake/handshake.types.ts",
    "lib/domain/src/handshake/handshakeRegistry.ts",
  ];
  for (const f of excluded) {
    record(`allowlist excludes ${f.replace(/^.*\/src\//, "")}`, isAssistantScanExcluded(f));
  }
  const notExcluded = [
    "artifacts/api-server/src/lib/assistant/tools.ts",
    "artifacts/api-server/src/lib/assistant/featureMap.ts",
    "artifacts/api-server/src/lib/chart/recordRubyRead.ts",
    // The fixed user-facing domain surface (GET /me/market-edge sentence) must
    // stay in scope so a future "Ruby" regression there fails the guard.
    "lib/domain/src/signal-intelligence/explainMarketRead.ts",
  ];
  for (const f of notExcluded) {
    record(
      `user-facing lib file NOT allowlisted: ${f.replace(/^.*\/src\//, "")}`,
      !isAssistantScanExcluded(f),
    );
  }
}

// 5. The live repository is clean.
{
  const r = checkNoInternalNamesUserUi();
  record(
    "live repo has zero user-facing internal-name leaks",
    r.ok,
    r.ok ? (r.notes?.[0] ?? "clean") : `${r.violations.length} violation(s): ${r.violations[0]}`,
  );
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} assistant-name guard cases passed`);
process.exit(failed === 0 ? 0 : 1);
