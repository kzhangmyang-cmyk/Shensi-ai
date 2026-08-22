### Task 3: authorized API, CSRF, budgets, and fail-closed artifact validation

**Repository:** `/Users/mac/Documents/新项目/GoodJob-growth/.worktrees/douyin-comment-automation`

**Base:** `2b514f9b6cff96198be85bcb5caa9e4008915ab1`

**Source of truth:** Task 3 and global constraints in `docs/superpowers/plans/2026-08-15-douyin-authorized-visual-comment-reader.md`, Task 1 contracts, and the approved Task 2 repository.

**Owned files:** the complete Task 3 file list in the current plan. It intentionally includes the Task 2 repositories for durable header idempotency, `server.ts` for an invariant route-specific JSON limit, static OpenAPI/tests for real response codes, the same-repository generated acquisition type projection at `frontend/src/features/ai-growth/generated/ai-acquisition.ts`, drift coverage, application tests, and this brief/report/progress.

#### Authorization and server-owned session creation

- The router derives `{ ownerId, teamId, actorId }` from `req.user` and rejects missing context even when mounted without production `requireAuth`. Production stays behind global `requireAuth`; cookie writes use its existing CSRF cookie/header equality check. The extension receives no credential.
- The service reads the scoped Run and immutable PlanVersion from `AcquisitionPlanRunRepository`. Require exact owner/team and Plan/Version binding, Run status `queued | running`, `targetPlatform === "douyin"`, and `douyinPublicCommentSample.enabled === true`.
- Server limits: `maxVideos = min(10, policy.maxVideosPerRun)`, `maxCommentsPerVideo = min(30, policy.maxCommentsPerVideo)`, `maxScrolls = 5`, `maxOcrCalls = 10`, `maxDurationMs = 120000`. `createdAt = authorizedAt = now`; expiry is exactly 120 seconds later.
- Derive `visual-session:<HMAC>` from a dedicated purpose key plus scope, Run and header idempotency key. Extend the repository with atomic create-with-result so concurrent exact calls yield one created result and replays; same key with different Run or artifact policy conflicts. Raw keys never persist.

#### Durable batch idempotency and normalization

- Extend internal append input with closed `{ keyHash, requestHash }`. Memory/MySQL bind it in the same state/transaction as observations/artifacts under existing 1,000/256 KiB caps. Same key+same canonical submission replays; same key+different request conflicts before usage or row writes. Store no raw header.
- Every batch that accepts at least one new observation consumes one bounded capture cycle through `scrollCount`; exact request replay and a new request containing only duplicates consume no extra cycle. This does not claim that the client performed a literal DOM scroll.
- Validate the complete Task 1 submission. Reparse `https://www.douyin.com/video/<digits>` and require the path ID equals `videoId`; if profile URL and secUid both exist, require the public user key equals secUid. `vision` returns `visual_extraction_method_disabled`; normalize only DOM/accessibility/OCR.
- Recompute text, viewport, card-bounds and crop hashes plus server observation/artifact IDs. Accept no client server-owned ID/hash. Captured time must be inside the authorized session window.
- Low-confidence observations remain immutable facts. An internal `manualReviewOnlyObservationIds` result may support Task 5; public batch response remains exactly `{ session, accepted, duplicates }`.

#### Redacted WebP validation

- Add `sharp@0.35.3` as the only runtime dependency and record Apache-2.0. Accept only request-memory `Buffer`; never URL/path/stream.
- Decode fail-closed with at most 1,000,000 pixels, one page/frame, bounded raw RGBA. Require WebP, no animation/extra page, no EXIF/ICC/XMP/IPTC, dimensions equal to `round(cardBounds width/height * deviceScaleFactor)`, and consistent aspect ratio.
- Proof rectangles are in-bounds integer pixels. Union of visible regions covers at most 80%. Every pixel outside that union, every avatar pixel, and every declared masked-region pixel equals `[17,61,51,255]`. Reject before repository access. Pure DOM observations may omit crops.

#### Router, body bounds, errors, and artifact response

- Use the six Task 1 `/api/v1/acquisition/...` paths. Writes require an ASCII-safe 1..200 `Idempotency-Key`; create/batch use durable bindings, complete/abort use exact terminal replay.
- Batch limits: 20 observations, five crops, canonical Base64, total decoded crop bytes at most `5 * 262144`, and real JSON body maximum 2 MiB before service/repository. Global parser selection must keep this path at 2 MiB even if `JSON_BODY_LIMIT` is larger; retain router-side serialized-size protection for standalone composition.
- Status mapping: invalid source/observation/artifact/method 400; unauthenticated 401; existing CSRF 403; missing scoped resource 404; disabled/expired/budget/idempotency/terminal conflict 409; oversized 413; unexpected 500. ApiError responses never include image, text, URL, secUid, stack or storage data.
- Artifact GET is raw `image/webp` with `private, no-store`, `nosniff`, and `default-src 'none'; frame-ancestors 'none'; sandbox`; never a JSON byte wrapper.
- Static/runtime OpenAPI must have identical six routes, schemas, reachable 403/413, replay header and binary headers. Add all paths to drift coverage; they are no longer static-only reservations. Regenerate and check the same-repository frontend acquisition types after static contract changes.

#### TDD and verification

1. Read applicable `AGENTS.md`, full plan, this brief, Task 1 schemas, Task 2 repository, TDD/writing-good-tests/verification skills.
2. Write and run artifact/service/router RED before installing Sharp or implementing modules.
3. Vertical order: artifact validator; service Plan/Run/create/normalization; durable header binding; router/auth/body/errors/download; application/server/OpenAPI/security.
4. Run artifact/service/router plus affected Task 2 repository, application lifecycle, OpenAPI/response/drift, security, contracts, backend build, diff check. Run complete acquisition with the established bounded/force-exit convention and isolate unchanged Pi baselines.
5. If `MYSQL_TEST_ADMIN_URL` is absent, report the live limitation; stateful request-binding parity remains mandatory.
6. Update Task 3 report/progress/current docs, stage only Task 3, commit `feat: expose authorized visual reader sessions`.

**Hard boundaries:** no Task 4 UI, extension or OCR implementation; no evidence/candidate ingestion; no Cookie/session export, signature/fingerprint evasion, proxy/captcha, write interaction, raw/full screenshot persistence, remote vision call, or real Douyin traffic.
