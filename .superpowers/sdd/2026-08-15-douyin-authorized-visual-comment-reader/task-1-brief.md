### Task 1: 视觉会话、观察和遮挡制品合同

**Repository:** `/Users/mac/Documents/新项目/GoodJob-growth/.worktrees/douyin-comment-automation`

**Base:** `3e65d49`

**Source of truth:** Task 1 and global constraints in `docs/superpowers/plans/2026-08-15-douyin-authorized-visual-comment-reader.md`.

**Files:**

- Create `contracts/json-schema/douyin-visual-comment-observation.v1.schema.json`
- Create `contracts/json-schema/acquisition-visual-reader-session.v1.schema.json`
- Modify `contracts/json-schema/acquisition-run-presentation.v1.schema.json`
- Modify `contracts/openapi/ai-acquisition.v1.yaml`
- Modify `contracts/test/schema-registry.test.mjs`
- Modify `contracts/test/openapi.test.mjs`
- Modify `contracts/test/generated-types.test.mjs`
- Modify `contracts/README.md`
- Modify `backend/src/acquisition-openapi.ts` only to keep the optional Run Presentation visual schema in static/runtime parity; do not advertise or mount the six unimplemented runtime routes until Task 3
- Regenerate `frontend/src/features/ai-growth/generated/ai-acquisition.ts`
- Modify `docs/superpowers/plans/2026-08-15-douyin-authorized-visual-comment-reader.md` to preserve the resolved versioned-route and standard-schema decisions
- Include this `task-1-brief.md` as the controller decision record
- Create/update `.superpowers/sdd/2026-08-15-douyin-authorized-visual-comment-reader/task-1-report.md`
- Append this plan's `progress.md`

**Required public contracts:**

- `VisualExtractionMethod = dom | accessibility | ocr | vision`; `vision` is reserved in the contract but is not enabled by this task.
- Define strict normalized `DouyinVisualCommentObservationV1`, client-only `VisualObservationSubmission`, `OpaqueRectRedactionProofV1`, visual reader session/outcome/limits, batch request/response, complete/abort requests, and minimal artifact metadata/response components required by the six fixed routes.
- Fixed routes:
  - `POST /api/v1/acquisition/visual-reader-sessions`
  - `GET /api/v1/acquisition/visual-reader-sessions/{sessionId}`
  - `POST /api/v1/acquisition/visual-reader-sessions/{sessionId}/observations:batch`
  - `POST /api/v1/acquisition/visual-reader-sessions/{sessionId}:complete`
  - `POST /api/v1/acquisition/visual-reader-sessions/{sessionId}:abort`
  - `GET /api/v1/acquisition/visual-reader-artifacts/{artifactId}`
- Session states: `created | collecting | completed | partial_success | aborted | expired`.
- Limits are closed, bounded, and server-visible: default behavior is owned by later service tasks; contract hard caps are 10 videos, 30 comments/video, 5 scrolls, 10 OCR calls, 120000 ms.
- Submission batches: maximum 20 observations; maximum 5 observations with a crop; text maximum 2000 characters; WebP crop decoded bytes maximum 256 KiB; confidences 0..1; all request objects `additionalProperties: false`.
- Client input must not accept server-owned `observationId`, `textHash`, `viewportHash`, or `redactedCropHash`.
- Only strict Douyin HTTPS source URLs and matching video IDs are accepted. `platformCommentId`, `publicProfileUrl`, and `secUid` are optional and may only be supplied as literal DOM/public-link facts; schemas must reject malformed/contradictory values and must not invent them.
- Crop is only `image/webp`, carries `opaque-rect-v1` proof, fixed `[17,61,51,255]` RGBA, bounded rectangles, and no avatar URL.
- Explicitly reject unknown/exfiltration fields such as Cookie/header/networkResponse/html/browserConfig/fingerprint/avatarUrl/fullPageScreenshot.
- Add backward-compatible optional `authorizedVisualReader` summary and visual steps to Run Presentation without breaking existing Run fixtures. Do not weaken existing seven-step comment automation constraints.
- Existing auth/CSRF/idempotency/header and error-envelope conventions must be reused exactly; do not invent a second API style.
- Exact public DTO decision:
  - create request `{ runId, artifactUploadEnabled }`; server derives Plan, PlanVersion, platform, coverage, authorizedAt, expiry, and limits;
  - session requires `sessionId/runId/planId/planVersionId/platform/coverage/status/artifactUploadEnabled/limits/usage/outcome/lastErrorCode/createdAt/authorizedAt/updatedAt/expiresAt/completedAt`;
  - limits require `maxVideos/maxCommentsPerVideo/maxScrolls/maxOcrCalls/maxDurationMs`; usage requires `videoCount/observationCount/scrollCount/ocrCallCount/domObservationCount/accessibilityObservationCount/ocrObservationCount/lowConfidenceObservationCount/artifactCount`;
  - server-derived outcome requires terminal `status`, the same observation/method/low-confidence/artifact counters, and a unique bounded array of stable visual reader error codes;
  - batch request is `{ observations }`; response is `{ session, accepted, duplicates }`, accepted items are `{ clientObservationKey, observation }`, duplicates are client keys;
  - complete request is `{ status: completed | partial_success, errorCodes }`; abort request is `{ reasonCode: user_requested | visual_reader_user_takeover }`;
  - optional Run Presentation `authorizedVisualReader` contains the persisted session identity/status/coverage, server counters/error, and exactly five visual steps `authorize_visual_reader/read_visible_comment_cards/extract_visible_text/persist_visual_observations/review_visual_signal_confidence`;
  - artifact GET returns only `image/webp` binary with private no-store, nosniff, and restrictive CSP headers; no JSON image bytes.
- Standard JSON Schema cannot compare sibling values. Task 1 validates the Douyin URL, videoId, and session shapes independently and records the runtime invariants in schema/OpenAPI descriptions and contract tests. Task 3 service must enforce URL video ID equality and path/target session equality before persistence. Do not add Ajv `$data`, custom keywords, or a non-standard schema dialect.
- The five visual steps use `minItems = maxItems = 5` plus one closed step schema and the five-ID enum so the existing OpenAPI 3.0 converter stays valid. Task 7 projection must enforce exact order, uniqueness, and one occurrence of every ID; do not use unsupported `prefixItems` or weaken drift normalization.
- Review hardening is part of Task 1: canonical Base64 pad bits; shared ASCII identifier grammar `^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$`; a secUid/user-key grammar that starts alphanumeric; no root `$defs` instance field in generated session/observation response types; globally unique visual helper names that preserve the existing Copilot token `components.schemas.usage`; and a generated-type consumer regression test with real legal visual DTO fixtures.

**TDD protocol:**

1. Read applicable `AGENTS.md`, the complete plan, `superpowers:test-driven-development`, `writing-good-tests`, and `verification-before-completion` before editing.
2. Add strict schema/OpenAPI registry tests first. Cover legal DOM, accessibility, OCR, and reserved vision values plus rejection of unknown method, non-Douyin/non-HTTPS/mismatched video, extra fields, forged IDs, long text, confidence bounds, image count/size, avatar/Cookie/header/networkResponse/html fields, invalid redaction proof, and cross-session observation shape.
3. Run `npm run test:contracts` and preserve the expected RED caused by missing/unregistered production schemas/routes.
4. Implement the smallest closed schemas/OpenAPI components and regenerate types.
5. Run `npm run test:contracts && npm run generate:frontend-contract-types && npm run check:generated-acquisition-types && npm run test:contract-drift --workspace backend && git diff --check`.
6. Check current docs: update `contracts/README.md`; do not modify product README/PRD yet because API is contract-only and not implemented.
7. Write the task report with RED/GREEN evidence, decisions, exact files, and remaining risks.
8. Stage only the task files plus its ledger/report and commit `feat: define authorized visual reader contracts`.

**Hard boundaries:**

- No Cookie/session extraction, private signatures, fingerprint evasion, proxy, captcha handling, DOM/HTML dumps, raw full-page screenshot upload, private messages, comments, likes, follows, publishing, or CRM conversion actions.
- No real Douyin traffic in tests.
- No backend repository/service/router implementation in Task 1.
- Do not touch the external frontend worktree or its user-owned untracked `package-lock.json`.
- If a material public response shape is not determined by the plan/current conventions, stop and report the exact gap before inventing it.
