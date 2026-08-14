---
name: Lazy-load collapsed-but-mounted heavy panels
description: A heavy component mounted on every route counts toward first-paint compile in Vite dev even when collapsed/hidden by CSS.
---

# Lazy-load collapsed-but-mounted heavy panels

A component that is statically imported and mounted at the layout root on EVERY
route pays its full module-graph compile cost on first authed paint in the Vite
**dev preview**, even if it renders nothing (collapsed, `hidden`, or behind a
toggle). CSS/visibility hiding does not avoid the import cost.

**Why:** the ARX dashboard felt ~7s on the real Replit preview while transport
was fast (index TTFB 33–442ms, `/api/me` 3ms). Root cause was client-side Vite
dev compilation of the eager global module graph — the worst offender was the
1686-line `ArxAssistantLivePanel` (voice / realtime WebRTC / TTS /
`@workspace/integrations-openai-ai-react` / audio), statically imported into
`AppLayout` and mounted on every route though collapsed by default.

**How to apply:**
- Convert such panels to `React.lazy(() => import(...))` + `<Suspense fallback={null}>`
  so the heavy graph loads after first paint, not before it.
- Look for this whenever a layout-root component pulls in voice/WebRTC/audio/AI
  SDKs, charting, or other large deps but is hidden/collapsed by default.
- Verify on the REAL preview (logged-in, mobile + desktop), not just typecheck —
  transport timing and typecheck do not reveal dev-compile cost.
