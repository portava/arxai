---
name: Perf action naming + leak avoidance
description: Three rules for adding markActionStart instrumentation around fetch/SSE/raw POST paths.
---

Three rules when wrapping a user action with `markActionStart` → `markActionEnd`:

1. **Sanitise dynamic path segments out of the action label.** If the action
   name is derived from a URL like `/api/admin/allocations/123/freeze`, the
   numeric `123` (and any UUID-shaped segment) must be collapsed to `:id`
   before joining into the label, or the ring buffer accumulates one label
   per user/resource and perf reporting becomes unusable.
   **Why:** label cardinality directly drives memory + perf-flush row count.
   **How to apply:** strip the static prefix, split on `/`, map `/^\d+$/` and
   `/^[0-9a-f-]{8,}$/i` to `:id`, then `.join(".")`.

2. **Every early-return inside an SSE / fetch loop must call markApiEnd +
   markActionEnd.** Aborting the controller is not enough — the perf row is
   bookkeeping in JS land. Audit each `return` and each `controller.abort()`
   call inside the streaming loop. Especially the safety-envelope rejection
   branch in `ArxAssistantLivePanel.sendText` — it would silently leak a
   row otherwise.
   **Why:** unclosed `inFlight` rows never flush; they stay alive forever and
   skew "still running" diagnostics.
   **How to apply:** for any code path that exits after `markActionStart`,
   call `markApiEnd(pid, endpoint)` + `markActionEnd(pid, { bottleneck })`.
   `markActionEnd` is idempotent so a safety-net call at the bottom of the
   handler is OK as a belt-and-suspenders.

3. **Never call markActionStart during React render.** Move it into
   `useEffect` and store the pid in a ref. Strict-mode double-invocation and
   concurrent rendering would otherwise create two perf rows per mount that
   never reconcile, and SSR will throw on `performance.now()` indirectly.
   **Why:** render must be pure.
   **How to apply:** `useEffect(() => { const pid = markActionStart(...);
   refRef.current = pid; return () => { /* close on unmount */ }; }, [])`
   then a second effect to close on data/error arrival.
