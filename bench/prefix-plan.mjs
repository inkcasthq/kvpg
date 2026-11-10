// Measures the plan of each prefix predicate of deletePrefix (docs/decisions.md, RF9).
// Usage: KVPG_TEST_DATABASE_URLS=postgres://user:pass@host:port/db,... node bench/prefix-plan.mjs
// Each database gets a throwaway schema with 100,000 keys. The script drops the schema after.
import pg from 'pg';

const urls = (process.env.KVPG_TEST_DATABASE_URLS ?? '').split(',').filter(Boolean);
if (urls.length === 0) throw new Error('set KVPG_TEST_DATABASE_URLS to one or more PostgreSQL URLs');

const schema = `kvpg_prefix_plan_${process.pid}`;
const predicates = [
  ['range', 'key >= $1 AND key < $2', ['3:nsk12', '3:nsk13']],
  ['starts_with', 'starts_with(key, $1)', ['3:nsk12']],
  ['like', 'key LIKE $1', ['3:nsk12%']],
];

async function plan(client, sql, values) {
  const { rows } = await client.query(`EXPLAIN (COSTS OFF) ${sql}`, values);
  return rows.map((row) => row['QUERY PLAN'].trim()).join(' | ');
}

for (const url of urls) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`CREATE TABLE ${schema}.e (key text COLLATE "C" PRIMARY KEY, value bytea NOT NULL,
      expires_at timestamptz NOT NULL DEFAULT 'infinity') WITH (fillfactor = 70)`);
    await client.query(`INSERT INTO ${schema}.e (key, value) SELECT '3:nsk' || g, '\\x00' FROM generate_series(1, 100000) g`);
    await client.query(`ANALYZE ${schema}.e`);
    const custom = {};
    for (const [name, predicate, values] of predicates) {
      custom[name] = await plan(client, `DELETE FROM ${schema}.e WHERE ${predicate}`, values);
    }
    // A named prepared statement can switch to a generic plan, as postgres.js statements do.
    await client.query('SET plan_cache_mode = force_generic_plan');
    const generic = {};
    for (const [name, predicate, values] of predicates) {
      const types = values.map(() => 'text').join(', ');
      await client.query(`PREPARE p_${name}(${types}) AS DELETE FROM ${schema}.e WHERE ${predicate}`);
      const args = values.map((value) => `'${value}'`).join(', ');
      generic[name] = await plan(client, `EXECUTE p_${name}(${args})`, []);
    }
    const version = (await client.query('SHOW server_version')).rows[0].server_version;
    const cron = (await client.query("SELECT count(*)::int AS n FROM pg_available_extensions WHERE name = 'pg_cron'")).rows[0].n;
    console.log(JSON.stringify({ version, pg_cron_available: cron > 0, custom, generic }));
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
}
