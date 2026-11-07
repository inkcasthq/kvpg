# Design of the PostgreSQL store

This document gives the table, the SQL and the reason for each choice. Each choice has a source or a planned measurement. A choice marked "to measure" stays open until the benchmark issue (#7) gives the number.

## Why another library

Three libraries already store keys in PostgreSQL. kvpg adds four things that they do not have together:

1. A written contract (`docs/standard.md`) with a conformance suite that any store can pass, also a store that is not PostgreSQL. An application can then swap its cache store and keep its tests.
2. A table that keeps updates HOT, with the measurements below.
3. Expiry by the clock of the database, so that clients with different clocks agree.
4. Extension points for drivers, codecs, hooks and cleanup (`docs/extending.md`).

| Library | Language and version | Expiry | Index on expiry | Cleanup | Licence |
|---|---|---|---|---|---|
| @keyv/postgres | TypeScript, 6.1.0 | `expires BIGINT` column, in Unix milliseconds | Yes, partial | `clearExpired()`, the interval is off by default | MIT |
| pgkv | Rust, 0.1.0, synchronous driver | `expires_at` column, checked on read | Yes, partial | `cleanup_expired()` | MIT |
| postgres-kv | JavaScript, 0.1.2 (2023) | Not reviewed | Not reviewed | Not reviewed | Not reviewed |

Sources, read 2026-11-07: the npm registry entries of each package, the @keyv/postgres README (github.com/jaredwray/keyv, `storage/postgres`), and the pgkv README (github.com/imumesh18/pgkv).

## The table

```sql
CREATE TABLE IF NOT EXISTS public.kvpg_entries (
  key        text COLLATE "C" PRIMARY KEY,
  value      bytea       NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT 'infinity'
) WITH (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.01);
```

With `unlogged: true`, the statement is `CREATE UNLOGGED TABLE`. The schema and the table name are options. The column type of `value` comes from the codec: `bytea`, `text` or `jsonb`.

## The statements

```sql
-- get (rule S1)
SELECT value FROM public.kvpg_entries WHERE key = $1 AND expires_at > now();

-- set (rules S2 and S4). $3 is the absolute expiry, or NULL. $4 is the time to live in ms, or NULL.
INSERT INTO public.kvpg_entries AS e (key, value, expires_at)
VALUES ($1, $2, COALESCE($3::timestamptz, now() + $4 * interval '1 millisecond', 'infinity'))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at;

-- set with ifAbsent (rule S6): the same INSERT, with a condition on the update
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
WHERE e.expires_at <= now();

-- delete (rule S5)
DELETE FROM public.kvpg_entries WHERE key = $1 RETURNING expires_at > now() AS live;

-- cleanupExpired, one batch (rule S10)
DELETE FROM public.kvpg_entries
WHERE ctid IN (
  SELECT ctid FROM public.kvpg_entries
  WHERE expires_at <= now()
  LIMIT $1
  FOR UPDATE SKIP LOCKED
)
AND expires_at <= now();
```

With a default time to live, the store sends it as `$4`. A row count of 0 from `set` with `ifAbsent` means that a live entry exists, so `set` returns false.

## Choices

D1. No index on `expires_at`. The umesh.dev article (Umesh Yadav, 2026-09-24) measured that with an index on `expires_at`, 0 of 371,048 upserts were HOT updates. A HOT (heap-only tuple) update writes no index entry, so it makes less WAL and less bloat. The cost is that each cleanup batch reads the table without an index. Both other libraries index the column. The benchmark issue measures both designs on one machine. To measure.

D2. `fillfactor = 70` and `autovacuum_vacuum_scale_factor = 0.01`, from the same article. A HOT update needs free space on the same page, and the fill factor leaves 30% of each page free. Autovacuum then starts after 1% of the rows change, not 20%.

D3. `COLLATE "C"` on the key. Keys then compare byte by byte (rules S3 and S8), and the order does not depend on the locale of the server.

D4. `'infinity'` for a persistent entry. The column stays `NOT NULL`, and the read keeps one condition, `expires_at > now()`. This choice is ours, and the conformance suite tests it.

D5. Logged by default, unlogged as an option. PostgreSQL empties an unlogged table after a crash, and a replica has no rows of it (PostgreSQL documents, `CREATE TABLE`). Aurora PostgreSQL also empties it after a crash, and only the writer node can read it (AWS documents, "Working with unlogged tables in Aurora PostgreSQL"). A cache that a job refills can accept that loss. The application must then read the cache from the primary or the writer. The article measured one-client writes at 39 µs unlogged and 62 µs logged, on an Apple M1 Pro with PostgreSQL 18.6.

D6. `bytea` with a JSON codec by default. A cache seldom queries inside a value, and both other designs store bytes. `jsonb` parses each value on write. To measure.

D7. The clock of the database decides expiry. `now()` is the start time of the transaction, so one statement uses one time for all its rows.

D8. Cleanup with `FOR UPDATE SKIP LOCKED`. Two cleanups at the same time then take different rows (rule S10). The outer `expires_at <= now()` makes sure that a row that a `set` made live again stays. The article runs the same batch delete without `SKIP LOCKED`, so this change needs its own test.

D9. The store gives its DDL as text (`schemaSql()`), and a `migrate()` call runs it. An application with its own migration tool applies the text in its own migration.

## Open for the implementation

- `deletePrefix` must use the primary key index and treat `%`, `_` and `\` as plain characters. Two candidates are a range `key >= $1 AND key < upper_bound` and `starts_with(key, $1)`. The store issue (#2) chooses one and proves it with `EXPLAIN` on PostgreSQL 15, 16, 17 and 18.
- The size of a cleanup batch for a large table without an index on the expiry (D1).
- The cost of `getMany` with `key = ANY($1)` for 1, 100 and 1,000 keys.

## Sources

- Umesh Yadav, "Postgres as a key-value store", umesh.dev, 2026-09-24: the table, the SQL, the measurements and the warnings about unlogged tables.
- pgkv, github.com/imumesh18/pgkv, MIT: the list of operations. kvpg copies no code from pgkv.
- @keyv/postgres 6.1.0, github.com/jaredwray/keyv: the prior design in TypeScript.
- PostgreSQL documents: `CREATE TABLE` (`UNLOGGED`, `fillfactor`), `INSERT` (`ON CONFLICT`), `SELECT` (`FOR UPDATE SKIP LOCKED`).
- AWS documents: "Working with unlogged tables in Aurora PostgreSQL".
