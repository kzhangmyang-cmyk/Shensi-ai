# P4 Task 2 — stale-source verification and approval

Status: COMPLETE

Implement current source-head/version/hash/workspace verification and current capability reauthorization. Approval requires latest run and portfolio revision, feasible nonempty selection, and `finance.council.approve`; it freezes approver/actions/result/snapshot/policy hashes and inserts approval+dispatch outbox atomically before advancing to approved. Reject is terminal with no outbox. Changed sources/capability/revision fail closed; caller cannot supply approver/time.
