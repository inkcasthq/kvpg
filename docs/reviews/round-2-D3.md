# D3: owner decision audit

| Decision | Source and contract | Measured result |
| --- | --- | --- |
| #11 | `store.ts:200-224`, `sql.ts:71-79`, `contract.ts:31-32`, `contracts/operations/setMany.schema.json:21-43` | A2 proves per-entry conditional outcomes. A4 proves invalid_batch before any query for repeated keys. |
| #12 | `store.ts:166-187`, `contract.ts:28-29`, `contracts/common.schema.json:119-158` | A3 proves tagged reads. S1 proves stored undefined through a custom codec. F5 corrects the encode-error code. |
| #14 | `packages/kvpg/package.json:13-19`, `telemetry.ts:7,38-48`, `docs/telemetry.md:35-45` | API 1.9.1, SDK 2.12.1 and logs 0.223.1 pass. The remaining version range is NOT REACHED. |
| #6 | `extension.ts:97-109`, `telemetry.ts:69-86,126-146,206-211`, telemetry contract T03 | Nine new tests prove no-provider behavior, late registration and both off-switch forms on PostgreSQL 15-18. |
| #16 | `contract.ts:54-63`, `store.ts:84-90,395-397,432-437`, `contracts/common.schema.json:239-265` | A4 and S14 prove exact limits, separate error codes, no query on refusal and recovery. |

Source paths without a prefix refer to `packages/kvpg/src/`. The installed SDK metric package accepts API versions below 1.10.0. The declared API peer range extends beyond that tested pair. Phase 6 of the build plan owns the remaining qualification. This review runs no install and makes no manifest change.

The new owner-decision test creates stores before providers. It first observes zero recording calls. After provider registration, the default store emits spans, metrics and a failure log. Both disabled stores remain silent. The run passes nine tests with no failures or skips.
