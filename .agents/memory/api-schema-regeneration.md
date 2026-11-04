---
name: API schema regeneration
description: Keep OpenAPI-generated contract updates focused when using the workspace code generator.
---

After changing the root OpenAPI contract, regenerate the schemas and inspect all generated-file diffs. The installed Orval version can rewrite unrelated React Query client formatting as well as the intended API schema; preserve the contract change but avoid broad unrelated churn.

**Why:** The installed generator version and checked-in generated-file headers/styles differed, so regeneration rewrote the unrelated client module even though only the health response schema changed.

**How to apply:** For future root API contract changes, run the configured codegen, verify generated types, and review the complete diff before retaining any generated output.

Generator compatibility is also a runtime-schema concern, not just formatting.
Do not accept an SDK-wide rewrite for a small additive contract change.

**Why:** The installed generator can emit newer Zod APIs than the current schema
package supports, alongside unrelated client changes. A failed regeneration
does not justify replacing working request or cancellation behavior.

**How to apply:** Prefer isolated generation with a compatible schema target.
Retain the failed output as evidence, reconcile only the generated contract
delta when broader output is incompatible, and typecheck both generated
packages and their consumers. Report the regeneration failure separately.
