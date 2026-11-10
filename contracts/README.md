# Contract payloads

This folder gives the payloads of the kvpg contract, version 1, as JSON Schema 2020-12.
`docs/standard.md` states the rules (S1 to S14). The TypeScript types of `packages/kvpg/src` state the same payloads.
Two tests keep the three in step. Both run in `npm test`.

## Layout

| Path | Content |
| --- | --- |
| `common.schema.json` | The shared definitions: key, value, expiry options, entry, read result, write outcome, time to live, cleanup options and result, limits, error code, operation |
| `operations/<operation>.schema.json` | One file for each of the 15 operations. `$defs.input` is the argument list, `$defs.result` the resolved value, `$defs.error` the `KvError` with the codes that this operation can raise |
| `telemetry/spans.schema.json` | One finished kvpg span in normal form (T04, T07, T08) |
| `telemetry/metrics.schema.json` | One kvpg metric point in normal form (T09) |
| `telemetry/logs.schema.json` | One kvpg log record in normal form (T10) |
| `telemetry/hooks.schema.json` | The hook arguments: the operation event and the hook-error notice (T07) |
| `samples/<schema path>.samples.json` | Valid and invalid samples for each schema |

## Rules of the schemas

- An operation input is an array of the arguments in order. A trailing optional argument makes `minItems` lower than the tuple length. `items: false` closes the tuple.
- A date-time string is the payload form of a `Date`.
- The `none` definition is the result of an operation that resolves with no value (`void`).
- The schemas use no `oneOf`, `anyOf` or `not`. A union with a tag property uses `if`, `then` and `else` on that tag. Thus each refusal names one rule.
- `x-kvpg-utf8` is a kvpg keyword for strings. `maxBytes` limits the UTF-8 length, `wellFormed` refuses a lone surrogate, and `noNul` refuses the NUL character (S3).
- An object of an operation input accepts other properties, and the store ignores them. A result object and a telemetry record accept no other property.

Some rules need the store configuration or the whole batch, so no schema can state them. The store applies them, and the conformance suite tests them:

- A key two or more times in one `setMany`: `invalid_batch` (S7).
- A value or a batch over the store limits: `value_too_large` or `batch_too_large` (S14).
- A value outside the codec domain: `invalid_value` (RF18).

## Normal form of a telemetry record

The telemetry tests convert each exported record before they apply a schema:

| Signal | Normal form |
| --- | --- |
| Span | `{ name, kind, status, attributes }`. `kind` is the `SpanKind` name, `status` the `SpanStatusCode` name |
| Metric point | `{ name, instrument, unit, attributes, value }`. `instrument` is `histogram` or `counter`. A histogram value is `{ count, sum }` |
| Log record | `{ eventName, severityNumber, body, attributes }` |

## Samples

Each samples file names its schema and holds a list of cases. A case gives `def` (the `$defs` entry, or no `def` for the root), `name`, `valid` and `data`.
An invalid case also gives the `keyword` and the `instancePath` of the one rule that it breaks, and can give `params`.

## Tests

- `test/contracts/gate.test.mjs` compiles every schema with Ajv in strict mode. Each valid sample must pass. Each invalid sample must fail with exactly one error, and that error must have the stated keyword, path and params.
- `test/contracts/drift.test.mjs` converts each schema to a TypeScript type and lets `tsc` compare it with the package type. It also compares the error codes, the operations and the limit defaults with the package constants. The telemetry schemas must match the tables of `docs/telemetry.md`.
