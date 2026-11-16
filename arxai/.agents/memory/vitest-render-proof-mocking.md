---
name: vitest render-proof mocking pitfalls
description: vi.mock gotchas when render-proofing a component whose module pulls a heavy sibling graph (trading-dashboard layout)
---

When writing a vitest render proof for a component exported from a file that
statically imports many heavy siblings (e.g. `SidebarContent` lives in
`AppLayout.tsx`, which imports Topbar/FloatingActionPanel/NotificationCenter/…):

- **Do NOT return `new Proxy(...)` from a `vi.mock` factory.** Vitest's
  module-namespace handling throws `TypeError: Cannot create proxy with a
  non-object as target or handler`. Use a plain object literal of explicit named
  exports instead.
- **A shared top-level `const stub = …` referenced inside `vi.mock` hits TDZ**
  (`Cannot access 'stub' before initialization`) because `vi.mock` is hoisted
  above it. Inline the factory per call, or use `vi.hoisted`.
- **Imported-but-not-rendered siblings usually need NO mock.** Only the
  component-under-test's *rendered* tree matters. For `SidebarContent` it was
  enough to mock what it actually consumes: the data/role hooks
  (`useViewMode`/`useProductRole`/`useCurrentUser`), `wouter`
  (`Link`→anchor, `useLocation`→`["/", fn]`), and the single shared source hook
  (`useAssistantName`). The heavy siblings load fine at import time; mocking them
  was unnecessary churn.

**Why:** spent two failed attempts (TDZ then Proxy) trying to defensively stub
siblings that were never rendered. The convention already in the repo
(mock hooks, no QueryClientProvider) is sufficient.

**How to apply:** render-proofing any layout/page component — mock only its
consumed hooks + wouter; partial-mock the shared module with
`importOriginal()` so re-exported constants survive; skip sibling stubs.
