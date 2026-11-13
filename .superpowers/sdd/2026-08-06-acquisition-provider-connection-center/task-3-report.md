# Task 3 Report — Accessible in-workspace provider drawer

## Result

Implemented the search Provider Connection Center as an accessible right-side
drawer inside the AI Growth workspace. The existing “配置搜索来源” CTA now opens
the drawer in place without changing the hash, workspace, task text, platform,
or selected template.

The drawer renders only returned `kind=search` providers, correlates safe
connection projections, exposes honest lifecycle status and actions, and
continues the preserved acquisition task only after an `active + passed +
search` connection exists.

## Security and lifecycle guarantees

- The API Key exists only in the live password input and a short-lived local
  event-handler variable used for the request.
- Save and confirmed rotation read the input directly, blank it, restore
  `type=password`, and only then await the controller action.
- No value attribute, fake masked key, Base URL field, controller/view-model
  state, URL, local/session storage, toast, or serialized drawer HTML contains
  the submitted fixture key.
- Closing, changing selection, rerendering, leaving the workspace, success, and
  error replace or remove the input; in-flight results are still protected by
  the Task 2 generation/mutation guards.
- Catalog text, capabilities, cost notes, messages, and errors are escaped.
  External documentation links render only for parsed HTTPS URLs and include
  `target=_blank` plus `rel="noreferrer noopener"`.
- Credential rotation and deletion require native confirmation; cancellation
  makes no PATCH or DELETE request.

## Accessible behavior

- The drawer uses `role=dialog`, `aria-modal=true`, and a stable labelled
  heading.
- Opening records the semantic trigger, locks body scrolling, and focuses the
  active drawer after every rerender.
- Escape closes the active Provider or Battle Card drawer, restores body
  overflow, and restores focus even when the original trigger node was replaced
  by a render.
- Tab and Shift+Tab are trapped within whichever AI Growth drawer is active.
- The provider backdrop has no destructive click action.
- Status/error messages use `role=status`/`role=alert`; all mutation buttons
  disable and use operation-specific progress labels.

## RED → GREEN evidence

Observed focused RED failures before their matching implementations:

- missing `provider-connection-center` module
- absent connection action/gating markup
- CTA continued to navigate away and no provider dialog appeared
- provider selection did not render an API Key input
- pending save left no request path through the mounted UI
- rotation/delete produced zero confirmations
- provider drawer did not lock body scrolling or trap focus
- focus restoration failed after the trigger DOM node was replaced
- Task Input counted content reader/import connections and marked
  `active + failed` search as healthy
- pending create rendered an enabled “保存连接” button without progress text
- leaving the workspace kept the connection center open

Final focused GREEN:

- provider renderer: 6 tests passed
- mounted Playwright flow: 4 tests passed
- focused Task Input health and drawer lifecycle tests passed

## Changed files

- `frontend/src/features/ai-growth/components/provider-connection-center.ts`
- `frontend/src/features/ai-growth/provider-connection-center.test.ts`
- `frontend/src/features/ai-growth/controller.ts`
- `frontend/src/features/ai-growth/controller.test.ts`
- `frontend/src/features/ai-growth/styles.css`
- `frontend/tests/ai-acquisition-loop.spec.ts`
- `.superpowers/sdd/2026-08-06-acquisition-provider-connection-center/progress.md`
- `.superpowers/sdd/2026-08-06-acquisition-provider-connection-center/task-3-report.md`

## Verification

- focused mounted Playwright: 4 passed, 0 failed
- frontend unit suite: 126 passed, 0 failed
- frontend production build/typecheck: passed; Vite retained only the existing
  large-chunk warning
- `git diff --check`: passed

## Desktop and mobile visual inspection

Inspected the real local page at `#ai-growth/new` with the local frontend and
backend running, using a deterministic provider catalog at both viewports.

- Desktop 1440×1000: drawer width 680px; six providers render in two balanced
  columns; form/footer remain readable; backdrop preserves the task behind it.
- Mobile 390×844: drawer is exactly viewport width; catalog, facts, actions,
  and secret field collapse to one column; no horizontal page overflow. The
  footer is static at this breakpoint so it never covers provider cards.
- Both: body overflow is locked, focus remains inside the dialog, and the
  password input has no value attribute.
- At the mobile scroll endpoint, Save and Continue are both visible and do not
  overlap.

Screenshots captured during inspection:

- `/tmp/task3-provider-desktop.png`
- `/tmp/task3-provider-mobile.png`
- `/tmp/task3-provider-mobile-form.png`

## Independent review

The independent accessibility/security review found no Critical or security
issue. It raised two actionable accessibility findings and both were addressed:

- rerenders originally focused the first drawer control because `innerHTML`
  replacement detached the active node; the mount now captures a stable
  action/provider/connection/candidate/field descriptor before render and
  restores the matching replacement. Only a newly opened drawer receives
  first-control autofocus, and a focused browser regression covers provider
  selection.
- password labels originally wrapped both an input and toggle button; each input
  now has a dedicated `label[for]`, while the sibling toggle has an explicit
  `aria-label` and `aria-controls`.

Visual review additionally found the mobile sticky footer could obscure later
provider cards. The ≤560px footer is now static; the responsive browser test and
fresh screenshots confirm the correction.

The reviewer re-checked both accessibility fixes and returned an approved
verdict with no remaining blocker.

## Scope

No backend, OpenAPI, generated contract, generic settings navigation, or
protected user plan file was changed.
