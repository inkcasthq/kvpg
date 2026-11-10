import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { assertPrivateDataAbsent } from './assertions.mjs';
import { createSession } from './sdk-harness.mjs';

function loopbackURL(value) {
  const url = new URL(value);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'integration endpoints must use loopback');
  assert.equal(url.protocol, 'http:');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  return url;
}

async function query(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
  assert.equal(response.ok, true, 'Prometheus query request failed');
  const body = await response.json();
  assert.equal(body.status, 'success');
  assert.equal(body.data.resultType, 'vector');
  assert.ok(body.data.result.length <= 1, 'the sum query must return at most one value');
  const count = body.data.result.length === 0 ? 0 : Number(body.data.result[0].value[1]);
  assert.ok(Number.isFinite(count) && count >= 0);
  return { count, body };
}

// Call each route from its own node:test file, with one provider lifetime.
export function prometheusAcceptance(route, makeIntegration) {
  assert.ok(['scrape', 'otlp'].includes(route));
  if (makeIntegration !== undefined) assert.equal(typeof makeIntegration, 'function');
  test(`T11 Prometheus ${route} receives the native cache counter without duplicate increments`, {
    skip: makeIntegration === undefined ? '#6: the owned Prometheus integration fixture is a later build phase; the store of #2 is built' : false,
    timeout: 15_000,
  }, async () => {
    const integration = await makeIntegration(route);
    let session;
    let fixture;
    try {
      const endpoint = new URL('/api/v1/query', loopbackURL(integration.prometheusURL));
      endpoint.searchParams.set('query', 'sum({__name__=~"kvpg[._]cache[._]hits.*", kvpg_operation="get"})');
      assert.equal((await query(endpoint)).count, 0, 'each route needs a fresh Prometheus data directory');
      session = await createSession({ metricReaders: [integration.metricReader] });
      fixture = await integration.makeFixture({ telemetry: { enabled: true } });
      const key = 'KVPG_PROMETHEUS_SYNTHETIC_KEY_711';
      const value = 'KVPG_PROMETHEUS_SYNTHETIC_VALUE_712';
      await fixture.store.set(key, value);
      assert.equal(await fixture.store.get(key), value);
      await session.snapshot();

      // Poll only for asynchronous ingestion. Never repeat the store operation.
      const end = performance.now() + 5_000;
      let result;
      do {
        result = await query(endpoint);
        assert.ok(result.count <= 1, 'native counter was duplicated');
        if (result.count === 1) break;
        await delay(25);
      } while (performance.now() < end);
      assert.equal(result.count, 1, 'Prometheus did not ingest the single hit');
      assertPrivateDataAbsent(result.body, [key, value]);

      if (route === 'scrape') {
        const response = await fetch(loopbackURL(integration.scrapeURL), { signal: AbortSignal.timeout(1_000) });
        assert.equal(response.ok, true);
        const text = await response.text();
        assert.match(text, /kvpg_cache_hits/);
        assertPrivateDataAbsent(text, [key, value]);
      } else {
        const response = await fetch(new URL('/api/v1/status/flags', loopbackURL(integration.prometheusURL)), { signal: AbortSignal.timeout(1_000) });
        assert.equal(response.ok, true);
        const flags = await response.json();
        assert.equal(flags.data['web.enable-otlp-receiver'], 'true');
        const metricsEndpoint = loopbackURL(integration.metricsEndpoint);
        assert.equal(metricsEndpoint.origin, loopbackURL(integration.prometheusURL).origin);
        assert.equal(metricsEndpoint.pathname, '/api/v1/otlp/v1/metrics');
      }
    } finally {
      try { if (fixture) await fixture.dispose(); }
      finally {
        try { if (session) await session.shutdown(); }
        finally { await integration.dispose(); }
      }
    }
  });
}
