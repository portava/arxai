---
name: React Query browser focus checks
description: Trigger TanStack Query's default focus revalidation in headless browser tests.
---

When a browser QA test needs to simulate a user returning to a tab, dispatch `visibilitychange` on `window`; a synthetic `focus` event alone does not invoke TanStack Query's default focus manager.

**Why:** The installed TanStack Query v5 focus manager subscribes to the window's `visibilitychange` event, so synthetic focus did not revalidate `/api/me` in headless Chromium.

**How to apply:** Dispatch the visibility event only after the observed query is stale, then wait for the expected network response before asserting auth or cache behavior.
