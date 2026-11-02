---
name: Preview verification account scope
description: Least-privilege requirements for ARX development-preview QA accounts.
---

Create development-preview verification accounts only through ARX's normal signup, approval, and authentication flow, with standard dashboard access. Do not attach brokers, real funds, access to existing users' information, or live execution. Do not reset existing account passwords, change existing permissions, or bypass authentication.

**Why:** The owner specified this boundary to isolate visual and interaction verification from existing accounts and trading.

**How to apply:** Use the normal access-request and invite process; issue only a standard USER invitation. Use honest empty states unless fixtures are confined to a separate test environment.
