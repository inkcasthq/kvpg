import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { flattenMetrics, metricDelta } from './assertions.mjs';

const require = createRequire(import.meta.url);
const PACKAGES = Object.freeze({
  api: '@opentelemetry/api',
  traces: '@opentelemetry/sdk-trace',
  metrics: '@opentelemetry/sdk-metrics',
  logs: '@opentelemetry/sdk-logs',
  resources: '@opentelemetry/resources',
  context: '@opentelemetry/context-async-hooks',
  core: '@opentelemetry/core',
});

export function probeSdk() {
  const missing = [];
  for (const name of Object.values(PACKAGES)) {
    try { require.resolve(name); }
    catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
      missing.push(name);
    }
  }
  return { available: missing.length === 0, missing };
}

async function loadSdk() {
  const availability = probeSdk();
  assert.ok(availability.available, `#14: missing OpenTelemetry test packages: ${availability.missing.join(', ')}`);
  const entries = await Promise.all(Object.entries(PACKAGES).map(async ([key, name]) => {
    const module = await import(pathToFileURL(require.resolve(name)).href);
    return [key, { ...module.default, ...module }];
  }));
  const sdk = Object.fromEntries(entries);
  assert.equal(typeof sdk.api.logs?.getLogger, 'function', '#14: this test backend requires the API 1.10 logs interface');
  return sdk;
}

// The SDK backend targets the proposed SDK 3 generation. It does not select #14.
// Each suite owns a fresh node:test worker and one provider lifetime.
export async function createSession({ register = true, metricReaders = [] } = {}) {
  const sdk = await loadSdk();
  const { api } = sdk;
  const resource = sdk.resources.resourceFromAttributes({ 'service.name': 'kvpg-conformance' });
  const traceExporter = new sdk.traces.InMemorySpanExporter();
  const metricExporter = new sdk.metrics.InMemoryMetricExporter(sdk.metrics.AggregationTemporality.CUMULATIVE);
  const logExporter = new sdk.logs.InMemoryLogRecordExporter();
  const reader = new sdk.metrics.PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 3_600_000 });
  const choices = { always: new sdk.traces.AlwaysOnSampler(), off: new sdk.traces.AlwaysOffSampler(), ratio: new sdk.traces.TraceIdRatioBasedSampler(0.01) };
  let sampling = 'always';
  const sampler = { shouldSample: (...args) => choices[sampling].shouldSample(...args), toString: () => `kvpg-test-${sampling}` };
  const meterProvider = new sdk.metrics.MeterProvider({ resource, readers: [reader, ...metricReaders] });
  const tracerProvider = new sdk.traces.TracerProvider({ resource, sampler, spanProcessors: [new sdk.traces.SimpleSpanProcessor(traceExporter)] });
  const loggerProvider = new sdk.logs.LoggerProvider({ resource, processors: [new sdk.logs.SimpleLogRecordProcessor(logExporter)] });
  const contextManager = new sdk.context.AsyncLocalStorageContextManager().enable();
  const registered = new Set();
  const calls = { traces: 0, metrics: 0, logs: 0 };
  const faults = { traces: false, metrics: false, logs: false };
  const createdSpans = [];
  const instruments = [];
  let stopped = false;

  function wrapSpan(span, entry) {
    return new Proxy(span, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args) => { entry.calls.push(key); return value.apply(target, args); };
    } });
  }
  const tracing = { getTracer(name, version, options) {
    const tracer = tracerProvider.getTracer(name, version, options);
    if (name !== 'kvpg') return tracer;
    return new Proxy(tracer, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (key !== 'startSpan' && key !== 'startActiveSpan') return value.bind(target);
      return (...args) => {
        calls.traces++;
        if (faults.traces) throw new Error('synthetic trace API failure');
        const entry = { name: args[0], attributes: structuredClone(args[1]?.attributes ?? {}), calls: [] };
        createdSpans.push(entry);
        if (key === 'startSpan') return wrapSpan(value.apply(target, args), entry);
        const callback = args.at(-1);
        args[args.length - 1] = (span) => callback(wrapSpan(span, entry));
        return value.apply(target, args);
      };
    } });
  } };
  const metering = { getMeter(name, version, options) {
    const meter = meterProvider.getMeter(name, version, options);
    if (name !== 'kvpg') return meter;
    return new Proxy(meter, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (!String(key).startsWith('create')) return value.bind(target);
      return (...args) => {
        instruments.push({ method: key, name: args[0], options: structuredClone(args[1] ?? {}) });
        const instrument = value.apply(target, args);
        return new Proxy(instrument, { get(item, method) {
          const record = Reflect.get(item, method, item);
          if (typeof record !== 'function') return record;
          return (...values) => {
            if (method === 'record' || method === 'add') {
              calls.metrics++;
              if (faults.metrics) throw new Error('synthetic metric API failure');
            }
            return record.apply(item, values);
          };
        } });
      };
    } });
  } };
  const logging = { getLogger(name, version, options) {
    const logger = loggerProvider.getLogger(name, version, options);
    if (name !== 'kvpg') return logger;
    return new Proxy(logger, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (key !== 'emit') return value.bind(target);
      return (...args) => {
        calls.logs++;
        if (faults.logs) throw new Error('synthetic log API failure');
        return value.apply(target, args);
      };
    } });
  } };

  async function shutdown() {
    if (stopped) return;
    stopped = true;
    const results = await Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown(), loggerProvider.shutdown()]);
    if (registered.has('traces')) api.trace.disable();
    if (registered.has('metrics')) api.metrics.disable();
    if (registered.has('logs')) api.logs.disable();
    if (registered.has('context')) api.context.disable();
    if (registered.has('propagation')) api.propagation.disable();
    contextManager.disable();
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'test providers failed to stop');
  }
  function install() {
    assert.ok(!stopped, 'test session is closed');
    assert.ok(!registered.has('traces'), 'providers can be installed only once per worker');
    for (const [signal, set] of [
      ['traces', () => api.trace.setGlobalTracerProvider(tracing)],
      ['metrics', () => api.metrics.setGlobalMeterProvider(metering)],
      ['logs', () => api.logs.setGlobalLoggerProvider(logging)],
    ]) {
      assert.equal(set(), true, `test worker already has a ${signal} provider`);
      registered.add(signal);
    }
  }
  try {
    assert.equal(api.context.setGlobalContextManager(contextManager), true, 'test worker already has a context manager');
    registered.add('context');
    assert.equal(api.propagation.setGlobalPropagator(new sdk.core.W3CTraceContextPropagator()), true, 'test worker already has a propagator');
    registered.add('propagation');
    if (register) install();
  } catch (error) {
    await shutdown();
    throw error;
  }

  return {
    api, faults, createdSpans, instruments, install, shutdown,
    sample(mode) { assert.ok(Object.hasOwn(choices, mode)); sampling = mode; },
    async snapshot() {
      await Promise.all([tracerProvider.forceFlush(), meterProvider.forceFlush(), loggerProvider.forceFlush()]);
      const rawMetrics = metricExporter.getMetrics();
      return { spans: [...traceExporter.getFinishedSpans()], logs: [...logExporter.getFinishedLogRecords()],
        metrics: flattenMetrics(rawMetrics), rawMetrics: [...rawMetrics], calls: { ...calls } };
    },
    since(before, after) {
      return { spans: after.spans.slice(before.spans.length), logs: after.logs.slice(before.logs.length),
        metrics: metricDelta(before.metrics, after.metrics), rawMetrics: after.rawMetrics,
        calls: Object.fromEntries(Object.keys(calls).map((key) => [key, after.calls[key] - before.calls[key]])) };
    },
  };
}
