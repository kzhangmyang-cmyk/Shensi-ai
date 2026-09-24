# CFO conversation pilot

## Current boundary

The real `#agents` question panel supports the six selected specialist roles. The existing six-role reporting
workflow, verified data ingestion, draft editing and outreach remain unchanged.
Each role can analyze a selected partial ledger, income/expense table or other
read-only enterprise document; three complete financial statements are not a
chat prerequisite. Current-conversation attachments take precedence over an
explicit finance-page selection, which takes precedence over verified statements.
Missing values remain missing. The formal financial-council workflow retains its
separate verified-statement requirements.
The question editor survives report-controller rerenders. CFO text conversations
are saved as encrypted, actor/workspace-scoped records in `cfo_conversation_sessions`.
The history list shows the latest fifty sessions; each retains up to one hundred
completed turns. Model context stays bounded to ten recent turns, including
confirmed in-page voice turns. Voice audio/transcripts are not persisted by this
text pilot. History is unverified conversation, not company facts or a knowledge
base. Other five roles keep their existing page-local history.

`/api/v1/finance/cfo-sessions` creates/lists sessions, `/{sessionId}` restores a
session, and `/{sessionId}/turns` answers and saves with revision compare-and-swap.
An old revision or changed document source rejects continuation; the UI preserves
the unsent question and offers reselecting history or a new conversation. New
conversation and role switching preserve input. Expired read-only sources are not
recreated or silently replaced. Failed questions are not stored as completed
answers; uncertain/disconnected requests are not automatically replayed. Reopen
the saved history to check whether a response was persisted before disconnect.
If history cannot be loaded, the existing ephemeral text route remains available
with an explicit history-unavailable message.

Six-role text questions use the current role model to decide whether public
research is needed, after validating the selected document and role route.
Planning receives only the question and a same-scope public topic; private
attachments, history and preferences are never added to a search query.
Recognizable private internal-analysis questions skip research; mixed private
search questions require a separate public topic. One bounded retrieval feeds
the existing answer model. Financial values and document references retain their
original validators; public snippets provide qualitative context, not company facts.
An optional `research` snapshot (Growth 1.0.34) contains validated source IDs,
URLs, snippets and timestamps. It is saved in the same assistant-turn CAS and
restored without another search. The UI displays expandable sources below the
answer; search connections remain in settings. Missing connections, empty results
and invalid citations are explicit failures. Voice research is not enabled.

Text or confirmed voice turns that explicitly ask the software to execute a
Douyin acquisition workflow are separated from financial Q&A before the CFO
HTTP route. The panel immediately creates one `cfo.acquisition.orchestrate`
server job through `POST /api/v1/acquisition/cfo-workflows`; it does not depend
on a browser event or a later visit to the Acquisition page. The instruction and
workflow output are encrypted with the existing AgentJob payload boundary. The
server creates the existing auditable plan and returns a bounded review snapshot
containing its objective, providers, operations and budget. Collection starts
only after an explicit click on `批准并启动` records the human reason and calls
the existing plan approval/run services.

The AgentJob record is the execution authority and is scoped to the exact owner
and team. It stores the Plan, Run, candidate decision, Customer and Todo links;
reopening the panel loads `/cfo-workflows/latest` instead of trusting
localStorage. Its generic aggregate identity remains immutable after insertion;
the generated Plan ID is stored in the encrypted workflow state instead of
rewriting the AgentJob key. A five-second application-owned reconciliation loop advances a
running workflow after the existing acquisition Run reaches a terminal state.
Candidates are deduplicated by the existing Run candidate links and remain
pending until a human approves, rejects or marks them do-not-contact. Approval
uses the existing qualification decision version, acquisition attribution and
private-domain handoff service to create/recover the CRM customer and first
follow-up Todo. Operation-derived idempotency keys prevent duplicate callbacks
from duplicating review, CRM or Todo writes. Cancellation is persisted before
remote cancellation is requested and blocks all not-yet-started candidate
writes. There is no global workflow lock; only same-process operations for the
same workflow ID are serialized.

The focused real-MySQL integration test provisions an isolated database, runs
the workflow through an approved candidate and CRM/Todo handoff, closes and
reopens the store, verifies the workflow and links after restart, then drops
only that test database. Run it by supplying `MYSQL_TEST_ADMIN_URL` to
`backend/src/cfo-acquisition-workflow-test.ts`; ordinary tests skip this one
when no disposable MySQL administrator connection is available.

The retired `cfo-acquisition-progress.ts` browser pointer remains only as a
compatibility/test artifact for the former cross-page event flow and is no
longer installed by `app-entry.ts` or read by the CFO panel. External
comment/private-message approvals remain separate from this workflow.

`POST /api/v1/finance/cfo-conversation` → workspace resolver and
`finance.council.run` → `FinancialCouncilAgentCenter.ask` → exact selected read-only
document, or latest verified statement package for that workspace → current selected-role routing or existing default
connection → immutable model snapshot → structured text gateway. The request
contains question, user/assistant history, optional `role` (omitted means CFO) and
optional `documentId`. A nonempty document ID is scoped to the authenticated actor/workspace;
expiration, replacement or restart never falls back to an older verified package.
Null or omitted ID retains verified-package semantics. No client-supplied reports,
system turns or write tools are accepted. Source report period and model appear
under the answer. No report means null material, not fabricated company figures.
Methodology loads the selected product-owned skill (CFO: `cfo-operating-advisor.v1`) and
deterministic preparation below; this is not company RAG.

The conversation identifies the actual source: an explicitly AI-read original
CSV/XLSX, text PDF or DOCX from **财务经营**, or the current workspace's most recently confirmed
three-statement import from **准备财务分析**. Original-source reading supports
partial and same-sheet mixed statements without creating a package or council run.
Choosing a file alone, an unconfirmed statement preview or a ledger commit does
not select question material. Clear the current read-only source to explicitly
return to confirmed statements. The input lifecycle is in
`finance-document-reading.md`; role methods are in `agent-specialist-skills.md`.

Closing the panel or stopping a question aborts the request and rejects late UI
updates. HTTP disconnect propagates abort into the provider fetch. Request rate
is bounded per authenticated workspace/actor; there is no automatic question
retry. Gateway credentials and verified business reports stay server-side.

## Product-owned CFO skill

The CFO pilot has an internal optional execution observer on
`FinancialCouncilAgentCenter.ask`. It reports `material_ready` after source
resolution (including an explicit absence of material), `skill_ready` after
skill preparation, `model_started` immediately before the gateway request, and
`answer_validated` only after the selected answer path succeeds. Both confirmed
statements and read-only documents propagate this observer. It contains no
model reasoning, source text, credentials, estimated percentage or timer-driven
progress. Cancellation fences callbacks; an observer failure does not own or
cancel business computation. Other roles and the existing JSON/voice callers
remain unchanged. CFO session turns accept `application/x-ndjson` for actual
stage events followed by a saved result or safe error; the existing JSON route
remains available. The interface displays only these real stage events, and
`answer_validated` is labelled as still saving until persistence succeeds.
The bounded follow-up scope and acceptance are in
[`cfo-conversation-pilot.md`](cfo-conversation-pilot.md).

`backend/src/skills/cfo-operating-advisor/SKILL.md` is the maintained method
asset. `prepareCfoSkill` loads it beside its module, selects relevant methods
from the question/short follow-up history, and prepares facts before
`createCfoChatModel` calls the existing durable gateway. The Backend build copies
the same asset next to compiled JavaScript; there is no separate persona copy
or global Codex installation. Text and realtime `ask_cfo` share this path.

The trusted internal material includes the existing package hash, parser
version, creation time, statement source hashes and import warnings, supplied
by `FinancialCouncilAgentCenter.ask`. The public answer remains plain text; Growth 1.0.17 retains the optional request role. No client can supply that material. Conversation numbers remain
unverified, not a substitute for company records.

Methods cover operating diagnosis, profit versus cash, comparison prerequisites,
prioritized follow-up and tax-scope clarification; standalone greetings bypass
financial preparation. Canonical report validation and existing normalization
produce profit/asset totals. Growth integer currency tools produce signed
rounded basis-point ratios. Facts carry formula, unit, input fields and package
ID. Zero denominators yield a missing ratio, not zero or infinity. A metadata
company/period/currency/unit conflict or cash reconciliation difference above
the existing one-major-unit tolerance withholds precise facts and raw material
from the model. The cash-profit difference is not an explained causal bridge.

The current reader supplies only the latest verified package, **not a budget
or prior-period baseline**. No comparable growth/variance is fabricated from
chat. The financial question path has no write tools; only the separately
detected execution intent can create the bounded server workflow and still
requires explicit plan and candidate decisions. Period labels do not preserve monthly versus cumulative column coverage;
accounting basis also needs confirmation for comparisons. Historical cash is not
a forecast; no customer-loss/overdue-stock cause can be concluded from aggregate
figures alone. Skills are methods; versioned company knowledge and model
training are different capabilities.

The six-role responsibilities, numeric reference validator, missing data and
reuse decisions are in [`agent-specialist-skills.md`](agent-specialist-skills.md).
Models receive display facts, not raw Minor integers or raw reports. They compose
`{{fact:id}}` references; the server validates and renders exact amounts, ratios
and percentages. One structured-output repair is allowed; persistent numeric
violations fail closed. Existing council-run specialist formulas/knowledge are
not silently replaced. Only CFO supports realtime voice.

## In-product voice settings

The CFO realtime connector defaults to the supported `Ethan` voice for the
male operating-advisor voice. Fresh connections and reopened sessions use the
same default; an explicit connector voice override remains authoritative.
Startup-greeting saved voice preferences remain unchanged. The controlled
WebSocket test checks the actual `session.update` payload, not a persona prompt.
This is configuration verification, not physical microphone/playback acceptance.
Provider reference: [Qwen realtime audio](https://help.aliyun.com/zh/model-studio/realtime).

Session failure diagnostics contain only the normalized failure code, elapsed
timing, audio-gap duration and tool/output pending flags. They contain no audio,
transcripts, history or credentials. Existing logs without an ending reason are
insufficient to attribute intermittent disconnections; adding this observation
does not itself repair reconnection behavior.

Open **智能体中心 → 和经营总管聊聊 → 语音服务设置** in the desktop app.
**设置中心 → 语音服务 → 配置** also opens this same dialog after the agent
view is ready. Leaving the destination or changing account cancels a pending
open; navigation alone does not start a voice session.
The black/green dialog accepts a Beijing Bailian API Key and an optional Bailian
Workspace ID. Main uses the supported public Beijing endpoint
`wss://dashscope.aliyuncs.com/api-ws/v1/realtime` with Bearer authentication;
the optional ID is local metadata, not interpolated into that host. A workspace
dedicated endpoint is a separate supported provider option, not a prerequisite
for this public endpoint. Fixed help
buttons open the relevant official documentation. Advanced connection details
show `qwen3.5-omni-flash-realtime`, Beijing, and the current local storage scope.

Successful save/replace clears the password input; a failed save retains both
local inputs, with the Key still masked, so the user can correct the reported
field without repasting it. Closing/disposal clears the Key. Renderer and Main
share the same format validator: trim surrounding whitespace, accept a bounded
nonempty header-safe Key without guessing its provider prefix, and normalize the
Bailian Workspace ID as a DNS label when supplied (empty is valid). `voice_key_invalid` and
`voice_workspace_invalid` identify the field before any provider connection;
`voice_input_invalid` identifies a malformed command/DTO, not a model rejection.
The outer IPC workspace identifies Shensi authorization/storage scope; the
save input's workspace identifies Bailian. Model selection is fixed in Main,
not a required save field. Neither format validation nor saving proves provider
ownership or model access. Old credentials never return through read IPC.
`safeStorage` encrypts both values in a private 0700 directory / 0600
record, scoped to the authenticated Shensi actor and workspace. No Key is stored
in Renderer localStorage, logs, source, URL query strings or a readable env file.
Removing a configuration closes its active session and deletes only that record.

Saving yields `saved`, not `ready`. Explicit 检测连接 opens a bounded Main
WebSocket and requires `session.created` followed by acknowledged
`session.updated`. Credentials, permission, network and protocol failures have
separate safe messages. The check sends no microphone audio; ready status is
memory-only and must be checked again after application restart. Settings and
check/start IPC revalidate current authentication and finance workspace rights.
Connection failures record `cfo.realtime_connection_failed` in the existing
private desktop log. Diagnostics contain a closed handshake stage/reason,
numeric HTTP status, provider code/parameter categories, response format/content
type and server categories, Via presence and bounded redacted error semantics.
At most 16 KiB of the HTTP body is read in memory; raw responses and headers
are never persisted. Actual credential/workspace values, URLs and private
request/session identifiers are removed before any semantic text reaches the
log. `cfo.realtime_turn` records only stages, routing category and numeric
elapsed/duration and character/audio-byte counts; never transcripts, audio, or conversation IDs.
A generic protocol error
alone does not establish invalid credentials or missing model permission.

Mac startup greeting is a separate, bounded capability. After authentication,
a concrete workspace and the startup Logo exit are all complete, Main plays one
locally approved greeting. Settings expose an enabled switch, `Ethan` male or
`Tina` female voice, fixed or random selection from three checked-in sentences,
draft preview, and explicit save. Preview receives a closed preference DTO and
does not persist it; leaving the settings surface stops in-flight preview.
Persistence completes before the active in-memory preference changes, so a
failed write leaves the previous setting effective.

The verified Bailian Qwen `Tina` WAV for the default fixed sentence is a build
input and packaged application resource. A fresh Mac copies that read-only
resource into the application's private `voice-preferences` directory as a
`0600` cache; later launches play the cache with `/usr/bin/afplay`, without
requiring that user to configure an API key or making another cloud synthesis
request. Other selected voice/text combinations use a private content-addressed
cache and require a valid encrypted Bailian configuration for the first
synthesis. The readout sends neither microphone audio nor business/tool
requests, validates the exact transcript and uses an empty tool set. DashScope
may omit an acknowledged empty `tools` field, which is accepted only when the
instructions acknowledgement still matches exactly.

Main guards once per process launch; route refresh/polling does not repeat the
greeting. Stop/mute, logout, workspace replacement and disposal invalidate work
that is still waiting on authorization or the Logo exit, and stop playback from
the old scope. Synthesis, validation, cache or playback failure never blocks
application startup. Mute preference is persisted privately for this
application on this Mac. Greeting never requests microphone permission. Its
status contains mute, voice, random-mode and speaking state; realtime readiness
belongs to the separate realtime bridge.

## Streaming audio and business authority

`cfo-conversation.ts` → `CfoRealtimeClient` → explicit microphone permission →
`openCfoMicrophone` / AudioWorklet → mono PCM16 at 16kHz in 100ms chunks → narrow
IPC → Main `CfoRealtimeService` → `openQwenRealtime` / official WSS endpoint.
The Main transport retains the Master Key and authenticates with a Bearer header.
Web Audio plays 24kHz PCM deltas; it is not a full-answer TTS loop. Capture
requests browser echo cancellation, noise suppression and auto gain. Those
constraints are requests, not a claim that acoustic echo has been measured.

The provider's semantic VAD detects turns. Business answers use only `ask_cfo`,
the authenticated current workspace, existing CFO text-model route and verified
reports. Unknown tools stop the session. Main drops autonomous response audio
until an authorized answer is available. It does not depend on the model
voluntarily choosing a tool: a completed response without a call waits for the
current utterance's transcription. On ASR completion, Main starts one business analysis immediately, overlapping provider routing; a later native tool call or fallback reuses that same promise. It does not enable audio before validation and response/acknowledgement gates. Full-utterance
matches for a small set of standalone greetings, thanks and audio-presence
questions receive fixed conversational replies. No substring matching is used;
mixed greeting/business questions and context-dependent “继续/好的” always use
the original CFO with conversation history.

For this fallback, Main sends the resolved answer through a documented
`session.update` instructions update with tools disabled for that readout,
requires the matching `session.updated`, and then sends `response.create`.
It never fabricates a function-call ID or an unsupported conversation item.
The next utterance restores normal instructions/tools; interruption or stop
cancels pending work/acknowledgements and ignores old callbacks. Transcription
IDs are deduplicated, not utterance text, so repeated greetings are distinct
turns. Transcription and configuration acknowledgement waits are bounded.
A collapsible written
business answer shows the original tool result and model. Voice paraphrasing is
not promoted to a verified report, long-term memory or business write.

Playback acknowledgements use `AudioContext.getOutputTimestamp().contextTime`
(latency-adjusted fallback), not generation completion. Only fully played output
with its final transcript enters local assistant history. No word alignment is
invented for a partly played sentence. Barge-in clears scheduled audio, cancels
the active provider response and **replaces the provider session**, seeded with
bounded confirmed history. About one second of captured pre-roll and up to
three seconds during reconnect are buffered. Old callbacks are generation-fenced.

Qwen's documented realtime protocol has no `conversation.item.truncate` /
delete or `tool_choice`. The older provider-neutral `cfo-realtime-session.ts`
is a prototype/test contract, **not the active Qwen adapter**; its truncate port
must not be used as evidence of a supported Qwen command.

Explicit stop, disconnect, route disposal, logout/workspace change, window
navigation/crash/quit release tracks, output nodes, timers and sockets. Main
allows microphone access only for the current local main frame during a started
session and checks current business permission every 15 seconds. Lost capture
is stopped within 15 seconds (initial permission preparation allows 60 seconds).
There is no automatic network-failure retry; barge-in context replacement is the
one deliberate reconnect path. Text questions end active speech and retain the
same bounded conversation history.

Dependencies: direct `ws` 8.21.3 (MIT), browser Web Audio and existing Electron
storage/authentication. No large voice framework or extra model runtime is copied.
Protocol references: [realtime](https://help.aliyun.com/zh/model-studio/realtime),
[client events](https://help.aliyun.com/zh/model-studio/client-events),
[tools](https://help.aliyun.com/zh/model-studio/qwen-function-calling), and
[public endpoint authentication](https://help.aliyun.com/en/model-studio/realtime-token-authentication),
[workspace lookup](https://help.aliyun.com/zh/model-studio/obtain-the-app-id-and-workspace-id).

## Conversation layout

The question panel is a complete scoped chat workspace rather than a bare form.
Its header shows the currently selected role's existing portrait, title and
responsibility; the toolbar contains role selection plus CFO-only voice controls.
A status rail distinguishes text-only specialist mode from CFO continuous voice,
and the empty canvas explains the verified-material boundary before the first
question. The labelled composer retains a clear primary action and character /
request status without adding decorative or nonfunctional controls.

On desktop, an agent with neither a real turn nor a recoverable acquisition
task keeps that empty state compact rather than stretching an otherwise blank
message area. Opening it does not seed demonstration messages or call the
business model, continuous voice, CRM, or acquisition actions; a real or
streaming turn and a recovered task use the normal operating layout.

The desktop right inspector stays a concise summary of the selected role,
workspace, used material and related work. Its financial-preparation summary
keeps the current three-report and model-routing state visible without putting
file fields into the narrow column. **准备财务分析** opens the existing report
import, routing and council-run controls in a full-width modal. Opening model
routing from there closes preparation first and shows the routing modal as a
separate top-level dialog, so the two native dialogs never compete. Opening
either dialog performs no import, model call, routing save or business write;
those remain explicit existing controls in the dialog.

Conversation copy uses 15px body / 11px labels, compact bubbles and bounded
history (400px / 45vh). User bubbles sit right with account initials when no
photo is available; assistants sit left with the selected role's portrait.
Switching role updates the header identity, cancels the old request and clears
completed/partial history while retaining the unsent question. The real form
stops propagation into the legacy demo submit handler. Desktop and 390px layouts
remain within the viewport without horizontal overflow.

Official `response.audio_transcript.delta` updates the same bubble incrementally
before playback completes, without invented word timestamps. Main deduplicates
event IDs and fences generations; Renderer coalesces latest text per animation
frame. Interrupted text remains marked “已打断 · 未计入对话上下文”. Only confirmed
complete playback becomes history. Reader scroll is preserved unless already
at the bottom. [Server events](https://www.alibabacloud.com/help/en/model-studio/server-events).

## Response latency

Sanitized stages cover speech stop, ASR, business start/end, controlled reply
acknowledgement, first audio, first playback and completion. One earlier real
business voice round took 3.123s from ASR to first audio (2.996s from tool start).
Logs do not establish physical hearing or echo quality.

ASR starts one abortable business computation without waiting for the provider's
routing response to finish. A controlled one-second routing / three-second
analysis case reaches an eligible answer at three rather than four seconds.
Native tool calls and fallback reuse that computation; interruption drops it.
Audio still requires the verified result and the response/acknowledgement gates.

Only conversational CFO requests to DeepSeek V4 Flash/Pro disable its default
thinking mode. The five specialists, other providers and council/report jobs keep
their existing defaults. In live tests, disabling thinking for cashflow repeatedly
failed numeric-reference validation, so that optimization is not deployed there.
[DeepSeek thinking control](https://api-docs.deepseek.com/guides/thinking_mode/).
Deterministic numeric validation stays enabled. Reasoning depth and variable
provider delay remain tradeoffs; exact measured samples are in PROJECT_STATUS.

## Real-device acceptance boundary

The development Electron already contains `NSMicrophoneUsageDescription`.
Before a future signed installer release, add the product microphone purpose
string and scoped `com.apple.security.device.audio-input` entitlement to the
signing policy and verifier, then test the signed application. No installer is
generated by this development pilot; old installed applications are not updated.

Saved user configuration must first pass an actual connection check, followed by
explicit microphone start to verify Bailian access, account quota, spoken turns, model tool calls,
speaker echo, physical hearing, interrupted-sentence continuity and weak-network
recovery. A fixture handshake or silent PCM playback cannot establish these.

## Validation

- `pnpm --dir backend test:cfo-conversation` (includes skill arithmetic,
  conflicts, missing data, follow-up and actual gateway-request integration)
- `pnpm --dir backend build` (copies the runtime skill asset)
- `pnpm --dir desktop exec tsx --test tests/cfo-voice.test.ts`
- `pnpm --dir desktop exec tsx --test tests/cfo-realtime-settings.test.ts tests/cfo-realtime-config-flow.test.ts tests/cfo-realtime-provider.test.ts tests/cfo-realtime-service.test.ts tests/cfo-realtime-ipc.test.ts`
- `pnpm --dir frontend exec playwright test --config=playwright.cfo-voice.config.ts`
- `pnpm --dir frontend test` (question, isolation, stale result, lifecycle tests)
- `./scripts/context-check`, `pnpm test`, `pnpm build`,
  `pnpm --dir desktop typecheck`, `pnpm --dir desktop build:main`, `git diff --check`

Real acceptance: #agents actual question/follow-up via configured model; no
report leads to explicit missing-data answer; switching workspace leaks no
history; one native greeting after real app launch; stop/mute and persisted
preference; no microphone activation. Future audio acceptance additionally
requires natural consecutive turns, interrupting during playback, actual-heard
history, speaker echo/weak-network recovery and microphone release on end.
