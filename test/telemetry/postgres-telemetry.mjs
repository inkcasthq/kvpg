// Registers the telemetry suite on the PostgreSQL store for one major version (docs/telemetry.md, README.md).
// Each version has its own test file, so that each file has its own worker and one provider lifetime.
import { after } from 'node:test';
import { VERSION } from '../../packages/kvpg/dist/index.js';
import { closePools, databaseUrls, makePostgresFixture, serverMajors } from './postgres-fixture.mjs';
import { telemetryConformance } from './suite.mjs';

/** The cases that need a part outside build batch 1. Each names its issue. */
const PENDING = Object.freeze({
  driverInstrumentation: '#6: the pg driver instrumentation (CLIENT span owner) is a later build phase',
  adapter: '#4 and #5: no adapter is built in batch 1',
});

export async function registerPostgresTelemetry(major) {
  const urls = databaseUrls();
  const found = urls.length === 0 ? undefined : (await serverMajors(urls)).find((entry) => entry.major === major);
  after(closePools);
  telemetryConformance(`PostgreSQL ${major}`, found === undefined ? undefined : makePostgresFixture(found.url), {
    store: 'postgresql',
    version: VERSION,
    defaultEnabled: true,
    auxiliaryOperations: ['schemaSql', 'migrate'],
    pending: PENDING,
    unavailable: `no PostgreSQL ${major} database in KVPG_TEST_DATABASE_URLS`,
  });
}
