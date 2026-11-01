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

Repository-wide static guards must run from the verified application repository
root, with their scan paths present. A package-directory result is not a
substitute for a failed root run.

**Why:** Cwd-relative scans silently treated missing paths as passing checks,
concealing wording findings while the same implementations failed at the root.

**How to apply:** Record cwd, exit status, coverage and per-guard findings.
Retain false-pass diagnostics without calling them acceptance, and never change
cwd or scan semantics merely to obtain green output.

Dist hashes alone cannot establish unchanged runtime behavior when a frontend
dev server reads mutable source. Inspect the actual process mode, cwd and loaded
configuration before applying any source-only import, not just startup scripts.

**Why:** An existing Vite dev process served the edited tree while dist hashes
remained identical. The no-explicit-restart claim was true but insufficient for
the user's no-visible-change boundary.

**How to apply:** For backup-only work, integrate in an unwatched checkout or
worktree. If source watching is discovered after edits, stop further application
changes, report possible HMR exposure and distinguish API/dist preservation from
unverified frontend visibility. Do not automatically roll back watched files.
