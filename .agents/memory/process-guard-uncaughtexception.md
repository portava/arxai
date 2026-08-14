---
name: Process-level crash guards on a safety-critical server
description: uncaughtException must FAIL SAFE (clean restart), not keep-alive; unhandledRejection may log-and-continue; request-path errors belong to always-JSON middleware.
---

On the ARX AI api-server (safety-critical, default-deny live trading), the
process-level guards in `index.ts` are split by fault class — they are NOT
symmetric:

- **`unhandledRejection` → log + keep alive.** A stray fire-and-forget rejection
  must not take the worker down (a dead worker is what makes the upstream proxy
  return a body-less 502 → client "Unexpected end of JSON input"). Logging and
  continuing is safe because a rejected promise does not corrupt synchronous
  global state.
- **`uncaughtException` → FAIL SAFE: log, `server.close()`, `process.exit(1)`**
  (with an unref'd 3s force-exit timer in case close hangs). Do **not** keep the
  worker alive.

**Why:** an uncaught synchronous throw leaves the process in an UNDEFINED state
(in-flight DB work, live-command bookkeeping, timers). On a trading server,
silently continuing a corrupted worker can affect the live path — worse than a
brief restart. This is the codebase's "explicit failure over silent fallback"
principle applied to the process lifecycle.

**How to apply:**
- Request-path errors should NEVER reach `uncaughtException` — they are caught by
  the Express always-JSON error middleware in `app.ts` (returns
  `{ok:false, error:"INTERNAL_ERROR"}`). So the uncaughtException handler fires
  only on genuine escaped faults; failing safe there is correct, not lossy.
- The client-side `safeJson` reader degrades a transient 502 (during the fresh
  worker's boot) honestly instead of throwing a raw SyntaxError, so fail-safe
  restart does not regress UX.
- A task phrased as "add process guards to survive 502" does NOT mean "keep the
  worker alive on every fault" — keep-alive is correct for rejections only.
  (Architect flagged a blanket keep-alive as the one blocking issue here.)
