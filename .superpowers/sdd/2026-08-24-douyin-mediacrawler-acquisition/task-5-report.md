# Task 5 — Douyin crawler candidate conversion

Status: implemented and verified on the Task 5 base.

- Added a persisted-page-only converter, deterministic pre-model qualification policy, bounded evidence projection, record edit supersession, stable workspace-scoped subject identity, and one-way platform-scoped DNC suppression.
- Added a workspace/run/filter/snapshot cursor-bound public candidate route. It exposes only candidate display state plus a 500-code-point public excerpt and source URL.
- Added `mediacrawler_public_record` as a closed evidence provenance contract and regenerated frontend acquisition types.
- Focused, OpenAPI/conformance, aggregate acquisition, backend build, and generated contract checks passed.

The converter now reads terminal persisted Task 4 jobs through `findByRun(workspaceId, runId)` and records through `listRecords(jobId)`; it does not accept sidecar records or a caller-supplied page. The next integration increment must add the required durable page acknowledgement/retention projection and direct authoritative evidence/candidate transaction adapter.
