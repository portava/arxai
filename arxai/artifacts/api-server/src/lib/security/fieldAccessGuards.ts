// AACI Security Foundation — role + field-level access composition.
//
// Composes the PURE domain field-access decisions with this app's auth context.
// The permission TABLES remain authoritative for actions (checkPermission);
// this is the narrower "may this caller SEE this field" projection used to keep
// a caller from reading another user's (or a higher-role-only) fields.

import { security } from "@workspace/domain";

export type FieldPolicyMap = Record<string, security.FieldPolicy>;

export interface ViewerContext {
  role: string | null | undefined;
  userId: number | null | undefined;
}

/**
 * Project a single record for a viewer. `ownerUserId` is the user that owns the
 * row (null for non-user-scoped records). Denied fields are masked or omitted
 * per their policy.
 */
export function projectRecordForViewer<T extends Record<string, unknown>>(
  record: T,
  policies: FieldPolicyMap,
  viewer: ViewerContext,
  ownerUserId: number | null | undefined,
): { record: Partial<T>; deniedFields: string[] } {
  return security.filterRecordFields(record, policies, {
    viewerRole: viewer.role,
    viewerUserId: viewer.userId,
    ownerUserId,
  });
}

/** Project a list of records, each owned by the same `ownerUserId` resolver. */
export function projectListForViewer<T extends Record<string, unknown>>(
  records: T[],
  policies: FieldPolicyMap,
  viewer: ViewerContext,
  ownerUserIdOf: (record: T) => number | null | undefined,
): Partial<T>[] {
  return records.map(
    (r) => projectRecordForViewer(r, policies, viewer, ownerUserIdOf(r)).record,
  );
}

/** Quick check: may this viewer read a single field under a policy? */
export function canViewField(
  policy: security.FieldPolicy,
  viewer: ViewerContext,
  ownerUserId: number | null | undefined,
): boolean {
  return security.resolveFieldAccess(policy, {
    viewerRole: viewer.role,
    viewerUserId: viewer.userId,
    ownerUserId,
  }).allowed;
}
