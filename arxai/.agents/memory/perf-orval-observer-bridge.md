---
name: Orval customFetch perf observer bridge
description: How every Orval-generated React Query call is automatically timed and split into backend-ms vs network-ms.
---

# Orval customFetch perf observer bridge

`lib/api-client-react/src/custom-fetch.ts` exposes a `setRequestObserver(obs)` hook. The host app wires it once at boot; from then on every Orval-generated API call (every React Query hook the codegen emits) feeds a `{method,url,status,totalMs,backendMs,ok}` row into the observer with zero per-call work at the call site.

**Why:** when only explicit `markActionStart`/`markActionEnd` calls were timed, every background query, refetch, and Orval hook call was invisible — duplicate-request detection and "slow API on a page with no named action" were both blind. Wiring the observer once at the mutator layer means new generated hooks get coverage for free, without touching every component.

**How to apply:**
- The bridge in `trading-dashboard/src/lib/perf.ts` (`observeOrvalRequest`) is the host-app side. It only enqueues rows above `API_SLOW_MS` so fast calls don't drown the signal.
- Backend ms comes from the `Server-Timing: app;dur=<ms>` header emitted by `artifacts/api-server/src/middlewares/perfTimer.ts`. The header is injected via a `res.writeHead` patch (set-Header after-flush would race with `res.json()`), and `Access-Control-Expose-Headers` is set in the same patch so cross-origin clients (Expo) can read it too.
- Keep the observer side-effect-free: the mutator is also used by Expo bundles, where `performance.now()` and the dashboard's perf module do not exist. The mutator must work with the observer unset (default = null).
- Don't broaden the observer to enqueue every call — that's the slow-row flusher's job, and the volume would blow past the 200-row pending cap on busy pages (5 components × 5s polling = ~100 rows/min from one page alone).
- The dashboard mounts the observer via a `<PerfObserverMount />` component inside `AuthGate` so HMR teardown clears it (`return () => setRequestObserver(null)`); otherwise hot reloads stack observers and double-flush every row.
