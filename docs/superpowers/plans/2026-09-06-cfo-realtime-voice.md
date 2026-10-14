# CFO realtime voice implementation plan

> Execute inline in the authorized current dirty workspace. No commit, package,
> cloud provisioning, production test credentials or acquisition writes.

**Goal:** Configure Beijing Bailian realtime voice inside the existing CFO panel,
with a Main-only encrypted credential and an actual streaming audio adapter.

**Architecture:** Main authenticates the current actor and requested workspace
through the existing session and finance agent-center permission route. A
separate per-actor/workspace safeStorage record holds Key and Bailian Workspace
ID. A bounded Main WebSocket speaks the official realtime protocol. Renderer
captures microphone PCM with AudioWorklet and plays PCM with Web Audio; narrow
IPC carries audio/control events but never returns credentials. `ask_cfo` is the
only tool and calls the existing authenticated CFO question endpoint.

**Protocol constraints:** Use the supported public Beijing DashScope endpoint;
the provider Workspace ID is optional metadata. Default model is
`qwen3.5-omni-flash-realtime`, voice Tina. Only documented events are used.
Qwen realtime has no documented truncate/delete or tool_choice. Interruption
cancels and replaces the provider session, seeding only local acknowledged
history in instructions. Partial playback retains duration, not invented word
alignment. Business audio is gated until the controlled CFO tool has returned.

## 1. Secure settings and Main transport

- [x] Add `desktop/src/shared/cfo-realtime.ts`: fixed provider/model, closed
  settings status, narrow save/remove/check/start/audio/stop/event bridge.
- [x] Add `desktop/tests/cfo-realtime-settings.test.ts` first: real temp private
  storage, encryption adapter, restart, replacement, removal, scope isolation,
  malformed input and unavailable encryption. Run red then implement
  `desktop/src/main/cfo-realtime-settings.ts` using existing private-storage.
- [x] Add protocol/service tests with a local WebSocket fixture before
  `desktop/src/main/cfo-realtime-provider.ts` and `cfo-realtime-service.ts`:
  session.created + session.updated required, no saving-as-ready, timeout,
  sanitized errors, abort/replacement, only ask_cfo, cancellation and cleanup.
- [x] Wire `cfo-realtime-ipc.ts`, `preload/cfo-realtime-api.ts`, Main lifecycle,
  fixed help URLs and audio-only microphone permission. Test untrusted frame,
  anonymous/forbidden/mismatched scope, stale session and invalid PCM commands.

## 2. Product entry and live audio

- [x] Add settings UI tests before `frontend/src/growth/agents/cfo-voice-settings.ts`:
  password input, save then clear, no auto check/recording, truthful state,
  replace/remove/help and unavailable bridge. Integrate in cfo-conversation
  without replacing its editor/history or business model settings.
- [x] Add `cfo-realtime-audio.ts` and an AudioWorklet processor with tests for
  PCM, output queue, playback acknowledgement, stale audio, interruption,
  permission rejection, disconnect and disposal. Keep devices closed until
  explicit Start. Never open a microphone during Codex conversation/testing.
- [x] Use the same backend permission/tool flow and bounded text history;
  provider output is not a verified financial report or business data write.

## 3. Verification and delivery

- [x] Run focused desktop/frontend tests, typechecks, root tests/build,
  context-check and diff check. Inspect current black/green product UI using
  isolated fixtures and actual Electron, including narrow viewport and errors.
- [x] Update current module/desktop/API documentation and PROJECT_STATUS.
- [x] Normal desktop:local restart loaded the latest settings/audio code after
  verifying saved configuration and no pending form edits. The user's own Key
  remains encrypted; no fixture credential or microphone session was introduced.
- [x] Report completed layers and explicit pending real connection/permission/hearing
  acceptance. Do not call a fixture handshake a real Bailian success.

The endpoint investigation identified IllegalEndpoint on the workspace hostname
and InvalidApiKey on the same-key public comparison. The user later established
a real voice session and received input transcription. A separate unconditionally
tool-gated output defect prevented greeting replies. Main now resolves an
uncalled turn from its transcription before requesting a controlled audio reply;
the chat panel also has compact scoped typography. These implementation
checkboxes do not certify audible real-device acceptance. Current runtime,
verification and remaining work are in PROJECT_STATUS.

## Reuse evidence

Official protocol: https://help.aliyun.com/zh/model-studio/realtime,
https://help.aliyun.com/zh/model-studio/client-events,
https://help.aliyun.com/zh/model-studio/qwen-function-calling,
https://help.aliyun.com/zh/model-studio/obtain-the-app-id-and-workspace-id.
Reviewed aceFelix/jarvis (MIT, early-stage self-described unstable): interaction
reference only; no command-execution/auto-approval framework copied. LiveKit
Agents JS (Apache-2.0) and Pipecat (BSD-2-Clause) require extra runtime layers
not needed here. Use the mature MIT `ws` client already present in the lockfile
as a direct desktop dependency; reuse Shensi private-storage and auth routes.
