---
name: Browser QA dependencies
description: Restore declared browser-test dependencies in a fresh nested workspace checkout.
---

When a `scripts` browser test reports missing Playwright or Vite, verify the dependency is declared and install the scripts package's existing lockfile dependencies with a filtered frozen install; do not edit package manifests just to repair a fresh checkout.

**Why:** The nested ARX workspace had those dependencies in its package manifest and lockfile, but they were not linked into its local `node_modules`.

**How to apply:** Before treating a browser QA failure as a code problem, check for the package in the nested workspace install and restore only the relevant workspace package dependencies.
