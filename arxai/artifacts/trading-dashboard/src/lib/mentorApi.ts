// Shared mentor-session reads for AI Mentor and the Command Center Chat tab.
//
// Both pages read the same endpoints through one React Query cache, so they
// must agree on what a cache entry means: a non-2xx response is an error
// (never cached as data that looks like "no session yet"), and a history page
// fetched with one ?limit= is never shown as if it had been fetched with
// another.

/** Reads a mentor API response and throws on a non-2xx status. */
export async function readMentorJson<T>(r: Response, action: string): Promise<T> {
  let body: unknown = null;
  try { body = await r.json(); } catch { body = null; }
  if (!r.ok) {
    const err = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : null;
    throw new Error(`${action} failed (HTTP ${r.status}${err ? `: ${err}` : ""})`);
  }
  return body as T;
}

export const MENTOR_LATEST_QUERY_KEY = ["mentor-latest"] as const;

/** History is keyed by its page size; invalidating ["mentor-history"] still matches every size. */
export function mentorHistoryQueryKey(limit: number) {
  return ["mentor-history", limit] as const;
}
