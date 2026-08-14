---
name: scripts/src test files must be ES modules (export {})
description: A test file under scripts/src with no import/export is treated as a global script; two such files declaring the same top-level names collide at typecheck.
---

# scripts/src test files need to be modules, or they collide

`pnpm --filter @workspace/scripts run typecheck` compiles all of `scripts/src`
in one TS program. A file with **no** top-level `import` or `export` is a global
script, so its top-level declarations land in the global scope. Two such test
files that both declare e.g. `type CheckResult`, `const results`, `function
record`, `let passed` produce `TS2300 Duplicate identifier` / `TS2451 Cannot
redeclare` — even though neither file changed.

**Why:** a recent merge can add a self-contained test that uses a local
`record()`/`results[]` harness without importing anything; it typechecks alone
but breaks the package once a second one exists.

**How to apply:** if scripts typecheck reports duplicate-identifier across two
test files you didn't touch, append `export {};` to each to scope it as a module
(behavior-preserving). The harness in most tests imports from `@workspace/*`, so
they're already modules; the pure no-import ones are the trap.
