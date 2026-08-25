# Third-party notices

## MediaCrawler

Shensi includes the MediaCrawler source tree from [NanmiCoder/MediaCrawler](https://github.com/NanmiCoder/MediaCrawler.git), pinned to commit `d6f7c5bb906b6dac40ddf343ef9e26438a3de092`. Its license is retained verbatim at [services/media-crawler/LICENSE](../services/media-crawler/LICENSE).

Commercial authorization is held outside Git by the operator. This repository contains no authorization evidence, credentials, or secrets.

## tldts

The backend uses [`tldts`](https://github.com/remusao/tldts) `7.4.10` and its
`tldts-core` `7.4.10` runtime to recognize ICANN public suffixes, including
Unicode/IDN suffixes. Both packages are MIT licensed. The exact versions and
integrity hashes are pinned in `backend/package.json`, `pnpm-workspace.yaml`,
and `pnpm-lock.yaml`; no minimum-release-age exception is used.
