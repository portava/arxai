---
name: Economic calendar provider-agnostic honesty surfaces
description: Where calendar provider-agnosticism + honesty must be enforced, and the FRED dates-only honesty rules.
---

# Economic calendar provider-agnostic honesty surfaces

The economic calendar is provider-agnostic behind one shared seam (TE takes
precedence when keyed, else FRED; this environment runs FRED). Provider selection
is config, never code.

**Rule: enforce provider-agnosticism + honesty at EVERY backend surface that reads
the calendar, not just the shared service.**
**Why:** a review failed because two surfaces (the events route and the provider-health
diagnostics) still imported a provider-specific adapter directly, so they were silently
TE-hardcoded even though the service was agnostic.
**How to apply:** any surface reading calendar data goes through the shared provider
helpers — never re-import a provider-specific adapter. Keep all provider adapters intact
(deleting one would re-hardcode by omission).

**Honesty states (never fake low-risk/all-clear):**
- missing config ⇒ not-connected, provider "none", empty events, freshness unavailable.
- fetch error ⇒ configured-but-not-connected, selected provider still reported, error surfaced, empty events.
- reachable + 0 classifiable ⇒ connected, empty events ("no relevant events").

**FRED dates-only honesty:** FRED returns release dates only. A curated release-name
classifier maps to factual {currency,country,impact}; unrecognized releases are dropped;
forecast/previous/actual/clock-time stay null (never fabricated). Synthetic symbols
(V75/R_75 etc.) ⇒ macro N/A ⇒ 0 events even when real rows exist. Do NOT add an
instant-based lower-bound window or FRED midnight-dated "today" events get dropped.
