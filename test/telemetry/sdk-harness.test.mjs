import assert from 'node:assert/strict';
import test from 'node:test';
import { probeSdk, createSession } from './sdk-harness.mjs';
import { assertOperationSpan, assertMetricPoints, assertLogRecord } from './assertions.mjs';

const availability = probeSdk();
test('T01/T02 the SDK prerequisite probe names absent packages without substituting exporters', () => {
  assert.equal(availability.available, availability.missing.length === 0);
  assert.ok(availability.missing.every((name) => name.startsWith('@opentelemetry/')));
});

test('T13 the official in-memory exporters collect all three signals', {
  skip: availability.available ? false : '#14: OpenTelemetry development packages are absent; no package install is authorized',
}, async () => {
  const session = await createSession();
  try {
    const attributes = { 'kvpg.operation': 'get', 'kvpg.store': 'postgresql', 'kvpg.trigger': 'foreground', 'kvpg.outcome': 'error', 'error.type': 'driver' };
    const span = session.api.trace.getTracer('kvpg', '0.0.0').startSpan('kvpg.get', { attributes });
    span.setStatus({ code: session.api.SpanStatusCode.ERROR });
    session.api.context.with(session.api.trace.setSpan(session.api.context.active(), span), () => {
      session.api.logs.getLogger('kvpg', '0.0.0').emit({ severityNumber: 17, severityText: 'ERROR', body: 'kvpg operation failed', attributes: { ...attributes, 'event.name': 'kvpg.operation.failed', 'kvpg.duration': 0.01 } });
    });
    span.end();
    session.api.metrics.getMeter('kvpg', '0.0.0').createHistogram('kvpg.operation.duration', { unit: 's' }).record(0.01, attributes);
    const exported = await session.snapshot();
    assert.equal(exported.spans.length, 1);
    assert.equal(exported.logs.length, 1);
    assert.equal(exported.metrics.length, 1);
    assertOperationSpan(exported.spans[0], { operation: 'get', outcome: 'error', errorCode: 'driver', store: 'postgresql', version: '0.0.0' });
    assertMetricPoints(exported.metrics, { store: 'postgresql', version: '0.0.0' });
    assertLogRecord(exported.logs[0], { store: 'postgresql', version: '0.0.0' });
    assert.equal(exported.logs[0].spanContext.spanId, exported.spans[0].spanContext().spanId);
  } finally {
    await session.shutdown();
  }
});
