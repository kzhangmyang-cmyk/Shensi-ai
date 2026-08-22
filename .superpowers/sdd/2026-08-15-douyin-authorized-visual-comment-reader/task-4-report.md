# Task 4 report — authorized visual-reader web control plane

## Outcome

The external GoodJob frontend now exposes an explicit, read-only authorization control inside the existing acquisition detail center. It preserves the current near-black, deep-green, warm-white visual system and does not introduce a new page, component library, avatar, local progress simulation, or write interaction.

Frontend commits:

- `8167ead` — `feat: add visual reader authorization controls`
- `f351261` — `fix: serialize visual reader control operations`
- `e032683` — `fix: unblock visual reader stop recovery`

The frontend worktree remains clean except for the user's pre-existing untracked `package-lock.json`, which was not read, modified, staged, or committed.

## Implemented boundary

- Same-origin API client with credentials, CSRF, strict public response validation, safe errors, and explicit idempotency keys.
- Real endpoints: top-level `POST /api/v1/acquisition/visual-reader-sessions`, session child mutation routes, and top-level `GET /api/v1/acquisition/visual-reader-artifacts/:artifactId`.
- Per-detail-lifecycle 256-bit `channelNonce` generated only with `crypto.getRandomValues`.
- Closed bridge protocol with `probe`, `start`, `acknowledge_batch`, `abort`, `ready`, `observation_batch`, and `terminal` messages.
- Exact source/origin/version/nonce/session checks plus strict Task 1 observation validation, including URL/video identity, profile/secUid identity, OCR restrictions, and 20-observation/5-crop limits.
- `artifactUploadEnabled` is copied from the server session into `start`; text-only submission strips every crop again before API submission.
- Batch mutations are serialized before terminal mutations. ACK occurs only after durable batch success.
- Ambiguous network retries reuse semantic keys for authorization, terminal completion, and stop.
- Reconcile request tokens and terminal monotonicity prevent stale `collecting` responses from overwriting terminal state; a projected session change immediately invalidates the old bridge and mutation epoch.
- User stop immediately tells the extension to halt, discards unconfirmed local batches without ACK, then aborts the server session behind a new stop barrier. Abort failures restore the button and retain the same semantic key for retry.
- Authorization is enabled only for an approved immutable Douyin plan version with `douyinPublicCommentSample.enabled=true`, a matching queued/running Run, a ready bridge, and no existing session.
- UI renders only service session and Run Presentation counters, budgets, steps, and errors. It includes native keyboard controls, focus/disabled states, `aria-live`, escaped text, privacy copy, and responsive 1440/1024/768 layouts.

## TDD and review evidence

Initial RED waves covered the missing API, bridge, and controller modules plus missing detail rendering/integration. Review RED waves then reproduced:

- authorization retry keys changing after a network failure;
- terminal starting before a deferred batch completed;
- stale reconcile responses regressing `completed` to `collecting`;
- authorization being offered outside the backend Plan/Run eligibility boundary;
- failed batches permanently blocking user stop.

The final GREEN behavior is locked by focused self-tests for API, bridge, controller, detail controller, and detail view. Independent review approved the final implementation with no remaining Critical or Important finding.

Fresh final verification in the frontend worktree:

- five focused self-tests: PASS;
- `npm run test`: PASS, 125 checks;
- `npm run test:types`: PASS;
- `npm run build`: PASS, with only the existing Vite chunk-size warning;
- `git diff --check`: PASS;
- isolated rendered document width at 1440, 1024, and 768 pixels: equal to the viewport, with no horizontal overflow.

No real Douyin request or real visual-reader session was created during this task. The live local backend had no seeded acquisition task suitable for authorization; the visual check used an isolated server-session fixture and did not persist data.
