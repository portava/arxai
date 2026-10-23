// Investor statement file helpers (Task #82).
//
// SAFETY:
// - Access control for serving uploaded statement files is enforced by the
//   CALLER via per-user DB scoping (the statement row is looked up scoped to
//   the requesting investor, or admin-gated). This helper only streams a known
//   object path; it NEVER decides who may read it.
// - Uploaded files live in object storage under "/objects/...". External link
//   URLs (http/https) are NOT served here — the UI links to them directly.
// - On upload we also stamp a private owner ACL on the object as
//   defence-in-depth, but DB scoping is the authoritative gate.

import type { Request, Response } from "express";
import { Readable } from "stream";
import { and, eq, ne, sql } from "drizzle-orm";
import { db, investorStatementsTable } from "@workspace/db";
import { ObjectStorageService, ObjectNotFoundError } from "../objectStorage.js";

export const objectStorageService = new ObjectStorageService();

/** Hard cap on uploaded statement file size. Protects storage + downloads. */
export const MAX_STATEMENT_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

/**
 * Content types accepted for uploaded statement files. The admin UI uploads
 * with a normalized PDF/CSV content type; this slightly broader set also
 * tolerates the common CSV MIME variants brokers/Excel emit, while still
 * rejecting anything that is not a PDF or CSV.
 */
export const ALLOWED_STATEMENT_CONTENT_TYPES: ReadonlyArray<string> = [
  "application/pdf",
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
];

export type StatementFileValidationError =
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_FILE_TYPE"
  | "FILE_NOT_FOUND"
  | "METADATA_READ_FAILED";

export type StatementFileValidationResult =
  | { ok: true }
  | { ok: false; code: StatementFileValidationError; message: string };

/** True when fileUrl points at an uploaded object (vs an external link). */
export function isUploadedObjectPath(fileUrl: string | null | undefined): boolean {
  return typeof fileUrl === "string" && fileUrl.startsWith("/objects/");
}

/**
 * True when fileUrl is an INTERNAL object-storage path we own and serve through
 * the guarded statement routes — as opposed to an external http(s) link the UI
 * opens directly. Alias of {@link isUploadedObjectPath} under the lifecycle
 * vocabulary used by the file-serving guards and cleanup helpers.
 */
export function isInternalObjectUrl(fileUrl: string | null | undefined): boolean {
  return isUploadedObjectPath(fileUrl);
}

/**
 * Canonicalise an internal object reference for comparison/reference-counting:
 * trims surrounding whitespace and returns the `/objects/...` path. Returns
 * `null` for anything that is not an internal object URL (external links,
 * empty/nullish values), so callers can cheaply skip non-owned references.
 */
export function normalizeObjectPath(fileUrl: string | null | undefined): string | null {
  if (typeof fileUrl !== "string") return null;
  const trimmed = fileUrl.trim();
  return trimmed.startsWith("/objects/") ? trimmed : null;
}

/**
 * Count how many investor-statement rows still reference a given internal
 * object path, OPTIONALLY excluding one statement id (the one being edited).
 *
 * "Active reference" here means any live row in `investor_statements` that
 * still points at the object — regardless of lifecycle status. A soft-REMOVED
 * statement is restorable and must keep its file; REPLACED/SUPERSEDED rows are
 * historical records that still legitimately reference their file. So ANY
 * remaining row referencing the object is a reason NOT to delete it. Returns 0
 * for external links / empty paths (nothing we own to reference-count).
 */
export async function countActiveReferencesToObject(
  fileUrl: string | null | undefined,
  excludeStatementId?: number,
): Promise<number> {
  const path = normalizeObjectPath(fileUrl);
  if (path === null) return 0;
  const whereClause =
    typeof excludeStatementId === "number"
      ? and(
          eq(investorStatementsTable.fileUrl, path),
          ne(investorStatementsTable.id, excludeStatementId),
        )
      : eq(investorStatementsTable.fileUrl, path);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(investorStatementsTable)
    .where(whereClause);
  return row?.n ?? 0;
}

function humanBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/**
 * Validate a freshly uploaded statement object against the size cap and the
 * allowed PDF/CSV content types. The presigned PUT bypasses the API, so the
 * ONLY reliable enforcement point is here — at publish/edit time — by reading
 * the stored object's metadata. External-link statements (and empty fileUrls)
 * are a no-op: they carry no object we control.
 */
export async function validateStatementFileObject(
  req: Request,
  fileUrl: string | null | undefined,
): Promise<StatementFileValidationResult> {
  if (!isUploadedObjectPath(fileUrl)) return { ok: true };

  let metadata: { size?: string | number | null; contentType?: string | null };
  try {
    const objectFile = await objectStorageService.getObjectEntityFile(fileUrl as string);
    [metadata] = await objectFile.getMetadata();
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      return {
        ok: false,
        code: "FILE_NOT_FOUND",
        message: "The uploaded file could not be found. Please upload it again.",
      };
    }
    req.log.error({ err }, "Could not read uploaded statement file metadata");
    return {
      ok: false,
      code: "METADATA_READ_FAILED",
      message: "Could not verify the uploaded file. Please try again.",
    };
  }

  const size = Number(metadata.size ?? 0);
  if (Number.isFinite(size) && size > MAX_STATEMENT_FILE_BYTES) {
    return {
      ok: false,
      code: "FILE_TOO_LARGE",
      message: `File is too large (${humanBytes(size)}). The maximum is ${humanBytes(
        MAX_STATEMENT_FILE_BYTES,
      )}.`,
    };
  }

  const contentType = (metadata.contentType ?? "").toString().split(";")[0].trim().toLowerCase();
  if (!ALLOWED_STATEMENT_CONTENT_TYPES.includes(contentType)) {
    return {
      ok: false,
      code: "UNSUPPORTED_FILE_TYPE",
      message: "Only PDF or CSV files are allowed.",
    };
  }

  return { ok: true };
}

/**
 * Stamp a private, owner-scoped ACL on a freshly uploaded statement object.
 * Best-effort: a failure here never blocks publishing — the authoritative
 * access gate is the per-user DB lookup on the download route.
 */
export async function setStatementFileAcl(
  req: Request,
  fileUrl: string | null | undefined,
  ownerUserId: number,
): Promise<void> {
  if (!isUploadedObjectPath(fileUrl)) return;
  try {
    await objectStorageService.trySetObjectEntityAclPolicy(fileUrl as string, {
      owner: String(ownerUserId),
      visibility: "private",
    });
  } catch (err) {
    req.log.warn({ err }, "Could not set ACL on investor statement file");
  }
}

/**
 * Best-effort cleanup of an uploaded statement object that has become orphaned
 * (e.g. a statement was edited to point at a different file or an external
 * link, leaving the previously uploaded object referenced by nothing). NEVER
 * throws and NEVER blocks the user-facing action — a failure is logged only.
 * External-link statements (and empty fileUrls) are a no-op: there is no
 * object we control. A missing object is treated as success (already gone).
 *
 * NOTE: this is deliberately NOT called on statement removal. Removal is a
 * reversible soft-delete (status → REMOVED, restorable to ACTIVE), and the row
 * still references the file, so the object is not orphaned and must survive a
 * later restore.
 */
export async function deleteStatementFileObject(
  req: Request,
  fileUrl: string | null | undefined,
): Promise<void> {
  if (!isUploadedObjectPath(fileUrl)) return;
  try {
    await objectStorageService.deleteObjectEntity(fileUrl as string);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return;
    req.log.warn({ err }, "Could not delete orphaned investor statement file");
  }
}

/**
 * Reference-aware, idempotent cleanup of a statement object that *may* have
 * become orphaned (e.g. a statement was edited to point at a different file or
 * an external link, OR a freshly uploaded object was rejected by validation at
 * publish/edit time before it was ever persisted). This is the safe variant the
 * edit and publish paths must use instead of the raw
 * {@link deleteStatementFileObject}.
 *
 * Guarantees (all required by the storage-integrity contract):
 * - NEVER deletes an external link or empty path (no-op for non-internal URLs).
 * - NEVER deletes an object still referenced by ANOTHER statement row — the
 *   reference count (optionally excluding the statement being edited) is checked
 *   first, so a file shared by a second active/soft-removed/historical statement
 *   survives. On publish (no statement persisted yet) `excludeStatementId` is
 *   omitted, so ANY existing row referencing the object protects it.
 * - Idempotent and NEVER throws: a missing object is treated as success and any
 *   storage error is logged, never propagated, so the user-facing action is
 *   never blocked.
 *
 * Returns a small outcome tag for callers/tests that want to assert the branch
 * that was taken without inspecting storage.
 */
export async function safelyDeleteUnreferencedStatementObject(
  req: Request,
  fileUrl: string | null | undefined,
  excludeStatementId?: number,
): Promise<"skipped_external" | "skipped_referenced" | "deleted"> {
  if (!isInternalObjectUrl(fileUrl)) return "skipped_external";
  const refs = await countActiveReferencesToObject(fileUrl, excludeStatementId);
  if (refs > 0) {
    req.log.info(
      { fileUrl, refs, excludeStatementId },
      "Skipping statement object cleanup — still referenced by another statement",
    );
    return "skipped_referenced";
  }
  await deleteStatementFileObject(req, fileUrl);
  return "deleted";
}

/**
 * Stream an uploaded statement file to the response. The CALLER must already
 * have authorised access to this statement (per-user scoped or admin-gated).
 * Falls back to 404 for external-link statements (served directly by the UI).
 */
export async function streamStatementFile(
  req: Request,
  res: Response,
  fileUrl: string | null | undefined,
): Promise<void> {
  if (!isUploadedObjectPath(fileUrl)) {
    res
      .status(404)
      .json({ ok: false, error: "NOT_FOUND", message: "No uploaded file for this statement." });
    return;
  }
  try {
    const objectFile = await objectStorageService.getObjectEntityFile(fileUrl as string);
    const response = await objectStorageService.downloadObject(objectFile);
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (response.body) {
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ ok: false, error: "NOT_FOUND", message: "File not found." });
      return;
    }
    req.log.error({ err }, "Error serving investor statement file");
    res.status(500).json({ ok: false, error: "READ_FAILED", message: "Could not serve file." });
  }
}
