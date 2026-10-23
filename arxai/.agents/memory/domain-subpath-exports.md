---
name: @workspace/domain uses per-file subpath exports
description: Domain safety-contracts must be imported via subpath, not from the package root.
---

Rule: import safety-contract helpers as `@workspace/domain/safety-contracts/<file>`, not `@workspace/domain`. New helpers must be added to `lib/domain/package.json` `exports` map before they can be imported.

**Why:** `lib/domain` deliberately uses per-file subpath exports (no barrel) so each contract has an explicit, greppable import path and tree-shaking stays trivial. A bare `@workspace/domain` import will resolve to nothing.

**How to apply:** After creating a new `lib/domain/src/safety-contracts/foo.ts`, add a matching entry to the `exports` map in `lib/domain/package.json`, then re-run `pnpm run typecheck:libs` before importing.
