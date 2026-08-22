# Task 2 Round 3 Report: accepted handoff idempotency aliases

## Status

The final Important finding is fixed in the backend only. The frontend remains
at `8997782`; this round created no frontend commit or frontend source change.

## RED evidence

The regression drives the public handoff service through this sequence:

1. processing key A reserves the operation and fails at Customer persistence;
2. the same normalized request with key B resumes and completes;
3. B's response is treated as lost and a new service instance retries B;
4. A is retried as well.

Before the fix, the focused test failed at the B retry with
`false !== true`: the final handoff retained only A's primary hash, so B was
not recognized as a replay.

## Implementation

- Handoff operations and final handoffs now persist a deduplicated
  `acceptedProcessingKeyHashes` audit set while retaining the original primary
  `processingKeyHash` for compatibility.
- A same-request takeover key is added durably before resumed CRM side effects.
  The final handoff copies the complete accepted-key set.
- Completed lookup treats every accepted alias as the same idempotent request:
  A and B both return the original resources with `replayed: true`; an accepted
  key with a different request hash still returns 409.
- MySQL adds `accepted_processing_key_hashes_json` to operation and handoff
  tables, backfills legacy rows from the primary hash, and maps the field in
  both load and persistence paths.
- Processing hashes remain owner/team/candidate scoped. Public HTTP projection
  still does not expose any hash.

## Verification

- Focused RED became GREEN:
  `npx tsx src/acquisition-private-domain-handoff-test.ts`.
- Required backend target set: 51/51 passed, 0 failed.
- Backend `npm run build`: passed.
- `git diff --check`: passed.
- Regression confirms identical handoff/customer/todo IDs, one Lead, one
  Customer, one Activity, one Todo, one operation, and one final handoff.
- Existing unrelated backend worktree changes and the protected untracked plan
  were not staged. The frontend's pre-existing `pnpm-workspace.yaml` change was
  not touched.

## Commit

This report is included in the backend fix commit:
`fix(acquisition): persist accepted handoff idempotency aliases`.
