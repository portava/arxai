---
name: Imported baseline provenance
description: Why the upstream remote is separate from the Replit checkpoint repository.
---

Keep upstream source history separate from the Replit workspace checkpoint history. Do not push the workspace branch directly over the upstream application's branch.

**Why:** The full application was imported beneath the existing scaffold to preserve its layout. During workspace registration, the nested clone metadata was no longer present; upstream history was fetched into a separate named remote without replacing the workspace repository. The workspace and upstream have different root layouts.

**How to apply:** Treat the upstream remote as provenance/read-only until an explicit source synchronization workflow is designed. Compare the prefixed application against upstream rather than assuming workspace HEAD is an upstream application commit.
