---
name: Outage banner page-scope + enrichment fan-out cap
description: Degraded/outage banners must render above the tab container; scanner per-symbol enrichment must be concurrency-bounded.
---

# Outage banner must be page-scope, not tab-trapped

A degraded/outage banner placed inside a single tab's results block (e.g. the
Broad Scan `resultsBlock`) is invisible on every other tab — including the
default Focus tab — exactly when the user most needs the honest signal.

**Rule:** hoist such banners to page scope, rendered once after the header
summary and ABOVE the `<PageTabs>` container, so they are independent of the
active tab.

**How to verify here:** the page imports ~30 heavy children (lightweight-charts
etc.) so full jsdom render is brittle. Prove it with a source-scan test instead:
assert the banner `testId` appears exactly once and its index sits between
`<ScannerHeaderSummary` and `<PageTabs`. (See
`market-scanner.scan-feedback.test.ts`.)

# Scanner enrichment fan-out must be concurrency-capped

The async opportunity decorators (`decorateOpportunitiesWithNewsRisk`,
`...TimingContext`, `...History`) used `Promise.all(uniqueSymbols.map(...))`,
firing one task per symbol with no bound. Replaced with a shared
`mapWithConcurrency(items, ENRICHMENT_CONCURRENCY=8, fn)` worker-pool
(order-preserving) in `marketScanner.ts`. `decorateOpportunitiesWithFinalRead`
is sync (no fan-out). Behavioral test asserts peak in-flight ≤ cap over 250
items + order preserved.

**Why:** read-side resilience only — this caps DB/provider load during a wide
scan without touching execution / gates / brain / EA / bridge / schema.

# Proving the outage banner beyond source-scan

The page can't render headlessly (lightweight-charts), so two complementary
proofs are the pattern — neither requires rendering the real page wholesale:

1. **Dev-only forced-502 injection** to make the failure reproducible. A failure
   toggle that flips both read feeds to a body-less 502 must be gated at
   CALL-TIME (not import-time) so it is inert in prod and a stale armed flag
   stops firing if the env posture flips, and its toggle endpoint must 404 (not
   just deny) where injection isn't allowed. Safe to add ONLY because scanner
   reads are idempotent/read-only — it must never sit on an execution/EA/gate
   path. Drives an authenticated curl/browser E2E.
2. **jsdom render test** that mocks EVERY heavy child + the `safeJson` reader and
   keeps the real banner + degraded-copy module: assert the banner appears on
   the DEFAULT tab when the reads fail and clears on recovery. Force the recovery
   reload via a `visibilitychange` round-trip instead of waiting on the poll
   interval.

**Why:** source-scan locks the banner's *position* (page-scope, above tabs,
exactly once) but not the *behaviour* (502 → banner → recover). The render test
locks the behaviour without fighting the un-renderable children; the injection
makes the same outage reproducible against the live server.
