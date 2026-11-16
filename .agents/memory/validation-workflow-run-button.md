---
name: Validation workflow run button
description: Preserve the app's existing run-button behavior when registering named validation commands.
---

After registering a named validation command, inspect `.replit` for changes to the `Project` run-button workflow. Keep the validation task as its own validation workflow and do not let it replace the app's normal run path.

**Why:** The validation registration helper may create a `Project` workflow that runs only the validation command, displacing the app's run-button behavior.

**How to apply:** Check the generated workflow config immediately after registration. If the app run button was redirected, restore its previous behavior using the `.replit` validation-and-replacement flow while retaining the named validation.
