# Shensi MediaCrawler provenance

This subtree was imported from [NanmiCoder/MediaCrawler](https://github.com/NanmiCoder/MediaCrawler.git) at commit `d6f7c5bb906b6dac40ddf343ef9e26438a3de092`.

The upstream `LICENSE` is retained verbatim at [LICENSE](LICENSE). Commercial authorization is held outside Git by the operator.

This repository also records that commercial authorization is held outside Git; no authorization evidence, credentials, or secrets are stored here.

To update the pinned subtree, review the target upstream commit and run from the Shensi repository root:

```bash
git subtree pull --prefix=services/media-crawler https://github.com/NanmiCoder/MediaCrawler.git <approved-commit> --squash
```

Shensi-owned code is isolated in `shensi_adapter/` and `tests/shensi_adapter/`; it provides the private service boundary without modifying upstream source files.

The adapter's authenticated internal Douyin QR endpoints keep browser profiles
and cookies inside the configured encrypted deployment volume.  They return an
opaque account handle only to the trusted acquisition backend; public account
API responses are deliberately sanitized and never include browser state.

The deployment must set both `MEDIACRAWLER_ENCRYPTED_VOLUME` and
`MEDIACRAWLER_PROFILE_ROOT`; startup rejects missing or out-of-volume profiles.
The adapter owns Playwright on one dedicated thread so FastAPI worker threads
never call a browser object directly.

Private crawl-job endpoints execute the pinned Douyin search API with an
account profile, frozen argument arrays, comments enabled, and a bounded
deadline. User values are never interpolated into shell text. Closed
creator/video/comment records are stored as append-only opaque-cursor pages;
reads do not acknowledge them and terminal pages remain available for 24
hours.
