# Task 1 report — authorized visual reader contracts

## Status

Task 1 is complete and is included in
`feat: define authorized visual reader contracts`. No Task 2 browser-extension
work and no Task 3 visual-reader service/router work is included.

## RED evidence

The tests were written before the schemas and routes.

```text
npm run test:contracts
# tests 73
# pass 64
# fail 9
```

The failures were the intended missing-contract failures: absent observation
and session schemas, absent visual OpenAPI components/routes, and absent Run
Presentation visual projection. One test fixture initially threw while reading
the absent schema; it was corrected so RED remained a product assertion rather
than a test error before implementation began.

After the static contract was green, the production parity gate exposed one
additional expected RED:

```text
npm run test:contract-drift --workspace backend
# tests 17
# pass 16
# fail 1
GET /api/v1/acquisition/runs/{id}/presentation
```

The only drift was the optional `authorizedVisualReader` projection missing
from the existing runtime Run Presentation builder.

## Delivered contracts

- Added strict normalized `DouyinVisualCommentObservationV1` and client-only
  observation submission contracts for visible top-level Douyin comments.
- Added the closed visual session, limits, usage, terminal outcome, stable
  errors, create/batch/complete/abort, redacted WebP crop, and opaque-rectangle
  proof contracts.
- Published the six versioned `/api/v1/acquisition/...` static routes using
  existing acquisition auth, CSRF, idempotency, response, and error-envelope
  conventions. The artifact GET exposes only `image/webp` binary plus exact
  private no-store, nosniff, and restrictive CSP headers.
- Added the optional backward-compatible Run Presentation
  `authorizedVisualReader` projection while preserving the required existing
  seven public-comment automation steps.
- Synchronized only that optional projection into the production OpenAPI
  builder. The six not-yet-implemented runtime routes remain unmounted and are
  deferred to Task 3.
- Regenerated the committed frontend acquisition types and documented the
  current contract-only status in `contracts/README.md`.

## Closed boundary decisions

- Creation accepts only `{ runId, artifactUploadEnabled }`; Plan,
  PlanVersion, platform, coverage, clocks, expiry, and effective limits are
  server-derived.
- `dom | accessibility | ocr | vision` is the complete method enum. `vision`
  is reserved but not enabled.
- Source URLs are exact Douyin HTTPS video URLs with a non-zero numeric ID and
  no query/fragment. Public profile URLs, `secUid`, comment IDs, confidences,
  bounds, text, batches, crops, decoded bytes, and counters are independently
  closed and bounded.
- Standard Draft 2020-12 schemas do not use `$data` or custom keywords.
  Task 3 must enforce URL/video ID, profile/`secUid`, and route/session sibling
  equality before persistence.
- Presentation visual steps use exactly five array slots and one closed step
  schema whose ID is one of the fixed five values. OpenAPI 3.0 cannot express
  tuple order without unsupported `prefixItems`; Task 7 must enforce fixed
  order, uniqueness, and one occurrence of every ID from persisted facts.
- Client submissions reject server-owned IDs/hashes and unknown exfiltration
  fields. No Cookie, signing, fingerprint, proxy, captcha, HTML/DOM dump,
  full-page screenshot, private interaction, publishing, or CRM-write ability
  exists in these contracts.

## GREEN verification

Fresh task verification:

```text
node --test contracts/test/schema-registry.test.mjs contracts/test/openapi.test.mjs
# tests 33
# pass 33

npm run test:contracts
# tests 73
# pass 73

npm run generate:frontend-contract-types
# exit 0

npm run check:generated-acquisition-types
# exit 0

npm run test:contract-drift --workspace backend
# tests 17
# pass 17

npm run build --workspace backend
# exit 0
```

All tests are local contract fixtures; none contacts Douyin.

## Remaining risks and next owners

- These are release contracts, not an available runtime visual reader. Task 3
  owns service validation, repository transactions, artifact decoding/pixel
  proof validation, authorization, expiry/budget enforcement, and route mount.
- Task 7 owns the persisted Run Presentation projection and exact five-step
  order/uniqueness invariant.
- `vision` stays disabled pending an explicit connector and data-transfer
  review.
- No product README/PRD was changed because the feature is not implemented or
  user-operable yet. The current contract README, execution plan, controller
  brief, report, and ledger were synchronized.

## Review round 1

The verified review findings are fixed in the independent commit
`fix: harden authorized visual reader contracts`. The fix remains inside Task
1 contract scope: it does not implement Task 2, mount the six Task 3 runtime
routes, or change the global type generator, JSON Schema converter, or drift
normalizer.

### Review RED evidence

Each executable finding was reproduced independently before its production
fix:

```text
visual crop base64 is canonical...
# tests 1; pass 0; fail 1
# non-canonical B== was accepted although it decoded to the same bytes as A==

visual profile keys start alphanumeric...
# tests 1; pass 0; fail 1
# public profile key "." was accepted

visual public identifiers use the existing ASCII boundary...
# tests 1; pass 0; fail 1
# an identifier containing NUL was accepted

generated visual response DTOs accept real legal values...
# tests 1; pass 0; fail 1
# TS2741/TS2322 required schema metadata property $defs on legal DTO values

generated visual helpers remain globally unique...
# tests 1; pass 0; fail 1
# VisualReaderUsage did not target visualReaderUsage and displaced Copilot usage
```

After the schema fix, the existing drift gate supplied one further integration
RED: 16/17 passed because cross-file Presentation references into a schema
whose root is itself a `$ref` were aliased to that external root during OpenAPI
dereferencing. The production builder still had the correct inline closed
usage and error schemas. The contract source was fixed at that boundary rather
than changing the converter, normalizer, or builder.

The README ambiguity was a documentation defect, not a runtime behavior. It
was reviewed directly instead of adding a brittle prose-grep test.

### Review decisions and delivered hardening

- Canonical crop base64 now restricts the final data character to `[AQgw]`
  before `==` and `[AEIMQUYcgkosw048]` before `=`. Tests cover both pad modes,
  equal decoded bytes, exactly 256 KiB, and 256 KiB plus one byte.
- Public visual identifiers use the existing bounded ASCII grammar
  `^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$` and explicitly reject control
  characters, including the ECMAScript end-anchor trailing-newline edge.
  Douyin public user keys likewise start with an ASCII letter or digit, so
  `.`, `..`, `-`, `~`, and `___` are rejected.
- The two public visual response DTOs are explicit, closed, uniquely named
  `$defs` fragments selected by root `$ref`; named OpenAPI components target
  those fragments. Real legal generated consumers therefore need no `$defs`
  instance property. No generated file was hand-edited.
- Every new visual helper has a `visualReader*` or `visualObservation*` name.
  The pre-existing Copilot `usage`, platform `digest`, and comment-event
  `$defs-digest` helpers and references are unchanged from their prior public
  names.
- Run Presentation keeps its small visual usage and stable-error projections
  inline. This preserves its implemented static/runtime parity without
  weakening or broadening the shared conversion machinery.
- `contracts/README.md` now states that planned contract-only routes are the
  explicit exception and that drift covers only the implemented-path
  allowlist; the existing Presentation operation remains covered.

### Review GREEN verification

```text
node --test test/generated-types.test.mjs test/schema-registry.test.mjs test/openapi.test.mjs
# tests 39
# pass 39

npm run test:contracts
# tests 78
# pass 78

npm run generate:frontend-contract-types
# exit 0

npm run check:generated-acquisition-types
# exit 0

npm run test:contract-drift --workspace backend
# tests 17
# pass 17

npm run test:acquisition-openapi --workspace backend
# tests 28
# pass 28

npm run build --workspace backend
# exit 0

git diff --check
# exit 0
```

All review fixtures remain local and make no real Douyin request. Remaining
runtime enforcement and evidence ownership stay with Tasks 3 and 7 as recorded
above.

## Review round 2

The remaining generated-helper collision is fixed in the independent commit
`fix: namespace visual observation leaf contracts`. This round changes only
Task 1 schema composition, its generated-type regression, committed generated
types, and the Task 1 report/ledger. It does not change validation limits,
runtime routes, or Task 2 behavior.

### Review RED evidence

The generated helper test now builds the dependency closure reachable from all
12 named public visual aliases. Before the production change it failed on the
first leaked generic component:

```text
node --test --test-name-pattern="generated visual helpers remain globally unique" test/generated-types.test.mjs
# tests 1
# pass 0
# fail 1
# visual helper leaked generic component sourceUrl
```

The same output also contained generic `videoId`, `visibleText`,
`extractionMethod`, `readerVersion`, and `capturedAt` components. The prior
round's assertions covered only the known `usage` and digest collisions and
therefore did not detect this complete reachable helper set.

### Review decision and delivered hardening

The six leaf constraints now live once in the observation schema as
`visualObservationSourceUrl`, `visualObservationVideoId`,
`visualObservationVisibleText`, `visualObservationExtractionMethod`,
`visualObservationReaderVersion`, and `visualObservationCapturedAt`.
Both the normalized Observation root and the Session submission reference
those fragments. No schema constraint is duplicated, removed, or relaxed.

The generated regression rejects the six known generic component names and
walks the complete public visual dependency closure. Every non-public helper
in that closure must use `visualObservation*` or `visualReader*`; the named
public Observation component remains the sole documented exception. This
protects future helpers beyond the six current leaves while retaining the
round 1 Copilot `usage` and digest checks.

### Review GREEN verification

```text
node --test --test-name-pattern="generated visual helpers remain globally unique" test/generated-types.test.mjs
# tests 1
# pass 1

node --test test/generated-types.test.mjs test/schema-registry.test.mjs test/openapi.test.mjs
# tests 39
# pass 39

npm run test:contracts
# tests 78
# pass 78

npm run generate:frontend-contract-types
# exit 0

npm run check:generated-acquisition-types
# exit 0

npm run test:contract-drift --workspace backend
# tests 17
# pass 17

npm run test:acquisition-openapi --workspace backend
# tests 28
# pass 28

npm run build --workspace backend
# exit 0

git diff --check
# exit 0
```

All tests remain local and make no real Douyin request. Task 3 and Task 7
ownership and the prohibited capability boundary are unchanged.
