---
name: Imported baseline provenance
description: Why the upstream remote is separate from the Replit checkpoint repository.
---

Keep upstream source history separate from the Replit workspace checkpoint history. Do not push the workspace branch directly over the upstream application's branch.

**Why:** The full application was imported beneath the existing scaffold to preserve its layout. During workspace registration, the nested clone metadata was no longer present; upstream history was fetched into a separate named remote without replacing the workspace repository. The workspace and upstream have different root layouts.

**How to apply:** Treat the upstream remote as provenance/read-only until an explicit source synchronization workflow is designed. Compare the prefixed application against upstream rather than assuming workspace HEAD is an upstream application commit.

Joining the histories does not make their repository roots equivalent. Keep the
application-root mapping explicit in later merges, and check dependencies that
are unchanged on the incoming feature branch but absent from the workspace.

**Why:** A feature-range merge can apply cleanly while retaining an older local
dependency interface; adopting a source owner can also require its matching
contracts and helpers. Git ancestry alone does not establish source compatibility.

**How to apply:** Preserve a recovery reference, reconcile mapped trees, restore
required dependencies from the same reviewed source, and use compilation and
scoped regressions to confirm the combination rather than inventing adapters.

For an authorized exact-source development sync, use the last actually imported source snapshot as the reconciliation base and map both source trees beneath the nested application root. Do not infer the base from workspace Git ancestry or silently combine other branches.

**Why:** The combined upstream integration can diverge from the previously imported source branch while the workspace also contains independent authentication, test-isolation and environment fixes. Replacing the source tree or using the workspace's unrelated ancestry would discard those fixes.

**How to apply:** Keep a pre-update backup reference, audit local differences before and after reconciliation, and record the exact source and validation limitations in the update report.

For selective feature imports, audit the complete feature dependency set rather
than selecting only obvious component filenames. Matching source-owned test
metadata and legacy status indicators can be required even when package versions
are unchanged.

**Why:** A component-only chart selection omitted catalogue/scope metadata and a
shared status-header change; existing regression checks correctly rejected the
incomplete combination.

**How to apply:** Preserve initial failures, bring only the missing dependencies
from the same verified source, and rerun the affected checks without weakening
assertions or importing unrelated backend work.
