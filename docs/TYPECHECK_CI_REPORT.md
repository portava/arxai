# Typecheck CI Gate — Restore the full typecheck (fix OOM)

## Summary

`tsc`-based typechecking was being cgroup-OOM-killed in this 8 GiB sandbox, so
recent merges had **no passing full typecheck** — "green" only meant "tsx ran the
tests + manual symbol checks," which would miss a real type regression. This
restores a typecheck command that runs every package to completion and reports
real pass/fail, **without weakening type safety**.

New command: `pnpm run typecheck:ci` (root) →
`pnpm --filter @workspace/scripts run typecheck:ci` → `tsx ./src/typecheckCi.ts`.
It runs each unit as its **own serial `tsc` process** (composite libs via
`tsc --build`, then `api-server`, `scripts`, `trading-dashboard` each via their
existing `tsc -p tsconfig.json --noEmit`), aggregates pass/fail, runs **all** units
even after one fails, and exits non-zero if any unit fails.

## The cgroup ceiling

- `/sys/fs/cgroup/memory.max` = `8589934592` (**8 GiB**).
- The kill is a **cgroup OOM-kill** (`-1` / no output / SIGKILL), **not** a V8 heap
  error (a V8 error prints `JavaScript heap out of memory`).
- **Counter-intuitive consequence:** raising `--max-old-space-size` makes it
  *worse* — V8 grows its heap past the cgroup ceiling and gets killed. A
  *moderate* cap forces GC so RSS fits.

## Which invocation OOM'd and why

- The old root `typecheck` runs `tsc --build` (libs) then leaf packages at
  `--workspace-concurrency=1`, both at a **4096 MB** heap. That heap is too high
  for the ceiling, and the dominant idle hog is the **IDE TypeScript language
  server** (`tsserver.js` / `typescript-language-server`, ~1.9 GB RSS), which
  leaves little headroom for a bash-spawned `tsc`.
- The heaviest compile cost is the generated Orval output compiled inside the
  composite libs (`lib/api-client-react`, `lib/api-zod`); `artifacts/api-server`
  is the heaviest leaf; `trading-dashboard` is the lightest.
- Both the libs `tsc --build` and a single per-package `tsc` (e.g. api-server,
  scripts) could be SIGKILLed when the cgroup was already heavily used. Memory
  per serial unit actually stays flat (~2.3–2.8 GiB total) — the kills happen
  during transient spikes (browser flooding the dev API + Vite rebuilds + the
  resident LSP), not from any single unit's steady-state footprint.

## The fix chosen and why

1. **Serial, one-process-per-unit orchestrator** (`scripts/src/typecheckCi.ts`):
   no two `tsc` processes are ever live at once, so peak memory is one unit's
   working set (~1.3–1.5 GiB) plus the running dev workflows — never the sum.
2. **Moderate per-unit heap caps** (lower, not higher): libs `3072`, each leaf
   `2560`. Each value is empirically proven to pass; the caps force GC so RSS
   fits under the ceiling. The orchestrator prepends its cap to any inherited
   `NODE_OPTIONS` so a caller can still override.
3. **On-disk `incremental` reuse for the leaf packages** (`api-server`, `scripts`,
   `trading-dashboard`). Only the composite libs had `.tsbuildinfo`; the leaves
   were always cold. Enabling `incremental: true` (api-server pinned to
   `dist/tsconfig.tsbuildinfo`) lets warm repeat runs reuse cached results. This
   does **not** weaken any check — it only caches program state; `.tsbuildinfo` is
   already gitignored. This both speeds the gate for everyone and lets the full
   run be demonstrated to completion within this sandbox's interactive limits.

**Operational note (sandbox only, not part of the gate):** in this interactive
container the resident IDE language server can be freed for headroom by killing
its exact PIDs (`ps … | grep -E 'tsserver\.js|typescript-language-server'` →
`kill <pid>`; it auto-respawns). The `typecheck:ci` command itself does **not**
depend on the IDE LSP. Do **not** `pkill -f tsserver` — the broad match catches
the agent's own shell and returns exit 143.

## Passing output (exit 0)

Full `pnpm run typecheck:ci`, end-to-end:

```
──────── typecheck:ci → lib/* (composite, tsc --build) (heap 3072MB) ────────
──────── typecheck:ci → @workspace/api-server (heap 2560MB) ────────
──────── typecheck:ci → @workspace/scripts (heap 2560MB) ────────
──────── typecheck:ci → @workspace/trading-dashboard (heap 2560MB) ────────

════════════════ typecheck:ci summary ════════════════
  PASS            lib/* (composite, tsc --build)  (1.7s)
  PASS            @workspace/api-server  (10.4s)
  PASS            @workspace/scripts  (11.1s)
  PASS            @workspace/trading-dashboard  (8.8s)
══════════════════════════════════════════════════════
typecheck:ci PASSED — all 4 unit(s) typecheck clean.

>>> typecheck:ci OVERALL EXIT=0 TOTAL=34s peakMem=2.78GiB
```

Each unit was also proven exit 0 standalone (cold): libs ~60s, api-server 47–52s,
scripts 62s, trading-dashboard 38–48s — all well under the ceiling, memory flat.

## Caught-error proof

A trivial type error was injected in `artifacts/api-server/src` (a
`const … : number = "…"` → `TS2322`):

```
src/__typecheckCiProbe.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.

════════════════ typecheck:ci summary ════════════════
  PASS            lib/* (composite, tsc --build)  (1.3s)
  FAIL exit 2   @workspace/api-server  (10.6s)
  PASS            @workspace/scripts  (8.8s)
  PASS            @workspace/trading-dashboard  (7.7s)
══════════════════════════════════════════════════════
typecheck:ci FAILED — 1 of 4 unit(s) reported type errors.

>>> typecheck:ci EXIT=1
```

This proves three things: the gate **catches** the error, it **continues running
all units** after a failure (scripts + dashboard still ran), and it **exits
non-zero**. The probe was then removed and the run returned to exit 0.

## Wiring

- Root `ci` now **leads with** `typecheck:ci` (`pnpm run typecheck:ci && pnpm run
  ci:guards && …`), so the real typecheck gate runs before the guard + test chain.
- Existing scripts are unchanged and still work: `typecheck`, `typecheck:libs`,
  and `build` (`build` still does `pnpm run typecheck && pnpm -r … run build`).

## No type safety was weakened

- No new `skipLibCheck`, no `any`-ing, no excluded real source, no relaxed
  compiler options. The only `compilerOptions` change is adding `incremental`
  (plus an explicit `tsBuildInfoFile` for api-server), which only caches program
  state between runs — identical checks, identical diagnostics.
- The fix is purely *process structure* (serial execution + moderate heap caps +
  incremental cache). The caught-error proof above confirms real type errors are
  still surfaced and still fail the gate.

## In-scope scope notes

- No feature, route, schema, or UI change. No Orval/API-contract regeneration.
- No pre-existing real type errors were found — every package is currently clean.
- The heavy `pnpm run ci` test chain is unchanged except for prepending the
  typecheck gate.
