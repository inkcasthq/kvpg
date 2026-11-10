# kvpg

A key-value cache in PostgreSQL for Node.js, with a written contract that other stores can also keep.

Status: release 1.0 in progress. The contract (version 1), the design decisions and the contract payloads are written. The issues below track the work. Do not use kvpg in production before release 1.0.

## Why

If an application already has PostgreSQL, a cache table can replace a separate cache server for many workloads. The design of kvpg follows a measured article (Umesh Yadav, umesh.dev, 2026-09-24). It keeps updates HOT, it decides expiry by the clock of the database, and it deletes expired rows in batches. `docs/design.md` gives each choice and its source.

kvpg also writes the behavior down as a standard (`docs/standard.md`), with a conformance suite. A Valkey store or an in-memory store can pass the same suite. An application can then change its cache store and keep its tests.

## Layout

| Path | What | State |
|---|---|---|
| `docs/standard.md` | The cache contract, rules S1 to S14 | Written |
| `docs/spec-1.0.md` | The 1.0 specification, R01 to R23 | Written |
| `docs/decisions.md` | The owner decisions and the design refinements | Written |
| `docs/telemetry.md` | The native telemetry contract, T01 to T13 | Written |
| `docs/design.md` | The table, the SQL and the choices, with sources | Written |
| `docs/extending.md` | The five extension points | Written |
| `contracts/` | The contract payloads as JSON Schema 2020-12, with samples | Written |
| `test/contracts/` | The contract gate test and the drift test of types against schemas | Written |
| `packages/kvpg` | `@inkcasthq/kvpg`: the contract types (version 1) and the extension points | Types written, store planned (#2) |
| `packages/kvpg-conformance` | `@inkcasthq/kvpg-conformance`: the test suite of the contract | Planned (#3) |
| `packages/kvpg-keyv` | `@inkcasthq/kvpg-keyv`: a Keyv storage adapter | Planned (#4) |

## Requirements

- Node.js 22, 24 or 26. Node.js 20 reached its end of life on 2026-04-30.
- PostgreSQL 15 or later. The CI tests 15, 16, 17 and 18.

## Work

The epic is issue #1. Each package and each measurement has its own issue, and each change comes by pull request with tests.

## Credits

The table and the SQL follow the article of Umesh Yadav. The list of operations follows his Rust library pgkv (MIT). kvpg copies no code from either. `NOTICE` has the details.

## Licence

Apache License 2.0. See `LICENSE` and `NOTICE`.
