import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const OPERATIONS = Object.freeze([
  'get', 'getMany', 'set', 'setMany', 'delete', 'deleteMany', 'deletePrefix',
  'has', 'ttl', 'expire', 'persist', 'cleanupExpired', 'close', 'schemaSql', 'migrate',
]);
export const ERROR_CODES = Object.freeze(['invalid_key', 'invalid_ttl', 'invalid_value', 'codec', 'driver', 'closed']);
const READS = new Set(['get', 'getMany', 'has', 'ttl']);
const BASE = ['kvpg.operation', 'kvpg.store', 'kvpg.trigger'];
const COUNTS = ['kvpg.keys', 'kvpg.hits', 'kvpg.misses', 'kvpg.rows_deleted', 'kvpg.batches'];
const SPAN_FIELDS = [...BASE, ...COUNTS, 'kvpg.outcome', 'error.type'];
const LOG_FIELDS = [...BASE, 'kvpg.keys', 'kvpg.rows_deleted', 'kvpg.batches', 'kvpg.outcome', 'error.type', 'kvpg.duration'];
const METRICS = Object.freeze({
  'kvpg.operation.duration': ['s', 'HISTOGRAM'],
  'kvpg.cache.hits': ['{key}', 'COUNTER'],
  'kvpg.cache.misses': ['{key}', 'COUNTER'],
  'kvpg.cleanup.rows_deleted': ['{row}', 'COUNTER'],
});
const LOGS = Object.freeze({
  'kvpg.operation.failed': [17, 'kvpg operation failed', 'error'],
  'kvpg.operation.slow': [13, 'kvpg operation slow', 'success'],
  'kvpg.cleanup.recovered': [9, 'kvpg cleanup recovered', 'success'],
  'kvpg.hook.failed': [17, 'kvpg hook failed', 'error'],
});

function exactKeys(value, allowed, required = []) {
  assert.ok(value !== null && typeof value === 'object', 'an observation must be an object');
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    assert.ok(typeof key === 'string' && allowed.includes(key), `unlisted observation field: ${String(key)}`);
    assert.ok('value' in Object.getOwnPropertyDescriptor(value, key), 'observation accessor is not permitted');
  }
  for (const key of required) assert.ok(Object.hasOwn(value, key), `missing field: ${key}`);
}

function finite(value, name) {
  assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0, `${name} must be finite and nonnegative`);
}

function count(value, name) {
  assert.ok(Number.isSafeInteger(value) && value >= 0, `${name} must be a nonnegative safe integer`);
}

function scope(actual, expected) {
  assert.equal(actual?.name, 'kvpg', 'wrong instrumentation scope');
  assert.equal(typeof actual?.version, 'string', 'scope version is required');
  assert.ok(actual.version.length > 0, 'scope version is required');
  if (expected.version !== undefined) assert.equal(actual.version, expected.version, 'wrong scope version');
  assert.deepEqual(actual.attributes ?? {}, {}, 'scope must not add attributes');
}

function attributes(actual, allowed, required, expected) {
  exactKeys(actual, allowed, required);
  if (Object.hasOwn(actual, 'kvpg.operation')) assert.ok(OPERATIONS.includes(actual['kvpg.operation']), 'unknown operation');
  if (Object.hasOwn(actual, 'kvpg.store')) {
    assert.ok(typeof actual['kvpg.store'] === 'string' && actual['kvpg.store'].length > 0, 'store identifier is required');
    if (expected.store !== undefined) assert.equal(actual['kvpg.store'], expected.store, 'wrong store identifier');
  }
  if (Object.hasOwn(actual, 'kvpg.trigger')) assert.ok(['foreground', 'interval'].includes(actual['kvpg.trigger']), 'unknown trigger');
  if (Object.hasOwn(actual, 'kvpg.outcome')) assert.ok(['success', 'error'].includes(actual['kvpg.outcome']), 'unknown outcome');
  if (Object.hasOwn(actual, 'error.type')) assert.ok([...ERROR_CODES, 'hook'].includes(actual['error.type']), 'unknown error code');
  for (const key of COUNTS) if (Object.hasOwn(actual, key)) count(actual[key], key);
  for (const key of ['kvpg.rows_deleted', 'kvpg.batches']) {
    if (Object.hasOwn(actual, key)) assert.equal(actual['kvpg.operation'], 'cleanupExpired', 'cleanup counts require cleanupExpired');
  }
}

function hrTime(value) {
  assert.ok(Array.isArray(value) && value.length === 2, 'timestamp or duration must use HrTime');
  count(value[0], 'seconds');
  assert.ok(Number.isInteger(value[1]) && value[1] >= 0 && value[1] < 1e9, 'invalid nanoseconds');
}

function spanContext(value) {
  exactKeys(value, ['traceId', 'spanId', 'traceFlags', 'isRemote', 'traceState'], ['traceId', 'spanId', 'traceFlags']);
  assert.match(value.traceId, /^[0-9a-f]{32}$/, 'invalid trace ID');
  assert.match(value.spanId, /^[0-9a-f]{16}$/, 'invalid span ID');
  assert.notEqual(value.traceId, '0'.repeat(32), 'zero trace ID');
  assert.notEqual(value.spanId, '0'.repeat(16), 'zero span ID');
  assert.ok(Number.isInteger(value.traceFlags) && value.traceFlags >= 0 && value.traceFlags <= 255, 'invalid trace flags');
}

export function assertPrivateDataAbsent(observations, markers) {
  assert.ok(Array.isArray(markers) && markers.length > 0, 'synthetic privacy markers are required');
  const needles = markers.flatMap((marker) => {
    assert.ok(typeof marker === 'string' && marker.length > 0, 'privacy marker must be nonempty');
    return [marker, encodeURIComponent(marker), JSON.stringify(marker).slice(1, -1),
      Buffer.from(marker).toString('base64'), Buffer.from(marker).toString('hex'),
      createHash('sha256').update(marker).digest('hex')];
  });
  const seen = new WeakSet();
  const examineString = (value) => {
    for (const needle of needles) assert.ok(!value.includes(needle), 'private data found in an observation');
  };
  function visit(value) {
    if (typeof value === 'string') return examineString(value);
    if (typeof value === 'symbol') return examineString(String(value));
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Uint8Array) examineString(new TextDecoder().decode(value));
    if (value instanceof Map) for (const [key, item] of value) { visit(key); visit(item); }
    if (value instanceof Set) for (const item of value) visit(item);
    let hasAccessor = false;
    for (const key of Reflect.ownKeys(value)) {
      examineString(String(key));
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if ('value' in descriptor) visit(descriptor.value);
      else hasAccessor = true;
    }
    assert.ok(!hasAccessor, 'observation accessor is not permitted');
  }
  visit(observations);
}

export function assertOperationSpan(span, expected) {
  assert.equal(span.name, `kvpg.${expected.operation}`, 'wrong span name');
  assert.equal(span.kind, 0, 'kvpg operation span must be INTERNAL');
  spanContext(span.spanContext());
  if (span.parentSpanContext !== undefined) spanContext(span.parentSpanContext);
  scope(span.instrumentationScope, expected);
  attributes(span.attributes, SPAN_FIELDS, [...BASE, 'kvpg.outcome'], expected);
  assert.equal(span.attributes['kvpg.operation'], expected.operation);
  assert.equal(span.attributes['kvpg.outcome'], expected.outcome);
  if (expected.trigger !== undefined) assert.equal(span.attributes['kvpg.trigger'], expected.trigger);
  assert.equal(span.ended, true, 'operation span is unfinished');
  hrTime(span.duration);
  exactKeys(span.status, ['code'], ['code']);
  assert.equal(span.status.code, expected.outcome === 'error' ? 2 : 0, 'wrong span status');
  if (expected.outcome === 'error') {
    assert.ok(ERROR_CODES.includes(span.attributes['error.type']), 'contract error code is required');
    if (expected.errorCode !== undefined) assert.equal(span.attributes['error.type'], expected.errorCode);
  } else {
    assert.ok(!Object.hasOwn(span.attributes, 'error.type'), 'success must omit error.type');
  }
  if (Object.hasOwn(span.attributes, 'kvpg.hits') || Object.hasOwn(span.attributes, 'kvpg.misses')) {
    assert.ok(READS.has(expected.operation) && expected.outcome === 'success', 'read counts require a successful read');
  }
  if (['deletePrefix', 'cleanupExpired', 'close', 'schemaSql', 'migrate'].includes(expected.operation)) {
    assert.ok(!Object.hasOwn(span.attributes, 'kvpg.keys'), 'this operation must omit key counts');
  }
  assert.deepEqual(span.events, [], 'no kvpg span events are defined');
  for (const link of span.links) {
    spanContext(link.context);
    attributes(link.attributes ?? {}, SPAN_FIELDS, [], expected);
  }
}

export function assertMetricPoints(points, expected = {}) {
  for (const point of points) {
    const definition = Object.hasOwn(METRICS, point.name) ? METRICS[point.name] : undefined;
    assert.ok(definition, 'unknown kvpg metric or duplicate database observation');
    assert.equal(point.unit, definition[0], 'wrong metric unit');
    assert.equal(point.instrumentType, definition[1], 'wrong metric instrument');
    scope(point.scope, expected);
    const duration = point.name === 'kvpg.operation.duration';
    attributes(point.attributes, duration ? [...BASE, 'kvpg.outcome', 'error.type'] : BASE,
      duration ? [...BASE, 'kvpg.outcome'] : BASE, expected);
    if (duration) {
      count(point.value?.count, 'histogram count');
      assert.ok(point.value.count > 0, 'duration histogram needs a recorded observation');
      finite(point.value.sum, 'histogram sum');
      if (point.attributes['kvpg.outcome'] === 'error') assert.ok(ERROR_CODES.includes(point.attributes['error.type']), 'error histogram requires error.type');
      else assert.ok(!Object.hasOwn(point.attributes, 'error.type'), 'success histogram must omit error.type');
    } else {
      count(point.value, 'counter increment');
      assert.ok(point.value > 0, 'zero counter increments must produce no point');
      if (point.name === 'kvpg.cleanup.rows_deleted') assert.equal(point.attributes['kvpg.operation'], 'cleanupExpired');
      else assert.ok(READS.has(point.attributes['kvpg.operation']), 'cache counters require reads');
    }
  }
}

export function assertLogRecord(record, expected = {}) {
  scope(record.instrumentationScope, expected);
  attributes(record.attributes, LOG_FIELDS, [...BASE, 'kvpg.outcome', 'kvpg.duration'], expected);
  const event = record.eventName;
  const definition = Object.hasOwn(LOGS, event) ? LOGS[event] : undefined;
  assert.ok(definition, 'unknown log event');
  assert.equal(record.severityNumber, definition[0], 'wrong log severity');
  assert.equal(record.body, definition[1], 'log body must be fixed');
  assert.equal(record.attributes['kvpg.outcome'], definition[2], 'wrong log outcome');
  finite(record.attributes['kvpg.duration'], 'log duration');
  hrTime(record.hrTime);
  if (record.spanContext !== undefined) spanContext(record.spanContext);
  if (definition[2] === 'error') {
    assert.ok(Object.hasOwn(record.attributes, 'error.type'), 'error log requires error.type');
    if (event === 'kvpg.hook.failed') assert.equal(record.attributes['error.type'], 'hook');
    else assert.ok(ERROR_CODES.includes(record.attributes['error.type']), 'operation failure needs a contract error code');
  } else assert.ok(!Object.hasOwn(record.attributes, 'error.type'), 'success log must omit error.type');
  if (event === 'kvpg.cleanup.recovered') {
    assert.equal(record.attributes['kvpg.operation'], 'cleanupExpired');
    assert.equal(record.attributes['kvpg.trigger'], 'interval');
  }
}

export function assertHookEvent(event, { hookError = false } = {}) {
  if (hookError) {
    exactKeys(event, ['code'], ['code']);
    assert.equal(event.code, 'hook');
    return;
  }
  exactKeys(event, ['operation', 'keys', 'hits', 'durationMs', 'errorCode'], ['operation', 'keys', 'durationMs']);
  assert.ok(OPERATIONS.includes(event.operation), 'unknown hook operation');
  count(event.keys, 'hook key count');
  if (Object.hasOwn(event, 'hits')) count(event.hits, 'hook hit count');
  finite(event.durationMs, 'hook duration');
  if (Object.hasOwn(event, 'errorCode')) assert.ok(ERROR_CODES.includes(event.errorCode), 'unknown hook error code');
}

function pointKey(point) {
  const entries = (value) => Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([point.scope.name, point.scope.version, point.scope.schemaUrl,
    entries(point.scope.attributes), entries(point.resourceAttributes),
    point.name, point.unit, point.instrumentType, entries(point.attributes)]);
}

export function flattenMetrics(exports) {
  const latest = new Map();
  for (const resource of exports) for (const group of resource.scopeMetrics) for (const metric of group.metrics) {
    if (group.scope.name !== 'kvpg') continue;
    // SDK exports identify aggregations, not the original API instrument class.
    const instrumentType = metric.dataPointType === 0 || metric.dataPointType === 1 ? 'HISTOGRAM'
      : metric.dataPointType === 3 && metric.isMonotonic === true ? 'COUNTER' : 'GAUGE';
    for (const data of metric.dataPoints) {
      const point = { name: metric.descriptor.name, unit: metric.descriptor.unit,
        instrumentType, scope: group.scope, resourceAttributes: structuredClone(resource.resource?.attributes ?? {}),
        attributes: data.attributes, value: structuredClone(data.value) };
      latest.set(pointKey(point), point);
    }
  }
  return [...latest.values()];
}

export function metricDelta(before, after) {
  const previous = new Map(before.map((point) => [pointKey(point), point]));
  const result = [];
  for (const point of after) {
    const old = previous.get(pointKey(point));
    if (point.instrumentType === 'HISTOGRAM') {
      const value = { count: point.value.count - (old?.value.count ?? 0), sum: point.value.sum - (old?.value.sum ?? 0) };
      assert.ok(value.count >= 0 && value.sum >= 0, 'cumulative histogram decreased');
      if (value.count > 0) result.push({ ...point, value });
    } else {
      const value = point.value - (old?.value ?? 0);
      assert.ok(value >= 0, 'cumulative counter decreased');
      if (value > 0) result.push({ ...point, value });
    }
  }
  return result;
}
