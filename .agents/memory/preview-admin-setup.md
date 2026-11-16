---
name: Preview admin setup approval
description: Scope of the user's authorization to enable admin bootstrap from existing Secrets.
---

The user explicitly approved enabling preview admin setup using existing admin Secrets. This approval does not include production bootstrap or live trading.

**Why:** Admin sign-in was blocked because baseline-validation launch restrictions also prevented preview admin provisioning. The user approved the preview-only change after its privileged-account effect was explained.

**How to apply:** Preserve the approved preview behavior when adjusting launch restrictions. Do not extend it to production, overwrite an existing account password, or enable live trading without separate authorization.
