// The PostgreSQL store of #2 on each database of KVPG_TEST_DATABASE_URLS (docs/spec-1.0.md R04 to R11).
// First the portable suite of #3, then the acceptance cases that need PostgreSQL itself.
// Each test makes its own schema and drops it after.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, test } from 'node:test';
import pg from 'pg';
import { createStore } from '@inkcasthq/kvpg';
import { conformance, rejectsWith } from '@inkcasthq/kvpg-conformance';
import { closePools, databaseUrls, poolFor, serverMajors, storedKey } from '../telemetry/postgres-fixture.mjs';

const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const HOUR = 3_600_000;
const HIT = (value) => ({ found: true, value });
const MISS = { found: false };

const urls = databaseUrls();
const servers = urls.length === 0 ? [] : await serverMajors(urls);
after(closePools);

/** A Queryable over the pool that counts and keeps each statement text. */
function recordingDriver(pool, intercept) {
  const driver = {
    calls: 0,
    texts: [],
    async query(text, values) {
      driver.calls += 1;
      driver.texts.push(text);
      if (intercept) await intercept(text, driver.calls);
      return pool.query(text, values);
    },
  };
  return driver;
}

async function freshSchema(pool, prefix = 'kvpg_store_') {
  const schema = `${prefix}${randomBytes(6).toString('hex')}`;
  await pool.query(`CREATE SCHEMA ${quote(schema)}`);
  return schema;
}

/** The subject factory of the portable suite: each call makes a schema, migrates its table and drops it in dispose(). */
function postgresSubjects(url) {
  const pool = poolFor(url);
  return async (config) => {
    const schema = await freshSchema(pool, 'kvpg_conformance_');
    const stores = [];
    const make = async (storeConfig) => {
      const driver = recordingDriver(pool);
      const store = createStore({ ...storeConfig, db: driver, table: { schema } });
      stores.push(store);
      return { store, queryCount: () => driver.calls, dispose: async () => {}, sibling: make };
    };
    const first = await make(config);
    await first.store.migrate();
    return {
      ...first,
      async dispose() {
        for (const store of stores) await store.close().catch((error) => assert.equal(error.code, 'closed'));
        await pool.query(`DROP SCHEMA ${quote(schema)} CASCADE`);
      },
    };
  };
}

/** One test schema with a migrated store, dropped after the test. */
async function setup(t, pool, options = {}) {
  const schema = options.schema ?? await freshSchema(pool);
  if (options.schema) await pool.query(`CREATE SCHEMA ${quote(schema)}`);
  t.after(() => pool.query(`DROP SCHEMA ${quote(schema)} CASCADE`));
  const driver = recordingDriver(pool, options.intercept);
  const table = { schema, ...options.table };
  const store = createStore({ ...options.store, db: driver, table });
  t.after(() => store.close().catch((error) => assert.equal(error.code, 'closed')));
  if (options.migrate !== false) await store.migrate();
  const qualified = `${quote(schema)}.${quote(table.table ?? 'kvpg_entries')}`;
  return { store, driver, schema, qualified };
}

async function withClient(url, action) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await action(client);
  } finally {
    await client.end();
  }
}

/** The nodes of a JSON plan, depth first. */
function planNodes(node) {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

async function deadline(promise, ms = 5_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no result within ${ms} ms: a lock blocked the call`)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

if (servers.length === 0) {
  conformance('PostgreSQL', async () => assert.fail('no database'), { pending: 'no database in KVPG_TEST_DATABASE_URLS' });
}

for (const { url, major } of servers) {
  conformance(`PostgreSQL ${major}`, postgresSubjects(url));

  describe(`PostgreSQL ${major} store`, { concurrency: false }, () => {
    const pool = poolFor(url);

    test('R04 migrate makes the configured table twice, with quoted identifiers, and schemaSql describes it', async (t) => {
      const schema = `kvpg "q" 'x' ${randomBytes(4).toString('hex')}`;
      const { store, qualified } = await setup(t, pool, { schema, table: { table: 'Entries "x"; DROP', fillfactor: 80 } });
      const ddl = await store.schemaSql();
      assert.ok(ddl.startsWith(`CREATE TABLE IF NOT EXISTS ${qualified} (`), ddl);
      await store.migrate();
      assert.equal(await store.set('k', 1), true, 'a value is stored after the second migrate');
      const { rows: columns } = await pool.query(`SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type, c.collname,
          pg_get_expr(d.adbin, d.adrelid) AS fallback, a.attnotnull
        FROM pg_attribute a LEFT JOIN pg_collation c ON c.oid = a.attcollation
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [qualified]);
      assert.deepEqual(columns.map((row) => [row.attname, row.type, row.collname, row.attnotnull]), [
        ['key', 'text', 'C', true], ['value', 'bytea', null, true], ['expires_at', 'timestamp with time zone', null, true],
      ]);
      assert.equal(columns[2].fallback, "'infinity'::timestamp with time zone");
      const { rows: [table] } = await pool.query(`SELECT c.relpersistence, c.reloptions,
          (SELECT count(*)::int FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary) AS primary_keys,
          (SELECT count(*)::int FROM pg_class o WHERE o.relnamespace = c.relnamespace AND o.relkind = 'r') AS tables
        FROM pg_class c WHERE c.oid = to_regclass($1)`, [qualified]);
      assert.equal(table.relpersistence, 'p');
      assert.deepEqual(table.reloptions, ['fillfactor=80', 'autovacuum_vacuum_scale_factor=0.01']);
      assert.equal(table.primary_keys, 1);
      assert.equal(table.tables, 1);
    });

    test('R04 an unlogged table is unlogged', async (t) => {
      const { qualified } = await setup(t, pool, { table: { unlogged: true } });
      const { rows } = await pool.query('SELECT relpersistence FROM pg_class WHERE oid = to_regclass($1)', [qualified]);
      assert.equal(rows[0].relpersistence, 'u');
    });

    test('R04 a key with SQL in it is data: no statement text holds it, and no other statement runs', async (t) => {
      const { store, driver, qualified } = await setup(t, pool);
      const key = "'); DROP TABLE x; --";
      driver.texts.length = 0;
      assert.equal(await store.set(key, key), true);
      assert.deepEqual(await store.get(key), HIT(key));
      assert.equal(await store.deletePrefix("'); DROP"), 1);
      assert.equal(driver.texts.length, 3, 'one statement for each operation');
      assert.ok(driver.texts.every((text) => !text.includes('DROP TABLE x')), 'a statement text holds the key');
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${qualified}`);
      assert.equal(rows[0].n, 0);
    });

    test('R04 and RF19 migrate refuses a table of another shape with schema and changes no data', async (t) => {
      const schema = await freshSchema(pool);
      t.after(() => pool.query(`DROP SCHEMA ${quote(schema)} CASCADE`));
      const shapes = {
        collation: 'key text PRIMARY KEY, value bytea NOT NULL, expires_at timestamptz NOT NULL',
        value: 'key text COLLATE "C" PRIMARY KEY, value text NOT NULL, expires_at timestamptz NOT NULL',
        expiry: 'key text COLLATE "C" PRIMARY KEY, value bytea NOT NULL, expires_at timestamp NOT NULL',
        fits: 'key text COLLATE "C" PRIMARY KEY, value bytea NOT NULL, expires_at timestamptz NOT NULL',
      };
      for (const [table, columns] of Object.entries(shapes)) {
        const qualified = `${quote(schema)}.${quote(table)}`;
        await pool.query(`CREATE TABLE ${qualified} (${columns})`);
        await pool.query(`INSERT INTO ${qualified} (key, value, expires_at) VALUES ('0:kept', $1, 'infinity')`,
          [table === 'value' ? 'x' : Buffer.from('1')]);
        const store = createStore({ db: pool, table: { schema, table } });
        if (table === 'fits') await store.migrate();
        else assert.match((await rejectsWith(store.migrate(), 'schema')).message, /COLLATE "C"/);
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${qualified}`);
        assert.equal(rows[0].n, 1, `the ${table} table keeps its row`);
        await store.close();
      }
    });

    test('R06 the database clock decides expiry: a skewed application clock changes nothing', async (t) => {
      const { store, qualified } = await setup(t, pool);
      await pool.query(`INSERT INTO ${qualified} (key, value, expires_at) VALUES ($1, $2, now() - interval '1 second'),
        ($3, $2, now() + interval '1 hour')`, [storedKey('', 'old'), Buffer.from('1'), storedKey('', 'soon')]);
      const realNow = Date.now;
      for (const skew of [-10 * 365 * 86_400_000, 10 * 365 * 86_400_000]) {
        Date.now = () => realNow() + skew;
        try {
          assert.deepEqual(await store.getMany(['old', 'soon']), [MISS, HIT(1)]);
          assert.equal(await store.set('relative', 1, { ttlMs: 60_000 }), true);
        } finally {
          Date.now = realNow;
        }
        const { rows } = await pool.query(`SELECT extract(epoch FROM expires_at - now()) * 1000 AS ms FROM ${qualified} WHERE key = $1`,
          [storedKey('', 'relative')]);
        assert.ok(Number(rows[0].ms) > 55_000 && Number(rows[0].ms) <= 60_000, `relative expiry from the database clock: ${rows[0].ms}`);
      }
    });

    test('R06 an expired row stays invisible to every read while it still exists', async (t) => {
      const { store, qualified } = await setup(t, pool);
      await store.set('old', 1, { expiresAt: new Date(Date.now() - HOUR) });
      assert.deepEqual(await store.get('old'), MISS);
      assert.deepEqual(await store.getMany(['old']), [MISS]);
      assert.equal(await store.has('old'), false);
      assert.deepEqual(await store.ttl('old'), { state: 'missing' });
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${qualified} WHERE key = $1`, [storedKey('', 'old')]);
      assert.equal(rows[0].n, 1, 'the row still exists before cleanup');
    });

    test('R06 the largest ttlMs and the latest Date write an expiring entry, never a persistent one', async (t) => {
      const { store, qualified } = await setup(t, pool);
      assert.equal(await store.set('ttl', 1, { ttlMs: Number.MAX_SAFE_INTEGER }), true);
      assert.equal(await store.set('date', 1, { expiresAt: new Date(8.64e15) }), true);
      for (const key of ['ttl', 'date']) {
        const left = await store.ttl(key);
        assert.equal(left.state, 'expiring');
        assert.ok(Number.isSafeInteger(left.ms) && left.ms > 2 ** 52, `${key}: ${left.ms}`);
      }
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${qualified} WHERE expires_at = 'infinity'`);
      assert.equal(rows[0].n, 0);
    });

    test('R08 a trigger that fails one row leaves the whole batch unwritten, and the next batch works', async (t) => {
      const { store, schema, qualified } = await setup(t, pool);
      await store.set('kept', 'old');
      const refuse = `${quote(schema)}.refuse`;
      await pool.query(`CREATE FUNCTION ${refuse}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.key LIKE '%poison' THEN RAISE EXCEPTION 'refused by the test trigger'; END IF; RETURN NEW; END $$`);
      await pool.query(`CREATE TRIGGER refuse BEFORE INSERT OR UPDATE ON ${qualified} FOR EACH ROW EXECUTE FUNCTION ${refuse}()`);
      const failure = await rejectsWith(store.setMany([
        { key: 'kept', value: 'new' }, { key: 'fresh', value: 1, options: { ifAbsent: true } }, { key: 'poison', value: 1 },
      ]), 'driver');
      assert.match(failure.cause.message, /refused by the test trigger/);
      assert.deepEqual(await store.getMany(['kept', 'fresh', 'poison']), [HIT('old'), MISS, MISS]);
      assert.deepEqual(await store.setMany([{ key: 'kept', value: 'new' }, { key: 'fresh', value: 1, options: { ifAbsent: true } }]),
        ['written', 'written']);
    });

    test('R09 and R10 each key statement uses the primary key index in a generic plan', async (t) => {
      const { store, driver } = await setup(t, pool);
      await store.setMany(Array.from({ length: 50 }, (_, index) => ({ key: `k${index}`, value: index })));
      const operations = {
        get: () => store.get('k1'), getMany: () => store.getMany(['k1', 'k2']), has: () => store.has('k1'), ttl: () => store.ttl('k1'),
        expire: () => store.expire('k1', { ttlMs: HOUR }), persist: () => store.persist('k1'), delete: () => store.delete('k3'),
        deleteMany: () => store.deleteMany(['k4', 'k5']), deletePrefix: () => store.deletePrefix('k6'),
        cleanupExpired: () => store.cleanupExpired({ batchSize: 10, maxBatches: 1 }),
      };
      const args = {
        get: "'0:k1'", getMany: "'{0:k1,0:k2}'", has: "'0:k1'", ttl: "'0:k1'", expire: "'0:k1', NULL, 3600000", persist: "'0:k1'",
        delete: "'0:k3'", deleteMany: "'{0:k4,0:k5}'", deletePrefix: "'0:k6', '0:k7'", cleanupExpired: "'0:', '0;', 10",
      };
      await withClient(url, async (client) => {
        await client.query('SET enable_seqscan = off');
        await client.query('SET plan_cache_mode = force_generic_plan');
        for (const [name, run] of Object.entries(operations)) {
          driver.texts.length = 0;
          await run();
          assert.equal(driver.texts.length, 1, `${name} makes one statement`);
          await client.query(`PREPARE kvpg_${name} AS ${driver.texts[0]}`);
          const { rows } = await client.query(`EXPLAIN (FORMAT JSON) EXECUTE kvpg_${name}(${args[name]})`);
          // A bitmap plan names the table in its heap node and the index in its index node.
          const nodes = planNodes(rows[0]['QUERY PLAN'][0].Plan)
            .filter((node) => node['Relation Name'] === 'kvpg_entries' || node['Index Name'] === 'kvpg_entries_pkey');
          const scans = nodes.map((node) => `${node['Node Type']}${node['Index Name'] ? ` ${node['Index Name']}` : ''}`);
          t.diagnostic(`PostgreSQL ${major} ${name}: ${scans.join(', ')}`);
          assert.ok(nodes.length > 0, `${name}: the plan reads the table`);
          assert.ok(!scans.some((scan) => scan.startsWith('Seq Scan')), `${name} uses a sequential scan: ${scans.join(', ')}`);
          assert.ok(scans.some((scan) => scan.endsWith('kvpg_entries_pkey')), `${name} does not use the primary key: ${scans.join(', ')}`);
        }
      });
    });

    test('R10 cleanup skips locked candidates, and a renewal that holds its row survives', async (t) => {
      const { store, qualified } = await setup(t, pool);
      const expired = ['a', 'b', 'c', 'd', 'e', 'f', 'renewed'];
      await store.setMany(expired.map((key) => ({ key, value: 1, options: { expiresAt: new Date(Date.now() - HOUR) } })));
      await withClient(url, async (client) => {
        await client.query('BEGIN');
        await client.query(`SELECT 1 FROM ${qualified} WHERE key = ANY($1::text[]) FOR UPDATE`, [[storedKey('', 'a'), storedKey('', 'b')]]);
        await client.query(`UPDATE ${qualified} SET expires_at = now() + interval '1 hour' WHERE key = $1`, [storedKey('', 'renewed')]);
        assert.deepEqual(await deadline(store.cleanupExpired({ batchSize: 10 })), { deleted: 4, batches: 1 });
        await client.query('COMMIT');
      });
      assert.deepEqual(await store.cleanupExpired({ batchSize: 10 }), { deleted: 2, batches: 1 });
      assert.deepEqual(await store.get('renewed'), HIT(1));
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${qualified}`);
      assert.equal(rows[0].n, 1);
    });

    test('R10 two concurrent cleanups delete each expired row once and no live row', async (t) => {
      const { store, qualified } = await setup(t, pool);
      await pool.query(`INSERT INTO ${qualified} (key, value, expires_at)
        SELECT '0:old' || g, '\\x31', now() - interval '1 hour' FROM generate_series(1, 500) g`);
      await store.setMany(Array.from({ length: 20 }, (_, index) => ({ key: `live${index}`, value: index })));
      const results = await Promise.all([store.cleanupExpired({ batchSize: 50 }), store.cleanupExpired({ batchSize: 50 })]);
      assert.equal(results[0].deleted + results[1].deleted, 500);
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${qualified}`);
      assert.equal(rows[0].n, 20);
    });

    test('R10 a failed batch keeps the confirmed batches, and a later cleanup removes the rest', async (t) => {
      let failSecond = true;
      const intercept = async (text) => {
        // A cleanup batch is the only statement that deletes by `expires_at <= now()`.
        if (text.startsWith('WITH d AS (DELETE') && text.includes('expires_at <= now()') && failSecond && (intercept.batches = (intercept.batches ?? 0) + 1) === 2) {
          failSecond = false;
          throw new Error('synthetic connection loss');
        }
      };
      const { store, qualified } = await setup(t, pool, { intercept });
      await store.setMany(['a', 'b', 'c', 'd', 'e'].map((key) => ({ key, value: 1, options: { expiresAt: new Date(Date.now() - HOUR) } })));
      const failure = await rejectsWith(store.cleanupExpired({ batchSize: 2 }), 'driver');
      assert.equal(failure.cause.message, 'synthetic connection loss');
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${qualified}`);
      assert.equal(rows[0].n, 3, 'the first batch stays deleted');
      assert.deepEqual(await store.cleanupExpired({ batchSize: 2 }), { deleted: 3, batches: 2 });
    });

    test('R10 the pg_cron command of schemaSql parses back, with quotes in the names, and cleans one batch', async (t) => {
      const schema = `kvpg 'cron' "x" ${randomBytes(4).toString('hex')}`;
      // migrate() applies schemaSql(), and its cron.schedule statement needs pg_cron, which no test database has.
      // A store without the policy makes the same table.
      const { store, qualified } = await setup(t, pool, {
        schema, migrate: false, store: { namespace: "it's", cleanup: { kind: 'pg_cron', schedule: '*/5 * * * *', batchSize: 2 } },
      });
      await createStore({ db: pool, table: { schema } }).migrate();
      await rejectsWith(store.migrate(), 'driver');
      // The command literal spans lines, so the statement is the text from its start to the end.
      const ddl = await store.schemaSql();
      const statement = ddl.slice(ddl.indexOf('SELECT cron.schedule('));
      assert.ok(statement.startsWith('SELECT cron.schedule(') && statement.endsWith(');'), statement);
      // PostgreSQL itself reads the three literals back, so the test does not depend on a parser of its own.
      const { rows: [parsed] } = await pool.query(`SELECT ARRAY[${statement.slice('SELECT cron.schedule('.length, -2)}] AS parts`);
      const [job, schedule, command] = parsed.parts;
      assert.equal(schedule, '*/5 * * * *');
      assert.ok(job.includes(qualified));
      await store.setMany(['a', 'b', 'c'].map((key) => ({ key, value: 1, options: { expiresAt: new Date(Date.now() - HOUR) } })));
      await pool.query(`INSERT INTO ${qualified} (key, value, expires_at) VALUES ('0:other', '\\x31', now() - interval '1 hour')`);
      const { rows } = await pool.query(command);
      assert.equal(Number(rows[0].deleted), 2, 'one batch of two');
      const { rows: left } = await pool.query(`SELECT key FROM ${qualified} ORDER BY key`);
      assert.equal(left.length, 2);
      assert.ok(left.some((row) => row.key === '0:other'), 'the command stays inside its namespace');
    });

    test('R11 close leaves the pool of the caller open', async (t) => {
      const { store } = await setup(t, pool);
      await store.close();
      const { rows } = await pool.query('SELECT 1 AS one');
      assert.equal(rows[0].one, 1);
    });
  });
}
