# Private development source snapshot

This repository starts a new history from the current Shensi working tree on
2026-09-21, including uncommitted and previously untracked product code.
It does not replace or rewrite the original working repository.

All application source, contracts, tests, dependency lockfiles, current frontend
artwork, desktop assets, deployment definitions and third-party notices are retained.
The two backend SQL files and the contract SQL fixture were checked to contain
schema definitions rather than private row data. Follow the current deployment
instructions; do not run legacy database initialization against an existing database.

Not included: prior Git history, dependencies, installers/build output, private
environment files, runtime state, credentials/account notes, database backups,
customer documents, browser profiles/cookies, logs and runtime screenshots.
The upstream documentation font STZHONGS.TTF is omitted because its redistribution
license was not established; it is not an application runtime dependency.
Generated concept images and application runtime artwork remain included.

Third-party code retains its original licenses and provenance. A private backup
does not grant additional distribution or commercial rights.

Use README.md and docs/DEPLOYMENT.md to install dependencies and provision an
independent development environment. Real local data and credentials are in a
separate access-controlled local backup, never this GitHub repository.
This snapshot is source backup, not a new production deployment or installer.
