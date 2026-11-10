/**
 * Native telemetry through the OpenTelemetry API only (docs/telemetry.md T01 to T10, RF12 to RF16).
 * A signal is on when the store switches allow it and the application registered a provider for it.
 * Without a provider and without a hook, an operation reads no clock and calls no recording method.
 * A failure of a recording call never changes the result of an operation and is never logged again.
 */
import { context, createNoopMeter, isSpanContextValid, metrics, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Attributes, Context, Counter, Histogram, Meter, Span, Tracer } from '@opentelemetry/api';
import type { KvErrorCode } from './contract.js';
import type { Hooks, Operation, TelemetryOptions } from './extension.js';
import { VERSION } from './version.js';

/** The instrumentation scope name of every kvpg signal (T04). */
export const SCOPE = 'kvpg';
/** The implementation identifier of this store (T07). */
export const STORE = 'postgresql';
/** The single environment switch of T03. */
export const ENVIRONMENT_SWITCH = 'OTEL_NODEJS_INSTRUMENTATION_KVPG_ENABLED';
/** The bucket advice of `kvpg.operation.duration`, in seconds (RF16). */
export const DURATION_BUCKETS = Object.freeze([0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10]);

export type Trigger = 'foreground' | 'interval';
type Outcome = 'success' | 'error';

/** The logs interface of `@opentelemetry/api-logs`, typed by the parts that kvpg uses. */
interface LoggerLike {
  emit(record: { eventName: string; severityNumber: number; body: string; attributes: Attributes; context: Context }): void;
  enabled?(): boolean;
}
interface LogsApiLike {
  getLogger(name: string, version?: string): LoggerLike;
}

/**
 * RF15: the logs package is imported once, at load. If it is not installed, logs are off and the other signals work.
 * Any other import error fails the import of kvpg, so a broken installation is visible.
 */
async function loadLogsApi(): Promise<LogsApiLike | undefined> {
  try {
    const module = await import('@opentelemetry/api-logs');
    return module.logs as unknown as LogsApiLike;
  } catch (error) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (code === 'ERR_MODULE_NOT_FOUND' && typeof message === 'string' && message.includes("'@opentelemetry/api-logs'")) return undefined;
    throw error;
  }
}
const logsApi = await loadLogsApi();

const NOOP_METER = createNoopMeter();

/** The resolved switches of one store (T03). */
export interface TelemetrySwitches {
  readonly traces: boolean;
  readonly metrics: boolean;
  readonly logs: boolean;
  readonly slowOperationMs: number | undefined;
}

/** `true`, `1`, `false` and `0`, trimmed and case-insensitive. Any other value means unset. */
function environmentSwitch(raw: string | undefined): boolean | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

/** The switches of T03: instance `enabled`, then the environment, then true. A signal needs the master and its own switch. */
export function resolveSwitches(options: TelemetryOptions | undefined, environment: string | undefined): TelemetrySwitches {
  if (options !== undefined && typeof options !== 'boolean' && (typeof options !== 'object' || options === null)) {
    throw new TypeError('kvpg: telemetry must be a boolean or an object');
  }
  const object = typeof options === 'object' ? options : {};
  for (const name of ['enabled', 'traces', 'metrics', 'logs'] as const) {
    if (object[name] !== undefined && typeof object[name] !== 'boolean') throw new TypeError(`kvpg: telemetry.${name} must be a boolean`);
  }
  const slow = object.slowOperationMs;
  if (slow !== undefined && !(typeof slow === 'number' && Number.isFinite(slow) && slow > 0)) {
    throw new RangeError('kvpg: telemetry.slowOperationMs must be a finite positive number');
  }
  const master = (typeof options === 'boolean' ? options : object.enabled) ?? environmentSwitch(environment) ?? true;
  return Object.freeze({
    traces: master && (object.traces ?? true),
    metrics: master && (object.metrics ?? true),
    logs: master && (object.logs ?? true),
    slowOperationMs: slow,
  });
}

interface Instruments {
  readonly duration: Histogram;
  readonly calls: Counter;
  readonly errors: Counter;
  readonly hits: Counter;
  readonly misses: Counter;
  readonly rowsDeleted: Counter;
}
const instrumentsByMeter = new WeakMap<Meter, Instruments>();

function instrumentsOf(meter: Meter): Instruments {
  let instruments = instrumentsByMeter.get(meter);
  if (instruments === undefined) {
    instruments = {
      duration: meter.createHistogram('kvpg.operation.duration', { unit: 's', description: 'Duration of kvpg public operations',
        advice: { explicitBucketBoundaries: [...DURATION_BUCKETS] } }),
      calls: meter.createCounter('kvpg.operation.calls', { unit: '{call}', description: 'Completed kvpg public operations' }),
      errors: meter.createCounter('kvpg.operation.errors', { unit: '{error}', description: 'Failed kvpg public operations' }),
      hits: meter.createCounter('kvpg.cache.hits', { unit: '{key}', description: 'Live results of kvpg reads' }),
      misses: meter.createCounter('kvpg.cache.misses', { unit: '{key}', description: 'Missing results of kvpg reads' }),
      rowsDeleted: meter.createCounter('kvpg.cleanup.rows_deleted', { unit: '{row}', description: 'Expired rows removed by kvpg cleanup' }),
    };
    instrumentsByMeter.set(meter, instruments);
  }
  return instruments;
}

/** Calls `action` and drops its failure (T08): a recording failure is not a cache failure and is not reported again. */
function quietly<T>(action: () => T): T | undefined {
  try {
    return action();
  } catch {
    return undefined;
  }
}

/** A tracer only when the application registered a tracer provider (RF12). */
function registeredTracer(): Tracer | undefined {
  const provider = trace.getTracerProvider() as ReturnType<typeof trace.getTracerProvider> & {
    getDelegateTracer?: (name: string, version?: string) => Tracer | undefined;
  };
  return typeof provider.getDelegateTracer === 'function'
    ? provider.getDelegateTracer(SCOPE, VERSION)
    : provider.getTracer(SCOPE, VERSION);
}

/** The instruments only when the application registered a meter provider (RF12). */
function registeredInstruments(): Instruments | undefined {
  const meter = metrics.getMeterProvider().getMeter(SCOPE, VERSION);
  return meter === NOOP_METER ? undefined : instrumentsOf(meter);
}

/** A logger only when the logs package is present and its logger is enabled (RF12, RF15). */
function registeredLogger(): LoggerLike | undefined {
  if (logsApi === undefined) return undefined;
  const logger = logsApi.getLogger(SCOPE, VERSION);
  return typeof logger.enabled !== 'function' || logger.enabled() ? logger : undefined;
}

const KEYLESS: ReadonlySet<Operation> = new Set(['deletePrefix', 'cleanupExpired', 'close', 'schemaSql', 'migrate']);
const READS: ReadonlySet<Operation> = new Set(['get', 'getMany', 'has', 'ttl']);

/** Safe counts of one operation (T07, T09). */
export interface Counts {
  hits?: number;
  misses?: number;
  rowsDeleted?: number;
  batches?: number;
}

const baseCache = new Map<string, Attributes>();
/** The fixed initial attributes of T08, cached for concurrent use. */
function baseAttributes(operation: Operation, trigger: Trigger): Attributes {
  const id = `${operation}:${trigger}`;
  let attributes = baseCache.get(id);
  if (attributes === undefined) {
    attributes = Object.freeze({ 'kvpg.operation': operation, 'kvpg.store': STORE, 'kvpg.trigger': trigger });
    baseCache.set(id, attributes);
  }
  return attributes;
}

/**
 * The telemetry of one public operation. `start` returns undefined when no signal is on and no hook is set:
 * then the operation does no telemetry work at all.
 */
export class Observation {
  readonly #operation: Operation;
  readonly #trigger: Trigger;
  readonly #switches: TelemetrySwitches;
  readonly #hooks: Hooks | undefined;
  readonly #start: number;
  readonly #span: Span | undefined;
  readonly #context: Context;
  readonly #instruments: Instruments | undefined;
  readonly #logger: LoggerLike | undefined;

  private constructor(operation: Operation, trigger: Trigger, switches: TelemetrySwitches, hooks: Hooks | undefined,
    tracer: Tracer | undefined, instruments: Instruments | undefined, logger: LoggerLike | undefined) {
    this.#operation = operation;
    this.#trigger = trigger;
    this.#switches = switches;
    this.#hooks = hooks;
    this.#instruments = instruments;
    this.#logger = logger;
    this.#start = performance.now();
    // T06: an interval cleanup has no application parent.
    const parent = trigger === 'interval' ? ROOT_CONTEXT : context.active();
    let span = tracer === undefined ? undefined : quietly(() => tracer.startSpan(`kvpg.${operation}`,
      { kind: SpanKind.INTERNAL, attributes: baseAttributes(operation, trigger) }, parent));
    // T08: an invalid span gets no further work: no activation, no attributes, no end.
    if (span !== undefined && !quietly(() => isSpanContextValid(span!.spanContext()))) span = undefined;
    this.#span = span;
    this.#context = span === undefined ? parent : trace.setSpan(parent, span);
  }

  static start(operation: Operation, trigger: Trigger, switches: TelemetrySwitches, hooks: Hooks | undefined): Observation | undefined {
    const tracer = switches.traces ? quietly(registeredTracer) : undefined;
    const instruments = switches.metrics ? quietly(registeredInstruments) : undefined;
    const logger = switches.logs ? quietly(registeredLogger) : undefined;
    if (tracer === undefined && instruments === undefined && logger === undefined && hooks === undefined) return undefined;
    return new Observation(operation, trigger, switches, hooks, tracer, instruments, logger);
  }

  /** Runs the work in the operation context, so driver spans become its children (T05). */
  within<T>(work: () => Promise<T>): Promise<T> {
    return this.#span === undefined && this.#trigger === 'foreground' ? work() : context.with(this.#context, work);
  }

  /** Adds the rows of one confirmed cleanup batch to the counter at once (T09). */
  confirmedRows(rows: number): void {
    const instruments = this.#instruments;
    if (instruments !== undefined && rows > 0) quietly(() => instruments.rowsDeleted.add(rows, baseAttributes(this.#operation, this.#trigger)));
  }

  /** Ends the span, records the metrics and logs, then delivers the hook (T04, T08 to T10, T07). */
  finish(outcome: Outcome, errorCode: KvErrorCode | undefined, keys: number | undefined, counts: Counts, recovered: boolean): void {
    const durationMs = performance.now() - this.#start;
    const seconds = durationMs / 1000;
    const operation = this.#operation;
    const base = baseAttributes(operation, this.#trigger);
    const read = outcome === 'success' && READS.has(operation);
    const span = this.#span;
    if (span !== undefined) {
      quietly(() => {
        if (span.isRecording()) {
          const attributes: Attributes = { 'kvpg.outcome': outcome };
          if (keys !== undefined && !KEYLESS.has(operation)) attributes['kvpg.keys'] = keys;
          if (read) Object.assign(attributes, { 'kvpg.hits': counts.hits ?? 0, 'kvpg.misses': counts.misses ?? 0 });
          if (operation === 'cleanupExpired') Object.assign(attributes, { 'kvpg.rows_deleted': counts.rowsDeleted ?? 0, 'kvpg.batches': counts.batches ?? 0 });
          if (errorCode !== undefined) {
            attributes['error.type'] = errorCode;
            span.setStatus({ code: SpanStatusCode.ERROR });
          }
          span.setAttributes(attributes);
        }
      });
      quietly(() => span.end());
    }
    const instruments = this.#instruments;
    if (instruments !== undefined) {
      const completed = { ...base, 'kvpg.outcome': outcome };
      quietly(() => instruments.duration.record(seconds, errorCode === undefined ? completed : { ...completed, 'error.type': errorCode }));
      quietly(() => instruments.calls.add(1, completed));
      if (errorCode !== undefined) quietly(() => instruments.errors.add(1, { ...base, 'error.type': errorCode }));
      if (read && (counts.hits ?? 0) > 0) quietly(() => instruments.hits.add(counts.hits!, base));
      if (read && (counts.misses ?? 0) > 0) quietly(() => instruments.misses.add(counts.misses!, base));
    }
    if (this.#logger !== undefined) {
      const attributes: Attributes = { ...base, 'kvpg.outcome': outcome, 'kvpg.duration': seconds };
      if (keys !== undefined && !KEYLESS.has(operation)) attributes['kvpg.keys'] = keys;
      if (operation === 'cleanupExpired') Object.assign(attributes, { 'kvpg.rows_deleted': counts.rowsDeleted ?? 0, 'kvpg.batches': counts.batches ?? 0 });
      if (errorCode !== undefined) {
        this.#emit('kvpg.operation.failed', 17, 'kvpg operation failed', { ...attributes, 'error.type': errorCode });
      } else if (recovered) {
        this.#emit('kvpg.cleanup.recovered', 9, 'kvpg cleanup recovered', attributes);
      } else if (this.#switches.slowOperationMs !== undefined && durationMs >= this.#switches.slowOperationMs) {
        this.#emit('kvpg.operation.slow', 13, 'kvpg operation slow', attributes);
      }
    }
    this.#deliver(outcome, errorCode, keys, counts, durationMs, seconds);
  }

  #emit(eventName: string, severityNumber: number, body: string, attributes: Attributes): void {
    const logger = this.#logger!;
    quietly(() => logger.emit({ eventName, severityNumber, body, attributes, context: this.#context }));
  }

  /** T07: the hook gets safe fields only. A throwing hook gets one notice and one log record, never a recursion. */
  #deliver(outcome: Outcome, errorCode: KvErrorCode | undefined, keys: number | undefined, counts: Counts, durationMs: number, seconds: number): void {
    const hook = this.#hooks?.onOperation;
    if (hook === undefined) return;
    const event: { operation: Operation; keys: number; durationMs: number; hits?: number; errorCode?: KvErrorCode } =
      { operation: this.#operation, keys: keys ?? 0, durationMs };
    if (outcome === 'success' && READS.has(this.#operation)) event.hits = counts.hits ?? 0;
    if (errorCode !== undefined) event.errorCode = errorCode;
    try {
      hook.call(this.#hooks, Object.freeze(event));
    } catch {
      const notify = this.#hooks?.onHookError;
      if (notify !== undefined) quietly(() => notify.call(this.#hooks, Object.freeze({ code: 'hook' as const })));
      if (this.#logger !== undefined) {
        this.#emit('kvpg.hook.failed', 17, 'kvpg hook failed', {
          ...baseAttributes(this.#operation, this.#trigger), 'kvpg.outcome': 'error', 'error.type': 'hook', 'kvpg.duration': seconds,
        });
      }
    }
  }
}
