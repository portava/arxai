# ARX Broker Credential Boundary — Phase 0B

**Status:** Approved design boundary for Phase 0B metadata only (2026-08-19).

## Decision

Phase 0B stores **no credential reference**. It contains no plaintext, ciphertext,
encrypted payload, OAuth state, nonce, PKCE verifier, refresh token, API key,
session cookie, bridge token, token hash, or provider credential metadata.

The new broker-hub tables may describe an owner, venue, native connection/account
references, normalized health/discovery status, and timestamps only. Existing MT5
bridge-token handling remains authoritative and is not read, copied, or referenced
by this model.

## Required later security review

Before a credential reference is introduced, a separate approved security slice
must define a vault-owned opaque reference, encryption/key ownership, OAuth
state/nonce/PKCE lifecycle, redaction and serializer allowlists, consent/scope
validation, rotation/revocation, audit events, access control, retention, and
incident handling. That slice must prove ordinary API serializers cannot expose
credential material.

## Phase 0B safety consequence

Because no credentials, handshake, or adapter connection flow exists here,
connection metadata cannot represent an enabled broker venue. Metadata endpoints
remain feature-flagged off and all trading, automation, and live capability fields
are permanently false in this phase.