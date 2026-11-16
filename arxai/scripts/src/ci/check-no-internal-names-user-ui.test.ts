// Regression suite for the no-internal-names-user-ui CI guard, focused on the
// old-assistant-codename ban (2026-11-05: the old name appears nowhere).
//
//   1. The detector is NOT vacuous: it flags the old name in any case, inside
//      identifiers, comments and file paths.
//   2. The live repository is clean.
//
// The old name is assembled from letters so this file does not contain it.

import {
  checkNoInternalNamesUserUi,
  findLegacyCodenameInSource,
} from "./check-no-internal-names-user-ui.js";

export {};

const OLD = ["r", "u", "b", "y"].join("");
const Old = OLD[0]!.toUpperCase() + OLD.slice(1);

type Case = { name: string; path?: string; src: string; expected: number };

const cases: Case[] = [
  { name: "capitalised word in a string", src: `const s = "Ask ${Old} anything";`, expected: 1 },
  { name: "upper case enum value", src: `const k = "${OLD.toUpperCase()}_EXECUTION";`, expected: 1 },
  { name: "glued identifier", src: `type ${Old}State = { on: boolean };`, expected: 1 },
  { name: "snake_case column", src: `text("${OLD}_summary")`, expected: 1 },
  { name: "comment", src: `// ${Old} lives here`, expected: 1 },
  { name: "JSX comment", src: `<p>Hi {/* ${Old} */}</p>`, expected: 1 },
  { name: "two on one line", src: `const a = "${Old}"; const b = "${OLD}";`, expected: 2 },
  { name: "file path", path: `src/components/${OLD}/Avatar.tsx`, src: `export {};`, expected: 1 },
  { name: "the new name is fine", src: `const s = "Eleanor is reading the chart";`, expected: 0 },
  { name: "unrelated words are fine", src: `const s = "rub your eyes, yes";`, expected: 0 },
];

let failed = 0;
console.log("\nno-internal-names-user-ui guard — old-codename regression suite");
for (const c of cases) {
  const hits = findLegacyCodenameInSource(c.path ?? "synthetic.ts", c.src);
  const ok = hits.length === c.expected;
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${c.name} — ${hits.length} hit(s)${ok ? "" : `, expected ${c.expected}`}`);
}
{
  const r = checkNoInternalNamesUserUi();
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  live repo is clean${r.ok ? "" : ` — ${r.violations.length} violation(s): ${r.violations[0]}`}`);
}
console.log(`\n${cases.length + 1 - failed}/${cases.length + 1} guard cases passed`);
process.exit(failed === 0 ? 0 : 1);
