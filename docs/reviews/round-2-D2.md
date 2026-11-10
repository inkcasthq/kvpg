# D2: adversarial store and suite review

MEASURED. The review fixes five defects in separate commits.

| ID | Defect | Fix commit | Before | After |
| --- | --- | --- | --- | --- |
| F1 | Sparse key arrays bypass validation | 21f6f57 | 10 failures across five stores | 158 passes, no skips |
| F2 | SQL literals depend on session backslash behavior | d905e9e | 8 failures on PostgreSQL 15-18 | 8 new cases pass on PostgreSQL 15-18 |
| F3 | Array serializers can write unreadable JSON bytes | 35e8a1f | 5 failures across five stores | 158 passes, no skips |
| F4 | The contract gate accepts impossible calendar dates | caeee49 | 5 samples and their parent fail | Full run: 812 passes, 14 existing skips |
| F5 | Invalid encoded output returns the wrong error code | 720416b | 5 failures across five stores | 163 passes, no skips |

F2 uses explicit PostgreSQL escape literals. The tests operate a harmless second SELECT through the old helper and parse the actual generated schedule arguments. The tests do not operate the pg_cron scheduler because the test databases lack that extension.

MEASURED. `test/store/adversarial.test.mjs` passes 28 tests on PostgreSQL 15, 16, 17 and 18. It covers both commit orders for concurrent set and setMany, conditional writes against commit and rollback, the exact expiry boundary, clock skew, limits, cleanup during renewal, real connection loss and telemetry for every closed operation.

The connection-loss test terminates only the connection that the test creates. A database trigger holds the batch at a known lock wait. No partial write survives. A new connection then completes a valid batch. The error produces one span, one call count, one error count and one duration observation.

The new tests preserve the existing pending work. Driver instrumentation, adapter delegation and Prometheus integration remain outside this first batch. Their skipped cases are not evidence of success.
