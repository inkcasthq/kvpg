// Scheduled SQL must preserve literals with either PostgreSQL string configuration.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import pg from 'pg';
import { createStore } from '@inkcasthq/kvpg';
import { quoteLiteral } from '../../packages/kvpg/dist/sql.js';
import { closePools, databaseUrls, serverMajors, storedKey } from '../telemetry/postgres-fixture.mjs';

const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const servers = await serverMajors(databaseUrls());
after(closePools);
if (servers.length === 0) test('scheduled SQL needs PostgreSQL', { skip: 'no database in KVPG_TEST_DATABASE_URLS' }, () => {});

for (const { url, major } of servers) {
  test(`PostgreSQL ${major}: literal quoting cannot add a statement with backslash escapes enabled`, async () => {
    const db = new pg.Client({ connectionString: url });
    await db.connect();
    try {
      await db.query('SET standard_conforming_strings = off');
      const payload = "\\'; SELECT 99 AS injected; --";
      const result = await db.query(`SELECT ${quoteLiteral(payload)} AS literal`);
      assert.equal(Array.isArray(result), false, 'the payload executed another SQL statement');
      assert.equal(result.rows[0].literal, payload);
    } finally { await db.end(); }
  });

  test(`PostgreSQL ${major}: scheduled SQL preserves names and namespace under both string configurations`, async () => {
    const db = new pg.Client({ connectionString: url });
    await db.connect();
    const schema = `kvpg_literals_${randomBytes(6).toString('hex')}`;
    const table = 'entry \\ "quoted" \'name';
    const qualified = `${quote(schema)}.${quote(table)}`;
    const namespace = "n\\'quoted";
    const options = { db, table: { schema, table }, namespace };
    const ordinary = createStore(options);
    const scheduled = createStore({ ...options, cleanup: { kind: 'pg_cron', schedule: '*/5 * * * *', batchSize: 2 } });
    try {
      await db.query(`CREATE SCHEMA ${quote(schema)}`);
      await ordinary.migrate();
      for (const mode of ['off', 'on']) {
        await db.query(`SET standard_conforming_strings = ${mode}`);
        const ddl = await scheduled.schemaSql();
        const statement = ddl.slice(ddl.indexOf('SELECT cron.schedule('));
        const result = await db.query(`SELECT ARRAY[${statement.slice('SELECT cron.schedule('.length, -2)}] AS parts`);
        assert.equal(Array.isArray(result), false);
        const [job, schedule, command] = result.rows[0].parts;
        assert.equal(job, `kvpg cleanup ${qualified} ${storedKey(namespace, '')}`);
        assert.equal(schedule, '*/5 * * * *');
        await ordinary.set('old', 1, { expiresAt: new Date(0) });
        await ordinary.set('live', 2);
        await db.query(`INSERT INTO ${qualified} (key, value, expires_at) VALUES ($1, $2, $3)
          ON CONFLICT (key) DO UPDATE SET expires_at = EXCLUDED.expires_at`, ['0:other', Buffer.from('1'), new Date(0)]);
        const deleted = await db.query(command);
        assert.equal(Number(deleted.rows[0].deleted), 1);
        assert.deepEqual(await ordinary.get('live'), { found: true, value: 2 });
        assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${qualified} WHERE key = $1`, ['0:other'])).rows[0].n, 1);
      }
    } finally {
      await Promise.all([ordinary.close(), scheduled.close()]);
      await db.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
      await db.end();
    }
  });
}
