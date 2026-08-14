---
name: API responses must be normalised at the page boundary
description: Any field a page renders with `.replace`, `.length`, `new Date(...)`, etc. must pass through a defensive normaliser at the response boundary, not be trusted to match the OpenAPI shape.
---

Generated OpenAPI types describe the *intended* response shape, not what the server actually returns in every code path. Backends evolve, error branches return partial bodies, and rolling deploys can serve old shapes briefly. If a page calls `s.type.replace(...)`, `data.brokerOrders.length`, or `new Date(maybeNull).toISOString()` directly on a typed response, a single null/missing/invalid field will throw inside React's render and white-screen the whole page.

**Rule:** at the top of any page component that reads an API response, run the response through a tiny `normaliseX(raw: unknown): X` function whose job is to coerce missing/wrong-shape fields to safe defaults. Render only normalised data.

**Why:** in the 26-bug-group screenshot sweep, three pages were white-screening in production:
- `/alerts` — `s.type.replace(/_/g, " ")` on an alert row whose `type` was null
- `/broker-reconciliation` — `.length` on `brokerOrders` / `brokerPositions` / `mismatches` when the server returned an error/empty body
- `/live-trading-control` — `new Date(invalidString).toISOString()` on a stale heartbeat

All three were "TypeScript said the field existed so I trusted it". The fix in each case was a 5-line normaliser at the page boundary.

**How to apply:**
- Use the shared helpers in `artifacts/trading-dashboard/src/lib/safeFormat.ts` (`safeArray`, `safeLen`, `safeLabel`, `safeDate`) when the shape is simple.
- For composite responses, write a page-local `normaliseFoo(raw: unknown): Foo` and never destructure off the raw response.
- When adding a new page, write the normaliser first, then the renderer. The normaliser is the contract the page actually depends on.
- Add a regression test in `scripts/src/qaScreenshotCrashFixes.ts` (one assertion per crash mode) so a future refactor that removes a guard fails the test.
