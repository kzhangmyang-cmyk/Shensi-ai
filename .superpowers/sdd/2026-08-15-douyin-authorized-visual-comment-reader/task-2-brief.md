### Task 2: 租户隔离的视觉会话、观察和遮挡制品持久化

**Repository:** `/Users/mac/Documents/新项目/GoodJob-growth/.worktrees/douyin-comment-automation`

**Base:** `376393606283358e6aa6ef17ee50400032d45fa9`

**Source of truth:** Task 2 and global constraints in `docs/superpowers/plans/2026-08-15-douyin-authorized-visual-comment-reader.md` plus the Task 1 schemas.

**Files:**

- Create `backend/src/acquisition-visual-reader-sessions.ts`
- Create `backend/src/acquisition-visual-reader-sessions-test.ts`
- Create `backend/src/acquisition-visual-reader-mysql-repository.ts`
- Create `backend/src/acquisition-visual-reader-mysql-repository-test.ts`
- Create `backend/src/acquisition-visual-artifact-crypto.ts`
- Create `backend/src/acquisition-visual-artifact-crypto-test.ts`
- Create `backend/src/acquisition-visual-artifact-expiry-sweeper.ts`
- Create `backend/src/acquisition-visual-artifact-expiry-sweeper-test.ts`
- Modify `backend/src/acquisition-application.ts`
- Modify `backend/src/acquisition-application-test.ts`
- Include this brief, the visual plan if decisions change, `progress.md`, and `task-2-report.md`

**Repository contract:**

```ts
export interface AcquisitionVisualReaderRepository {
  createSession(input: CreateVisualReaderSessionInput): Promise<VisualReaderSession>;
  appendObservationBatch(input: AppendVisualObservationBatchInput): Promise<{
    accepted: VisualCommentObservation[];
    duplicates: string[];
  }>;
  completeSession(scope: AcquisitionScope, sessionId: string,
    outcome: VisualReaderOutcome): Promise<VisualReaderSession>;
  getSession(scope: AcquisitionScope, sessionId: string): Promise<VisualReaderSession | null>;
  listRunObservations(scope: AcquisitionScope, runId: string,
    options: { limit: number }): Promise<VisualCommentObservation[]>;
  getArtifact(scope: AcquisitionScope, artifactId: string): Promise<VisualReaderArtifact | null>;
  deleteExpiredArtifacts(input: { before: string; limit: number }): Promise<number>;
}
```

**Concrete internal inputs and invariants:**

- `CreateVisualReaderSessionInput` carries trusted server facts: scope, sessionId, runId, planId, planVersionId, artifactUploadEnabled, validated limits, createdAt, authorizedAt, expiresAt. Initial state is `created`, zero usage, null outcome/error/completedAt. Same scoped session replay is exact; differing facts conflict.
- An append item carries `clientObservationKey`, one complete server-normalized `DouyinVisualCommentObservationV1`, and zero or one already-validated artifact input. The observation sessionId must equal the target session. Artifact input requires artifactId, observationId, `image/webp`, plaintext `Buffer`, exact `sha256:...`, width/height, maskedRegionCount, createdAt, expiresAt.
- Repository recomputes and verifies artifact hash/byte length and the canonical card-bounds hash. It does not accept caller ciphertext, IV, tag, derived key, cardBoundsHash, or storage metadata.
- Observation idempotency is `ownerId + teamId + sessionId + sourceUrl + viewportHash + cardBoundsHash + textHash`. Also bind scoped `clientObservationKey` to its first immutable observation; replay returns it as duplicate, while reusing the key for different facts conflicts.
- Whole batches validate before commit. Observation, optional artifact, dedupe rows, session state and usage commit atomically; any failure leaves no observation, no artifact, no usage change and no partial duplicate mapping.
- `created -> collecting` on first accepted append; collecting remains collecting. Appends to completed/partial_success/aborted/expired sessions fail. Completion is exact/idempotent for one terminal outcome and conflicts on a different outcome.
- Usage is server-derived from accepted immutable facts where possible: unique video count, observation/method/low-confidence/artifact counts. The internal append port may carry a validated nonnegative `usageDelta` for scroll/OCR attempt accounting so Task 3 can enforce browser budgets; never trust or persist a value that exceeds session limits. Duplicate replay must not increment usage.
- Memory implementation must serialize all mutating entry points and commit by immutable next-state swap (or equivalent) so rollback cannot erase a concurrent successful write.
- `listRunObservations` is scoped, deterministic (`capturedAt`, then observationId), validates limit `1..1000`, and never returns another tenant or another Run.

**Artifact cryptography:**

- Derive a dedicated 32-byte subkey from the already validated acquisition master secret with HKDF-SHA256, fixed versioned salt/info dedicated to visual artifacts; do not reuse provider/import keys.
- Encrypt each WebP with AES-256-GCM and a fresh 12-byte IV. AAD is canonical and binds envelope version, ownerId, teamId, sessionId, observationId, artifactId, mediaType, plaintext hash and byte length.
- Persist only ciphertext, IV, tag, versions and non-sensitive metadata. Decrypt only after validating envelope shape, IV/tag lengths, AAD, hash and byte length; any mismatch returns a stable integrity error without image bytes, comment text or identity fields.
- Tests cover changed owner/team/session/observation/artifact/hash, tampered ciphertext/tag/IV, wrong key and malformed envelope. Never stringify/log plaintext or envelope secrets.

**MySQL parity:**

- Tables: `acquisition_visual_reader_sessions`, `acquisition_visual_comment_observations`, `acquisition_visual_reader_artifacts`.
- Every PK/unique lookup and FK-equivalent query includes `owner_id + team_id`; include scoped unique observation dedupe material and scoped client key.
- Batch append uses one DB transaction and row lock on the session. Rollback leaves no orphan BLOB/observation. Concurrent duplicate inserts converge to one immutable observation; conflicting client keys fail closed.
- Store the artifact ciphertext in a binary column; a repository test must inspect captured SQL/rows and prove the plaintext WebP byte sequence is absent.
- `ensureAcquisitionVisualReaderMysqlSchema(pool)` is isolated in this module, safe for repeated/concurrent startup, and called before repository use. No URL/file-path image input and no real network.
- If real `MYSQL_TEST_ADMIN_URL` is absent, record that limitation; fake/stateful SQL parity tests remain mandatory.

**Expiry sweeper and application wiring:**

- Expired artifacts are unreadable immediately (`getArtifact` returns null/stable not-found semantics) even before physical deletion. Default retention is 30 days; deletion is bounded to 100 per sweep and does not delete observations/evidence hashes.
- Sweeper owns startup, unref'd periodic interval, per-run isolation, and bounded close. Errors report only stable code/count, never bytes, text, URL, secUid or displayName.
- `AcquisitionRepositorySet` and application options gain the visual repository. Memory/MySQL modes instantiate the same port; MySQL ensures schema first. Tests prove injected repository identity, memory/MySQL selection, sweeper start/close, and no handle leak.
- Do not expose HTTP routes or public API behavior in Task 2.

**TDD and verification:**

1. Read applicable `AGENTS.md`, complete plan, `superpowers:test-driven-development`, writing-good-tests, and verification-before-completion.
2. Write memory repository + crypto RED first and run them. Preserve exact failing assertions.
3. Implement minimum memory/crypto GREEN, then write MySQL/expiry/application RED and implement parity.
4. Required final command:

```bash
npm exec --workspace backend -- tsx --test \
  src/acquisition-visual-reader-sessions-test.ts \
  src/acquisition-visual-reader-mysql-repository-test.ts \
  src/acquisition-visual-artifact-crypto-test.ts \
  src/acquisition-visual-artifact-expiry-sweeper-test.ts
npm run build --workspace backend
git diff --check
```

5. Also run focused application lifecycle tests and the existing acquisition master-secret/security tests affected by key derivation.
6. Sync the task report/ledger and current plan if an interface decision changes; no README/API docs change is needed because this task adds internal storage only.
7. Stage only Task 2 files and commit `feat: persist authorized visual observations`.

**Hard boundaries:**

- No router/service/OpenAPI changes; no Task 3 behavior.
- No Cookie/session export, signature/fingerprint evasion, proxy/captcha, HTML/full screenshot persistence, write interactions, or real Douyin traffic.
- Only validated, redacted per-comment WebP bytes enter this repository; raw viewport screenshots are never accepted.
- Do not touch the external marketing frontend worktree or its user-owned untracked `package-lock.json`.
- If repository semantics require a material public-contract change, stop and report before changing Task 1 contracts.
