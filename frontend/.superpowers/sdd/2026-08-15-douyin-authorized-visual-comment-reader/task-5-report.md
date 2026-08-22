# Task 5 report: bounded Douyin visual reader extension

## Delivered

- Manifest V3 extension with exact `activeTab`, `scripting`, `storage`, and `offscreen` permissions
- Exact Douyin host permission and generated, allowlisted GoodJob content-script origins; the read-only audit deep-compares the complete manifest to its template plus build origins
- Task 4 bridge protocol parity for `probe`, `start`, `acknowledge_batch`, `abort`, `ready`, `observation_batch`, and `terminal`
- Explicit popup selection and confirmation of one canonical Douyin video tab
- Visible, top-level comment extraction using DOM text, ARIA names, public time/count text, literal comment IDs, and literal in-card public profile links
- Fail-closed handling for selector drift, ambiguous read-only buttons, login, captcha, security verification, ads, and nested replies
- Bounded batching, ACK retention, deduplication, at most five programmatic scrolls, two-cycle no-progress stop, duration stop, and user-takeover stop; work stops before a reserved finalization window, empty or expired work queues terminal before content setup, and terminal attempts remain within the same total session deadline
- Per-start lifecycle ownership uses a monotonic generation plus a unique owner object, so a settled, rejected, or timed-out fallback from an older start cannot clear a replacement reader, session, or transport; this also protects restarts that deliberately reuse the same `sessionId`
- Strict `chrome.storage.session` projection containing only session/tab IDs, limits, usage, artifact flag, nonce hash, and state
- Same-canonical-URL reloads, URL-less `loading` lifecycle updates, and bound-tab replacements fail closed without affecting other tabs or windows
- MV3 restart reports `partial_success` with `visual_reader_session_expired`, so the GoodJob controller uses server completion rather than a user-takeover abort
- Local fixture tests using pinned `linkedom@0.18.13`; production bundle audit rejects linkedom leakage, remote network APIs, source maps, dynamic code, broad origins, and forbidden permissions
- Preserved popup visual language with deep green, warm white, cool gray, native controls, visible focus states, and polite live status

## Safety boundary

The Task 5 extension does not capture screenshots, run OCR, read cookies, inspect images or internal framework state, access browser storage from the Douyin page, call remote APIs, or perform private messages, likes, comments, follows, captcha handling, or other write interactions. Every observation has `redactedCrop: null`. Screenshot cropping and OCR remain Task 6 work.

## Verification

```text
npm exec -- tsx browser-extension/douyin-visual-reader/src/content-start.self-test.ts
  RED: maxDurationMs=1 content setup advanced the clock and the real transport attempted 0 sends instead of 1
  GREEN: PASS
  USER-AUTHORIZED EXTRA REPAIR RED: an older deferred fallback settled after a replacement reader reached batch-2, then the replacement ACK returned no response (`null`) instead of `{ accepted: true }`
  GREEN: PASS for stale fallback success, rejection/retry, and timeout/retry; both different-session and same-sessionId restarts retain ACK/abort routing, the replacement transport emits its aborted terminal, and all tracked timers/unhandled rejections are clear
npm exec -- tsx browser-extension/douyin-visual-reader/src/service-reliability.self-test.ts
  RED: an eligible send that consumed its last millisecond scheduled 1 timeout beyond the deadline instead of 0
  GREEN: PASS
npm run test:visual-reader       PASS
npm run test:types               PASS
npm run verify:visual-reader-build-order PASS
npm run check:visual-reader-bundle PASS
npm run test                     PASS (125 checks)
git diff --check                 PASS
```

This user-authorized extra repair wave is implemented and locally verified; independent review of the repair is pending. It does not change the public protocol, permissions, storage/logging boundary, or Task 6 scope.

The development manifest contains only `http://127.0.0.1:5191/*` for the GoodJob content script; unset or blank development origin input resolves to that fixed local origin, and every other supplied value is rejected. Release rendering fails closed unless `VISUAL_READER_RELEASE=1` is accompanied by explicit HTTPS `GOODJOB_APP_ORIGINS`. The read-only audit rejects any full-manifest drift from the template and rendered origins, including CSP, optional permissions, content-script attributes, background/action, and web-accessible resources.

The finalization reserve is 20% of `maxDurationMs`, capped at 1 second and floored at 1ms. Extract, send, ACK, DOM-stability, and scroll operations stop at the derived work deadline. A legal start whose work window is empty or already reached synchronously queues the budget terminal before constructing the DOM adapter, resolving the source URL, creating the reader, or installing takeover listeners. The first terminal eligibility check and send initiation share one synchronous decision: `maxDurationMs = 1` starts one attempt before setup can consume the session, while a queue decision at or after the absolute session deadline starts none. If the eligible send itself consumes the remaining time, no attempt timeout is scheduled beyond the deadline. Hung and rejected attempts remain bounded by that unchanged total deadline; normal sessions retain the reader completion path, work expiry emits once, takeover and explicit stop retain their aborted terminals, and setup fallback emits no duplicate terminal. Content-session and fallback cleanup now await the transport's bounded idle lifecycle instead of leaving terminal delivery unowned.

The final unpacked extension contains seven files and is approximately 64 KB. It has only been validated with fixed fixtures and local extension builds; real Douyin compatibility and Chrome Web Store publication are not claimed.

## Dependency and workspace note

`linkedom 0.18.13` is recorded in `THIRD_PARTY_NOTICES.md` as an unmodified ISC-licensed test-only dependency. The pre-existing untracked `package-lock.json` was not read, modified, staged, deleted, or committed; its size and modification timestamp remained unchanged before and after the no-lock install and all verification commands.
