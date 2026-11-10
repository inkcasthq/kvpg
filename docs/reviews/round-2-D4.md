# D4: final local test evidence

MEASURED. Runtime source: `6080721`. The review starts at `39d61cb`. Both runs use PostgreSQL 15.19, 16.15, 17.11 and 18.6 through `KVPG_TEST_DATABASE_URLS`. The environment uses Node v26.13.0 and npm 11.20.0.

| Command | Before | After |
| --- | --- | --- |
| `npm test` | 783 total, 769 pass, 0 fail, 14 skipped | 840 total, 826 pass, 0 fail, 14 skipped |
| `npm run check` | Exit 0 | Exit 0 |

All five fixes have before-and-after regression evidence on the four-database matrix. The new adversarial suite passes 28 tests. The new owner-decision suite passes nine tests. The eight SQL literal cases pass.

The 14 existing skips remain NOT REACHED: eight driver instrumentation cases, four adapter delegation cases and two Prometheus integration cases. The actual pg_cron scheduler, other OpenTelemetry version pairs, publication and CI execution also remain NOT REACHED. This result does not satisfy a zero-skipped release gate.

`git diff 39d61cb --check` passes. Manifests and the lockfile remain unchanged. Existing LF line endings remain LF. The test databases contain no schemas with the new review prefixes after the run. All test clients, pools and processes end. No container changes, installs, pushes or publication occur.
