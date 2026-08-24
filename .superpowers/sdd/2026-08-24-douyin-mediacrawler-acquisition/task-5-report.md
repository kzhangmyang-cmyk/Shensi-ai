# Task 5 — Douyin crawler candidate conversion

Status: implemented and verified on the Task 5 base.

- Added a persisted-page-only converter, deterministic pre-model qualification policy, bounded evidence projection, record edit supersession, stable workspace-scoped subject identity, and one-way platform-scoped DNC suppression.
- Added a workspace/run/filter/snapshot cursor-bound public candidate route. It exposes only candidate display state plus a 500-code-point public excerpt and source URL.
- Added `mediacrawler_public_record` as a closed evidence provenance contract and regenerated frontend acquisition types.
- Focused, OpenAPI/conformance, aggregate acquisition, backend build, and generated contract checks passed.

Known integration boundary: the base checkout exposes only `listRecords(jobId)` and no Task-4 validated page metadata or retention acknowledgement/age projection. The converter therefore takes the explicit `getValidatedPage` Task-4 repository boundary; wiring Task 4's final persisted-page and cleanup repository methods is required when that task lands.
