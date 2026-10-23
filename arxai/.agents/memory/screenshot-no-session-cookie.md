---
name: Authenticated UI capture via screenshot tool is blocked
description: The app_preview/screenshot tool cannot inject this app's session cookie, so authenticated browser pixel capture of a logged-in page is not achievable.
---

The `screenshot` (app_preview) tool drives an unauthenticated browser through
the `localhost:80` proxy and provides no way to set the app's `arx_user_session`
cookie. For ARX (custom cookie auth, NOT Clerk) any logged-in page therefore
renders the **login wall** (the page itself fires a 401 for `/api/me`), so you
cannot pixel-capture an authenticated Scanner/chart/badge view this way.

**Why:** session-injection isn't supported by the screenshot tool, and the QA
temp-session pattern (`auth_user_sessions` + `arx_user_session` cookie) only
works for server-side HTTP clients (curl), not the screenshot browser.

**How to apply:** for "compare UI vs API" checks, verify the UI mapping at the
SOURCE instead — e.g. `resolveDisplayStatus` in
`trading-dashboard/src/lib/chart-display-status.ts` is a pure function of the
same `/api/chart/candles` feedStatus fields (quality/isLive/stale/source/
aiUsable) and never upgrades the backend verdict, so you can deterministically
compute the rendered badge per row and prove agreement. Report the pixel-capture
gap honestly rather than faking a screenshot. (Playwright testing subagent could
log in via the UI but needs real, possibly-stale credentials and can't read env
secrets — see playwright-subagent-no-env-secrets.)
