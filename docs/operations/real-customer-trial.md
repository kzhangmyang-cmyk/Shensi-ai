# Real Customer Trial Runtime

This document is the current operating contract for the temporary Shensi
customer trial. It describes a real, isolated runtime; it is not a static demo
and it must not reuse the developer database or the already-running local
services.

## Goal

Publish the latest frontend and backend behind one temporary HTTPS address so
one invited customer can see every feature developed so far and use every
feature whose real integration is currently ready. The
trial login alias is `test`; the canonical backend identity remains an email
address and the alias is resolved only by the explicitly enabled trial build.

## Complete but truthful product scope

The trial navigation exposes every module and page developed in the latest
frontend. Modules backed by real APIs and persistent MySQL data are directly
usable, including:

- login, session and workspace-scoped authorization;
- CRM records and the private-domain handoff into opportunities and quotes;
- real Growth catalog, finance, ROI and quote workflows that do not require a
  missing provider;
- connection management for providers the operator has actually enabled;
- Douyin QR login, manual-keyword acquisition, live collection, candidates,
  CRM conversion and human approval.

Pages whose data or actions are still browser-local demonstrations remain
visible, but the page and relevant actions carry a clear `预览·待接入` status so a
customer cannot mistake them for a completed live channel. AI-only controls
remain visible and explain that a healthy model connection is required when
none is configured. Generic public-web acquisition remains visible and
optional; its missing provider does not block Douyin manual-keyword collection.

Real Douyin comments and direct messages remain unavailable to customers until
both actions pass a one-comment and one-message acceptance run against
operator-owned targets. The runtime must default the external-action worker to
disabled. Enabling it later requires an explicit environment flag, the
existing approval flow, exact target and text confirmation, and the platform's
normal warning, verification and rate-limit boundaries. The crawler must never
bypass CAPTCHA or platform warnings.

## Isolated topology

The first pilot serves one customer and uses these loopback-only addresses:

| Component | Address | Rule |
| --- | --- | --- |
| Public gateway | `127.0.0.1:5608` | The only service published by the tunnel |
| Frontend | `127.0.0.1:5610` | Latest worktree build |
| Backend | `127.0.0.1:5611` | Production mode, MySQL store |
| MediaCrawler sidecar | `127.0.0.1:5612` | One worker, dedicated secret and state |
| MySQL | `127.0.0.1:3310` | Dedicated data directory and database |

The database is `shensi_trial` and its application user has privileges only on
that database. The existing services on `3307`, `5488`, `5492`, `5588` and
`5590` are not modified or stopped until the new public runtime has passed its
acceptance checks.

The public gateway transparently forwards the frontend and `/api` traffic. It
preserves `Host`, `X-Forwarded-Proto: https`, cookies, CSRF headers and all
required HTTP methods, and never publishes MySQL, the backend or the sidecar
directly. The application login is the customer access boundary; its existing
rate limiting remains enabled.

## Identities and secrets

- The customer receives a tenant `admin`, never `super_admin`.
- The requested application credential is accepted as `test` plus the
  separately delivered password. The database stores an internal identity such
  as `test@shensi.local`; the backend login API continues to require email.
- Initial bootstrap super-admin credentials are operator-only and are removed
  from the running environment after the tenant admin has been provisioned.
- All JWT, encryption, cursor, claim, database, gateway and sidecar secrets are
  independent random values. They live only in owner-readable ignored runtime
  files and are never printed, committed, or copied from another environment.
- Previously pasted provider keys are considered exposed and are not reused.
- The Douyin Playwright profile and login state persist in a dedicated
  owner-only directory. The customer is told that the session remains on the
  trial host until disconnect or environment removal.

## Runtime mode contract

The frontend recognizes an explicit `VITE_REAL_TRIAL=true` mode. This mode:

1. maps the configured login alias to the configured internal email before
   calling `/api/auth/login`;
2. shows every developed module and labels preview-only integrations clearly;
3. does not enable frontend demo mode or synthesize records;
4. targets only the isolated backend.

MediaCrawler accepts an explicit output root so trial crawl artifacts cannot
land in another runtime's source-owned output directory. Its external action
worker is disabled unless a separate affirmative flag is present. The same
flag also prevents the backend from starting its action claim/recovery workers;
the backend and sidecar therefore both fail closed without consuming approved
actions into failed receipts.

## Deployment and recovery

Repository scripts prepare and launch the isolated runtime without embedding
secret values. Runtime state is stored beneath one ignored directory with
`0700` directories and `0600` credential files. Every component writes a PID
and log file so the operator can inspect status and stop only the exact trial
processes. Startup is fail-closed: occupied ports, missing secret files,
insecure permissions, a non-empty unexpected data directory, or an unhealthy
dependency abort the launch.

The temporary Cloudflare Quick Tunnel URL may change after the tunnel restarts,
and the environment is unavailable while the Mac sleeps or is offline. Trial
data survives application restarts because it lives in the dedicated MySQL
data directory. Before removing the environment, export the database and
preserve or explicitly delete the Douyin profile according to the trial data
retention decision.

## Acceptance gate

The link is customer-ready only when all of these checks pass against the new
environment:

1. unauthenticated protected API requests return `401`;
2. the `test` alias logs into a tenant `admin`, CSRF-protected writes work, and
   logout invalidates the session;
3. a CRM record persists after the backend restarts;
4. another tenant cannot read the pilot tenant's record;
5. public traffic cannot reach MediaCrawler internal endpoints, API docs,
   source files or secret files;
6. every developed navigation module is visible, with preview-only integrations
   clearly distinguished from live integrations;
7. Douyin QR creation and polling work, and a manual-keyword run can produce
   persistent candidates after the customer scans the QR code;
8. external comments and messages remain fail-closed until their separate live
   acceptance gate is completed;
9. `./scripts/context-check`, the focused tests, `pnpm test`, `pnpm build` and
   `git diff --check` pass from the latest worktree.
