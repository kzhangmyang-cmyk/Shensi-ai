# Task 8 report: Quote HTTP publication

## Status

Implemented the complete Quote HTTP surface and mounted it once through the
Growth Quote module. The router consumes the exact Foundation workspace,
command-context, and temporal singleton references; module options cannot
replace them.

All 18 released Quote operations now have closed request parsing, concrete
response projection, released status/error mapping, ID-scoped preconditions,
idempotency replay headers, and the exact 1.0.2 response/ETag surface.

## Frozen-contract priority decision

The immutable release is authoritative over stale illustrative Task 8 prose:

- `previewQuote` and `createQuoteVersion` map missing/stale preconditions into
  their released 400/409 matrices.
- `submitQuoteVersion` returns 200 `QuoteApproval` without ETag.
- `approveQuoteVersion` returns 200 `QuoteVersion` with its declared ETag.
- handlers do not emit undeclared Express-generated ETags.

Runtime conformance exposed a real 1.0.1 prerequisite defect: the released
`QuoteVersion` schema required an object probability snapshot even for drafts,
while the domain intentionally freezes that authority only on formal submit.
The authorized 1.0.2 successor fixes only this lifecycle constraint: draft
requires null; every non-draft status requires the complete object. Releases
1.0.0 and 1.0.1 remain byte-identical and have hash regression tests.

## TDD evidence

- RED: focused router tests failed because `quote-router` did not exist.
- RED: lifecycle contract tests rejected a real draft/null response and the
  release builder still produced 1.0.1.
- GREEN: focused router/runtime suite passes with the real draft response
  validated against dynamically selected release 1.0.2.

## Verification

- Focused Quote router/runtime: 8/8 pass.
- Existing Quote services/module/decision regression set: 18/18 pass.
- Full contracts package: 60/60 pass.
- Growth contract release check and Growth OpenAPI suite: 38/38 pass.
- Backend TypeScript build: pass.
- `git diff --check`: pass before commit.

MySQL live integration was not run because `MYSQL_TEST_ADMIN_URL` is absent;
no database was configured and all live gates remain fail-closed/unrun.

## Concerns

Publication retry uses the released required `If-Match` precondition but the
1.0.2 success response intentionally declares no ETag, matching the immutable
matrix. The adapter therefore validates the internal fenced revision without
leaking worker fencing fields. A later contract may need an explicit public
publication revision if clients are expected to derive this precondition from
the GET response.
