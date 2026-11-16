---
name: `@workspace/domain` uses per-file subpath exports
description: Importing a new symbol from `@workspace/domain` requires adding a file-level subpath in `lib/domain/package.json` exports and importing via that subpath, not the bare package name.
---

`lib/domain/package.json` declares per-file subpath exports (`./safety-contracts/bridgeMode`, `./safety-contracts/reconciliation`, etc.). The top-level `.` entry resolves to `src/index.ts`, which re-exports submodules using `export * as safetyContracts from "./safety-contracts"` — i.e. as a namespace, NOT as flat named exports.

**Consequence:** `import { mySymbol } from "@workspace/domain"` will only work if `mySymbol` is explicitly re-exported as a top-level named binding from `src/index.ts`. For anything inside `safety-contracts/`, this is not the case — you must import from the file subpath.

**How to apply:**
- When adding a new file `lib/domain/src/safety-contracts/foo.ts`:
  1. Add `"./safety-contracts/foo": "./src/safety-contracts/foo.ts"` to the `exports` block in `lib/domain/package.json`.
  2. Import in consumers as `import { fn } from "@workspace/domain/safety-contracts/foo"`.
- Do not rely on the barrel `safety-contracts/index.ts` for cross-package imports — it only helps inside the domain package itself.
- The build will pass `tsc --build` on the libs (because the file resolves directly) but fail leaf-package typecheck (`tsc --noEmit`) with a "no exported member" error — that's the signal you need to switch to the subpath form.
