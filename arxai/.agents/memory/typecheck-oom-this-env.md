---
name: Full workspace typecheck OOMs in this environment
description: pnpm run typecheck is killed (exit -1, no output); use the serial typecheck:ci gate.
---

## The gate to use: `pnpm run typecheck:ci`

`scripts/src/typecheckCi.ts` runs each unit as its **own serial `tsc` process**
(libs `tsc --build`, then api-server / scripts / trading-dashboard each
`tsc -p tsconfig.json --noEmit`), aggregates pass/fail, **runs all units even on
failure**, exits non-zero if any fail. Wired into root `ci` ahead of `ci:guards`.

**Why it works:** never more than one `tsc` live → peak ≈ one unit's working set
(~1.3–1.5 GiB) not the sum. Per-unit moderate heap caps (libs 3072, leaves 2560)
force GC so RSS fits the 8 GiB cgroup. Leaves now have `incremental: true`
(api-server pinned to `dist/tsconfig.tsbuildinfo`) so warm runs reuse
`.tsbuildinfo` (already gitignored); cold ~50–60s/unit, warm ~7–16s/unit. No
type safety weakened — incremental only caches, same checks.

**Sandbox-only gotchas when running it interactively here:**
- Detached (`setsid`/background) `tsc`/orchestrator processes get **reaped at
  ~3–5 min** with no exit file — a "stalled" detached run is usually already dead
  (memory flat, no tsc in `ps`). Run **foreground**; the full warm run is ~34s so
  it fits the 120s tool cap once leaves are warmed.
- Free the resident IDE LSP for headroom before heavy runs (kill EXACT PIDs from
  `ps … grep -E 'tsserver\.js|typescript-language-server'`; it auto-respawns).
  The gate itself does not depend on the LSP.

Below is the older root-`typecheck` analysis (still valid background).


`pnpm run typecheck` (root) intermittently exits with code `-1` and **no output**
in this Replit container — the process is killed (memory/signal), not a type
error.

**Why:** the root script previously ran `pnpm -r` across all leaf packages in
**parallel**, launching several `tsc` processes at once that together exceeded
the container's memory ceiling.

**Fix (applied):** the root `typecheck` script passes
`--workspace-concurrency=1` so leaf packages typecheck one at a time after
`tsc --build` for the libs, AND each tsc gets a raised heap via
`NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"` (default node heap
in this container is only ~2240MB). The `${VAR:-default}` form respects a
caller-supplied `NODE_OPTIONS` and otherwise applies the 4GB default. With
concurrency=1 only one tsc runs at a time, so peak stays within the ~5.7GB
available envelope. Standalone `pnpm run typecheck` completes green (~1m45s).

**How to apply:** keep the concurrency cap. The whole chained `pnpm run ci`
(typecheck → guards → 5 in-process app tests) can still be killed (`-1`,
no output) when run as a **single foreground agent bash tool call** — that is
the agent sandbox terminating a long-running foreground process, NOT a gate
failure. Verify in pieces: `pnpm run typecheck` (now passes), `pnpm run
ci:guards`, then each `pnpm --filter @workspace/scripts run test:*` step. All
green in pieces == green overall.

## Per-package typecheck ALSO OOMs under memory contention (observed)

Even a single per-package `tsc -p tsconfig.json --noEmit` (e.g. api-server,
scripts) can be SIGKILLed (`-1`, no output) when the 8GB cgroup is already
~7.4GB used. The dominant idle hog is the **IDE TypeScript language server**
(`node .../typescript/lib/tsserver.js`, ~1.9GB RSS). The `-1`/no-output is a
**cgroup OOM-kill**, not a V8 heap error (a heap error prints "JavaScript heap
out of memory").

**Counter-intuitive:** raising `--max-old-space-size` makes it WORSE — V8 grows
the heap past the cgroup ceiling and gets killed. A *lower/moderate* cap forces
aggressive GC so RSS fits.

**Workaround that works:**
1. Free memory: `kill <exact tsserver.js PID>` (find via
   `ps -eo pid,rss,args --sort=-rss | grep tsserver.js`). It is the editor LSP
   (re-indexable cache), NOT used by a bash-spawned `tsc`, and auto-respawns. Do
   **NOT** `pkill -f tsserver.js` — the broad match caught the agent's own shell
   parent and returned exit 143.
2. Run each typecheck **serially** (never batch multiple `tsc` in one parallel
   tool call — that guarantees OOM).
3. Use a moderate heap cap: api-server passed at
   `NODE_OPTIONS="--max-old-space-size=2816"`, scripts at `2048`. tsserver creeps
   back between runs, so re-kill before each heavy package.
4. trading-dashboard typecheck fits without freeing; api-server is the heaviest.
