---
name: Source-only validation boundaries
description: Isolated bundles do not guarantee that typechecks leave existing output directories byte-identical.
---

For source-only validation, inspect both bundle output paths and incremental
typecheck-cache paths before promising unchanged output directories. Keep
executable runtime preservation distinct from compiler-metadata preservation.

**Why:** An isolated API build preserved its executable bundle and process, but a
TypeScript check updated an incremental cache inside the existing output tree.
The complete-directory checksum therefore genuinely failed even though runtime
assets stayed unchanged.

**How to apply:** Isolate validation outputs and caches where the authorized
checks permit it. Retain full-directory comparisons and disclose metadata
exceptions separately; never silently exclude a changed file and call the
original whole-directory check a pass. Do not restore metadata merely to conceal
a validation side effect or infer a service restart from a cache change.

Offline network guards must preserve compiler Unix-domain IPC while blocking
TCP. Printed passing assertions and process exit status are separate evidence.

**Why:** A loader's normalized socket arguments can hide a Unix-domain path
inside an array. Blocking that IPC produced a failed command after every guard
and binding assertion had already printed a pass.

**How to apply:** Inspect normalized arguments without broadly permitting
localhost networking. Retain the failed exit and corrected run separately;
never convert printed passes into a successful command retrospectively.
