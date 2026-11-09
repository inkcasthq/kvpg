import { telemetryConformance } from './suite.mjs';

// Issue #2 has no createStore implementation. Do not supply a substitute store.
telemetryConformance('PostgreSQL', undefined, {
  store: 'postgresql', version: '0.0.0', auxiliaryOperations: ['schemaSql', 'migrate'],
});
