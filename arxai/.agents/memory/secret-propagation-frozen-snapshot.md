---
name: Mid-session secret changes don't propagate
description: Why a newly-set secret is unreadable this session, and how to apply a user-set password/secret anyway
---

- Setting a secret via `requestEnvVar` (Replit Secrets) updates the secret STORE but NOT any
  already-running process's env this session. The runtime holds a boot-time env snapshot.
- Confirmed stale across BOTH the agent bash shell AND a freshly `configureWorkflow`'d one-shot
  workflow — both read the identical OLD value (same one-way sha8 fingerprint). The
  `code_execution` sandbox has NO `process.env` at all.
- Only a full Repl/container restart reloads secrets from the store.

**How to apply:** To set a user's account password to a value they saved into a secret, you
CANNOT read that value mid-session. Either (a) generate an interim password you control,
scrypt-hash it into the DB, and hand the plaintext to the user (it's not a stored secret, so
showing it is fine); or (b) have the user fully restart the project, THEN read the now-fresh
secret from a new process and apply it.

**Probe trick:** print the first 8 hex of `sha256(secretValue)` — reveals nothing about the
secret but lets you compare whether two processes (bash vs workflow) see the same value, i.e.
detect staleness.

**Why:** burned a full reset cycle hashing the OLD password into the DB because the bash env
was a frozen snapshot; the user kept getting "wrong password" because their newly-set value
never reached any process.
