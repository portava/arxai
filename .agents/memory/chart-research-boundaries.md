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
Missing optional source identity or volume provenance must remain unavailable.
Report source/runtime mismatch and obtain separate authorization before
refreshing the API or claiming its new source is active.
