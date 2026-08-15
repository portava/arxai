// Lazy re-export so `eventLogDbTest` can import `@workspace/db` only AFTER it
// has confirmed DATABASE_URL is set. The db package throws at import time
// without it, which would defeat the self-skip the offline CI lane relies on.
export { db } from "@workspace/db";
export { sql } from "drizzle-orm";
