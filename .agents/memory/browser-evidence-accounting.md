---
name: Browser evidence accounting
description: Browser coverage accounting, observer/locator preflight and durable failure evidence.
---

Layout probes must distinguish settled rendering from transitional or native
hidden content, and measure the real fixed-position containing block.

**Why:** Native closed details can retain child rectangles, entering sheets can
be visible while still off-screen, and normal-flow body bounds do not clip
viewport-fixed portals. Treating these as layout failures produced false
positives before real overlapping controls were isolated.

**How to apply:** Use native visibility checks, await finite animations, retain
strict viewport/clipping checks, and verify control centers by hit testing.
For focus-ring comparisons, capture an actually unfocused baseline; modal
autofocus may otherwise make a correctly visible ring appear unchanged. Include
portaled controls: ancestor-scoped CSS variables do not cross portal boundaries.

Inspect an imported probe's internal viewport matrix before wrapping it. Run
each defined probe once unless repetition is deliberate, and distinguish
viewport-qualified coverage from repeated executions of the same whole probe.

**Why:** An upstream Scanner probe already visited desktop and mobile internally.
An outer repetition inflated a tester's claimed distinct coverage, and a summary
also retained a stale count after a corrected continuation.

**How to apply:** Audit raw assertion receipts and final corrected continuations,
not only prose summaries. Retain original failures and superseded reports;
publish unique coverage, repeated executions and incomplete checks separately.

Viewport evidence must record actual layout, stored preferences, selected
controls and scroll offset. Do not infer default state from a screenshot name.

**Why:** A multi-chart screenshot was misreported as a default single-chart
control-order failure. A targeted state-correct observation confirmed the
single-chart order while retaining the separate partial-visibility limitation.

**How to apply:** Preserve the original diagnosis and corrected receipts.
Distinguish geometric viewport intersection, unobscured visibility, whole-plot
fit and source-correct completion latency; none automatically proves the others.

Browser-exposed fixture readers are asynchronous, and assistant welcome cards
can disappear on the first send. Do not treat exposed readers as synchronous
arrays or identify a fresh reply by a stable count of all DOM children.
Identical refusals from different panes are still fresh replies; text novelty
alone cannot distinguish a new response from an old one.

**Why:** Promise-array predicates and unstable welcome-card child indexing
repeatedly stopped browser probes before their intended acceptance cases.

**How to apply:** Await exposed readers inside browser predicates; synchronize
replies by stable message identity or role-qualified fresh DOM nodes, not a phrase
anywhere in old history or text absent from previous replies. Repeating a valid
local chart request can legitimately produce identical reply text, so text
novelty cannot prove freshness. If message identity is unavailable, compare
per-text occurrence counts rather than total bubble counts or unique wording.
Preserve assertion counts separately from failed
steps and unstarted cases, and capture full error messages incrementally.

Preflight generated probes against the existing observer contract and rendered
markup. Compare numeric presentation semantically at its disclosed precision,
without weakening expected geometry, source or visibility requirements.

**Why:** Contract, locator-scope and formatting assumptions can stop acceptance
before the intended behavior is exercised. Capturing screenshots only after
success also leaves those failures without visual evidence.

**How to apply:** Inspect the actual reader/markup/formatter before a bounded
run. Persist source/runtime identity, stage, DOM, screenshots and network/error
records in failure cleanup as well as on success. Keep corrected programs and
attempts separate; an interrupted flow stays incomplete, not a feature pass.

When extending an accepted synthetic fixture, preserve its complete evidence
envelope and validate the tool's qualification contract before browser launch.
Exact installed candles alone do not prove that local analysis is qualified.
Fresh-reply detection must also observe refusals, not wait only for success text.

**Why:** A replacement ownership fixture omitted the source from its evidence
envelope while preserving prices and identity. The application correctly refused
analysis, but a success-only reply predicate reported that refusal as a timeout.
Changing viewport or fitting history could not repair the missing evidence.

**How to apply:** Diagnose retained reply/DOM evidence before another attempt.
Separate "a fresh reply arrived" from "the reply accepted the request"; preserve
the failed attempts and correct the fixture rather than weakening source gates.

Use standalone acceptance modules rather than nested string-replacement
correction wrappers. Exercise the actual parser and observer-shape adapter in
offline self-checks before launching the browser.

**Why:** Nested wrappers repeatedly failed on escaped replacement anchors and
directory rewrites before reaching the intended flow. A materialized program
made the fixture and pixel-versus-price contract inspectable, and completed the
same acceptance without changing application behavior.

**How to apply:** Keep old programs immutable, write a new standalone program,
pin its bytes in the receipt, and separate numeric price precision from rendered
pixel alignment tolerance. Do not repair a failing geometry check by accepting
receipt wording alone.

For outcome-sign acceptance, construct an exact-zero cost scenario from the
full-precision exported ledger, never from rounded table text or a tolerance.
Keep incidental assistant bootstrap writes distinct from local answer traffic;
diagnosing a blocked write does not make it approved background traffic.

**Why:** Rounded displayed P&L left a genuinely positive residual that the
assistant correctly called positive. Opening the panel also attempted remote
conversation creation even though the historical reply itself was local.

**How to apply:** Assert zero exactly on the calculated result, preserve
failed sign assumptions, and report strict allowlist failure separately from
successful offline containment. Never broaden the allowlist to obtain a pass.
