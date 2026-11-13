# Task 1 Report — Provider lifecycle frontend API

## Result

Implemented the Acquisition V1 provider catalog and Provider Connection
lifecycle facade with generated OpenAPI DTOs. No backend or OpenAPI files were
changed.

The production advisor transport previously parsed every successful response as
JSON. `DELETE` returns 204, so the smallest compatible response reader was added
and wired into that transport; 204 now resolves as `void` without consuming a
body.

## RED → GREEN evidence

Focused command used for every vertical slice:

```sh
cd frontend
node --import tsx --test src/features/ai-growth/api.test.ts
```

Observed RED failures before each implementation:

- `listProviders is not a function`
- `createProviderConnection is not a function`
- `getProviderConnection is not a function`
- `updateProviderConnection is not a function`
- `deleteProviderConnection is not a function`
- `testProviderConnection is not a function`
- module did not export `readAdvisorResponse` for the real 204 regression

Final focused GREEN: 8 tests passed, 0 failed.

## Changed files

- `frontend/src/features/ai-growth/api.ts`
  - derives catalog, create, update, connection, and health DTOs from generated
    Acquisition OpenAPI operations
  - adds catalog plus create/get/update/delete/test facade methods
  - reuses existing JSON POST/error mapping and URL segment helpers
  - adds the 204-safe success response reader
- `frontend/src/features/ai-growth/api.test.ts`
  - proves exact method/path/body/header semantics, encoded IDs, 204 behavior,
    honest `ok:true`/`ok:false` results, and unchanged 422/429/503 errors
- `frontend/src/prototype-api.ts`
  - uses the 204-safe reader in the existing advisor request transport
- `.superpowers/sdd/2026-08-06-acquisition-provider-connection-center/progress.md`
- `.superpowers/sdd/2026-08-06-acquisition-provider-connection-center/task-1-report.md`

## Verification

- `node --import tsx --test src/features/ai-growth/api.test.ts`: 8 passed
- `npm run test:unit --workspace frontend`: 104 passed
- `npm run build --workspace frontend`: passed (`tsc -b` and Vite production
  build); Vite retained the existing large-chunk warning
- `git diff --check`: passed

## Follow-up risks

- Task 2 must clear plaintext request DTO values from controller/form state after
  each save attempt; the facade intentionally neither stores nor logs inputs.
- Any future `AdvisorRequest` transport implementation must preserve the same
  204-to-`void` behavior.
- The build still reports pre-existing bundles larger than 500 kB; this task did
  not alter bundling.

## Independent review

Passed with no blocker or actionable finding. The reviewer also reported a
zero-issue CodeRabbit review of the three frontend files.

Residual review notes:

- 204 behavior is covered in two layers (response-reader unit test and facade
  request spy), not through a fetch-level integration test of the private
  `advisorRequest` function.
- Generic error passthrough is represented through `testProviderConnection`;
  the shared request paths are not redundantly repeated for every method.
