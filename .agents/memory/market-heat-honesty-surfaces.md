---
name: Market Heat honesty surfaces + UI-completeness review bar
description: How the Global Market Heat feature stays provider-honest, and what managed code review expects from a "card/map" feature.
---

# Market Heat (provider-honesty-first)

## Honesty contract (non-negotiable)
- A disconnected **news** provider NEVER reads as "low"/"calm" — it is `unavailable`.
- A disconnected **calendar** NEVER fabricates events — the list stays empty.
- Every display surface that shows this risk (the heat card AND the Trade-Plan
  NewsRiskCard) must surface a **per-provider** honesty banner — news-down,
  calendar-down, AND both-down are three distinct states. A computed
  `connected` flag that isn't wired to a standalone banner is the classic leak:
  a disconnected provider silently coexists with a reassuring "CLEAR" label.
- Fail-closed default: while provider status is still loading, assume
  unavailable (show the banner) — clear it only once providers resolve connected.
- Decision-support only: verdicts are advisory, carry no execution field, and
  never gate/bypass a trade gate.

**Why:** missing providers producing a fake low-risk/all-clear read would mislead
toward unsafe entries. "Absence of a warning is not an all-clear."

**How to apply:** when adding/narrowing a Market-Heat view (filters by
symbol/country/session), keep the provider-status rows present in the narrowed
response so a filtered view can't look like a confident all-clear.

## News-risk score = severity × recency, NOT item count
- The news-risk heat number must derive from a keyword-severity vocabulary
  (HIGH_IMPACT/MEDIUM_IMPACT) weighted by recency decay, in the pure domain fn
  `deriveNewsRiskScore(items, nowMs)` (lib/domain/src/market-heat/newsRisk.ts);
  the strongest fresh signal dominates (max-weighted), volume is secondary. A
  raw `itemCount/N` proxy was the prior bug — many calm headlines outscored one
  crash headline.
- `newsRiskLevelOf(score)` is the SINGLE threshold→level mapper; both the heat
  card (`newsSignalOf` → `deriveNewsRisk`) and Ruby (`rubyContext.fetchNews` /
  `composeRubyBriefing`) must route through it so one number → one verdict.
- **Why:** "12 newsletters" must never read as high risk and one "emergency rate
  decision / market crash" must never read as low. Severity is the signal.
- **How to apply:** when surfacing news risk on a new surface, compute the level
  via `newsRiskLevelOf(deriveNewsRiskScore(...))` from REAL fetched items; never
  re-derive from a count. Connected-but-zero-items legitimately reads low; only
  a disconnected/missing provider stays `unavailable`.

## Managed-code-review completeness bar (learned)
A feature billed as a "card"/"heat map" is REJECTED if it ships as a flat
collapsible list. The reviewer expects **distinct labeled sections** (top hot /
today's news risk / upcoming events) AND a real heat-map visual (colored tile
grid w/ drill-down), plus **cross-surface** honesty (every existing widget that
shows the same data, not just the new one). A fresh review can also REJECT a
prior "done" by re-checking the ORIGINAL requirements — treat each listed
requirement as acceptance criteria, not polish.
