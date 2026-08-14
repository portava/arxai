---
name: Pause raw setInterval polling on hidden tab
description: React Query's refetchIntervalInBackground:false only covers RQ-managed queries; raw setInterval loops need their own visibility guard.
---

# Pause raw `setInterval` polling on hidden tab

The global `QueryClient` default `refetchIntervalInBackground: false` only pauses React Query-managed polling. Pages that hand-roll `setInterval(load, 5000)` around raw `fetch()` (the market scanner is the worst offender) keep firing forever, even on backgrounded tabs — and the user comes back to ≤5s-stale data anyway because the next tick is up to a full interval away.

**Why:** discovered during PART D of the speed audit — a backgrounded scanner tab was sending two GETs every 5s for the entire session. Wasted CPU, wasted server cycles, and the data was still stale on return.

**How to apply:**
- Wrap every raw `setInterval` polling loop in a `visibilitychange` listener that `clearInterval`s while `document.hidden`, restarts on return, AND calls `load()` once immediately on return so the user sees fresh data without waiting.
- This pattern lives in `artifacts/trading-dashboard/src/pages/market-scanner.tsx` — copy it when you find another offender.
- The longer-term fix is to migrate the raw `fetch` to a generated React Query hook so the QueryClient default does the work for you; the visibility guard is a stopgap.
- Don't combine this with React Query polling on the same data — pick one owner. Double-polling appears as duplicate requests in `observeOrvalRequest` and is treated as a perf bug.
