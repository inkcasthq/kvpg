// Owner decision #6: late provider registration and the per-store off switch.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import { createStore } from '@inkcasthq/kvpg';
import { closePools, databaseUrls, poolFor, serverMajors } from '../telemetry/postgres-fixture.mjs';
import { createSession } from '../telemetry/sdk-harness.mjs';

const servers = await serverMajors(databaseUrls());
after(closePools);
if (servers.length === 0) test('owner decision #6 needs PostgreSQL', { skip: 'no database in KVPG_TEST_DATABASE_URLS' }, () => {});

if (servers.length > 0) test('owner #6: stores created before providers honor late registration and their own off switch', async (t) => {
  const session = await createSession({ register: false });
  const subjects = [];
  const variable = 'OTEL_NODEJS_INSTRUMENTATION_KVPG_ENABLED';
  const previous = process.env[variable];
  delete process.env[variable];
  try {
    for (const { url, major } of servers) {
      const pool = poolFor(url);
      const schema = `kvpg_owner_${randomBytes(6).toString('hex')}`;
      await pool.query(`CREATE SCHEMA "${schema}"`);
      const stores = [undefined, false, { enabled: false }].map((telemetry) => createStore({ db: pool, table: { schema }, telemetry }));
      subjects.push({ pool, schema, stores, major });
      await stores[0].migrate();
      await t.test(`PostgreSQL ${major}: no provider records no signal`, async () => {
        const before = await session.snapshot();
        for (const store of stores) {
          assert.equal(await store.set('k', 1), true);
          assert.deepEqual(await store.get('k'), { found: true, value: 1 });
        }
        const delta = session.since(before, await session.snapshot());
        assert.deepEqual(delta.calls, { traces: 0, metrics: 0, logs: 0 });
        assert.equal(delta.spans.length + delta.metrics.length + delta.logs.length, 0);
      });
    }
    session.install();
    for (const { major, stores: [enabled, ...disabled] } of subjects) {
      await t.test(`PostgreSQL ${major}: late provider records the default store while both off forms stay silent`, async () => {
        let before = await session.snapshot();
        assert.deepEqual(await enabled.get('k'), { found: true, value: 1 });
        await assert.rejects(enabled.get(''), { code: 'invalid_key' });
        const delta = session.since(before, await session.snapshot());
        assert.deepEqual(delta.spans.map((span) => span.name), ['kvpg.get', 'kvpg.get']);
        assert.equal(delta.metrics.filter((point) => point.name === 'kvpg.operation.calls').reduce((n, point) => n + point.value, 0), 2);
        assert.equal(delta.metrics.filter((point) => point.name === 'kvpg.operation.errors').reduce((n, point) => n + point.value, 0), 1);
        assert.equal(delta.metrics.filter((point) => point.name === 'kvpg.operation.duration').reduce((n, point) => n + point.value.count, 0), 2);
        assert.equal(delta.logs.length, 1);
        assert.equal(delta.logs[0].eventName, 'kvpg.operation.failed');
        before = await session.snapshot();
        for (const store of disabled) {
          assert.deepEqual(await store.get('k'), { found: true, value: 1 });
          await assert.rejects(store.get(''), { code: 'invalid_key' });
        }
        const silent = session.since(before, await session.snapshot());
        assert.deepEqual(silent.calls, { traces: 0, metrics: 0, logs: 0 });
        assert.equal(silent.spans.length + silent.metrics.length + silent.logs.length, 0);
      });
    }
  } finally {
    for (const { pool, schema, stores } of subjects) {
      for (const store of stores) await store.close();
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
    await session.shutdown();
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
});
