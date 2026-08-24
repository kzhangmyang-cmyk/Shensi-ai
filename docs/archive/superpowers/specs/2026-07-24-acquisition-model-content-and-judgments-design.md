# Acquisition Model Content Binding and Judgments Design

Date: 2026-07-24

Status: approved for implementation

## Goal

Make the acquisition Pi runtime executable through the production
`ActiveModelGateway` without weakening immutable content binding, then provide
a production `AcquisitionJudgmentPort` backed by the same owner/team-scoped
official BYOK model snapshot.

## Root cause

The current Pi runtime sends a fully rendered turn prompt to
`ActiveModelGateway.callTools()` without `schemaHash`. The gateway compares the
entire prompt with the job snapshot's `promptHash`. Pi turn prompts contain
messages and tool results, so their content changes every turn. Supplying the
missing schema hash alone cannot fix the design: the first changed turn still
fails with `MODEL_CONTENT_HASH_MISMATCH`.

## Content identity

Acquisition model content is a server-owned bundle:

- prompt templates are addressed by registered IDs;
- tool schemas are addressed by registered IDs;
- `promptHash` is the canonical hash of the complete registered prompt map;
- `schemaHash` is the canonical hash of the complete registered tool-schema
  map.

The gateway receives this trusted bundle at construction. For a bound call it
accepts only registered IDs and dynamic data. It selects the prompt and tools
from the bundle, serializes dynamic data canonically, and places it after an
explicit untrusted-data boundary. Callers cannot supply replacement prompt
text, tool definitions, or asserted per-call hashes.

Existing literal `callTools`, `generateStructured`, and streaming behavior
remains unchanged for non-acquisition jobs.

## Snapshot authority

The acquisition runtime factory looks up a persisted snapshot by
`jobId/ownerId/teamId`, compares every immutable model field with the session
snapshot, and also requires the persisted prompt/schema hashes to equal the
current server bundle hashes. An invented client snapshot, a snapshot from
another tenant, or an obsolete bundle identity is rejected before a credential
or network call is possible.

The exported bundle identity is the only value session/job creation should pass
to `bindActiveModelSnapshot`. Deployments must create new sessions/jobs after a
bundle version changes; old snapshots fail closed.

## Judgment port

`createAcquisitionJudgmentPort` receives an authenticated acquisition
identity, its persisted model snapshot, and a snapshot-bound gateway. It
implements `research`, `qualify`, `buildBattleCard`, and
`draftConnectionStrategy`.

All four operations call one registered judgment prompt and one registered
structured submission tool. Dynamic input contains only the operation,
tenant-neutral candidate projection, public evidence projection, and
operation-specific parameters. It never contains credentials or private
contact data. The returned discriminated payload is parsed with Zod and must
match the requested operation.

Post-validation enforces:

- every evidence ID belongs to the supplied evidence set;
- facts have evidence; inferences are labelled and evidenced; unknowns carry
  no fabricated evidence;
- qualification excerpts reference only supplied evidence;
- financial amounts are safe non-negative integers in minor units, and rates
  are basis points;
- battle-card model metadata is overwritten from the immutable snapshot;
- connection drafts cover exactly the requested channels;
- no output shape can create evidence, create review work, or execute outreach;
- sensitive/private personal-data keys and instruction-like evidence payloads
  are excluded from model input.

## Failure behavior and tests

Unknown binding IDs, bundle hash mismatch, tenant/snapshot mismatch, invalid
model output, unknown evidence IDs, unsafe amounts, or sensitive output all
fail closed with stable model/judgment errors. Tests prove the original
production hash failure, valid multi-turn bound calls, fail-closed bundle
selection, client snapshot rejection, all four judgment operations, and each
safety invariant.
