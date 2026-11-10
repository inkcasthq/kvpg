/**
 * The SQL of the PostgreSQL store (R04 to R10). Identifiers are quoted. Keys, values and limits are parameters,
 * apart from the scheduled cleanup of pg_cron, whose command text holds quoted literals.
 */
import type { ValueColumn } from './extension.js';

/** A PostgreSQL identifier in double quotes, with each embedded quote doubled. */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** An explicit escape literal, independent of `standard_conforming_strings`. */
export function quoteLiteral(text: string): string {
  return `E'${text.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
}

export interface TableShape {
  readonly schema: string;
  readonly table: string;
  readonly unlogged: boolean;
  readonly fillfactor: number;
  readonly column: ValueColumn;
}

/** The statements of one store. Each statement text is fixed when the store is created. */
export interface Statements {
  readonly qualified: string;
  readonly ddl: string;
  readonly get: string;
  readonly getMany: string;
  readonly set: string;
  readonly setIfAbsent: string;
  readonly setMany: string;
  readonly delete: string;
  readonly deleteMany: string;
  readonly deleteRange: string;
  readonly has: string;
  readonly ttl: string;
  readonly expire: string;
  readonly persist: string;
  readonly cleanupBatch: string;
  readonly columns: string;
}

const EXPIRY = `COALESCE($3::timestamptz, now() + $4::bigint * interval '1 millisecond', 'infinity')`;

/** The statements for one table. A `jsonb` value is read as text, so that the codec decodes it. */
export function statements(shape: TableShape): Statements {
  const t = `${quoteIdentifier(shape.schema)}.${quoteIdentifier(shape.table)}`;
  const value = shape.column === 'jsonb' ? 'value::text AS value' : 'value';
  const upsert = (condition: string) => `INSERT INTO ${t} AS e (key, value, expires_at)
VALUES ($1, $2::${shape.column}, ${EXPIRY})
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at${condition}
RETURNING true AS written`;
  const insertFrom = (filter: string, condition: string) => `INSERT INTO ${t} AS e (key, value, expires_at)
  SELECT key, value, COALESCE(expires_at, now() + ttl_ms * interval '1 millisecond', 'infinity')
  FROM input WHERE ${filter}
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at${condition}
  RETURNING e.key`;
  return Object.freeze({
    qualified: t,
    ddl: `CREATE ${shape.unlogged ? 'UNLOGGED ' : ''}TABLE IF NOT EXISTS ${t} (
  key text COLLATE "C" PRIMARY KEY,
  value ${shape.column} NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT 'infinity'
) WITH (fillfactor = ${shape.fillfactor}, autovacuum_vacuum_scale_factor = 0.01);`,
    get: `SELECT ${value} FROM ${t} WHERE key = $1 AND expires_at > now()`,
    getMany: `SELECT key, ${value} FROM ${t} WHERE key = ANY($1::text[]) AND expires_at > now()`,
    set: upsert(''),
    setIfAbsent: upsert('\nWHERE e.expires_at <= now()'),
    setMany: `WITH input AS (
  SELECT * FROM unnest($1::text[], $2::${shape.column}[], $3::timestamptz[], $4::bigint[], $5::boolean[])
    AS i(key, value, expires_at, ttl_ms, if_absent)
), plain AS (
  ${insertFrom('NOT if_absent', '')}
), conditional AS (
  ${insertFrom('if_absent', '\n  WHERE e.expires_at <= now()')}
)
SELECT key FROM plain UNION ALL SELECT key FROM conditional`,
    delete: `DELETE FROM ${t} WHERE key = $1 RETURNING expires_at > now() AS live`,
    deleteMany: `WITH d AS (DELETE FROM ${t} WHERE key = ANY($1::text[]) RETURNING expires_at > now() AS live)
SELECT (count(*) FILTER (WHERE live))::float8 AS deleted FROM d`,
    deleteRange: `WITH d AS (DELETE FROM ${t} WHERE key >= $1 AND key < $2 RETURNING expires_at > now() AS live)
SELECT (count(*) FILTER (WHERE live))::float8 AS deleted FROM d`,
    has: `SELECT EXISTS (SELECT 1 FROM ${t} WHERE key = $1 AND expires_at > now()) AS live`,
    ttl: `SELECT CASE WHEN expires_at = 'infinity' THEN NULL
  ELSE floor(extract(epoch FROM expires_at - now()) * 1000)::float8 END AS ms
FROM ${t} WHERE key = $1 AND expires_at > now()`,
    expire: `UPDATE ${t} SET expires_at = COALESCE($2::timestamptz, now() + $3::bigint * interval '1 millisecond')
WHERE key = $1 AND expires_at > now() RETURNING true AS changed`,
    persist: `UPDATE ${t} SET expires_at = 'infinity' WHERE key = $1 AND expires_at > now() RETURNING true AS changed`,
    cleanupBatch: cleanupSql(t, '$1', '$2', '$3'),
    columns: `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, c.collname AS collation
FROM pg_attribute a LEFT JOIN pg_collation c ON c.oid = a.attcollation
WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped`,
  });
}

/**
 * One cleanup batch (R10): expired rows of the namespace range, locked with SKIP LOCKED, deleted with a second
 * expiry test, and counted. The candidate query uses the primary key range, so it uses the index.
 */
function cleanupSql(t: string, lower: string, upper: string, limit: string): string {
  return `WITH d AS (DELETE FROM ${t} WHERE key IN (
  SELECT key FROM ${t} WHERE key >= ${lower} AND key < ${upper} AND expires_at <= now()
  LIMIT ${limit} FOR UPDATE SKIP LOCKED
) AND expires_at <= now() RETURNING 1)
SELECT count(*)::float8 AS deleted FROM d`;
}

/** The pg_cron statement of R10: one cleanup batch of the namespace range, as a SQL text with quoted literals. */
export function cronScheduleSql(qualified: string, lower: string, upper: string, batchSize: number, schedule: string): string {
  const command = cleanupSql(qualified, quoteLiteral(lower), quoteLiteral(upper), String(batchSize));
  const job = `kvpg cleanup ${qualified} ${lower}`;
  return `SELECT cron.schedule(${quoteLiteral(job)}, ${quoteLiteral(schedule)}, ${quoteLiteral(command)});`;
}
