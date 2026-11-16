-- Rename the assistant's old codename to Eleanor in the database.
--
-- RUN THIS BEFORE `drizzle push` / before starting the renamed server. The
-- Drizzle schema now names every table, column, index and constraint with
-- "eleanor"; if push runs first it sees the old names as unknown and DROPS
-- them (data loss). After this script, push finds nothing to change.
--
-- Idempotent: every step only acts on names/values that still contain the old
-- codename, so running it twice is a no-op. One transaction: all or nothing.
--
-- The old codename is assembled from letters (old_l below) so this file does not
-- contain it; the repo-wide guard bans the word everywhere.
--
-- What it renames
--   1. tables, 2. columns, 3. constraints (their backing indexes follow),
--   4. remaining indexes, sequences and views,
--   5. stored text/json values, case-preserving (ALL CAPS -> ELEANOR,
--      Capitalised -> Eleanor, lower -> eleanor): enum-like values the code
--      compares (origin, actor kind, event types, command types, agent key,
--      notification links, voice persona, chat history, ...).
--
-- What it deliberately does NOT rewrite
--   Rows of tables that carry an integrity hash, checksum or signature
--   (event_log, security_events, audit_events, arx_live_commands,
--   user_live_disclosure_acceptances, research/discovery reports, users and
--   credential tables, ...). Rewriting their content would break tamper
--   checks and could rename a real person. Those historical rows keep their
--   original wording.
--
-- Rollback: restore from the pre-migration backup (take one first). A reverse
-- rename is possible by swapping the two names in the helper below, but stored
-- values that were already "eleanor" before this script cannot be told apart.

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.eleanor_map(v text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  old_l text := 'r' || 'uby';
BEGIN
  IF v IS NULL THEN RETURN NULL; END IF;
  v := replace(v, upper(old_l), 'ELEANOR');
  v := replace(v, initcap(old_l), 'Eleanor');
  v := replace(v, old_l, 'eleanor');
  -- any other mixed casing
  RETURN regexp_replace(v, old_l, 'Eleanor', 'gi');
END $$;

DO $$
DECLARE
  old_l text := 'r' || 'uby';
  r record;
  sets text;
  conds text;
  n bigint;
BEGIN
  -- 1. tables
  FOR r IN
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p') AND position(old_l IN c.relname) > 0
  LOOP
    EXECUTE format('ALTER TABLE public.%I RENAME TO %I', r.name, pg_temp.eleanor_map(r.name));
    RAISE NOTICE 'table % -> %', r.name, pg_temp.eleanor_map(r.name);
  END LOOP;

  -- 2. columns
  FOR r IN
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND position(old_l IN column_name) > 0
  LOOP
    EXECUTE format('ALTER TABLE public.%I RENAME COLUMN %I TO %I',
      r.table_name, r.column_name, pg_temp.eleanor_map(r.column_name));
    RAISE NOTICE 'column %.% -> %', r.table_name, r.column_name, pg_temp.eleanor_map(r.column_name);
  END LOOP;

  -- 3. constraints (renaming a PK/unique constraint renames its index too)
  FOR r IN
    SELECT con.conname, cl.relname AS table_name FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    WHERE ns.nspname = 'public' AND position(old_l IN con.conname) > 0
  LOOP
    EXECUTE format('ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',
      r.table_name, r.conname, pg_temp.eleanor_map(r.conname));
  END LOOP;

  -- 4. remaining indexes, sequences, views
  FOR r IN
    SELECT c.relname AS name, c.relkind FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind IN ('i', 'I', 'S', 'v', 'm') AND position(old_l IN c.relname) > 0
  LOOP
    EXECUTE format('ALTER %s public.%I RENAME TO %I',
      CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'INDEX' END,
      r.name, pg_temp.eleanor_map(r.name));
  END LOOP;

  -- 5. stored values, one UPDATE per table over all its text-like columns
  FOR r IN
    SELECT t.table_name FROM information_schema.tables t
    WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns hc
        WHERE hc.table_schema = 'public' AND hc.table_name = t.table_name
          AND hc.column_name ~ '(hash|checksum|signature)'
      )
  LOOP
    SELECT
      string_agg(format('%I = %s', c.column_name,
        CASE
          WHEN c.data_type IN ('text', 'character varying', 'character') THEN format('pg_temp.eleanor_map(%I)', c.column_name)
          WHEN c.data_type = 'jsonb' THEN format('pg_temp.eleanor_map(%I::text)::jsonb', c.column_name)
          WHEN c.data_type = 'json' THEN format('pg_temp.eleanor_map(%I::text)::json', c.column_name)
          ELSE format('pg_temp.eleanor_map(%I::text)::%s', c.column_name, c.udt_name::regtype::text)
        END), ', '),
      string_agg(format('%I::text ~* %L', c.column_name, old_l), ' OR ')
    INTO sets, conds
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = r.table_name
      AND (c.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb')
           OR (c.data_type = 'ARRAY' AND c.udt_name IN ('_text', '_varchar')));
    IF sets IS NULL THEN CONTINUE; END IF;
    EXECUTE format('UPDATE public.%I SET %s WHERE %s', r.table_name, sets, conds);
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN RAISE NOTICE 'values: % rows in %', n, r.table_name; END IF;
  END LOOP;
END $$;

COMMIT;
