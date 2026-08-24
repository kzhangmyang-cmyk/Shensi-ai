# Shensi MediaCrawler provenance

This subtree was imported from [NanmiCoder/MediaCrawler](https://github.com/NanmiCoder/MediaCrawler.git) at commit `d6f7c5bb906b6dac40ddf343ef9e26438a3de092`.

The upstream `LICENSE` is retained verbatim at [LICENSE](LICENSE). Commercial authorization is held outside Git by the operator.

This repository also records that commercial authorization is held outside Git; no authorization evidence, credentials, or secrets are stored here.

To update the pinned subtree, review the target upstream commit and run from the Shensi repository root:

```bash
git subtree pull --prefix=services/media-crawler https://github.com/NanmiCoder/MediaCrawler.git <approved-commit> --squash
```

Shensi-owned code is isolated in `shensi_adapter/` and `tests/shensi_adapter/`; it provides the private service boundary without modifying upstream source files.
