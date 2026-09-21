# Execution ledger — decision-memory

Plan: `2026-09-20-decision-memory.md`; user explicitly approved direct native execution.

Ruling: owner aggregate instead of separate profile/review revisions ensures opt-out
and candidate generation are a single atomic CAS. Capacity is explicitly 200
reviews, not an unbounded journal; export includes all. If inadequate, later split
storage with a transaction preserving the same concurrency contract.

Preserve existing dirty branch and untracked decision module; no commit of unrelated
work or copied clean worktree, no installers. New tests first failed for missing
modules, then passed. Additional plan/result tampering test failed assertion and
passed after enforcing saved-plan comparison; candidate reappearance test failed
before unchanged/adopted feedback was suppressed.

Tasks 1/2: backend service, encrypted repository, HTTP routes and generated contract
implemented. Seven focused tests pass before final additional checks.
Task 3: complete. UI tests cover explicit use, late responses, review flow, stale
form revision and unrelated draft retention. Fresh focused review identified stale
form revision, unrelated draft loss and feedback hydration; all fixed. Root test/build
exit0; frontend52 tests; context/diff pass. Real MySQL/API isolated account smoke
passed; native61971 read-only profile/review controls verified. Detailed evidence
and actual acceptance boundary are in PROJECT_STATUS.
