# P4 Task 3 report

Status: COMPLETE

Implemented the closed council-owned draft domain and Memory/MySQL repositories
for budget adjustments, finance todos, tax review tasks, and financial data
completion plans. Draft identities bind the workspace, run, portfolio revision,
approved action, and approval/result source hashes; no draft can carry an
authority write payload.

The action adapter accepts only an opaque Task 2 approval proof and maps the
closed financial action set to controlled drafts or an exact-ref Advisor
recommendation. Missing current bindings fall back to a council todo, and quote
drafts plus unknown authority actions are rejected. Draft and Advisor hand-offs
also expose dispatch-hash probe/create operations that return only canonical
resource refs and content hashes for Task 4 recovery receipts.

Verification:

- Task 3 focused tests: 35 passed; 1 live-MySQL integration test skipped because
  `MYSQL_TEST_ADMIN_URL` is not configured.
- `npm run test:growth-advisor --workspace backend`: 102 passed.
- `npm run build --workspace backend`: passed immediately after Task 2. A later
  fresh build is temporarily blocked only by concurrent Task 4 repository
  interface work; Task 4 owns the combined-build rerun.
