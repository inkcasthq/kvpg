import assert from 'node:assert/strict';
import { before, after, describe, test } from 'node:test';
import {
  OPERATIONS, assertPrivateDataAbsent, assertOperationSpan, assertMetricPoints,
  assertLogRecord, assertHookEvent,
} from './assertions.mjs';
import { createSession } from './sdk-harness.mjs';
import { readFile } from 'node:fs/promises';

const KEY = 'KVPG_SYNTHETIC_KEY_701';
const VALUE = 'KVPG_SYNTHETIC_VALUE_702';
const CAUSE = 'KVPG_SYNTHETIC_CAUSE_703';
const PREFIX = 'KVPG_SYNTHETIC_PREFIX_704';
const NAMESPACE = 'KVPG_SYNTHETIC_NAMESPACE_705';
const MARKERS = [KEY, VALUE, CAUSE, PREFIX, NAMESPACE];
const ENV = 'OTEL_NODEJS_INSTRUMENTATION_KVPG_ENABLED';

function control(fixture, name) {
  assert.equal(typeof fixture[name], 'function', `real-store fixture must implement ${name}`);
  return fixture[name].bind(fixture);
}

function sum(points, name) {
  return points.filter((point) => point.name === name).reduce((total, point) => total + point.value, 0);
}

function durationCount(points) {
  return points.filter((point) => point.name === 'kvpg.operation.duration').reduce((total, point) => total + point.value.count, 0);
}

function kvpgSpans(snapshot) {
  return snapshot.spans.filter((span) => span.instrumentationScope.name === 'kvpg');
}

function kvpgLogs(snapshot) {
  return snapshot.logs.filter((record) => record.instrumentationScope.name === 'kvpg');
}

async function deadline(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('fixture barrier did not open within 5 seconds')), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}

function assertNoSignals(snapshot) {
  assert.equal(kvpgSpans(snapshot).length, 0);
  assert.equal(kvpgLogs(snapshot).length, 0);
  assert.equal(snapshot.metrics.length, 0);
}

async function withEnvironment(value, action) {
  const previous = process.env[ENV];
  try {
    if (value === undefined) delete process.env[ENV];
    else process.env[ENV] = value;
    return await action();
  } finally {
    if (previous === undefined) delete process.env[ENV];
    else process.env[ENV] = previous;
  }
}

async function captureConsole(action) {
  const calls = [];
  const methods = ['error', 'warn', 'info', 'log', 'debug'];
  const saved = Object.fromEntries(methods.map((name) => [name, console[name]]));
  try {
    for (const name of methods) console[name] = (...args) => calls.push({ name, args });
    await action();
  } finally {
    for (const name of methods) console[name] = saved[name];
  }
  return calls;
}

function invoke(store, operation) {
  const args = {
    get: [KEY], getMany: [[KEY, KEY, 'missing']], set: [KEY, VALUE],
    setMany: [[{ key: KEY, value: VALUE }]], delete: [KEY], deleteMany: [[KEY, KEY]],
    deletePrefix: [PREFIX], has: [KEY], ttl: [KEY], expire: [KEY, { ttlMs: 10_000 }],
    persist: [KEY], cleanupExpired: [{ batchSize: 2, maxBatches: 1 }], close: [], schemaSql: [], migrate: [],
  };
  return store[operation](...args[operation]);
}

/**
 * Register shared tests for a real store fixture. No factory means issue #2 is pending.
 * A fixture supplies its actual store, direct backend seeding, disposal, and fault controls.
 * See README.md for the control contract. A supplied but incomplete fixture fails.
 */
export function telemetryConformance(name, makeFixture, options = {}) {
  if (makeFixture !== undefined) assert.equal(typeof makeFixture, 'function', 'fixture must be a function');
  const pending = makeFixture === undefined ? '#2: the PostgreSQL store is not built; no substitute store is used' : false;
  const expected = { store: options.store, version: options.version };
  let session;
  describe(`${name} telemetry`, { concurrency: false }, () => {
    before(async () => {
      if (pending) return;
      assert.equal(typeof options.defaultEnabled, 'boolean', '#6: declare the candidate default without resolving the owner choice');
      assert.equal(typeof options.store, 'string');
      assert.equal(typeof options.version, 'string');
      session = await createSession({ register: false });
    });
    after(async () => { if (session) await session.shutdown(); });

    const check = (title, body) => test(title, { skip: pending, timeout: 15_000 }, body);
    async function fixture(t, configuration = {}, entries = [{ key: KEY, value: VALUE }]) {
      const subject = await makeFixture({ telemetry: { enabled: true }, ...configuration });
      assert.ok(subject?.store, 'fixture must return a real store');
      t.after(() => control(subject, 'dispose')());
      await control(subject, 'seed')(entries);
      return subject;
    }
    async function observe(action) {
      const start = await session.snapshot();
      await action();
      return session.since(start, await session.snapshot());
    }
    function safe(snapshot, hooks = []) {
      const publicFields = snapshot.spans.map((span) => ({ context: span.spanContext(), resource: span.resource?.attributes,
        scope: span.instrumentationScope, attributes: span.attributes, events: span.events, links: span.links, status: span.status }));
      assertPrivateDataAbsent({ spans: snapshot.spans, publicFields, logs: snapshot.logs, metrics: snapshot.rawMetrics, hooks }, MARKERS);
      assertMetricPoints(snapshot.metrics, expected);
      for (const record of kvpgLogs(snapshot)) assertLogRecord(record, expected);
      for (const event of hooks) assertHookEvent(event);
    }

    // These three cases precede the single global provider registration.
    check('T02/T08 API-only with no parent preserves results and exports no signals', async (t) => {
      const subject = await fixture(t);
      const output = await observe(async () => assert.equal(await subject.store.get(KEY), VALUE));
      assertNoSignals(output);
    });
    check('T02/T08 API-only retains a valid upstream parent without exporting', async (t) => {
      const subject = await fixture(t);
      const parent = { traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: 1, isRemote: true };
      const output = await observe(() => session.api.context.with(
        session.api.trace.setSpanContext(session.api.ROOT_CONTEXT, parent),
        async () => {
          assert.equal(await subject.store.get(KEY), VALUE);
          assert.equal(session.api.trace.getSpanContext(session.api.context.active()).traceId, parent.traceId);
        }));
      assertNoSignals(output);
    });
    check('T02 late registration records subsequent traces, metrics, and logs without replay', async (t) => {
      const subject = await fixture(t);
      await subject.store.get(KEY);
      session.install();
      const output = await observe(async () => {
        assert.equal(await subject.store.get(KEY), VALUE);
        await assert.rejects(subject.store.get(''), { code: 'invalid_key' });
      });
      assert.equal(kvpgSpans(output).length, 2);
      assert.equal(durationCount(output.metrics), 2);
      assert.equal(sum(output.metrics, 'kvpg.cache.hits'), 1);
      assert.equal(kvpgLogs(output).length, 1);
      safe(output);
    });
    check('T01 the runtime manifest depends on the API and excludes other OpenTelemetry packages', async () => {
      const manifestURL = options.manifestURL ?? new URL('../../packages/kvpg/package.json', import.meta.url);
      const manifest = JSON.parse(await readFile(manifestURL, 'utf8'));
      assert.equal(typeof manifest.dependencies?.['@opentelemetry/api'], 'string');
      for (const dependencies of [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]) {
        for (const name of Object.keys(dependencies ?? {})) {
          if (name.startsWith('@opentelemetry/')) assert.equal(name, '@opentelemetry/api');
          assert.notEqual(name, 'prom-client');
        }
      }
    });

    const publicOperations = OPERATIONS.filter((operation) => !['schemaSql', 'migrate'].includes(operation)
      || (options.auxiliaryOperations ?? []).includes(operation));
    for (const operation of publicOperations) {
      check(`T04 ${operation} emits exactly one named INTERNAL span and one duration`, async (t) => {
        const subject = await fixture(t);
        const output = await observe(() => invoke(subject.store, operation));
        assert.equal(kvpgSpans(output).length, 1);
        assertOperationSpan(kvpgSpans(output)[0], { ...expected, operation, outcome: 'success', trigger: 'foreground' });
        assert.equal(durationCount(output.metrics), 1);
        safe(output);
      });
    }

    check('T04/T09 empty batches emit one operation each without a database call', async (t) => {
      const subject = await fixture(t);
      const beforeQueries = control(subject, 'queryCount')();
      const output = await observe(async () => {
        assert.deepEqual(await subject.store.getMany([]), []);
        await subject.store.setMany([]);
        assert.equal(await subject.store.deleteMany([]), 0);
      });
      assert.equal(control(subject, 'queryCount')(), beforeQueries);
      assert.deepEqual(kvpgSpans(output).map((span) => span.name).sort(), ['kvpg.deleteMany', 'kvpg.getMany', 'kvpg.setMany']);
      assert.equal(durationCount(output.metrics), 3);
      assert.equal(sum(output.metrics, 'kvpg.cache.hits'), 0);
      assert.equal(sum(output.metrics, 'kvpg.cache.misses'), 0);
      safe(output);
    });
    check('T04/T07 input refusals use safe error status, metrics, and one failure log', async (t) => {
      const hooks = [];
      const subject = await fixture(t, { hooks: { onOperation: (event) => hooks.push(event) } });
      const beforeQueries = control(subject, 'queryCount')();
      const output = await observe(() => assert.rejects(subject.store.set(KEY, VALUE, { ttlMs: 0 }), { code: 'invalid_ttl' }));
      assert.equal(control(subject, 'queryCount')(), beforeQueries);
      assert.equal(kvpgSpans(output).length, 1);
      assertOperationSpan(kvpgSpans(output)[0], { ...expected, operation: 'set', outcome: 'error', errorCode: 'invalid_ttl' });
      assert.equal(kvpgLogs(output).length, 1);
      assert.equal(hooks.length, 1);
      assert.equal(hooks[0].errorCode, 'invalid_ttl');
      safe(output, hooks);
    });
    check('T04 closed calls reject without database work and still emit one failure', async (t) => {
      const subject = await fixture(t);
      await subject.store.close();
      const beforeQueries = control(subject, 'queryCount')();
      const output = await observe(() => assert.rejects(subject.store.get(KEY), { code: 'closed' }));
      assert.equal(control(subject, 'queryCount')(), beforeQueries);
      assert.equal(kvpgSpans(output).length, 1);
      assertOperationSpan(kvpgSpans(output)[0], { ...expected, operation: 'get', outcome: 'error', errorCode: 'closed' });
      assert.equal(kvpgLogs(output).length, 1);
      safe(output);
    });

    const switchCases = [
      ['unset', undefined, undefined, undefined],
      ['environment true', 'true', undefined, true],
      ['environment false', 'false', undefined, false],
      ['trimmed numeric true', ' 1 ', undefined, true],
      ['uppercase false', ' FALSE ', undefined, false],
      ['invalid environment', `unrecognized ${VALUE}`, undefined, undefined],
      ['empty environment', '', undefined, undefined],
      ['instance true overrides false', 'false', true, true],
      ['instance false overrides true', 'true', false, false],
      ['instance object true', 'false', { enabled: true }, true],
      ['instance master false', 'true', { enabled: false, traces: true, metrics: true, logs: true }, false],
    ];
    for (const [title, environment, telemetry, selected] of switchCases) {
      check(`T03 ${title} obeys the declared default and switch precedence`, async (t) => {
        await withEnvironment(environment, async () => {
          const subject = await fixture(t, { telemetry });
          const enabled = selected ?? options.defaultEnabled;
          const output = await observe(() => assert.rejects(subject.store.get(''), { code: 'invalid_key' }));
          assert.equal(kvpgSpans(output).length, enabled ? 1 : 0);
          assert.equal(durationCount(output.metrics), enabled ? 1 : 0);
          assert.equal(kvpgLogs(output).length, enabled ? 1 : 0);
          if (!enabled) assert.deepEqual(output.calls, { traces: 0, metrics: 0, logs: 0 });
          safe(output);
        });
      });
    }
    for (let mask = 0; mask < 8; mask++) {
      const traces = Boolean(mask & 1), metrics = Boolean(mask & 2), logs = Boolean(mask & 4);
      check(`T03 signals traces=${traces} metrics=${metrics} logs=${logs} are independent`, async (t) => {
        const subject = await fixture(t, { telemetry: { enabled: true, traces, metrics, logs } });
        const output = await observe(() => assert.rejects(subject.store.get(''), { code: 'invalid_key' }));
        assert.equal(kvpgSpans(output).length, traces ? 1 : 0);
        assert.equal(durationCount(output.metrics), metrics ? 1 : 0);
        assert.equal(kvpgLogs(output).length, logs ? 1 : 0);
        for (const [signal, enabled] of Object.entries({ traces, metrics, logs })) if (!enabled) assert.equal(output.calls[signal], 0);
        safe(output);
      });
    }
    check('T03 the environment is captured at construction and instances stay independent', async (t) => {
      await withEnvironment('false', async () => {
        const disabled = await fixture(t, { telemetry: undefined });
        process.env[ENV] = 'true';
        const enabled = await fixture(t, { telemetry: undefined });
        const output = await observe(async () => {
          await assert.rejects(disabled.store.get(''), { code: 'invalid_key' });
          await assert.rejects(enabled.store.get(''), { code: 'invalid_key' });
        });
        assert.equal(kvpgSpans(output).length, 1);
        assert.equal(durationCount(output.metrics), 1);
        assert.equal(kvpgLogs(output).length, 1);
        safe(output);
      });
    });
    check('T03 telemetry off leaves safe operation hooks active', async (t) => {
      const hooks = [];
      const subject = await fixture(t, { telemetry: false, hooks: { onOperation: (event) => hooks.push(event) } });
      const output = await observe(async () => assert.equal(await subject.store.get(KEY), VALUE));
      assertNoSignals(output);
      assert.deepEqual(output.calls, { traces: 0, metrics: 0, logs: 0 });
      assert.equal(hooks.length, 1);
      assert.equal(hooks[0].operation, 'get');
      safe(output, hooks);
    });

    check('T05 concurrent callers keep their own parent and restore caller context', async (t) => {
      const subject = await fixture(t);
      const hold = await control(subject, 'holdQueries')(2);
      const tracer = session.api.trace.getTracer('application-fixture', '1');
      const parents = [tracer.startSpan('request-a'), tracer.startSpan('request-b')];
      const start = await session.snapshot();
      const work = parents.map((parent) => session.api.context.with(session.api.trace.setSpan(session.api.ROOT_CONTEXT, parent), async () => {
        const value = await subject.store.get(KEY);
        assert.equal(session.api.trace.getSpan(session.api.context.active()), parent);
        return value;
      }));
      try { await deadline(hold.entered); }
      finally { hold.release(); }
      assert.deepEqual(await Promise.all(work), [VALUE, VALUE]);
      parents.forEach((parent) => parent.end());
      const output = session.since(start, await session.snapshot());
      const spans = kvpgSpans(output);
      assert.equal(spans.length, 2);
      assert.deepEqual(spans.map((span) => span.parentSpanContext.spanId).sort(), parents.map((span) => span.spanContext().spanId).sort());
      assert.equal(new Set(spans.map((span) => span.spanContext().spanId)).size, 2);
      safe(output);
    });
    check('T05 database CLIENT spans have exactly one external owner', async (t) => {
      const subject = await fixture(t, { driverInstrumentation: true });
      assert.equal(typeof subject.driverScope, 'string', 'fixture must name its real driver instrumentation scope');
      const attempts = control(subject, 'queryCount')();
      const output = await observe(() => subject.store.get(KEY));
      const parents = kvpgSpans(output);
      const clients = output.spans.filter((span) => span.kind === 2 && span.instrumentationScope.name === subject.driverScope);
      assert.equal(parents.length, 1);
      assert.equal(clients.length, control(subject, 'queryCount')() - attempts);
      assert.ok(clients.length > 0, 'qualified driver integration must observe the query');
      for (const span of clients) {
        assert.equal(span.parentSpanContext.spanId, parents[0].spanContext().spanId);
        assert.deepEqual(span.events, [], 'driver exception capture must be disabled');
        for (const key of Object.keys(span.attributes)) assert.ok(!/^(db\.(query\.(text|parameter)|statement)|exception\.)/.test(key), 'unsafe driver attribute');
      }
      assert.equal(output.metrics.filter((point) => point.name === 'db.client.operation.duration').length, 0);
      safe(output);
    });
    check('T05 driver retry attempts share one kvpg parent and one operation duration', async (t) => {
      const subject = await fixture(t, { driverInstrumentation: true });
      await control(subject, 'retryNextQuery')(new Error(CAUSE));
      const output = await observe(async () => assert.equal(await subject.store.get(KEY), VALUE));
      const parents = kvpgSpans(output);
      const clients = output.spans.filter((span) => span.kind === 2 && span.instrumentationScope.name === subject.driverScope);
      assert.equal(parents.length, 1);
      assert.equal(clients.length, 2);
      assert.ok(clients.every((span) => span.parentSpanContext.spanId === parents[0].spanContext().spanId));
      assert.equal(durationCount(output.metrics), 1);
      safe(output);
    });
    check('T05 W3C Trace Context stays in context and never becomes SQL data', async (t) => {
      const subject = await fixture(t);
      const carrier = { traceparent: `00-${'3'.repeat(32)}-${'4'.repeat(16)}-01` };
      const parent = session.api.propagation.extract(session.api.ROOT_CONTEXT, carrier);
      const output = await observe(() => session.api.context.with(parent, () => subject.store.get(KEY)));
      assert.equal(kvpgSpans(output)[0].spanContext().traceId, '3'.repeat(32));
      assert.equal(kvpgSpans(output)[0].parentSpanContext.spanId, '4'.repeat(16));
      const statements = control(subject, 'capturedQueries')();
      assert.ok(statements.length > 0);
      for (const query of statements) assertPrivateDataAbsent(query, [carrier.traceparent, '3'.repeat(32), '4'.repeat(16)]);
      safe(output);
    });

    check('T07 driver causes stay with callers and disappear from every signal and hook', async (t) => {
      const hooks = [];
      const subject = await fixture(t, { hooks: { onOperation: (event) => hooks.push(event) }, namespace: NAMESPACE });
      const cause = new Error(`${CAUSE} ${KEY} ${VALUE}`);
      await control(subject, 'failNextQuery')(cause);
      const output = await observe(async () => {
        await assert.rejects(subject.store.get(KEY), (error) => error.code === 'driver' && error.cause === cause);
        assert.equal(await subject.store.get(KEY), VALUE);
      });
      assert.equal(kvpgSpans(output).length, 2);
      assert.equal(kvpgLogs(output).length, 1);
      assert.equal(hooks.length, 2);
      assert.equal(sum(output.metrics, 'kvpg.cache.hits'), 1);
      assert.equal(sum(output.metrics, 'kvpg.cache.misses'), 0);
      safe(output, hooks);
    });
    check('T07 codec decode failure keeps its cause and later recovers', async (t) => {
      const cause = new Error(`${CAUSE} ${VALUE}`);
      let fail = true;
      const codec = { name: 'telemetry-fixture-json', column: 'bytea',
        encode: (value) => new TextEncoder().encode(JSON.stringify(value)),
        decode(bytes) { if (fail) throw cause; return JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)); } };
      const subject = await fixture(t, { codec });
      const output = await observe(async () => {
        await assert.rejects(subject.store.get(KEY), (error) => error.code === 'codec' && error.cause === cause);
        fail = false;
        assert.equal(await subject.store.get(KEY), VALUE);
      });
      assert.equal(kvpgLogs(output).length, 1);
      assert.equal(sum(output.metrics, 'kvpg.cache.hits'), 1);
      assert.equal(sum(output.metrics, 'kvpg.cache.misses'), 0);
      safe(output);
    });
    check('T07 codec encode refusal preserves its cause without a database call and later recovers', async (t) => {
      const cause = new Error(`${CAUSE} ${KEY} ${VALUE}`);
      let fail = true;
      const codec = { name: 'telemetry-fixture-text', column: 'text',
        encode(value) { if (fail) throw cause; return JSON.stringify(value); },
        decode: (value) => JSON.parse(typeof value === 'string' ? value : new TextDecoder().decode(value)) };
      const subject = await fixture(t, { codec }, []);
      const queries = control(subject, 'queryCount')();
      const output = await observe(async () => {
        await assert.rejects(subject.store.set(KEY, VALUE), (error) => error.code === 'invalid_value' && error.cause === cause);
        assert.equal(control(subject, 'queryCount')(), queries);
        fail = false;
        assert.equal(await subject.store.set(KEY, VALUE), true);
      });
      assert.equal(kvpgSpans(output).length, 2);
      assert.equal(durationCount(output.metrics), 2);
      assert.equal(kvpgLogs(output).length, 1);
      safe(output);
    });
    check('T07 throwing hooks and hook-error handlers preserve results without console output', async (t) => {
      const notices = [];
      const subject = await fixture(t, { hooks: {
        onOperation() { throw new Error(`${CAUSE} ${KEY} ${VALUE}`); },
        onHookError(notice) { notices.push(notice); throw new Error(CAUSE); },
      } });
      let output;
      const consoleCalls = await captureConsole(async () => { output = await observe(async () => assert.equal(await subject.store.get(KEY), VALUE)); });
      assert.equal(consoleCalls.length, 0);
      assert.equal(notices.length, 1);
      assertHookEvent(notices[0], { hookError: true });
      assertPrivateDataAbsent(notices, MARKERS);
      assert.equal(kvpgLogs(output).length, 1);
      assert.equal(kvpgLogs(output)[0].attributes['event.name'], 'kvpg.hook.failed');
      assertOperationSpan(kvpgSpans(output)[0], { ...expected, operation: 'get', outcome: 'success' });
      safe(output);
    });
    check('T08 dropped valid spans skip enrichment while metrics and correlated logs continue', async (t) => {
      const subject = await fixture(t);
      const offset = session.createdSpans.length;
      session.sample('off');
      let output;
      try { output = await observe(() => assert.rejects(subject.store.get(''), { code: 'invalid_key' })); }
      finally { session.sample('always'); }
      assert.equal(kvpgSpans(output).length, 0);
      assert.equal(durationCount(output.metrics), 1);
      assert.equal(kvpgLogs(output).length, 1);
      assert.ok(session.api.isSpanContextValid(kvpgLogs(output)[0].spanContext));
      const entries = session.createdSpans.slice(offset);
      assert.equal(entries.length, 1);
      assert.deepEqual(Object.keys(entries[0].attributes).sort(), ['kvpg.operation', 'kvpg.store', 'kvpg.trigger']);
      assert.ok(!entries[0].calls.some((name) => ['setAttribute', 'setAttributes', 'setStatus', 'recordException', 'addEvent'].includes(name)));
      assert.equal(entries[0].calls.filter((name) => name === 'end').length, 1);
      safe(output);
    });
    check('T08 recording API failures do not replace cache results or caller errors', async (t) => {
      const subject = await fixture(t);
      const start = await session.snapshot();
      Object.assign(session.faults, { traces: true, metrics: true, logs: true });
      let consoleCalls;
      try {
        consoleCalls = await captureConsole(async () => {
          assert.equal(await subject.store.get(KEY), VALUE);
          await assert.rejects(subject.store.get(''), { code: 'invalid_key' });
        });
      } finally { Object.assign(session.faults, { traces: false, metrics: false, logs: false }); }
      const output = session.since(start, await session.snapshot());
      assertNoSignals(output);
      assert.equal(consoleCalls.length, 0);
      assert.ok(output.calls.logs <= 1, 'API errors must not recurse through logs');
      const recovered = await observe(async () => assert.equal(await subject.store.get(KEY), VALUE));
      assert.equal(kvpgSpans(recovered).length, 1);
      assert.equal(durationCount(recovered.metrics), 1);
      assert.equal(sum(recovered.metrics, 'kvpg.cache.hits'), 1);
      safe(recovered);
    });
    check('T10 logs retain caller context with traces off and omit invalid root context', async (t) => {
      const subject = await fixture(t, { telemetry: { enabled: true, traces: false } });
      const parent = { traceId: '5'.repeat(32), spanId: '6'.repeat(16), traceFlags: 0, isRemote: true };
      const output = await observe(async () => {
        await session.api.context.with(session.api.trace.setSpanContext(session.api.ROOT_CONTEXT, parent),
          () => assert.rejects(subject.store.get(''), { code: 'invalid_key' }));
        await session.api.context.with(session.api.ROOT_CONTEXT,
          () => assert.rejects(subject.store.get(''), { code: 'invalid_key' }));
      });
      assert.equal(kvpgSpans(output).length, 0);
      assert.equal(kvpgLogs(output).length, 2);
      assert.equal(kvpgLogs(output)[0].spanContext.traceId, parent.traceId);
      assert.equal(kvpgLogs(output)[0].spanContext.spanId, parent.spanId);
      assert.equal(kvpgLogs(output)[1].spanContext, undefined);
      safe(output);
    });
    check('T09 duplicate live and expired read occurrences have exact hit and miss totals', async (t) => {
      const subject = await fixture(t, {}, [{ key: KEY, value: VALUE }, { key: 'expired', value: VALUE, expiresAt: new Date(0) }]);
      const output = await observe(async () => {
        assert.equal(await subject.store.get(KEY), VALUE);
        const results = await subject.store.getMany([KEY, KEY, 'missing', 'expired']);
        assert.equal(results.length, 4);
        assert.deepEqual(results.slice(0, 2), [VALUE, VALUE]);
        assert.equal(await subject.store.has('expired'), false);
        assert.equal((await subject.store.ttl(KEY)).state, 'persistent');
        assert.equal((await subject.store.ttl('expired')).state, 'missing');
      });
      assert.equal(sum(output.metrics, 'kvpg.cache.hits'), 4);
      assert.equal(sum(output.metrics, 'kvpg.cache.misses'), 4);
      assert.equal(durationCount(output.metrics), 5);
      safe(output);
    });
    check('T09 uses API histograms and counters rather than lookalike observable instruments', async (t) => {
      const subject = await fixture(t, {}, [{ key: KEY, value: VALUE }, { key: 'expired', value: VALUE, expiresAt: new Date(0) }]);
      await subject.store.get(KEY);
      await subject.store.get('missing');
      await subject.store.cleanupExpired();
      const definitions = new Map(session.instruments.map((entry) => [entry.name, entry]));
      for (const [name, method, unit] of [
        ['kvpg.operation.duration', 'createHistogram', 's'],
        ['kvpg.cache.hits', 'createCounter', '{key}'],
        ['kvpg.cache.misses', 'createCounter', '{key}'],
        ['kvpg.cleanup.rows_deleted', 'createCounter', '{row}'],
      ]) {
        assert.equal(definitions.get(name)?.method, method);
        assert.equal(definitions.get(name)?.options.unit, unit);
      }
    });
    check('T09 partial cleanup counts confirmed rows once across failure and recovery', async (t) => {
      const subject = await fixture(t, {}, [0, 1, 2].map((index) => ({ key: `${KEY}-${index}`, value: VALUE, expiresAt: new Date(0) })));
      const cause = new Error(`${CAUSE} ${VALUE}`);
      await control(subject, 'failQueryIn')(2, cause);
      const output = await observe(async () => {
        await assert.rejects(subject.store.cleanupExpired({ batchSize: 2 }), (error) => error.code === 'driver' && error.cause === cause);
        const result = await subject.store.cleanupExpired({ batchSize: 2 });
        assert.equal(result.deleted, 1);
      });
      assert.equal(sum(output.metrics, 'kvpg.cleanup.rows_deleted'), 3);
      assert.equal(durationCount(output.metrics), 2);
      assert.equal(kvpgLogs(output).length, 1);
      safe(output);
    });
    check('T10 slow success emits WARN and slow failure emits only ERROR', async (t) => {
      const subject = await fixture(t, { telemetry: { enabled: true, slowOperationMs: 1 } });
      await control(subject, 'delayNextQuery')(10);
      const output = await observe(async () => {
        assert.equal(await subject.store.get(KEY), VALUE);
        await assert.rejects(subject.store.get(''), { code: 'invalid_key' });
      });
      assert.deepEqual(kvpgLogs(output).map((record) => record.attributes['event.name']), ['kvpg.operation.slow', 'kvpg.operation.failed']);
      safe(output);
    });
    check('T06/T10 interval cleanup is a root and emits one recovery per failure episode', async (t) => {
      const parent = session.api.trace.getTracer('application-fixture', '1').startSpan('store-construction');
      const subject = await session.api.context.with(session.api.trace.setSpan(session.api.ROOT_CONTEXT, parent), () => fixture(t,
        { cleanup: { kind: 'interval', everyMs: 10, batchSize: 2 } }, [{ key: KEY, value: VALUE, expiresAt: new Date(0) }]));
      const output = await observe(async () => {
        await control(subject, 'runIntervalCleanup')();
        for (let index = 0; index < 2; index++) {
          await control(subject, 'failNextQuery')(new Error(CAUSE));
          await control(subject, 'runIntervalCleanup')();
        }
        await control(subject, 'runIntervalCleanup')();
        await control(subject, 'runIntervalCleanup')();
      });
      parent.end();
      assert.equal(kvpgSpans(output).length, 5);
      for (const span of kvpgSpans(output)) {
        assert.equal(span.parentSpanContext, undefined);
        assert.equal(span.attributes['kvpg.trigger'], 'interval');
      }
      assert.deepEqual(kvpgLogs(output).map((record) => record.attributes['event.name']),
        ['kvpg.operation.failed', 'kvpg.operation.failed', 'kvpg.cleanup.recovered']);
      assert.equal(sum(output.metrics, 'kvpg.cleanup.rows_deleted'), 1);
      safe(output);
    });
    check('T06 interval overlap skips new work and close stops later timer observations', async (t) => {
      const subject = await fixture(t, { cleanup: { kind: 'interval', everyMs: 10, batchSize: 2 } });
      const hold = await control(subject, 'holdQueries')(1);
      const start = await session.snapshot();
      const first = control(subject, 'runIntervalCleanup')();
      let second;
      try {
        await deadline(hold.entered);
        second = control(subject, 'runIntervalCleanup')();
      } finally { hold.release(); }
      await Promise.all([first, second]);
      let output = session.since(start, await session.snapshot());
      assert.equal(kvpgSpans(output).length, 1);
      await subject.store.close();
      const queries = control(subject, 'queryCount')();
      output = await observe(() => control(subject, 'runIntervalCleanup')());
      assert.equal(control(subject, 'queryCount')(), queries);
      assertNoSignals(output);
    });
    check('T06 database-scheduled cleanup creates no invented JavaScript observations', async (t) => {
      const subject = await fixture(t, { cleanup: { kind: 'pg_cron', schedule: '* * * * *', batchSize: 2 } });
      const output = await observe(() => control(subject, 'runDatabaseScheduledCleanup')());
      assertNoSignals(output);
      assert.equal(await control(subject, 'expiredRowCount')(), 0);
    });
    check('T04/T07 adapter delegation adds no second kvpg span, metric, or log', async (t) => {
      const subject = await fixture(t);
      const adapter = await control(subject, 'createAdapter')();
      const output = await observe(async () => assert.equal(await adapter.get(KEY), VALUE));
      assert.equal(kvpgSpans(output).length, 1);
      assert.equal(durationCount(output.metrics), 1);
      assert.equal(sum(output.metrics, 'kvpg.cache.hits'), 1);
      safe(output);
    });
  });
}
