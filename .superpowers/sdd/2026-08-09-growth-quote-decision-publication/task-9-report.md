# Task 9 report

## Status

Implemented the seven controlled Quote Pi tools on the singleton Growth tool
registry and injected one domain-neutral `GrowthAcquisitionToolDelegate` into
the production Acquisition executor. Owned Growth calls branch before the
generic Acquisition result ledger; the Quote executor is the sole envelope
ledger owner and authorizes/projects the frozen internal snapshot on every
fresh or replay attempt.

The delegate rebuilds `ActiveWorkspaceContext` from the persisted Copilot
session, current active user, and the issued acquisition-workspace resolver.
Tool payloads are closed and cannot supply tenant, actor, role, workspace, or
capability authority. Write revisions become the child
`CommandContext.expectedRevision`; Quote command results expose only `.value`,
not the domain replay flag.

## Contract decisions

- Used the immutable Growth contract 1.0.2 Quote input shapes.
- `preview_quote` and `create_quote_draft` require positive
  `quoteCaseRevision`; `create_quote_approval_task` requires positive
  `quoteVersionRevision`.
- The Pi retry path derives its expected revision from canonical parsed tool
  input and the frozen operation identity. It does not depend on a fabricated
  HTTP `ETag`. This resolves the Task 8 observation that publication GET does
  not declare an ETag while retry requires `If-Match`, without changing the
  contract.
- Legacy model bundles remain closed and immutable. A gate-required, explicitly
  authorized scope expansion updated `acquisition-pi-gateway-runtime.ts` and
  its test so the legacy compatibility adapter filters all seven new Quote
  names and rejects a forged legacy Quote call. No legacy tool semantics or
  hashes changed.

## Verification

- RED: focused suite failed because the Quote tool module was absent.
- RED (legacy compatibility): gateway test failed with
  `MODEL_TOOL_DEFINITION_INVALID` after the seven tools entered the current
  allowlist.
- GREEN focused gate: 32/32 passed.
- `npm run test:agent:pi`: all five Pi/Copilot test segments passed.
- Growth Quote module gate: 2/2 passed.
- `npm run build`: passed.
- `git diff --check`: passed.

## Concerns

- `MYSQL_TEST_ADMIN_URL` was unavailable, so no live MySQL gate was run. All
  required non-live gates passed.
