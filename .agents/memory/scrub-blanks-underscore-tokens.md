---
name: Scrub blanks UPPER_SNAKE tokens in user-facing copy
description: Why a STRUCTURAL_ONLY assertion fails on a scrubbed read-chart/panel response, and how to probe the state instead.
---

# Scrubber blanks UPPER_SNAKE tokens — assert on state, not on scrubbed text

The assistant copy scrubbers (`scrubUserCopyDeep` / `neutralizeFeedCopyDeep`)
blank out UPPER_SNAKE internal tokens (e.g. `STRUCTURAL_ONLY`, gate/enum names)
anywhere they appear inside user-facing `chartRead` copy strings. So a test that
greps the **scrubbed** read-chart/panel HTTP response for the literal
`STRUCTURAL_ONLY` will fail even when the read genuinely is structural-only.

**How to apply:**
- To prove the panel/chat is in the STRUCTURAL_ONLY state, probe the surviving
  display booleans that ride alongside the scrubbed copy — `gated`,
  `canReadStructure`, `canShowLiveTradeSetup`, `liveSetupWithheld` — not the
  enum token in the text.
- The shared `rubyStructuralReadService` returns the raw `readLayer` enum as a
  **separate top-level field** (not scrubbed); assert on that directly when you
  have the service return value. The blanking only bites when you only have the
  scrubbed `chartRead`/HTTP payload.

**Why:** the structural-read parity harness (panel vs chat) initially failed its
STRUCTURAL_ONLY case purely because the token was scrubbed out of the copy; the
fix was to assert on the booleans/`readLayer` field, not the prose.
