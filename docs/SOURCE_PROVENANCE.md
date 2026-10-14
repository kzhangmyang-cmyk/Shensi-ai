# Source Provenance

Platform TOTP uses pinned `otpauth` 9.5.2, MIT licensed, from
[hectorm/otpauth](https://github.com/hectorm/otpauth). It supplies TOTP
verification; Shensi owns encrypted storage, single-use counters, sessions and
transaction controls. Review dependency advisories during upgrades; this is
not a security certification. The console reuses React/Express/MySQL and
contract generation. React-admin/Casdoor comparisons are retained in the
historical account audit; neither project was installed or copied.

Decision personal-memory design (2026-09-20) reviewed LangGraph's namespace
store pattern ([MIT](https://github.com/langchain-ai/langgraph/blob/main/LICENSE))
and Mem0's explicit memory CRUD ([Apache-2.0](https://github.com/mem0ai/mem0/blob/main/LICENSE)).
No upstream code or package was imported: this bounded typed-data flow reuses
Shensi actor/workspace encryption and CAS. Additional vector/model/cloud
dependencies would add data exposure and integration cost without helping explicit
preferences. This review is not a security certification of those projects.

- Imported from: `/Users/mac/Documents/新项目/shensi-sales`
- Source branch: `codex/real-financial-council`
- Source commit: `5cba911a1c97cc7cf718b8382a5fc2629d8eed00`
- Imported at: `2026-08-24 Asia/Shanghai`
- Legacy GitHub repository: `https://github.com/kzhangmyang-cmyk/shensi-sales`

The legacy repository is a rollback and history source. New development,
deployment, status reporting, and AI instructions begin in this repository.

Desktop enrollment/status work reuses this repository's latest Renderer,
Main gateway, canonical OpenAPI generator, encrypted stores and existing
MediaCrawler/Douyin Spider adapter. It introduces no new vendored runtime or
license grant. Upstream revisions and licensing remain documented in
`services/media-crawler/SHENSI_UPSTREAM.md` and `docs/THIRD_PARTY_NOTICES.md`;
fake integration and UI fixtures are project-owned tests, not platform evidence.
