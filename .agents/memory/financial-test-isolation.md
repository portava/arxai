---
name: Financial test isolation
description: Keep financial integration checks independent of shared development seed data.
---

Financial tests should create dedicated users and pools and clean up only those fixtures. Do not temporarily change canonical investment pools merely to test NAV or tier transitions.

**Why:** A fresh development schema may have no canonical pools or low-numbered users. Reusing shared financial records also risks contaminating balances and append-only ledgers when a test crashes.

**How to apply:** Give new database-backed financial checks explicit fixture ownership, zero-capital starting state, and cleanup in `finally`. Keep risk thresholds and no-live-command assertions intact; never seed live access just to satisfy a foreign key.
