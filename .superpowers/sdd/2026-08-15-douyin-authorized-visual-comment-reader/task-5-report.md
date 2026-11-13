# Task 5 report — bounded MV3 Douyin visual reader

## Outcome

The external GoodJob frontend now builds an unpacked Manifest V3 extension that reads only visible top-level Douyin comment cards after an explicit GoodJob authorization and an explicit popup tab choice. It preserves the existing deep-green, warm-white, cool-gray popup style and uses native controls without a new UI library or image asset.

Frontend commits:

- `fc378c3` — `feat: add bounded douyin visual reader extension`
- `1732163` — `fix: harden douyin visual reader lifecycle`
- `cdbb176` — `fix: stabilize visual reader comment digests`
- `c52a2d9` — `fix: close visual reader lifecycle gaps`
- `7ae7945` — `fix: reserve visual reader finalization time`
- `8c1ba35` — `fix: queue visual reader budget terminal on time`
- `1c00cbf` — `fix: guard visual reader lifecycle ownership`

The frontend worktree remains clean except for the user's pre-existing untracked `package-lock.json`, which was not read, modified, staged, deleted, or committed.

## Implemented safety boundary

- Exact permissions: `activeTab`, `scripting`, `storage`, and `offscreen`; exact host permission: `https://www.douyin.com/*`.
- Development GoodJob match defaults only to `http://127.0.0.1:5191/*`; unset/blank input resolves to that fixed local origin, an explicit identical local value is accepted, and every other development `GOODJOB_APP_ORIGINS` value is rejected. Release builds require explicit HTTPS origins and reject wildcard or broad origins. The read-only audit deep-compares the full manifest to the template plus build origin, including CSP, optional permissions, content-script attributes, background/action, and web-accessible resources.
- Popup candidates are never auto-selected. Confirmation binds tab ID, window ID, and canonical video URL, focuses and activates the target, then revalidates it before script injection.
- Closing the popup does not abort. Explicit stop, user input, bound-tab close/navigation, same-window tab replacement, same-canonical-URL reload, URL-less target `loading` update, or real focus departure causes safe takeover; background activation in another window does not.
- Extraction reads only owned visible `innerText`, exact ARIA labels, public time/count text, explicit public comment IDs, and literal card-owned public profile links. It does not read images, styles, scripts, framework internals, cache/storage, nested reply bodies, cookies, or network responses.
- Login, captcha, security verification, selector drift, advertising cards, ambiguous exact-name buttons, and non-canonical source URLs fail closed.
- Missing public comment IDs use a full SHA-256 of canonical visible facts. Card index, geometry, relative time, and public counters are excluded, so movement or counter updates stay stable while replacement text changes the key.
- The extension protocol matches the Task 4 2000-character visible-text limit and its identity, count, viewport, bounds, confidence, timestamp, and reader-version constraints. Task 5 emits only DOM/ARIA observations with `redactedCrop: null`.
- The total session deadline remains the server-authorized `maxDurationMs`. A finalization reserve of 20% (capped at 1 second and floored at 1ms) derives an earlier work deadline for extract, DOM stability, batch send, ACK wait, retry delay, and programmatic scroll. Budget exhaustion queues terminal exactly once at the expired-budget check or timer callback, before rejection and abort settlement. This lets the allowed `maxDurationMs = 1` boundary start one transport send while still before the total deadline; hung/rejected sends and retries still stop at that unchanged deadline. ACK loss and transport rejection replay the exact retained batch and batch ID; the service worker clears pending state only after content confirms the matching ACK.
- Terminal delivery has bounded per-attempt timeouts and exact-event retries before the shared deadline. User takeover stops new page actions immediately and does not deadlock terminal delivery behind a pending batch.
- Every accepted content-script start owns a monotonic generation and unique owner object. Empty-window, source-fallback, normal-reader, and unavailable cleanup clears shared reader/session/transport state only when the exact owner and exact local object still match. A newer start invalidates the old owner synchronously even when it reuses the same `sessionId`; superseded transports still close their own timers and cannot clear or terminalize the replacement lifecycle.
- `chrome.storage.session` stores only the closed session/tab/window/source/budget/usage/artifact-mode/nonce-hash/status state. Raw nonce, body text, profile data, batch payloads, images, cookies, and authentication material are absent from storage and logs.
- A service-worker restart clears residual authority before notifying surviving GoodJob and Douyin content scripts. GoodJob reports `partial_success` with `visual_reader_session_expired` using only its existing in-memory nonce, so the server completion path preserves the non-user failure instead of writing a user-takeover abort. Douyin stops any retained reader or pending batch. There is no silent orphan continuation.
- Manifest generation and bundle audit are separate commands. The audit is read-only and rejects a tampered manifest without repairing it. Extension output lives in `dist-visual-reader/douyin-visual-reader`, so the main Vite build cannot erase it.

## TDD and verification evidence

Review RED cases reproduced a permanently blocked extractor, a lost ACK with only one send, a bounds-dependent missing-ID key, a 2001-character protocol mismatch, missing tab/window revalidation, absent restart recovery, a check command that regenerated tampered evidence, and the main build deleting extension output. Later REDs reproduced a permanently hung terminal runtime send and the exact `derive(0, 1)` real-reader/real-transport boundary where asynchronous budget handling reached the session deadline with zero terminal attempts (`0 !== 1`). The latter is GREEN with synchronous, idempotent deadline-trigger queuing plus exactly-once, no-early-completion, takeover/stop, timer-cleanup, and no-post-session coverage. The user-authorized extra repair RED held an old source-failure fallback send pending, started a real replacement DOM reader, ACKed its first batch, then settled the old fallback; the replacement batch-2 ACK returned no response instead of `{ accepted: true }`. GREEN repeats this lifecycle for fallback success, rejection/retry, and timeout/retry, covers both different-session and same-`sessionId` replacement, preserves replacement ACK/abort and terminal delivery, and leaves no tracked timer or unhandled rejection.

Fresh final verification in the frontend worktree:

- `npm run test:visual-reader`: PASS, ten focused groups plus the aggregate extension self-test;
- `npm run test`: PASS, 125 checks;
- `npm run test:types`: PASS;
- `npm run verify:visual-reader-build-order`: PASS for extension build/audit, main build, and final read-only extension audit;
- `git diff --check`: PASS.

The only build message was the existing Vite chunk-size warning. Tests used fixed local HTML fixtures and fake runtime/state transports. No real Douyin request was made, no Chrome Web Store publication was claimed, and Task 6 screenshot, crop, OCR, and vision work was not started.

The user-authorized extra repair is implemented at frontend commit `1c00cbf` and independently approved. The reviewer replayed fallback success, rejection/retry, timeout/retry, and same-session-ID replacement paths; new-session ACK/abort routing survived every stale completion, while old local transports and timers still closed. No new Critical or Important finding remained. The earlier deadline-snapshot adjudication remains unchanged.
