# kvpg telemetry contract for 1.0

This draft defines native telemetry for every kvpg store and adapter.
Telemetry means traces, metrics, and structured log records.
The API supplies interfaces that record signals.
The SDK processes signals for the application.
A span describes one timed operation in a trace.
An exporter sends recorded signals to a destination.

`MUST` states a requirement. `SHOULD` states a recommendation with a documented reason for each deviation.
These keywords use the meanings of RFC 2119.
Each numbered rule cites its authority.
Detailed policies under issue #6 are choices of this draft, unless the text marks an open owner choice.
The tests for this contract belong to issue #3.
This draft does not claim that the store or its telemetry exists.

## T01. Dependencies and ownership

Every store and adapter MUST implement this contract as native behavior [O6].
The main package MUST depend on `@opentelemetry/api` only for OpenTelemetry interfaces [O6].
Its runtime dependencies MUST exclude SDKs, exporters, samplers, instrumentation packages, and a separate logs API package [O6].
The application owns providers, resources, processors, exporters, sampling, propagation, and shutdown.
kvpg MUST NOT install global providers, change application propagation, start an exporter, or open a metrics server [O6].
kvpg MUST NOT detect installed SDK packages to choose whether telemetry is enabled [M].
The conformance development environment can use SDKs and in-memory exporters.

## T02. Versions remain an owner choice

OPEN OWNER CHOICE #14: the supported API and SDK ranges are undecided [O14].
Option A qualifies API `>=1.10.0 <1.11.0` with stable SDK packages `>=3.0.0 <4.0.0`.
Option B qualifies API 1.9 and SDK 2 with a separate application logger bridge.
Option B needs a revised logs design because the main package cannot depend on a separate logs API.
Recommendation: select Option A, then qualify exact minimum and current pairs before widening either range.
API 1.10 includes the logs interface [JS3].
No API/SDK pair is qualified by this document.

Each release MUST name its tested ranges and exact test pairs [O14].
The suite MUST exercise each supported pair without providers, with providers first, and with providers registered after store creation [O14].
Late registration applies to subsequent operations. Earlier signals do not replay.
The store MUST retain API access that permits subsequent operations to use late providers [O14].
The suite MUST measure late registration separately for traces, metrics, and logs [O14].

## T03. Switches and the open default

The proposed store configuration is:

```ts
type TelemetryOptions = boolean | {
  enabled?: boolean;
  traces?: boolean;
  metrics?: boolean;
  logs?: boolean;
  slowOperationMs?: number;
};
// createStore({ db, telemetry: TelemetryOptions })
```

The store MUST support this per-instance switch and `OTEL_NODEJS_INSTRUMENTATION_KVPG_ENABLED` as its single environment switch [O6].
The environment accepts trimmed, case-insensitive `true`, `1`, `false`, and `0`.
An absent, empty, or unrecognized value means unset.
The environment is read once at store creation.
No warning includes its raw value.

The resolved master switch uses the first defined value: instance `enabled`, the environment switch, then the selected release default.
A boolean `telemetry` supplies instance `enabled`.
An omitted signal switch means true.
If either switch is false, the signal is disabled.
Thus `enabled: false` disables all three signals, even with `traces: true`.
The implementation MUST obey this precedence independently for each store [O6].
With a signal disabled, kvpg MUST make no recording calls for that signal [O6].
With all signals disabled, kvpg MUST skip telemetry clocks, attribute construction, and API calls for the operation [O6].
Application hooks remain independent of these switches.

OPEN OWNER CHOICE #6: the release default is undecided.
Option A enables all three signals by default. A compatible application pipeline receives native telemetry without store configuration.
Option B disables all three signals by default. The application enables telemetry through the environment or the store configuration.
Recommendation: select Option A to match the native telemetry goal.
Option B matches the default recommended by the MongoDB tracing specification [M].
Neither option proves a cost claim.
The suite accepts an explicit default declaration until the owner selects the release default.

## T04. Scope and operation names

The instrumentation scope identifies the library that emits a signal.
The tracer, meter, and logger MUST use scope name `kvpg` and the emitting package version [O6].
Adapters MUST delegate to the underlying store without adding another kvpg observation for the same operation [O6].
A store implementation records its own public operation.

The operation vocabulary is fixed:

| Public method | Span name | Kind |
|---|---|---|
| `get` | `kvpg.get` | `INTERNAL` |
| `getMany` | `kvpg.getMany` | `INTERNAL` |
| `set` | `kvpg.set` | `INTERNAL` |
| `setMany` | `kvpg.setMany` | `INTERNAL` |
| `delete` | `kvpg.delete` | `INTERNAL` |
| `deleteMany` | `kvpg.deleteMany` | `INTERNAL` |
| `deletePrefix` | `kvpg.deletePrefix` | `INTERNAL` |
| `has` | `kvpg.has` | `INTERNAL` |
| `ttl` | `kvpg.ttl` | `INTERNAL` |
| `expire` | `kvpg.expire` | `INTERNAL` |
| `persist` | `kvpg.persist` | `INTERNAL` |
| `cleanupExpired` | `kvpg.cleanupExpired` | `INTERNAL` |
| `close` | `kvpg.close` | `INTERNAL` |
| `schemaSql` | `kvpg.schemaSql` | `INTERNAL` |
| `migrate` | `kvpg.migrate` | `INTERNAL` |

With traces enabled, each public operation MUST create exactly one INTERNAL span with the listed name [O6].
The operation includes input refusal, an empty batch, and a call after close.
The span starts before input processing and ends after the operation settles, before application hook delivery.
`createStore` is construction and creates no operation span.
An implementation MUST avoid nested kvpg spans from internal calls, such as `getMany` calling a private read helper [O6].
`schemaSql` inside `migrate` is an internal call and adds no second kvpg span.

## T05. Parents, database spans, and retries

The current application context is the parent of a foreground operation.
Context means the trace identity active during an operation.
With a valid operation context, the store MUST make that context current across asynchronous work and restore its caller context afterward [O6].
Concurrent operations MUST retain separate parents and separate completion data [O6].
kvpg uses the application propagation API and the application W3C Trace Context propagator.
kvpg MUST NOT put trace headers, trace comments, baggage, or cached data into SQL or stored values [O6], [O13].

Database CLIENT spans and `db.client.operation.duration` belong to the driver instrumentation.
kvpg MUST NOT emit either database observation under this ownership policy [O6].
The driver instrumentation creates its CLIENT children under the active kvpg operation.
An uninstrumented driver produces no database CLIENT spans.
Each store integration MUST document the driver instrumentation that owns its database observations [O6].
Driver instrumentation is application configuration and is outside the main package dependency tree.
The application MUST disable query parameters, query text, and exception capture that can expose cached data in the selected driver instrumentation [O13].
This restriction applies to the qualified integration, even though kvpg cannot control an unrelated application instrumentation.

kvpg adds no automatic retry policy in 1.0.
If a driver retries, the retry stays inside the same public-operation span.
The suite MUST make sure that each observed database attempt has one CLIENT owner, including retry, failure, and recovery paths [O6].
The store MUST count one public operation, rather than one operation per database attempt [O6].

## T06. Cleanup context

A manual `cleanupExpired` call uses its caller context.
An interval cleanup uses `ROOT_CONTEXT`, so a request that created the store does not become its parent.
Each interval invocation MUST create one `kvpg.cleanupExpired` INTERNAL span with trigger `interval` [O6].
Each manual invocation MUST use trigger `foreground` [O6].
Database batches remain children of that invocation through driver instrumentation.
The store MUST prevent overlapping interval invocations from the same store [O6].
Separate stores can clean concurrently under S10.
Database-scheduled `pg_cron` work does not execute JavaScript.
kvpg MUST NOT invent spans, durations, or removed-row counts for database-scheduled work that it cannot observe [O6].
`close` MUST stop telemetry-related timers that the store owns without stopping application providers [O6], [S11].

## T07. Privacy and the single allowlist

An allowlist names every permitted observation field.
This table covers kvpg span attributes, metric attributes, log attributes, and hook fields.
The metric rules narrow this list further.

| Field | Permitted value | Use |
|---|---|---|
| `kvpg.operation` | A method from T04 | Every signal |
| `kvpg.store` | A fixed implementation identifier, such as `postgresql` | Every signal |
| `kvpg.trigger` | `foreground` or `interval` | Every signal |
| `kvpg.outcome` | `success` or `error` | Completion signals |
| `error.type` | A contract error code, or `hook` | Error signals only |
| `kvpg.keys` | A nonnegative integer | Spans and logs |
| `kvpg.hits` | A nonnegative integer | Successful read spans |
| `kvpg.misses` | A nonnegative integer | Successful read spans |
| `kvpg.rows_deleted` | A nonnegative integer | Cleanup spans and logs |
| `kvpg.batches` | A nonnegative integer | Cleanup spans and logs |
| `kvpg.duration` | Nonnegative seconds | Logs |
| `event.name` | A log event from T10 | Logs |
| Hook `operation` | A method from T04 | Hook event |
| Hook `keys`, `hits`, `durationMs` | Safe counts and elapsed milliseconds | Hook event |
| Hook `errorCode` | A contract error code | Failed operation hook |
| Hook-error `code` | `hook` | `onHookError` argument |

Contract error codes are `invalid_key`, `invalid_ttl`, `invalid_value`, `codec`, `driver`, and `closed`.
The implementation identifier is a library constant, never a caller-supplied instance name.
Scope version, timestamps, trace IDs, span IDs, flags, severity, fixed bodies, and fixed span names are structural fields.
The application owns resource attributes and baggage.
kvpg does not copy either into its attributes.

Every kvpg signal and hook argument MUST contain only these permitted fields and structural fields [O13].
Signals, span events, link attributes, hook arguments, and diagnostics MUST NOT contain keys, prefixes, namespaces, values, or error causes [O13].
The ban includes encoded, hashed, truncated, and stringified forms.
kvpg MUST exclude SQL, parameters, connection strings, addresses, table names, arbitrary error messages, stacks, and exception events [O13].
kvpg MUST NOT call `recordException` or forward an `Error` object to an observer [O13].
kvpg MUST keep the original S12 `KvError.cause` for the caller [S12], [O13].
Caller error fidelity does not permit telemetry disclosure.

The current `OperationEvent.error` and `onHookError(error)` types need safe replacements before implementation.
An operation hook receives `errorCode` instead of an error object.
`onHookError` receives only `{ code: 'hook' }`.
The store MUST isolate a throwing hook and preserve the original operation result [E51], [O13].
If `onHookError` throws, the store discards that observer failure without recursion or console output.

## T08. Span creation and cost gates

The initial attributes are `kvpg.operation`, `kvpg.store`, and `kvpg.trigger`.
The store `SHOULD` cache these fixed names and values for concurrent use [M].
With traces enabled, it MUST create the span before inspecting its context validity or recording state [O6], [M].
If `isSpanContextValid(span.spanContext())` is false, it MUST skip further span work [O6], [M].
This path does not activate, enrich, set status, or end the invalid span.
The store still performs the cache operation and handles enabled metrics and logs independently.

If the context is valid, the store MUST activate it even if `span.isRecording()` is false [O6], [M].
If the span does not record, the store MUST skip completion attributes, status, and span events [O6], [M].
It still ends a valid span exactly once.
If the span records, the store MUST add safe completion attributes and end it exactly once [O6].
Success keeps status `UNSET`.
A failure sets status `ERROR` and `error.type`, without a status description or an exception event.
T09 defines read counts and cleanup counts.
Other spans omit unavailable counts.
`kvpg.keys` counts supplied key occurrences, including duplicates.
Prefix, cleanup, migration, schema, and close operations omit `kvpg.keys`.

Metric and log recording MUST NOT depend on trace sampling, span validity, or `isRecording()` [O6].
The store MUST use a monotonic clock for elapsed durations [O6].
An enabled signal MUST NOT change the result, rejection, or caller error cause of an operation [S12], [O6].
An API recording failure MUST NOT become a cache failure or produce recursive diagnostics [S12], [O6].

## T09. Metrics

kvpg metrics describe public cache operations, rather than database attempts.
These four names are custom kvpg metrics, not database semantic conventions.
The store MUST use the following instruments and units with metrics enabled [O6].

| Name | Instrument | Unit | Record rule |
|---|---|---|---|
| `kvpg.operation.duration` | Histogram | `s` | Once per completed public operation, including errors and empty batches |
| `kvpg.cache.hits` | Counter | `{key}` | Successful `get`, `getMany`, `has`, and `ttl` live results |
| `kvpg.cache.misses` | Counter | `{key}` | Successful `get`, `getMany`, `has`, and `ttl` missing results |
| `kvpg.cleanup.rows_deleted` | Counter | `{row}` | Confirmed expired rows removed by `cleanupExpired` |

Every duration point has exactly `kvpg.operation`, `kvpg.store`, `kvpg.trigger`, and `kvpg.outcome`.
An error duration point also has `error.type`.
Each counter point has exactly `kvpg.operation`, `kvpg.store`, and `kvpg.trigger`.
The store MUST omit all other metric attributes, including numeric counts, IDs, and names supplied by callers [O13], [O6].
It MUST record durations in seconds and counter increments as nonnegative integers [O6].
Zero counter increments produce no point.
Every successful read occurrence counts once, including a repeated key in `getMany`.
An expired entry counts as a miss under S1.
A persistent `ttl` result counts as a hit.
Failed reads contribute no hit or miss increments.
Writes, deletes, `expire`, and `persist` contribute neither hits nor misses.

Cleanup increments the removed-row counter after each confirmed batch.
A later failed batch does not erase the confirmed increments.
Its operation duration records an error.
The store MUST NOT infer deleted rows from requested batch size or from a failed query [O6].
Metrics MUST remain available with traces disabled or sampled out [O6].
The generic driver interface exposes no portable pool measurements.
kvpg publishes no pool metrics in 1.0.

The database instrumenter can emit `db.client.operation.duration` as a Histogram in `s` [DBM].
That Stable database metric is distinct from `kvpg.operation.duration`.
Its collection remains subject to the ownership and privacy requirements in T05.

## T10. Logs

With logs enabled, the store MUST use OpenTelemetry log records with timestamp, severity, fixed body, safe attributes, and available trace context [O6], [LOG].
There is no console, JSON-file, or logger-bridge duplicate of a native record.
The store MUST use one native emission owner per log event [O6].
The log rules are:

| Event name | Severity | Fixed body | Trigger |
|---|---|---|---|
| `kvpg.operation.failed` | `ERROR`, 17 | `kvpg operation failed` | One failed public operation |
| `kvpg.operation.slow` | `WARN`, 13 | `kvpg operation slow` | One successful operation at or over the threshold |
| `kvpg.cleanup.recovered` | `INFO`, 9 | `kvpg cleanup recovered` | First successful interval cleanup after one or more failed interval invocations |
| `kvpg.hook.failed` | `ERROR`, 17 | `kvpg hook failed` | One failed operation hook |

Every record includes `event.name`, the operation, store, trigger, outcome, and `kvpg.duration`.
Failure records include the safe `error.type`.
Hook failures use `hook` and outcome `error` without changing the operation outcome.
Cleanup records include confirmed row and batch counts.
The store MUST emit records according to this table and the T07 allowlist [O6], [O13].
If multiple internal actions fail, the operation emits one failure record.
A failed operation does not also emit a slow record.
`slowOperationMs` is a finite positive number in milliseconds.
An omitted threshold disables slow records.
The threshold `SHOULD` come from application latency requirements rather than an invented universal default [O6].
No successful foreground operation emits an ordinary success record.

Recovery state belongs to each interval cleanup loop.
An initial success produces no recovery record.
After repeated failures, one success produces one recovery record and resets that state.
The store MUST reset this state without mixing separate store instances [O6].
Logs use the valid active operation context, even for a nonrecording span.
With traces disabled, logs retain the valid caller context.
With no valid context, trace identity fields are absent.
The store MUST NOT synthesize trace IDs for logs [LOG].

## T11. Open formats and Prometheus

The integration MUST use OpenTelemetry and W3C Trace Context without a proprietary signal format [O6].
The application supplies OTLP export or an OpenTelemetry Prometheus exporter.
kvpg itself exposes no exporter configuration.
Both supported Prometheus routes use the same kvpg instruments:

| Route | Application responsibility | Prometheus responsibility |
|---|---|---|
| Scrape | Attach the OpenTelemetry Prometheus exporter as a metric reader | Scrape the exporter endpoint |
| OTLP | Attach the OpenTelemetry OTLP/HTTP metric exporter | Enable `--web.enable-otlp-receiver` |

The OTLP receiver accepts metrics at `/api/v1/otlp/v1/metrics` [PROM].
For OTLP/HTTP, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` contains the full endpoint URL.
A signal-specific endpoint is used unchanged [OTLP].
Neither route requires user-written cache metrics or `prom-client` inside kvpg.
The release integration tests MUST exercise both routes outside the main package [O6].

## T12. Cost acceptance

Before a telemetry cost claim, the benchmark MUST operate all four setups on the same source and workload [O6], [M].
Each setup starts in a fresh process without an active parent span.

| Setup | Configuration |
|---|---|
| `off` | All telemetry disabled |
| `api-only` | All telemetry enabled, with no registered providers |
| `sdk-ratio` | All telemetry enabled, with a 1% `TraceIdRatioBasedSampler` |
| `sdk-always` | All telemetry enabled, with an `AlwaysOnSampler` |

The two SDK setups use the same metric and log providers.
Their trace setup records without a trace processor or exporter, to separate recording cost from delivery cost.
An additional end-to-end export measurement can report delivery cost separately.
The benchmark MUST report latency, throughput, allocations or heap delta, CPU time, sample counts, and overhead relative to `off` [O6].
It MUST include warm-up, interleaved setup order, repetitions, versions, source SHA, commands, and raw output [O6], [M].
It MUST cover hits, misses, writes, batches, input refusals, driver errors, and cleanup [O6].
Report trace-only measurements as a separate series to isolate the span gates.
The benchmark `SHOULD` compare the selected default against the commit before telemetry support [M].
No numeric budget is selected here. No no-op or enabled cost is measured here.

## T13. Conformance and release tests

Every store MUST pass the same telemetry suite with in-memory trace, metric, and log exporters [O6].
The suite MUST use synthetic secret markers and inspect entire exported records and hook arguments [O13].
Inspection includes attributes, events, links, status, bodies, resource fields, scope fields, and error paths.
The application fixture supplies fixed public-safe resource attributes.
The suite MUST preserve full caller causes while detecting markers in observations [S12], [O13].
Each integration MUST also demonstrate the privacy of its selected database instrumenter [O6], [O13].

The acceptance matrix is:

| Test group | Positive case | Negative or recovery case |
|---|---|---|
| T01 | API-only runtime dependency tree | SDK import or provider mutation fails acceptance |
| T02 | SDK first and SDK late, per signal | No providers, supported pair boundaries, instance off |
| T03 | Every switch and precedence combination | Invalid environment value, two stores with different switches |
| T04 | Every public name and one INTERNAL span | Empty batches, input refusal, closed store, internal delegation |
| T05 | Parent-child context under concurrent calls | Failed queries, driver retries, caller context restoration |
| T06 | Manual and interval cleanup parents | Concurrent stores, interval overlap, close, database-only scheduling |
| T07 | Every allowed field and caller cause | Key, value, prefix, namespace, codec, driver, and hook markers |
| T08 | Recording span and valid dropped span | Invalid context, throwing API, trace-independent metrics and logs |
| T09 | Exact names, units, attributes, and count totals | Duplicate reads, expired misses, failed reads, partial cleanup |
| T10 | Failure, slow success, and recovery records | No duplicate records, failed hooks, repeated cleanup failures |
| T11 | Scrape and OTLP integration | No kvpg server, no duplicate database duration metric |
| T12 | All four benchmark setups | Missing setup or raw output blocks a cost claim |

Each test that requires the unbuilt PostgreSQL store MUST remain explicitly pending with issue #2 [O2], [O6].
A pending test is not conformance proof.
The release MUST have no pending telemetry acceptance cases for a supported store and API/SDK pair [O3], [O6], [O14].

## Sources

The issue sources were read from the saved owner snapshot on 2026-11-08.
External specifications were read on 2026-11-08.
Local line references describe baseline `ba7f1c1`.

[O2]: https://github.com/inkcasthq/kvpg/issues/2 "Store implementation and acceptance, read 2026-11-08"
[O3]: https://github.com/inkcasthq/kvpg/issues/3 "Portable conformance suite, read 2026-11-08"
[O6]: https://github.com/inkcasthq/kvpg/issues/6 "Owner telemetry decisions, including 2026-11-08 23:00 UTC, read 2026-11-08"
[O13]: https://github.com/inkcasthq/kvpg/issues/13 "Signal and hook privacy, read 2026-11-08"
[O14]: https://github.com/inkcasthq/kvpg/issues/14 "Open API/SDK qualification, read 2026-11-08"
[S11]: standard.md#rules "docs/standard.md:45, baseline ba7f1c1"
[S12]: standard.md#rules "docs/standard.md:47, baseline ba7f1c1"
[E51]: extending.md#3-hooks "docs/extending.md:51, baseline ba7f1c1"
[M]: https://github.com/mongodb/specifications/blob/a939a78/source/open-telemetry/open-telemetry.md "Cross-driver tracing model and cost gates, read 2026-11-08"
[JS3]: https://github.com/open-telemetry/opentelemetry-js/blob/v3.0.0/doc/3.x/migration-guide.md "API 1.10 logs and SDK 3 migration, read 2026-11-08"
[DBM]: https://github.com/open-telemetry/semantic-conventions/blob/v1.45.0/docs/db/database-metrics.md "Stable database duration metric, read 2026-11-08"
[LOG]: https://github.com/open-telemetry/opentelemetry-specification/blob/v1.62.0/specification/logs/data-model.md "Log fields and trace identity, read 2026-11-08"
[PROM]: https://prometheus.io/docs/guides/opentelemetry/ "Prometheus OTLP receiver, read 2026-11-08"
[OTLP]: https://github.com/open-telemetry/opentelemetry-specification/blob/v1.62.0/specification/protocol/exporter.md#endpoint-urls-for-otlphttp "OTLP/HTTP endpoint rules, read 2026-11-08"
