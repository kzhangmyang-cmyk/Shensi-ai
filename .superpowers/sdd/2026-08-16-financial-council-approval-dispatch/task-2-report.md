# P4 Task 2 report

Status: COMPLETE

Implemented current-source and workspace-binding verification, explicit
`awaiting_approval -> stale`, current capability reauthorization, and
approval/rejection persistence. Approval freezes the selected portfolio,
action IDs and hashes, snapshot/policy/source hashes, server approver/time,
`approvalHash`, and `portfolioOutputHash`.

Memory and MySQL repositories atomically persist the decision, terminal run
event, and one queued dispatch row per approved action. Dispatch rows freeze
portfolio kind/revision, portfolio/action/result hashes. MySQL locks temporal
barrier, active policy, run, and portfolio revision before the approval and
outbox writes. Reject creates no outbox.

Opaque action-specific approval proofs are process-branded and cannot be
forged structurally. A restarted issuer re-reads the durable approval and can
reissue an equivalent proof for Task 3.

Capabilities `finance.council.approve` and
`finance.council.policy.manage` are granted only to admin/super_admin; policy
updates now require the latter.

Verification:

- focused source/approval/status/capability/service: pass
- financial council aggregate: pass after module fixture compatibility fix
- MySQL aggregate: 75 pass, 3 conditional live skips
- capability/bootstrap: 7 pass
- backend build and `git diff --check`: pass

Known release handoff: the immutable public/static contract release still
lacks `stale`, approval `portfolioKind`, and the two capability values. P4
Task 5 must publish a new immutable release and clear that drift; no historical
release was edited here.
