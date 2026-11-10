// The real-store fixture of the PostgreSQL store (README.md, "Supply a real store fixture").
// Each fixture creates its own schema and table, and drops the schema in dispose(). The controls wrap the real
// driver boundary: they never make a span, a metric, a log record, a hook argument or a store result.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createStore } from '../../packages/kvpg/dist/index.js';

/** The URLs of the test databases, from KVPG_TEST_DATABASE_URLS (comma-separated). */
export function databaseUrls() {
  return (process.env.KVPG_TEST_DATABASE_URLS ?? '').split(',').map((url) => url.trim()).filter(Boolean);
}

const pools = new Map();
/** One pool per URL and process. `closePools()` ends them after the tests. */
export function poolFor(url) {
  let pool = pools.get(url);
  if (!pool) {
    pool = new pg.Pool({ connectionString: url, max: 8 });
    pools.set(url, pool);
  }
  return pool;
}
export async function closePools() {
  await Promise.all([...pools.values()].map((pool) => pool.end()));
  pools.clear();
}

/** The major version of each URL, read once with `server_version_num`. */
export async function serverMajors(urls = databaseUrls()) {
  return Promise.all(urls.map(async (url) => {
    const { rows } = await poolFor(url).query('SHOW server_version_num');
    return { url, major: Math.floor(Number(rows[0].server_version_num) / 10_000) };
  }));
}

const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const utf8 = (text) => Buffer.byteLength(text, 'utf8');
/** The stored key of S3 and RF8, written here without the package code, so that the fixture checks the store. */
export const storedKey = (namespace, key) => `${utf8(namespace)}:${namespace}${key}`;

/** PostgreSQL parses the schedule arguments, including explicit escape literals. */
async function scheduledCommand(db, ddl) {
  const start = ddl.indexOf('\nSELECT cron.schedule(');
  assert.ok(start >= 0 && ddl.endsWith(');'), 'schemaSql() must end with the cron.schedule statement');
  const args = ddl.slice(start + '\nSELECT cron.schedule('.length, -2);
  const { rows } = await db.query(`SELECT ARRAY[${args}] AS parts`);
  assert.equal(rows[0].parts.length, 3);
  return rows[0].parts[2];
}

/** A Queryable over the pool with the fault, hold and count controls of README.md. */
class ControlledDriver {
  #pool;
  #attempts = 0;
  #captured = [];
  #failures = new Map();
  #retries = new Map();
  #delays = new Map();
  #hold;

  constructor(pool) { this.#pool = pool; }

  get attempts() { return this.#attempts; }
  get captured() { return this.#captured.map((query) => structuredClone(query)); }
  failAt(offset, cause) { this.#failures.set(this.#attempts + offset, cause); }
  retryAt(offset, cause) { this.#retries.set(this.#attempts + offset, cause); }
  delayAt(offset, ms) { this.#delays.set(this.#attempts + offset, ms); }
  hold(count) {
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    let entered;
    const reached = new Promise((resolve) => { entered = resolve; });
    this.#hold = { remaining: count, waiting: 0, count, gate, entered };
    return { entered: reached, release: () => { open(); this.#hold = undefined; } };
  }

  async query(text, values) {
    this.#attempts += 1;
    const attempt = this.#attempts;
    this.#captured.push({ text, values: values === undefined ? [] : [...values] });
    const hold = this.#hold;
    if (hold && hold.remaining > 0) {
      hold.remaining -= 1;
      hold.waiting += 1;
      if (hold.waiting === hold.count) hold.entered();
      await hold.gate;
    }
    if (this.#failures.has(attempt)) {
      const cause = this.#failures.get(attempt);
      this.#failures.delete(attempt);
      throw cause;
    }
    if (this.#retries.has(attempt)) {
      // The driver retries inside this call: one more attempt is counted, and the call goes on to the database.
      this.#retries.delete(attempt);
      this.#attempts += 1;
    }
    const result = await this.#pool.query(text, values);
    const delay = this.#delays.get(attempt);
    if (delay !== undefined) {
      this.#delays.delete(attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return result;
  }
}

/** Creates the store with timers under control: the fixture keeps the interval callback that the store registers. */
function createWithCapturedTimer(options) {
  const real = globalThis.setInterval;
  let callback;
  globalThis.setInterval = (handler, ms) => {
    assert.equal(callback, undefined, 'the store registered more than one interval');
    callback = handler;
    assert.ok(Number.isSafeInteger(ms) && ms > 0);
    return { unref() { return this; }, ref() { return this; }, hasRef: () => false };
  };
  try {
    return { store: createStore(options), interval: () => callback };
  } finally {
    globalThis.setInterval = real;
  }
}

/**
 * The fixture factory for one database URL. `configuration` follows README.md: telemetry, hooks, cleanup, codec,
 * namespace and driverInstrumentation. Extra store options (limits, defaultTtlMs, table) pass through.
 */
export function makePostgresFixture(url) {
  return async function makeFixture(configuration = {}) {
    const { driverInstrumentation, ...storeOptions } = configuration;
    assert.notEqual(driverInstrumentation, true, '#6: the pg driver instrumentation is not installed in this workspace');
    const pool = poolFor(url);
    const schema = `kvpg_test_${randomBytes(6).toString('hex')}`;
    const table = storeOptions.table?.table ?? 'kvpg_entries';
    const column = storeOptions.codec?.column ?? 'bytea';
    const qualified = `${quote(schema)}.${quote(table)}`;
    await pool.query(`CREATE SCHEMA ${quote(schema)}`);
    await pool.query(`CREATE TABLE ${qualified} (key text COLLATE "C" PRIMARY KEY, value ${column} NOT NULL,
      expires_at timestamptz NOT NULL DEFAULT 'infinity') WITH (fillfactor = 70)`);
    const driver = new ControlledDriver(pool);
    const namespace = storeOptions.namespace ?? '';
    const { store, interval } = createWithCapturedTimer({ db: driver, ...storeOptions, table: { ...storeOptions.table, schema, table } });
    const command = storeOptions.cleanup?.kind === 'pg_cron' ? await scheduledCommand(pool, await store.schemaSql()) : undefined;
    const encode = (value) => {
      if (storeOptions.codec) return storeOptions.codec.encode(value);
      return Buffer.from(JSON.stringify(value));
    };
    return {
      store,
      schema,
      qualified,
      pool,
      async dispose() {
        await store.close().catch((error) => assert.equal(error.code, 'closed'));
        await pool.query(`DROP SCHEMA ${quote(schema)} CASCADE`);
      },
      async seed(entries) {
        for (const { key, value, expiresAt } of entries) {
          const cast = column === 'bytea' ? '' : `::${column}`;
          await pool.query(`INSERT INTO ${qualified} (key, value, expires_at) VALUES ($1, $2${cast}, COALESCE($3::timestamptz, 'infinity'))`,
            [storedKey(namespace, key), encode(value), expiresAt ?? null]);
        }
      },
      queryCount: () => driver.attempts,
      capturedQueries: () => driver.captured,
      failNextQuery(cause) { driver.failAt(1, cause); },
      failQueryIn(n, cause) { driver.failAt(n, cause); },
      retryNextQuery(cause) { driver.retryAt(1, cause); },
      holdQueries(n) { return driver.hold(n); },
      delayNextQuery(ms) { driver.delayAt(1, ms); },
      async runIntervalCleanup() {
        const callback = interval();
        assert.equal(typeof callback, 'function', 'the store registered no interval callback');
        await callback();
      },
      async runDatabaseScheduledCleanup() {
        assert.ok(command, 'the fixture has no pg_cron policy');
        await pool.query(command);
      },
      async expiredRowCount() {
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${qualified} WHERE expires_at <= now()`);
        return rows[0].n;
      },
    };
  };
}
