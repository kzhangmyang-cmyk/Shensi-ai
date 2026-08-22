# Task 3 report — authorized visual reader API

Task 3 exposes the six Task 1 visual-reader routes through the acquisition
application. The server, rather than the client, authorizes each session from
the tenant-scoped Run and immutable PlanVersion, derives the hard-capped
limits and 120-second expiry, normalizes every accepted observation, and
serves only encrypted-at-rest, already-redacted WebP artifacts.

## Delivered behavior

- Session creation is atomic and tenant scoped. Its HMAC identity includes
  owner, team, Run, and the raw request key without persisting that raw key.
  Concurrent exact creates have one `201` winner and one `200` replay; a
  changed Run or artifact policy conflicts.
- Batch header bindings use a durable versioned envelope with disjoint
  `observations` and `requests` namespaces. The request namespace stores only
  hashed keys and the first public response facts, so an exact retry returns
  the same session snapshot, accepted observations, and duplicate keys without
  re-running Sharp, encryption, or persistence. A changed body conflicts before
  mutation. Legacy flat bindings upgrade only inside a successful mutation;
  legacy client keys literally named `version`, `observations`, or `requests`
  remain valid because only a string `version` declares an envelope.
- The memory and MySQL repositories share the 1,000-entry / 256 KiB canonical
  binding budget. MySQL parsing rejects unknown or mixed versions and duplicate
  JSON keys at every object depth. Replay snapshots must agree with the current
  row's immutable session, Run, Plan, platform, coverage, artifact policy, and
  limits; status, usage, and timestamps remain the original response snapshot.
- The service reparses the exact Douyin video URL and public profile key,
  requires their sibling IDs to agree, and recomputes normalized IDs and
  hashes. `vision` is disabled. OCR requires a crop/redaction proof and cannot
  assert `platformCommentId`, `publicProfileUrl`, or `secUid`; pure DOM and the
  contracted accessibility path may omit a crop.
- Every batch that accepts at least one new observation consumes one bounded
  capture cycle through `scrollCount`. Exact request replay and a new request
  containing only duplicates consume no additional cycle; the sixth
  new-observation cycle is rejected atomically. This is a server-side capture
  budget and does not claim that the client performed a literal DOM scroll.
- Sharp 0.35.3 receives only an in-memory `Buffer` with a one-megapixel input
  limit. Validation rejects non-WebP or animated/multi-page input, metadata,
  dimension mismatch, invalid rectangles, more than 80% visible union area,
  and every unmasked pixel outside the visible union, avatar, or declared mask.
- All four writes require an ASCII-visible 1–200 byte `Idempotency-Key` and are
  mounted behind production authentication and cookie CSRF. Create and batch
  advertise replay headers backed by durable bindings. Complete and abort keep
  the required header but do not claim `Idempotency-Replayed`, because terminal
  outcome replay is not bound to a durable header record.
- The production parser applies a route-specific 2 MiB raw JSON limit before
  the configurable global parser, so a larger `JSON_BODY_LIMIT` cannot weaken
  the boundary. Service validation additionally caps 20 observations, five
  crops, each decoded crop at 256 KiB, and their decoded aggregate. Production
  oversized bodies and standalone malformed JSON both return the complete
  five-field `ApiError`, request ID, and `no-store` without echoing the body.
- Artifact GET returns raw `image/webp` with `private, no-store`, `nosniff`, and
  `default-src 'none'; frame-ancestors 'none'; sandbox`. Public responses and
  errors do not echo submitted text, image bytes, URLs, secUid, storage state,
  or stacks.

## Contract and application integration

Runtime OpenAPI now publishes all six static routes with stable operation IDs,
closed Task 1 DTOs, real 403/413 write statuses, correct replay semantics, and
the binary artifact headers. Before dereferencing or restoring visual schemas,
the drift helper checks every raw visual route request/success-response node,
the exact Task 1 session/observation fragment target of every visual component
`$ref`, and the inline binary artifact schema. A wrong fragment, wrong route
schema, missing node, or added schema keyword therefore fails closed instead
of being hidden by the fragment-restoration step. The OpenAPI 3.0 projection
retains the strict batch shape but omits only Draft 2020-12
`contains/minContains/maxContains` after checking the source is exactly the
service-enforced five-crop rule; every other unsupported keyword still fails
closed. Numeric Draft 2020-12 exclusive bounds are converted losslessly to
OpenAPI 3.0 bounds. Drift tests compare all six published/runtime operation
surfaces.

The static response status/header changes are regenerated into the
same-repository `frontend/src/features/ai-growth/generated/ai-acquisition.ts`;
the generated-type freshness check and the complete acquisition contract gate
both pass. No external frontend worktree or frontend `package-lock.json` was
read or changed.

The acquisition application composes the service with the existing visual
repository and Plan/Run repository, mounts the router, and retains repository
identity plus sweeper lifecycle. Production keeps the entire acquisition
surface behind the existing `requireAuth` middleware and cookie CSRF check.

## TDD review evidence

- OCR identity was RED 0/1, then GREEN 1/1. OCR without a crop, DOM without a
  crop, and disabled vision remain explicit service cases.
- Nested duplicate binding namespaces were RED 0/2 then GREEN 2/2; tampered
  replay session/Run/Plan identities were RED 0/2 then GREEN 2/2.
- Legacy reserved-name compatibility was RED 0/1, then GREEN 2/2 together with
  the strict unknown/mixed/version envelope test.
- Runtime/static six-route parity was RED 0/2 then GREEN 2/2. The mounted
  visual response fixture was RED 0/1 then GREEN 1/1.
- Capture-cycle accounting was RED 0/1 then GREEN 1/1. The production 2 MiB
  standard-error boundary was RED 0/1 then GREEN 1/1. Standalone malformed
  JSON was RED 0/1 then GREEN 1/1.
- Router error response conformance was RED 0/1 then GREEN 1/1, including the
  unknown dependency error fail-closed path.
- Raw OpenAPI visual source validation was RED 0/3: the assertion was absent,
  and wrong external fragments and route schemas were silently restored. It
  was then GREEN 3/3 with exact source-node and target checks before
  dereference.

## Final verification record

```text
artifact + router + service
# tests 26; pass 26; fail 0

memory + stateful MySQL repository parity
# tests 55; pass 54; fail 0; skip 1

application lifecycle with --test-force-exit
# tests 27; pass 27; fail 0

runtime OpenAPI + response conformance
# tests 30; pass 30; fail 0

runtime/static OpenAPI drift
# tests 18; pass 18; fail 0

static contracts
# tests 78; pass 78; fail 0

security self-test
# ok: true; visualReaderCsrfBlocked: true

backend TypeScript build
# exit 0

generated acquisition type freshness
# exit 0

complete acquisition contract gate
# exit 0 (contracts, drift, security, OpenAPI, generated types,
# frontend build/tests, Baota package)

raw visual OpenAPI source validation
# tests 3; pass 3; fail 0

complete acquisition with --test-force-exit before the file list
# tests 912; pass 909; fail 2; skip 1
```

The two full-acquisition failures are unchanged Pi baselines outside Task 3:
`acquisition-pi-gateway-runtime-test.ts` and
`acquisition-pi-runtime-factory-test.ts` both stop at
`MODEL_TOOL_DEFINITION_INVALID`. All visual tests in that run pass. The one
skip is the conditional live-MySQL visual contract: `MYSQL_TEST_ADMIN_URL` is
not configured in this environment. Stateful MySQL transactions, row/parser
integrity, replay, and memory parity all pass; no test contacted Douyin.
