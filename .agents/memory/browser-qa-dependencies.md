---
name: Browser QA dependencies
description: Dependency/browser-runtime preflight, long isolated journeys and database-backed login test isolation.
---

When a `scripts` browser test reports missing Playwright or Vite, verify the dependency is declared and install the scripts package's existing lockfile dependencies with a filtered frozen install; do not edit package manifests just to repair a fresh checkout.

**Why:** The nested ARX workspace had those dependencies in its package manifest and lockfile, but they were not linked into its local `node_modules`.

**How to apply:** Before treating a browser QA failure as a code problem, check for the package in the nested workspace install and restore only the relevant workspace package dependencies.

For browser tests that sign in multiple times, give the test API requests a unique forwarded client IP and trust only the local proxy hop. The login cooldown is persisted by IP in the database, so repeated runs from loopback can throttle one another.

**Why:** A database-backed login cooldown outlives the test process; a fixed loopback IP made otherwise isolated fixtures share rate-limit state across runs.

**How to apply:** Keep the unique proxy identity and trust setting confined to the local test server; never loosen proxy trust in the production app.

Long portable offline journeys can run through an owned Node/Playwright process instead of one whole-action browser-tool evaluation. Check for an installed system Chromium when Playwright's expected cached binary is absent before changing dependencies.

**Why:** A whole-action tool deadline can discard a long journey's results even though its individual browser operations work. The existing Playwright package and system Chromium can execute the original portable journey without installing packages or weakening assertions.

**How to apply:** Use a sanitized environment, the same blocked-network fixture boundary, immutable journey hashes, durable start/result/terminal files and an explicit outer deadline. Record the actual browser and CPU conditions; close only owned browsers and fixture servers. Do not turn functional results into navigation or physical-paint claims.
