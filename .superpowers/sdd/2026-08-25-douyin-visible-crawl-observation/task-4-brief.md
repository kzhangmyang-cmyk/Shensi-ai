### Task 4: Current documentation and verification gates

**Files:**
- Modify: `README.md`
- Modify: `docs/PROJECT_STATUS.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/modules/acquisition.md`
- Modify: `docs/DEPLOYMENT.md`

**Interfaces:**
- Documents: local visible-window behavior, observation-mirror semantics,
  headless production behavior, and the closed safe progress contract.

- [ ] **Step 1: Update current execution documents**

Describe the current behavior directly. Do not add a top-of-file revision
note or make archived plans the execution authority.

- [ ] **Step 2: Run focused and aggregate verification**

```bash
./scripts/context-check
pnpm check:acquisition-contracts
pnpm test
pnpm build
git diff --check
```

Expected: all available deterministic gates pass. Docker/live Douyin gates
remain outside this change and must be reported as not run, not treated as
successful.

## Handoff from Tasks 1–3

- Starting HEAD is `a35c596`.
- State the runtime truth directly: local
  `MEDIACRAWLER_BROWSER_HEADLESS=false` opens a dedicated standard-Playwright
  Douyin window; production may set `true`; Shensi explicitly disables CDP.
- The visible tab is an operator observation mirror for the approved keyword
  and public video. The deterministic MediaCrawler request client remains the
  data authority; observation navigation does not fabricate results.
- The only persisted/public activity fields are phase, approved keyword/null,
  visible/headless mode, and monotonic sequence. Never document or expose raw
  URL, profile path, cookie, header, selector, CDP/WebSocket endpoint, browser
  identifier, or raw log.
- The dashboard polls the persisted Node projection, shows localized phase,
  browser mode, keyword, attempt/update time and candidate allowance, and
  blocks duplicate run submission while the current intent is unobserved or
  nonterminal. Comment/direct-message approval rules are unchanged.
- Update existing current sections rather than adding revision-note prose.
  `docs/API_INDEX.md` and `docs/modules/acquisition.md` already contain Task 3
  contract/UI text; reconcile rather than duplicate it.
- Do not run a real crawl, browser, Docker deployment, comment, direct message,
  or CAPTCHA flow. Report those gates as not run, not passed.
