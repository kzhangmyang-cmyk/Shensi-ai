# Decision preferences and operating reviews

Approved scope: extend the existing decision workspace, not an agent platform.

## Reuse and gaps

`decision-preferences.ts` assesses report-local confirmed preferences only.
`decision-simulation-service.ts` stores immutable reports. CFO sessions already
use actor/workspace encryption and revision compare-and-swap. Advisor
recommendations already support acceptance/completion but completion references
server-resolved business receipts, not manual observations. Preserve those flows.

Use one companion table with one revisioned personal aggregate per actor/workspace,
encrypted through `agent-job-security`. Scope comes exclusively from authenticated
workspace context. A deleted profile retains only a revision tombstone to prevent
stale clients resurrecting it. Profile and reviews share CAS so concurrent opt-out
and feedback cannot race. At most 200 manual reviews; existing rows remain editable
and the complete aggregate exportable. No report mutation or new model/network invocation.

## Personal profile

Explicit save, view, correction, disable, delete and JSON export. Loading a
profile does not apply it to a draft: a separate explicit adoption copies the
values into the existing confirmed-input editor. New reports retain their own
snapshot; old reports remain unchanged. Profile deletion removes its contents,
not immutable report snapshots. Individual report deletion is not currently
available and must be stated at deletion. Shared company facts/SOP remain in
their existing source workflows; neither profile nor review text is a system
instruction or automatically sent to a model.

## Execution review

One owner-scoped record per run/recommendation. Server verifies the saved report
and recommendation belong to that owner, and captures the original suggestion.
User claim/plan stores metric, unit, baseline, target, due date and source.
Manual result stores actual, observed date, source and attribution uncertainty;
recorded timestamp is server-owned. Compare actual against target/baseline only
for that same explicit metric. Never fabricate a modeled numerical prediction
where the saved suggestion had none. No advisor/CRM completion is triggered.

When an enabled personal profile permits learning, explicit result feedback can
propose cash/profit/delivery priority. Nothing is adopted until a separate confirm
action; adoption checks profile and review revisions and current opt-in. Disabled
or deleted profiles cannot generate or adopt candidates. Reviews remain readable.

## Research / license

Reviewed 2026-09-20: LangGraph namespace store (MIT,
https://github.com/langchain-ai/langgraph/blob/main/LICENSE) and Mem0 explicit
memory CRUD (Apache-2.0, https://github.com/mem0ai/mem0/blob/main/LICENSE).
Both have active public repositories. Their model/vector/cloud machinery is not
needed for typed, confirmed preferences; introducing it would add dependencies,
data exposure and migration cost. Reuse the local encryption/CAS pattern instead;
no external source copied and no package installed. This is not a security audit
of either upstream project.

## Acceptance

Actor/workspace isolation; strict input; encryption; stale-write conflicts and
delete/recreate ABA; opt-out; immutable historical reports; own-data-only export;
manual observations never become verified financial facts; no model/outreach calls.
Frontend exercises explicit save/adopt, feedback candidate and clear semantics.
Run focused tests, repository test/build/context/diff gates, then only the documented
desktop runtime (existing database/keys, outreach disabled). No installers.
