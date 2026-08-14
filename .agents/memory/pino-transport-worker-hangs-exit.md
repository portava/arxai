---
name: pino transport worker can hang process.exit
description: Why a pure-logic tsx test that imports the logger can intermittently fail to exit, and the fix pattern.
---

# Pino transport worker can intermittently hang `process.exit()`

A plain `tsx` test that calls `process.exit(0)` and still PASSES can
intermittently **fail to exit** (open-handle hang) if its import graph reaches
`artifacts/api-server/src/lib/logger.ts`.

**Why:** in non-production, that logger configures a `pino-pretty` `transport`,
which pino runs in a WORKER THREAD (a `MessagePort` handle). The underlying
`thread-stream` installs a synchronous, blocking `process.on('exit')` flush
(`Atomics.wait`) that races the worker's startup — when the worker isn't ready
it can block exit. `setInterval(...).unref()` and `process.exit()` do NOT save
you from this; the blocking flush runs inside the exit handler.

**How to apply:** for a PURE-logic unit test, don't mask it with
`--test-force-exit` — eliminate the handle by construction. Keep the pure
evaluation logic in a side-effect-free sibling module (imports only types +
constants, never `logger`/`alertManager`/`db`) and point the test at that core;
have the runnable module re-export the core so production keeps one import
surface and unchanged behavior. Removing the transitive `logger` import drops
the worker entirely — test exits cleanly and noticeably faster (no heavy chain
loaded). This is the same pure-helper-module split pattern the repo already uses
elsewhere. Once deterministic, promote into root `ci` and remove from the
`check-test-scripts-wired.ts` ALLOWLIST in lockstep.
