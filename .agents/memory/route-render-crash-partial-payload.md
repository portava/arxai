---
name: Route render crash from truthy-but-partial payload
description: Why /admin/live-shared (and similar routes) crash into RouteErrorBoundary, and the guarding discipline that prevents it.
---

A page crashes into `RouteErrorBoundary` ("This page hit a snag") when a single
child component dereferences a nested field on a fetched payload that is truthy
(`ok:true`) but missing/null a nested object or number.

**The silent trap:** mixed optional chaining like `data?.readiness.decision`
short-circuits ONLY on `data`, not on `readiness`. Once `data` is a partial
object, `.readiness` is undefined and `.decision` throws
`Cannot read properties of undefined`. Same class: `n.toFixed(2)` on a null
balance figure (live balance sources legitimately return null when the master
account isn't synced / rate-limited).

**How to apply:**
- Guard EVERY nested hop (`data?.a?.b`), not just the first.
- Coerce numbers before `.toFixed` (helper that maps non-finite → 0).
- Filter array elements with a type guard before `.map`/`.filter` access
  (`(c): c is Row => !!c && typeof c === "object" && ...`).
- On routes wrapped in RouteErrorBoundary the boundary HIDES the stack from a
  normal user and there may be no browser console log — reproduce with a focused
  vitest+jsdom render test that feeds a malformed-but-truthy payload (stub
  `fetch`) rather than trying to find it by reading.
- This is render-robustness only; it touches no live/governance/MT5/16-gate
  surface and must not change displayed values for well-formed data.
