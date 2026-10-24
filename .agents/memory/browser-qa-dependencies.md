---
name: Browser QA dependencies
description: Restore declared browser-test dependencies in a fresh nested workspace checkout.
---

When a `scripts` browser test reports missing Playwright or Vite, verify the dependency is declared and install the scripts package's existing lockfile dependencies with a filtered frozen install; do not edit package manifests just to repair a fresh checkout.

**Why:** The nested ARX workspace had those dependencies in its package manifest and lockfile, but they were not linked into its local `node_modules`.

**How to apply:** Before treating a browser QA failure as a code problem, check for the package in the nested workspace install and restore only the relevant workspace package dependencies.

For browser tests that sign in multiple times, give the test API requests a unique forwarded client IP and trust only the local proxy hop. The login cooldown is persisted by IP in the database, so repeated runs from loopback can throttle one another.

**Why:** A database-backed login cooldown outlives the test process; a fixed loopback IP made otherwise isolated fixtures share rate-limit state across runs.

**How to apply:** Keep the unique proxy identity and trust setting confined to the local test server; never loosen proxy trust in the production app.
