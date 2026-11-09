import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPrivateDataAbsent,
  assertOperationSpan,
  assertMetricPoints,
  assertLogRecord,
  assertHookEvent,
  metricDelta,
  flattenMetrics,
} from './assertions.mjs';

const MARKER = 'KVPG_SYNTHETIC_SECRET_701';
const scope = { name: 'kvpg', version: '0.0.0' };
const base = { 'kvpg.operation': 'get', 'kvpg.store': 'postgresql', 'kvpg.trigger': 'foreground' };
const span = (extra = {}) => ({
  name: 'kvpg.get', kind: 0, instrumentationScope: scope,
  attributes: { ...base, 'kvpg.outcome': 'success', 'kvpg.keys': 1, 'kvpg.hits': 1, 'kvpg.misses': 0 },
  status: { code: 0 }, events: [], links: [], duration: [0, 1], ended: true,
  spanContext: () => ({ traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: 1 }),
  ...extra,
});
const point = (extra = {}) => ({
  name: 'kvpg.cache.hits', unit: '{key}', instrumentType: 'COUNTER',
  scope, attributes: { ...base }, value: 1, ...extra,
});
const log = (extra = {}) => ({
  instrumentationScope: scope, eventName: 'kvpg.operation.failed', severityNumber: 17,
  body: 'kvpg operation failed', hrTime: [1, 0],
  attributes: { ...base, 'kvpg.outcome': 'error', 'kvpg.duration': 0.01, 'error.type': 'driver' },
  ...extra,
});

test('T07 accepts safe observations and cyclic structural metadata', () => {
  const record = { spans: [span()], logs: [log()], metrics: [point()] };
  record.self = record;
  assertPrivateDataAbsent(record, [MARKER]);
});

for (const [name, make] of [
  ['span attribute', () => ({ attributes: { key: MARKER } })],
  ['span event', () => ({ events: [{ attributes: { detail: MARKER } }] })],
  ['span link', () => ({ links: [{ attributes: { detail: MARKER } }] })],
  ['status description', () => ({ status: { message: MARKER } })],
  ['log body', () => ({ body: MARKER })],
  ['metric attribute name', () => ({ attributes: { [MARKER]: 1 } })],
  ['non-enumerable cause', () => new Error('driver failed', { cause: new Error(MARKER) })],
  ['stored bytes', () => new TextEncoder().encode(MARKER)],
  ['base64 value', () => Buffer.from(MARKER).toString('base64')],
  ['hex value', () => Buffer.from(MARKER).toString('hex')],
]) {
  test(`T07 rejects a synthetic marker in ${name}`, () => {
    assert.throws(() => assertPrivateDataAbsent(make(), [MARKER]), /private data/);
  });
}

test('T07 does not call getters while inspecting observations', () => {
  let called = false;
  const unsafe = Object.defineProperty({}, 'unsafe', { get() { called = true; throw new Error('getter'); } });
  assert.throws(() => assertPrivateDataAbsent(unsafe, [MARKER]), /accessor/);
  assert.equal(called, false);
});

test('T04/T08 accepts a completed INTERNAL span with fixed attributes', () => {
  assertOperationSpan(span(), { operation: 'get', outcome: 'success', store: 'postgresql', version: '0.0.0' });
});

for (const [name, extra] of [
  ['CLIENT kind', { kind: 2 }],
  ['key in name', { name: `kvpg.get ${MARKER}` }],
  ['query attribute', { attributes: { ...span().attributes, 'db.query.text': 'SELECT value' } }],
  ['error object', { attributes: { ...span().attributes, error: new Error('unsafe') } }],
  ['exception event', { events: [{ name: 'exception', attributes: {} }] }],
  ['link attribute', { links: [{ attributes: { key: 'unsafe' } }] }],
  ['success with ERROR status', { status: { code: 2 } }],
  ['status message', { status: { code: 0, message: 'unsafe' } }],
  ['unfinished span', { ended: false }],
  ['negative duration', { duration: [-1, 0] }],
  ['wrong scope', { instrumentationScope: { name: 'other', version: '0.0.0' } }],
  ['invalid span identity', { spanContext: () => ({ traceId: MARKER, spanId: '2'.repeat(16), traceFlags: 1 }) }],
]) {
  test(`T04/T07 rejects ${name}`, () => {
    assert.throws(() => assertOperationSpan(span(extra), { operation: 'get', outcome: 'success', store: 'postgresql', version: '0.0.0' }));
  });
}

test('T08 accepts a safe error code and ERROR status', () => {
  assertOperationSpan(span({ status: { code: 2 }, attributes: { ...base, 'kvpg.outcome': 'error', 'error.type': 'driver', 'kvpg.keys': 1 } }),
    { operation: 'get', outcome: 'error', errorCode: 'driver', store: 'postgresql', version: '0.0.0' });
});

test('T09 accepts the fixed counter schema', () => {
  assertMetricPoints([point()], { store: 'postgresql', version: '0.0.0' });
});

for (const [name, extra] of [
  ['wrong unit', { unit: 'ms' }],
  ['wrong instrument', { instrumentType: 'GAUGE' }],
  ['unknown name', { name: 'db.client.operation.duration' }],
  ['prototype name', { name: '__proto__', unit: undefined, instrumentType: undefined }],
  ['extra label', { attributes: { ...base, 'kvpg.keys': 1 } }],
  ['unknown operation', { attributes: { ...base, 'kvpg.operation': 'invented' } }],
  ['negative counter', { value: -1 }],
  ['fractional counter', { value: 0.5 }],
  ['zero counter point', { value: 0 }],
]) {
  test(`T09 rejects ${name}`, () => {
    assert.throws(() => assertMetricPoints([point(extra)], { store: 'postgresql', version: '0.0.0' }));
  });
}

test('T09 accepts a duration histogram in seconds', () => {
  assertMetricPoints([point({ name: 'kvpg.operation.duration', unit: 's', instrumentType: 'HISTOGRAM',
    attributes: { ...base, 'kvpg.outcome': 'success' }, value: { count: 1, sum: 0.01 } })], { store: 'postgresql', version: '0.0.0' });
});

test('T09 cumulative exports use the latest snapshot without double counting', () => {
  const resource = (value) => ({ scopeMetrics: [{ scope, metrics: [{ descriptor: { name: 'kvpg.cache.hits', unit: '{key}' }, dataPointType: 3, isMonotonic: true, dataPoints: [{ attributes: base, value }] }] }] });
  const points = flattenMetrics([resource(1), resource(3)]);
  assert.equal(points.length, 1);
  assert.equal(points[0].value, 3);
  assert.equal(metricDelta(flattenMetrics([resource(1)]), points)[0].value, 2);
});

test('T09 histogram deltas subtract counts and sums, without reusing bucket totals', () => {
  const histogram = (count, sum) => point({ name: 'kvpg.operation.duration', unit: 's', instrumentType: 'HISTOGRAM',
    attributes: { ...base, 'kvpg.outcome': 'success' }, value: { count, sum, buckets: { counts: [count] } } });
  const delta = metricDelta([histogram(2, 0.1)], [histogram(3, 0.3)])[0].value;
  assert.equal(delta.count, 1);
  assert.ok(Math.abs(delta.sum - 0.2) < 1e-12);
  assert.deepEqual(metricDelta([point()], [point()]), []);
});

test('T09 refuses reset or decreasing cumulative data', () => {
  assert.throws(() => metricDelta([point({ value: 3 })], [point({ value: 1 })]), /decreas/);
});

test('T10 accepts a fixed failure record', () => {
  assertLogRecord(log(), { store: 'postgresql', version: '0.0.0' });
});

for (const [name, extra] of [
  ['arbitrary body', { body: 'driver message' }],
  ['wrong severity', { severityNumber: 9 }],
  ['cause attribute', { attributes: { ...log().attributes, cause: 'unsafe' } }],
  ['unknown error code', { attributes: { ...log().attributes, 'error.type': 'arbitrary' } }],
  ['missing duration', { attributes: Object.fromEntries(Object.entries(log().attributes).filter(([key]) => key !== 'kvpg.duration')) }],
  ['missing timestamp', { hrTime: undefined }],
  ['invalid log identity', { spanContext: { traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0 } }],
  ['prototype event', { eventName: '__proto__', severityNumber: undefined, severityText: undefined, body: undefined }],
]) {
  test(`T10 rejects ${name}`, () => {
    assert.throws(() => assertLogRecord(log(extra), { store: 'postgresql', version: '0.0.0' }));
  });
}

test('T07 accepts safe operation and hook-error notices', () => {
  assertHookEvent({ operation: 'get', keys: 1, hits: 0, durationMs: 0.01, errorCode: 'driver' });
  assertHookEvent({ code: 'hook' }, { hookError: true });
});

test('T07 rejects the current Error-bearing hook shape', () => {
  assert.throws(() => assertHookEvent({ operation: 'get', keys: 1, durationMs: 0.01, error: new Error('unsafe') }));
  assert.throws(() => assertHookEvent(new Error('unsafe'), { hookError: true }));
});


test('V3 EventName identifies a log event without the deprecated event.name attribute', () => {
  const attributes = { ...log().attributes };
  delete attributes['event.name'];
  assertLogRecord(log({ eventName: 'kvpg.operation.failed', attributes }));
});

test('V3 an attribute-only event name cannot replace EventName', () => {
  assert.throws(() => assertLogRecord(log({ eventName: undefined, attributes: { ...log().attributes, 'event.name': 'kvpg.operation.failed' } })), /event|field/);
});


test('V3 event records do not require SeverityText', () => {
  assertLogRecord(log({ severityText: undefined }));
});
