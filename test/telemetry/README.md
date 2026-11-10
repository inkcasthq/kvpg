# Telemetry conformance tests

This directory tests the contract in `docs/telemetry.md`.
The current repository has no PostgreSQL store under issue #2.
The tests do not create a substitute store.
A pending case names its blocking issue.
Pending cases do not prove conformance.

The assertion tests use synthetic exported records to test the assertions themselves.
Those records are not a cache implementation or SDK output.
If the development dependencies are present, the exporter setup uses the official OpenTelemetry in-memory exporters.
The default job does not install those dependencies.
The proposed SDK 3 backend does not resolve the owner choice in issue #14.

## Operate the tests

From the repository root, operate the tests:

```sh
npm test
```

For assertions without the SDK, use:

```sh
node --test test/telemetry/assertions.test.mjs
```

The SDK probe reports package availability without substituting an exporter.
A missing development package leaves the exporter smoke case pending under #14.
A broken import from an available package fails the test.
With a real store factory supplied, a missing SDK package fails setup instead of silently skipping conformance.

## Files and evidence

| File | Purpose |
|---|---|
| `assertions.mjs` | Fixed signal schemas, privacy inspection, cumulative metric snapshots, and deltas |
| `assertions.test.mjs` | Positive and negative cases for the assertions |
| `sdk-harness.mjs` | Official exporters, application-owned providers, context, sampling, and API probes |
| `sdk-harness.test.mjs` | Dependency availability and a three-signal exporter smoke case |
| `suite.mjs` | Shared tests for a real store fixture |
| `store.test.mjs` | Explicit issue #2 pending registration |
| `prometheus.mjs` | Real Prometheus ingestion assertions for scrape and OTLP |
| `prometheus-scrape.test.mjs` | Pending scrape integration under #2 and #6 |
| `prometheus-otlp.test.mjs` | Pending OTLP integration under #2 and #6 |

The privacy inspector examines data properties, including non-enumerable causes, without calling getters.
It also examines map entries, set entries, bytes, and property names.
It detects raw markers, URI encoding, JSON escaping, base64, hexadecimal, and SHA-256 hexadecimal forms.
Hexadecimal detection accepts lowercase, uppercase, and mixed case.
The field allowlists reject arbitrary attributes even without a marker.
Every shared inspection applies the span schema to all kvpg spans, including failure and interval paths.
No finite marker set proves every possible transformation.

Metric exports contain cumulative snapshots.
The test backend uses the latest point for each complete metric stream.
A stream includes resource attributes, scope metadata, metric name, unit, aggregation kind, and point attributes.
It subtracts earlier counts and sums to isolate each case.
It does not add cumulative snapshots together.
The API probe distinguishes counters from observable instruments because exported sums alone do not distinguish them.

## SDK development dependencies

The proposed backend expects these packages in the test workspace:

- `@opentelemetry/api`, with the API 1.10 logs interface.
- `@opentelemetry/sdk-trace`, from the SDK 3 generation.
- `@opentelemetry/sdk-metrics`, from the SDK 3 generation.
- `@opentelemetry/sdk-logs`, from the SDK 3 generation.
- `@opentelemetry/resources`, from the SDK 3 generation.
- `@opentelemetry/context-async-hooks`, from the matching generation.
- `@opentelemetry/core`, from the matching generation.

These packages belong to the test environment, not the main package runtime.
The test backend registers providers only inside an isolated `node:test` worker.
It owns one provider lifetime in each worker.
It shuts down providers and metric readers after the suite.
It stops its context manager and removes only its own global registrations.
It does not replace an existing provider silently.

## Supply a real store fixture

A fixture supplies a real store and test controls.
Register the shared suite from a new test file after issue #2 supplies `createStore`:

```js
import { telemetryConformance } from './suite.mjs';
import { makePostgresFixture } from './postgres-fixture.mjs';

telemetryConformance('PostgreSQL', makePostgresFixture, {
  store: 'postgresql',
  version: '1.0.0',
  defaultEnabled: true, // Candidate declaration until the owner decides #6.
  auxiliaryOperations: ['schemaSql', 'migrate'],
});
```

The example factory is not implemented here.
The version equals the tested package version.
The default declaration describes the candidate under test, not an owner decision.
For a different package, `manifestURL` identifies its runtime manifest.
The manifest test covers declared direct dependencies.
Release qualification also examines the installed runtime tree and bundled code for forbidden SDK imports.

The factory accepts the configuration used by the case:

```ts
type FixtureConfiguration = {
  telemetry?: unknown;
  hooks?: unknown;
  cleanup?: unknown;
  codec?: unknown;
  namespace?: string;
  driverInstrumentation?: boolean;
};
```

The factory applies that configuration to its actual store.
It supplies an empty isolated namespace and a compatible physical table for each codec.
It returns the following controls:

| Member | Behavior |
|---|---|
| `store` | The actual store under test |
| `dispose()` | Stop owned store work and release fixture resources, including after an explicit close |
| `seed(entries)` | Write fixtures through the backend without creating kvpg observations |
| `queryCount()` | Return actual store-issued query attempts since fixture creation |
| `capturedQueries()` | Return actual SQL and parameters for propagation inspection |
| `failNextQuery(cause)` | Reject the next real driver attempt with this exact cause |
| `failQueryIn(n, cause)` | Reject the nth subsequent driver attempt once |
| `retryNextQuery(cause)` | Fail one observed driver attempt, then retry within that driver call |
| `holdQueries(n)` | Return an `entered` promise and `release()` for n blocked query attempts |
| `delayNextQuery(ms)` | Delay the next driver completion by the requested milliseconds |
| `runIntervalCleanup()` | Fire the actual registered interval callback and await its completion |
| `runDatabaseScheduledCleanup()` | Operate the actual database-scheduled SQL outside the JavaScript store |
| `expiredRowCount()` | Read remaining expired rows directly through the backend |
| `createAdapter()` | Return a real delegating adapter over this store |
| `driverScope` | Name the selected external driver instrumentation scope |

Failure controls wrap the real driver boundary.
They do not manufacture spans, metrics, logs, hook arguments, or store results.
Retry controls belong to the driver and do not add a kvpg retry policy.

Timer controls fire callbacks that the store actually registers.
They do not call `cleanupExpired()` as a replacement for a timer callback.
The fixture keeps timers controlled so that unrelated intervals cannot race a test.

For failed interval work, the control awaits settlement without changing the observed failure.

The first cases operate without registered providers.
The late-registration case installs the providers once.
The remaining cases use that same provider lifetime.
Each case gets a fresh store and a metric baseline.
This sequence does not require a library to support arbitrary global provider replacement.

## Supply the Prometheus integrations

Each route uses its own test worker and fresh Prometheus data directory.
Replace the undefined integration factory in the selected route file after the real fixture exists.
The factory returns these members:

| Member | Behavior |
|---|---|
| `metricReader` | An application-owned OpenTelemetry Prometheus reader or OTLP/HTTP exporting reader |
| `prometheusURL` | The loopback URL of the owned Prometheus process |
| `scrapeURL` | The loopback exporter endpoint for the scrape route |
| `metricsEndpoint` | The full Prometheus OTLP metrics endpoint for the OTLP route |
| `makeFixture(configuration)` | Create the actual store with the requested telemetry configuration |
| `dispose()` | Stop the owned Prometheus process and release its resources |

The scrape fixture configures Prometheus to scrape the supplied reader.
The OTLP fixture enables `--web.enable-otlp-receiver` and exports to `/api/v1/otlp/v1/metrics`.
The test performs one cache hit and observes one counter increment through the Prometheus query API.
Polling waits for ingestion and never repeats the store operation.
The test refuses non-loopback endpoints.
Its cleanup stops the store, providers, reader, and Prometheus process after success or failure.

## Remaining release obligations

The current pending registrations cover the absent store, missing SDK packages, and absent Prometheus fixtures.
They do not establish supported API/SDK pairs or database versions.
The full T12 benchmark remains under issues #6 and #7.

It needs real workloads for `off`, `api-only`, `sdk-ratio`, and `sdk-always` before a cost claim.
The test backend includes those sampler modes but publishes no timing result.
SDK generation boundaries and minimum-version pairs remain under #14.

Additional implementations can reuse this suite with their own real fixtures.
Release acceptance requires zero pending cases for each supported store and pair.