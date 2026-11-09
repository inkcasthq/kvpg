# Changelog

All changes to the contract and the packages are listed here. The format follows Keep a Changelog, and the versions follow Semantic Versioning.

## Unreleased

### Added

- Telemetry conformance assertions and pending store tests, with an in-memory exporter harness and tests for both Prometheus routes.
- The combined 1.0 specification (`docs/spec-1.0.md`), with behavior, implementation logic, acceptance tests, and open owner decisions.
- The native telemetry specification (`docs/telemetry.md`), with open owner choices for the default and supported API/SDK versions.
- The cache contract, version 0 (`docs/standard.md`), and its TypeScript types.
- The extension points: driver, codec, hooks, cleanup policy and table options.
- The design of the PostgreSQL store (`docs/design.md`).
