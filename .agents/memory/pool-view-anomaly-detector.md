---
name: Pool-view anomaly detector idempotency & detection
description: How the Shared Bridge Pool view anomaly detector dedupes alerts and detects "first-time" origins without writing to the audit log.
---

# Shared Bridge Pool view anomaly detector

A scheduled detector raises admin alerts when a brand-new (adminId, ipAddress)
origin opens the Shared Bridge Pool view, or when one admin opens it in a burst.

## Idempotency via alertType encoding
`upsertAlertOnce` dedupes per `(userId, alertType, hourly-bucket)` — the unique
index has exactly three columns and cannot take a 4th. To get one alert *per
distinct anomaly* per recipient per hour, encode the anomaly identity INTO the
alertType string: `pool_view_new_origin:<sha256(adminId|ip)[:12]>` and
`pool_view_burst:<adminId>`. Distinct anomalies then occupy distinct idempotency
slots while still collapsing duplicates within the hour.

**Why:** without identity in the alertType, two different new origins in the same
hour would collide on the bucket and only the first would alert.

## "First-time" detection is read-only
Detect a new origin by querying whether the same `(adminId, ipAddress)` pair
appears in any `admin_action_audit_log` ALLOCATION_POOL_VIEWED row created
*before* the rolling window start. No state table, no writes to the audit log —
the detector is strictly read-only over the audit table (only writes are into
`user_alerts`). After the pair's first occurrence ages out of the window, the
before-window query finds it and it stops being flagged, so the alert naturally
fires once.

## Recipients
All non-system `ADMIN`/`OWNER` users (filter out `isSystemUser`). IPs/emails only
ever land in an admin recipient's own alert row, so non-admins never see them.
