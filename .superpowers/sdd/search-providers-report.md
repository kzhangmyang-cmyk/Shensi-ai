# Real Search Providers — Implementation Report

Date: 2026-07-23
Branch: `feature/ai-acquisition-agent-design`

## Scope

Added exactly three customer-BYOK Web search adapters to the existing provider
contract, runtime, encrypted connection, catalog, and UI-facing provider metadata
flow:

1. `baidu_ai_search`
   - `POST https://qianfan.baidubce.com/v2/ai_search/web_search`
   - `X-Appbuilder-Authorization: Bearer <customer key>`
   - Baidu Search v2, Web-only results, `safe_search: true`
2. `tencent_web_search`
   - `POST https://api.wsa.cloud.tencent.com/SearchPro`
   - `Authorization: Bearer <customer key>`
   - Mode 0; the default adapter omits premium-only `Cnt`
3. `tavily`
   - `POST https://api.tavily.com/search`
   - `Authorization: Bearer <customer key>`
   - Basic/general search without answer or raw-page content

All three adapters are exported through `LEAD_PROVIDERS`. Consequently they are
included by `createDefaultProviderCatalog()` and use the existing personal
connection API, encrypted credential storage, provider runtime, network
allowlist, request ledger, and UI catalog semantics without a parallel secret
path.

## Data and provenance behavior

- The adapters use only provider-returned indexed title, URL, snippet/content,
  date, site, search relevance, rank, and request ID.
- They do not fetch result pages and do not describe indexed snippets as
  complete page content.
- Every valid record is a `discovery_page`.
- The true result URL is retained as `sourceUrl`.
- Rank, request ID, search relevance, and source-specific provenance are
  retained in `evidenceSummary`.
- `providerRecordId` is a stable HMAC over the provider ID and canonical source
  URL. Query parameter ordering and URL fragments do not create duplicate
  source records.
- Production must configure a stable `PROVIDER_CREDENTIAL_KEY`. Rotating the
  HMAC key changes future source IDs and therefore requires an explicit
  re-key/deduplication migration.
- Search relevance never becomes lead confidence. Search-result records remain
  `discovery_page` records with confidence `0` until a later verification
  stage.
- Search results never auto-promote a URL to `officialWebsite`; that field is
  left blank until independent verification.
- Malformed individual results are skipped with `invalidCount` and warnings.
- Malformed top-level responses fail closed as `PROVIDER_SCHEMA_CHANGED`.
- Baidu accepts an omitted `type` and omitted/empty `references` on successful
  Web-only requests, maps official error code `216003` to authentication
  failure, and predictably bounds query text to the official 72 weighted
  character limit while retaining the core goal and exclusion terms.
- Tencent uses the standard default result size without asserting premium
  connection capabilities and marks non-empty results as potentially
  incomplete.
- All three adapters return `exhausted: true` because none currently exposes a
  continuation cursor. When a result cap/default page may be incomplete, the
  warning explicitly says that no continuation cursor is available.
- Tavily HTTP 432 and 433 both map to quota exhaustion.
- Tavily credit usage is mapped to the shared `ProviderUsage` shape.

## Security behavior

- API keys are sent only in the documented authorization header.
- No environment/global key fallback was added.
- No key is placed in a query string, record ID, warning, or evidence field.
- Each provider has a strict HTTPS host/path/method allowlist.
- Credential-bearing cross-host redirects remain blocked by the shared HTTP
  client.
- The integration fixture verifies encrypted `ProviderConnection` decryption,
  real runtime search and health execution, network allowlisting, and audit-log
  redaction without exposing API keys, queries, authorization headers, or
  provider request IDs.
- Health checks issue a minimal real search request and validate its schema;
  they do not return a synthetic success.

## TDD evidence

RED:

```text
$ npm run test:provider:web-search --workspace backend
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'.../backend/src/web-search-providers.js'
exit code 1
```

The test intentionally referenced the not-yet-created adapter module.

GREEN:

```text
$ npm run test:provider:web-search --workspace backend
Real web search provider tests passed
exit code 0
```

Fixture coverage includes:

- exact URL, method, authorization header, and JSON body;
- result parsing, source URL, rank/request provenance, and usage;
- invalid per-result records and malformed top-level responses;
- 401/403, 429, 432 quota, and 5xx normalization;
- outbound host/path policy enforcement;
- minimal real health requests;
- `LEAD_PROVIDERS` and generated catalog visibility.

Correction RED:

```text
$ npm run test:provider:web-search --workspace backend
AssertionError: Expected values to be strictly equal: 0 !== 1
at web-search-providers-test.ts:115
exit code 1
```

This correctly exposed that a valid Baidu Web result without the optional
`type` field was being rejected.

Pagination-semantics RED:

```text
$ npm run test:provider:web-search --workspace backend
AssertionError: false !== true
at web-search-providers-test.ts:256
exit code 1
```

This exposed the contradictory state of `exhausted: false` without any
continuation cursor.

Correction GREEN:

```text
$ npm run test:provider:web-search --workspace backend
Real web search provider tests passed

$ ./node_modules/.bin/tsc --noEmit --target ES2022 --module NodeNext \
  --moduleResolution NodeNext --strict --esModuleInterop --skipLibCheck \
  backend/src/web-search-providers.ts backend/src/web-search-providers-test.ts
exit code 0

$ npm test --workspace backend
self-test passed
Real web search provider tests passed

$ npm run build --workspace backend
tsc -p tsconfig.json
exit code 0
```

Regression checks:

```text
$ npm run test:providers --workspace backend
Provider runtime contract tests passed

$ npm run test:provider:sec-edgar --workspace backend
SEC EDGAR provider tests passed

$ npm run test:provider:public-sources --workspace backend
{ "ok": true, "executableSources": 11, "assistedSources": 7 }
```

## Official references

- Baidu Qianfan AI Search:
  <https://cloud.baidu.com/doc/qianfan-api/s/Wmbq4z7e5>
- Tencent Cloud Web Search API-key mode:
  <https://cloud.tencent.com/document/product/1806/130615>
- Tavily Search:
  <https://docs.tavily.com/documentation/api-reference/endpoint/search>

## Release gate

No live request was made because no customer API keys were supplied. Before a
production release, run one search and one health check per provider with a
customer-owned test key, verify quota display, inspect provider-side request
logs by request ID, and confirm current commercial terms and regional
availability.

The default backend self-test now includes the real Web-search fixture. The
provider runtime contract test, focused strict TypeScript check, default backend
test, and full backend TypeScript build all pass in the shared worktree.
