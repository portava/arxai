import { pool } from "@workspace/db";
import { createDependencyReadiness } from "./dependencyReadiness.js";

// Fixed read-only statement. No account/position reads or control writes.
const query = { text: "select 1", query_timeout: 1_500 };
export const checkDatabaseReadiness = createDependencyReadiness(() => pool.query(query));
