# Multi-Mac Central Service Plan

## Target boundary

Every macOS client runs the current Electron Renderer, Main process, local
Sidecar, visible Playwright browser and one device-local Douyin Profile. All
Shensi accounts, workspaces, CRM records, acquisition evidence, approvals,
device registrations and action state live in one HTTPS Backend and one central
MySQL database. Local Profiles, cookies, Sidecar tokens, recovery files and
device credentials are never copied between Macs or uploaded as business data.

Two Macs may sign in to the same Shensi account and read the same workspace
data. Each installation still has a distinct installation identity and encrypted
device credential. A Douyin account has only one active executor device; moving
execution requires an explicit generation-fenced handoff and is blocked while
an unresolved action exists.

## Source evidence available now

`backend/src/security-test.ts` drives the existing login and CRM HTTP routes
with two independent Cookie/CSRF clients for one newly registered account. The
first client creates a customer, the second reads and updates the same ID, and
the first observes the update. Logging out the second client does not invalidate
the first or remove the shared record. A separately registered account and
workspace cannot read that ID. The test deletes its temporary customer before
the process exits.

The same scenario is also covered by
`backend/test/multi-mac-central-mysql-test.ts`. The guarded operator creates a
fresh owner-locked disposable MySQL 8.4 runtime and a random dedicated schema,
runs the real Backend and MySQL store, then closes and recreates the store before
checking the same customer ID. It also checks workspace isolation and that one
client logout leaves the other authenticated. The operator removes the exact
temporary schema/runtime after the test. This passed on 2026-09-07; it proves
local MySQL durability across a Backend/store restart, but not TLS, WAN behavior,
two physical Macs, Alibaba Cloud restore or rollback.

Run it with:

```bash
NODE_ENV=test JWT_SECRET=goodjob-security-test-secret-at-least-32-characters \
  pnpm --dir backend exec tsx src/security-test.ts
pnpm api:verify:multi-mac-crm:mysql
```

## Existing-account data preservation

1. Freeze the selected source database for migration and record its exact
   schema/version, row counts and backup digest. Do not point clients at the new
   service yet.
2. Restore that backup into a new, independently named central MySQL database.
   Never initialize an empty schema over the only source copy.
3. Run the repository's migration/compatibility checks against the restored
   copy. Stop on unknown schema, destructive repair, count mismatch or an
   unresolved outreach action.
4. Verify accounts, password hashes/auth versions, workspace memberships, CRM
   customers, acquisition evidence, approvals and action state by scoped counts
   and sampled stable IDs. Do not export API keys, cookies or local Douyin
   Profiles into the shared database.
5. Deploy one Backend revision against the restored copy behind the final HTTPS
   origin. Keep desktop mutation admission locked until both architecture build
   digests and device enrollment are approved.
6. Test one existing account from Mac A and Mac B, plus a different workspace,
   using the acceptance checklist. Do not resume queued external actions during
   this read/write data check.
7. After acceptance, switch clients to the central origin. Retain the source
   database read-only through the rollback window; rollback changes the client
   origin and Backend/database pair together.

## Controlled build admission

The canonical desktop build manifest includes architecture, so arm64 and x64
have different exact digests. `exact` admission requires
`SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256` and may include up to seven
additional unique lowercase exact digests in
`SHENSI_DESKTOP_ADDITIONAL_ADMITTED_BUILD_MANIFEST_SHA256S`. This is only a
bounded architecture/rolling-version allowlist. It does not replace account,
workspace, installation, approval or executor fencing.

## Missing external resources and evidence

- Alibaba Cloud compute/RDS (or an approved self-managed MySQL host).
- A final HTTPS domain, certificate and DNS control.
- Developer ID Application signing identity and notarization profile.
- One Intel/x64 Mac or x86_64 macOS runner; current real evidence is arm64 on
  macOS 26.5 with a declared minimum of macOS 13.0.
- A second physical Mac for same-account and handoff acceptance.
- An authorized source-database backup selected for preserving existing users.
- Real WAN/TLS, central MySQL restore, rollback and two-Mac acceptance evidence.

Until these exist, no source-only or memory test may be described as cloud
deployment, MySQL migration, x64 compatibility acceptance or physical two-Mac
acceptance.
