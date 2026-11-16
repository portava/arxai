---
name: Package firewall baseline
description: Preserve source fidelity while handling historical dependency downloads rejected by the environment.
---

Keep environment-required dependency adjustments narrow and disclose them separately from application logic changes. Do not bypass package download protections to recreate an old lockfile.

**Why:** The imported lockfile had stale override metadata, and two historical package downloads were rejected by the environment's package firewall. A reproducible frozen install required reconciliation plus targeted parent-package upgrades.

**How to apply:** Distinguish the source commit from the locally installed dependency baseline. When comparing upstream fidelity, audit dependency manifests and lockfiles separately; do not describe the import as byte-for-byte unchanged.
