# Task 3 Brief — Accessible in-workspace provider drawer

## Goal

Turn the completed Provider Connection state machine into a polished,
accessible, in-context drawer inside the AI Growth workspace. The existing
“配置搜索来源” action must stop navigating to generic settings.

## Scope

- Create `frontend/src/features/ai-growth/components/provider-connection-center.ts`.
- Modify `frontend/src/features/ai-growth/controller.ts` only for rendering,
  event delegation, focus management and wiring existing Task 2 actions.
- Modify `frontend/src/features/ai-growth/styles.css`.
- Modify/create focused component, controller mount and accessibility tests.
- Do not add backend or OpenAPI behavior.

## Product Layout

- A right-side drawer is appended as an overlay in every relevant AI Growth
  render branch. It must not change the hash/route or navigate away.
- Header: “搜索来源连接中心”, concise explanation that the customer uses their
  own official API Key and that GoodJob never displays it again.
- Provider catalog: show all returned `kind=search` catalog providers with
  official display name, capabilities/cost note when present, connection
  status, and a safe official documentation link.
- Provider status labels must distinguish:
  - 未配置
  - 已保存·待测试
  - 测试通过·待启用
  - 已启用·可用于获客
  - 测试失败
  - 已禁用
- Selecting an unconfigured provider opens a compact connection form.
- Selecting an existing connection opens its safe details/actions. Never show
  a fake masked key or imply that the old key can be recovered.

## Secret Handling

- The API Key exists only as the live value of a user-edited
  `<input type="password">`; it must never be interpolated into HTML,
  attributes, view models, controller state, local/session storage, URL,
  toast, logs or snapshots.
- On Save, read the input directly, immediately blank the input element before
  awaiting the request, and pass the local string to
  `controller.saveProviderConnection`.
- On close, selection change, rerender, success or error, no prior secret value
  may remain in the document.
- A “显示/隐藏” control may toggle only the current input element's `type`; it
  must not copy its value elsewhere.
- Do not expose Base URL in the default UI. The official backend default is the
  supported product path; advanced custom URL remains out of this task.

## Actions

- `configure-connections` → open current-workspace drawer.
- `close-provider-connections` → close drawer.
- provider/connection selection → existing controller selection methods.
- `save-provider-connection` → save/rotate disabled credential.
- `test-provider-connection` → real test; render HTTP-200 `ok:false` as failure.
- `enable-provider-connection` available only when current safe projection is
  `lastHealthStatus=passed`.
- `disable-provider-connection` uses status-only mutation.
- `delete-provider-connection` and credential rotation require an explicit
  confirmation (native confirm is acceptable); cancel produces no API call.
- `continue-after-connection` is enabled only for at least one
  active+passed+search connection and invokes the Task 2 continuation flow.
- All async buttons are disabled while `mutationStatus !== idle` and display a
  specific progress label.

## Existing Workspace Corrections

- Search health chips in `TaskInput` must filter out content_fetch/import and
  derive health from both status and `lastHealthStatus`; do not report system
  reader/import sources as healthy search connections.
- The connection-required copy stays visible behind the drawer and the user's
  task text/platform/template remain unchanged.

## Accessibility and Responsive Behavior

- `role="dialog"`, `aria-modal="true"`, and `aria-labelledby` bound to a unique
  drawer heading.
- Opening stores current focus, locks body scroll and focuses the first useful
  control. Closing/Escape restores focus and scroll state.
- Tab and Shift+Tab are trapped inside whichever AI Growth drawer is active.
- Backdrop click must not cause an accidental save/delete; closing by backdrop
  may be omitted.
- Buttons have visible focus styles; status updates use `role=status` or
  `role=alert` appropriately.
- Width ≤900px: `min(620px, calc(100vw - 24px))`; ≤560px: full viewport width,
  with single-column provider/action layouts.
- Respect reduced motion and preserve the existing AI Growth visual language.

## Security Rendering Rules

- Escape every catalog/provider/message/error field.
- Only render official docs links whose parsed scheme is HTTPS (HTTP allowed
  only if the existing product policy explicitly permits it; prefer HTTPS).
- Add `target="_blank" rel="noreferrer noopener"` for external docs.
- No `innerHTML` fragment may be sourced from API text without escaping.

## TDD Cases

1. Rendering six search providers and correlating a configured connection.
2. Status labels for unconfigured, untested, passed-disabled, active-passed,
   failed and disabled.
3. HTML escaping and unsafe docs URL rejection.
4. Password field has no value attribute; rendered/serialized output never
   contains fixture secret.
5. CTA opens inline drawer with unchanged hash and no generic navigation.
6. Save handler blanks the DOM input before the async request settles.
7. Failed health cannot enable/continue; passed + active can continue.
8. Confirm cancel blocks rotate/delete.
9. Escape, focus restoration and Tab trap work for connection and battle-card
   drawers.
10. Task input counts only real search connections and labels health honestly.
11. Responsive CSS assertions or browser checks cover desktop/tablet/mobile.

## Required Method

1. Write focused render/mount/accessibility tests first and demonstrate RED.
2. Implement the smallest complete drawer and event wiring.
3. Run focused tests, full frontend unit suite, production build and
   `git diff --check`.
4. Manually inspect the real local page at `/\#ai-growth/new` (or the repo's
   current equivalent) at desktop and mobile widths; capture findings in the
   report.
5. Obtain independent review, address actionable findings, and commit as
   `feat: add acquisition connection center`.
6. Write `task-3-report.md` and update `progress.md`.

## Protected File

Do not read, modify, stage or commit
`docs/superpowers/plans/2026-07-23-ai-model-adapters-and-pi.md`.
