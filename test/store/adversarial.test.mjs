// Review attacks use owned schemas and connections on the configured databases.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { after, test } from 'node:test';
import pg from 'pg';
import { createStore, OPERATIONS } from '@inkcasthq/kvpg';
import { rejectsWith } from '@inkcasthq/kvpg-conformance';
import { closePools, databaseUrls, serverMajors } from '../telemetry/postgres-fixture.mjs';
import { createSession } from '../telemetry/sdk-harness.mjs';

const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const HIT = (value) => ({ found: true, value });
const MISS = { found: false };
const servers = await serverMajors(databaseUrls());
const session = servers.length ? await createSession() : undefined;
after(async () => { await session?.shutdown(); await closePools(); });
if (servers.length === 0) test('adversarial store tests need PostgreSQL', { skip: 'no database in KVPG_TEST_DATABASE_URLS' }, () => {});

async function fixture(url, action) {
  const pool = new pg.Pool({ connectionString: url, max: 8, statement_timeout: 5000 });
  const schema = `kvpg_attack_${randomBytes(6).toString('hex')}`;
  const qualified = `${quote(schema)}.kvpg_entries`;
  const clients = [];
  const stores = [];
  const make = (db = pool, options = {}) => {
    const store = createStore({ db, table: { schema }, ...options });
    stores.push(store);
    return store;
  };
  const connect = async () => {
    const db = new pg.Client({ connectionString: url, statement_timeout: 5000 });
    db.on('error', () => {}); // Connection-loss tests also observe rejection of the active query.
    await db.connect();
    clients.push(db);
    const { rows: [{ pid }] } = await db.query('SELECT pg_backend_pid() AS pid');
    return { db, pid, store: make(db) };
  };
  try {
    await pool.query(`CREATE SCHEMA ${quote(schema)}`);
    const store = make();
    await store.migrate();
    await action({ pool, schema, qualified, store, make, connect });
  } finally {
    for (const client of clients) await client.query('ROLLBACK').catch(() => {});
    for (const store of stores) await store.close().catch((error) => assert.equal(error.code, 'closed'));
    for (const client of clients) await client.end();
    try { await pool.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`); }
    finally { await pool.end(); }
  }
}

// This waits for database evidence of the intended race, not for a guessed duration.
async function blocked(pool, pid) {
  const end = performance.now() + 4000;
  while (performance.now() < end) {
    const { rows } = await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid]);
    if (rows[0]?.wait_event_type === 'Lock') return;
    await delay(5);
  }
  assert.fail('the owned connection never reached the expected lock wait');
}
const handled = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
async function success(promise) {
  const result = await promise;
  if (result.error) throw result.error;
  return result.value;
}

for (const { url, major } of servers) {
  test(`PostgreSQL ${major} A1: concurrent set and setMany follow commit order in either direction`, { timeout: 15000 }, async () => {
    await fixture(url, async ({ pool, store, connect }) => {
      const first = await connect();
      const second = await connect();
      for (const batchFirst of [false, true]) {
        await first.db.query('BEGIN');
        if (batchFirst) assert.deepEqual(await first.store.setMany([{ key: 'race', value: 'first' }]), ['written']);
        else assert.equal(await first.store.set('race', 'first'), true);
        const pending = handled(batchFirst ? second.store.set('race', 'last')
          : second.store.setMany([{ key: 'race', value: 'last' }, { key: 'other', value: 1 }]));
        await blocked(pool, second.pid);
        await first.db.query('COMMIT');
        assert.deepEqual(await success(pending), batchFirst ? true : ['written', 'written']);
        assert.deepEqual(await store.get('race'), HIT('last'));
      }
    });
  });

  test(`PostgreSQL ${major} A2: ifAbsent batch waits for commit or rollback and returns each outcome`, { timeout: 15000 }, async () => {
    await fixture(url, async ({ pool, store, connect }) => {
      const first = await connect();
      const second = await connect();
      for (const commit of [true, false]) {
        const key = commit ? 'committed' : 'rolled-back';
        await first.db.query('BEGIN');
        assert.equal(await first.store.set(key, 'first', { ifAbsent: true }), true);
        const pending = handled(second.store.setMany([
          { key, value: 'second', options: { ifAbsent: true } }, { key: `${key}-plain`, value: 2 },
        ]));
        await blocked(pool, second.pid);
        await first.db.query(commit ? 'COMMIT' : 'ROLLBACK');
        assert.deepEqual(await success(pending), [commit ? 'exists' : 'written', 'written']);
        assert.deepEqual(await store.getMany([key, `${key}-plain`]), [HIT(commit ? 'first' : 'second'), HIT(2)]);
      }
    });
  });

  test(`PostgreSQL ${major} A3: expiry boundary and relative batch expiry use transaction time despite client skew`, async () => {
    await fixture(url, async ({ qualified, connect }) => {
      const { db, store } = await connect();
      await db.query('BEGIN');
      await db.query(`INSERT INTO ${qualified} (key, value, expires_at) VALUES
        ('0:before', $1, now() - interval '1 microsecond'), ('0:equal', $1, now()),
        ('0:after', $1, now() + interval '1 microsecond')`, [Buffer.from('1')]);
      const originalNow = Date.now;
      try {
        for (const skew of [-10 * 365 * 86400000, 10 * 365 * 86400000]) {
          Date.now = () => originalNow() + skew;
          assert.deepEqual(await store.getMany(['before', 'equal', 'after']), [MISS, MISS, HIT(1)]);
          assert.equal(await store.has('equal'), false);
          assert.deepEqual(await store.ttl('equal'), { state: 'missing' });
          assert.deepEqual(await store.ttl('after'), { state: 'expiring', ms: 0 });
          assert.equal(await store.persist('equal'), false);
          assert.equal(await store.expire('equal', { ttlMs: 1000 }), false);
          assert.deepEqual(await store.setMany([{ key: 'relative', value: 1, options: { ttlMs: 1234 } }]), ['written']);
          assert.equal((await db.query(`SELECT (extract(epoch FROM expires_at - now()) * 1000)::integer AS ms
            FROM ${qualified} WHERE key = '0:relative'`)).rows[0].ms, 1234);
        }
      } finally { Date.now = originalNow; }
      assert.equal(await store.set('equal', 2, { ifAbsent: true }), true);
      assert.deepEqual(await store.cleanupExpired({ batchSize: 10 }), { deleted: 1, batches: 1 });
      assert.deepEqual(await store.get('after'), HIT(1));
      await db.query('ROLLBACK');
      assert.deepEqual(await store.getMany(['equal', 'relative']), [MISS, MISS]);
      assert.equal(await store.set('recovered', 3), true);
    });
  });

  test(`PostgreSQL ${major} A4: limit and duplicate failures make no query and preserve existing data`, async () => {
    await fixture(url, async ({ pool, make }) => {
      let calls = 0;
      const store = make({ query: (...args) => { calls++; return pool.query(...args); } }, { limits: { maxValueBytes: 4, maxBatchSize: 2 } });
      assert.deepEqual(await store.setMany([{ key: 'a', value: 'aa' }, { key: 'b', value: 'bb' }]), ['written', 'written']);
      for (const [action, code] of [
        [() => store.setMany([{ key: 'a', value: 1 }, { key: 'c', value: 2 }, { key: '', value: undefined }]), 'batch_too_large'],
        [() => store.getMany(['a', 'b', 'c']), 'batch_too_large'],
        [() => store.deleteMany(['a', 'b', 'c']), 'batch_too_large'],
        [() => store.cleanupExpired({ batchSize: 3 }), 'batch_too_large'],
        [() => store.setMany([{ key: 'a', value: 1 }, { key: 'c', value: 'aaa' }]), 'value_too_large'],
        [() => store.setMany([{ key: 'a', value: 1 }, { key: 'a', value: 2, options: { ifAbsent: true } }]), 'invalid_batch'],
      ]) {
        const before = calls;
        await rejectsWith(action(), code);
        assert.equal(calls, before);
        assert.deepEqual(await store.getMany(['a', 'b']), [HIT('aa'), HIT('bb')]);
      }
      assert.deepEqual(await store.setMany([{ key: 'a', value: 2 }, { key: 'c', value: 3, options: { ifAbsent: true } }]), ['written', 'written']);
    });
  });

  test(`PostgreSQL ${major} A5: cleanup skips a renewal until its transaction commits or rolls back`, async () => {
    await fixture(url, async ({ store, connect }) => {
      const writer = await connect();
      for (const commit of [true, false]) {
        await store.setMany(['renew', 'remove'].map((key) => ({ key, value: 1, options: { expiresAt: new Date(0) } })));
        await writer.db.query('BEGIN');
        await writer.store.set('renew', 2);
        assert.deepEqual(await store.cleanupExpired(), { deleted: 1, batches: 1 });
        await writer.db.query(commit ? 'COMMIT' : 'ROLLBACK');
        assert.deepEqual(await store.cleanupExpired(), { deleted: commit ? 0 : 1, batches: 1 });
        assert.deepEqual(await store.get('renew'), commit ? HIT(2) : MISS);
      }
      assert.equal(await store.set('renew', 3), true);
      assert.deepEqual(await store.get('renew'), HIT(3));
    });
  });

  test(`PostgreSQL ${major} A6: connection loss inside a batch rolls back every entry and emits one error`, { timeout: 15000 }, async () => {
    await fixture(url, async ({ pool, schema, qualified, store, connect }) => {
      await store.set('kept', 'old');
      const holder = await connect();
      const victim = await connect();
      await holder.db.query('SELECT pg_advisory_lock(hashtext($1), 1)', [schema]);
      await pool.query(`CREATE FUNCTION ${quote(schema)}.hold_batch() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.key = '0:blocked' THEN PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_SCHEMA), 1); END IF;
        RETURN NEW; END $$`);
      await pool.query(`CREATE TRIGGER hold_batch BEFORE INSERT OR UPDATE ON ${qualified}
        FOR EACH ROW EXECUTE FUNCTION ${quote(schema)}.hold_batch()`);
      const before = await session.snapshot();
      const pending = handled(victim.store.setMany([
        { key: 'kept', value: 'new' }, { key: 'fresh', value: 1 }, { key: 'blocked', value: 2 },
      ]));
      await blocked(pool, victim.pid);
      assert.equal((await pool.query('SELECT pg_terminate_backend($1) AS stopped', [victim.pid])).rows[0].stopped, true);
      const { error } = await pending;
      assert.equal(error?.code, 'driver');
      assert.equal(error.cause.code, '57P01');
      const delta = session.since(before, await session.snapshot());
      assert.equal(delta.spans.filter((span) => span.name === 'kvpg.setMany').length, 1);
      for (const name of ['kvpg.operation.calls', 'kvpg.operation.errors', 'kvpg.operation.duration']) {
        const points = delta.metrics.filter((point) => point.name === name && point.attributes['kvpg.operation'] === 'setMany');
        assert.equal(points.length, 1, name);
        assert.equal(name.endsWith('duration') ? points[0].value.count : points[0].value, 1, name);
        if (name !== 'kvpg.operation.calls') assert.equal(points[0].attributes['error.type'], 'driver');
      }
      assert.deepEqual(await store.getMany(['kept', 'fresh', 'blocked']), [HIT('old'), MISS, MISS]);
      await holder.db.query('SELECT pg_advisory_unlock(hashtext($1), 1)', [schema]);
      assert.deepEqual(await store.setMany([{ key: 'kept', value: 'new' }, { key: 'blocked', value: 3 }]), ['written', 'written']);
      assert.deepEqual(await store.get('blocked'), HIT(3));
    });
  });

  test(`PostgreSQL ${major} A7: each closed operation emits exactly one span and all RED metrics`, async () => {
    await fixture(url, async ({ store }) => {
      await store.close();
      const args = { get: ['k'], getMany: [[]], set: ['k', 1], setMany: [[]], delete: ['k'], deleteMany: [[]],
        deletePrefix: ['k'], has: ['k'], ttl: ['k'], expire: ['k', { ttlMs: 1 }], persist: ['k'], cleanupExpired: [],
        close: [], schemaSql: [], migrate: [] };
      assert.deepEqual(Object.keys(args).sort(), [...OPERATIONS].sort());
      for (const operation of OPERATIONS) {
        const before = await session.snapshot();
        await rejectsWith(store[operation](...args[operation]), 'closed');
        const delta = session.since(before, await session.snapshot());
        assert.equal(delta.spans.length, 1, operation);
        assert.equal(delta.spans[0].name, `kvpg.${operation}`);
        assert.equal(delta.spans[0].attributes['error.type'], 'closed');
        for (const name of ['kvpg.operation.calls', 'kvpg.operation.errors', 'kvpg.operation.duration']) {
          const points = delta.metrics.filter((point) => point.name === name);
          assert.equal(points.length, 1, `${operation} ${name}`);
          assert.equal(points[0].attributes['kvpg.operation'], operation);
          assert.equal(name.endsWith('duration') ? points[0].value.count : points[0].value, 1);
        }
      }
    });
  });
}
