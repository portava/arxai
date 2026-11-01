---
name: Chart research integration boundaries
description: Extend existing authorities while keeping API activation and unsupported evidence explicitly deferred.
---

Add missing capabilities to the existing Smart Chart, assistant, Truth and
historical research systems; do not duplicate or rebuild them.

**Why:** The owner explicitly requested additions to existing systems, not a
replacement or parallel authority.

**How to apply:** Reuse the existing calculator, source evidence, research engine
and overlay renderer. Keep unsupported language, insufficient history and
missing original evidence unavailable rather than guessing.

Development source synchronization does not authorize API activation. Preserve
the existing API process, its built bundle and service settings; validate API
builds in a separate output directory.

**Why:** The owner repeatedly authorized source-only updates while explicitly
deferring API and operational-worker activation.

**How to apply:** Frontend/shared-domain code can be newer than the running API.
Missing optional source identity, volume provenance or original price-basis
declarations must remain unavailable.
Report source/runtime mismatch and obtain separate authorization before
refreshing the API or claiming its new source is active.

Original candle-price-basis evidence must come from the producer's observation,
not a provider name or asset profile. Importing EA source that observes chart
mode does not establish that the running producer has been installed or verified.

**Why:** The owner prohibited manufacturing declarations or treating synthetic
fixtures/source imports as broker acceptance; EA installation is separately
restricted.

**How to apply:** Keep candles visible, qualify only original evidence, withdraw
current research markers/explanations when it disappears, and treat any producer
upgrade or real-provider acceptance as separately authorized work.

No current production adapter qualifies original historical UTC. ISO formatting
and today's broker offset cannot establish past UTC mapping. Keep prices visible
while historical research and timezone conversion remain held without authority.

**Why:** The owner explicitly identified broker-clock chart coordinates and
required original authority rather than inferred UTC.

**How to apply:** Preserve source-coordinate disclosures across chart, reader,
replay and archived analysis. An audited adapter and its original evidence path
require separate qualification; client claims or EA price-basis declarations
cannot supply clock authority.
