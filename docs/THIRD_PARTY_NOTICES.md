# Third-party notices

## OTPAuth

Backend TOTP uses OTPAuth 9.5.2, MIT licensed, copyright Héctor Molinero
Fernández. Upstream: https://github.com/hectorm/otpauth. The full license is
included in the installed package's `LICENSE.md`; no source was vendored.

## Read-only PDF and Word documents

The backend pins [pdfjs-dist](https://github.com/mozilla/pdf.js) `6.3.289`
(Apache-2.0), [yauzl](https://github.com/thejoshwolfe/yauzl) `3.4.0` (MIT), and
[sax](https://github.com/isaacs/sax-js) `1.6.1` (BlueOak-1.0.0). Their licenses
remain in the installed packages; exact integrity hashes are in the pnpm lockfile.
PDF.js extracts existing text using local package CMaps/fonts; yauzl and sax read
bounded DOCX ZIP/XML, not HTML conversion, executable fields or external links.
The parser does not perform OCR or interpret legacy `.doc` files.

Mozilla's [GHSA-wgrm-67xf-hhpq](https://github.com/mozilla/pdf.js/security/advisories/GHSA-wgrm-67xf-hhpq)
lists an affected range ending at 4.1.392 and a fix in 4.2.67; the pinned 6.3.289
is outside that range. This is a specific advisory check, not a claim that the
parser or its native dependencies have no vulnerabilities. Parsing runs in a
time-bounded worker with V8 heap limits; document content is not written to logs.

## Acquisition platform brand artwork

The desktop acquisition selector displays locally bundled 512-pixel application
artwork for Douyin, Kuaishou, Xiaohongshu, WeChat, and Weibo. The files were
retrieved from the respective Apple App Store China listings on 2026-09-08 and
are used only to identify the corresponding platform in the product interface.
The artwork and trademarks remain owned by their respective brand owners; this
notice does not claim an open-source license or imply endorsement. File-level
source pages and checksums are recorded in
[`frontend/public/assets/platform-brands/README.md`](../frontend/public/assets/platform-brands/README.md).

## MediaCrawler

Shensi includes the MediaCrawler source tree from [NanmiCoder/MediaCrawler](https://github.com/NanmiCoder/MediaCrawler.git), pinned to commit `d6f7c5bb906b6dac40ddf343ef9e26438a3de092`. Its license is retained verbatim at [services/media-crawler/LICENSE](../services/media-crawler/LICENSE).

The included upstream license is a non-commercial learning license, not an
open-source production grant. Commercial authorization is held outside Git by
the operator and must be verified before any production or commercial image is
built or deployed. This repository contains no authorization evidence,
credentials, cookies, browser state, or service secrets. The Shensi adapter
does not widen the upstream authorization boundary.

## DouYin_Spider focused direct-message transport

Shensi vendors only the modules needed for authenticated recipient resolution,
conversation creation, protobuf text-message sending, request signing, and
transport from [`cv-cat/DouYin_Spider`](https://github.com/cv-cat/DouYin_Spider),
pinned to commit `9afaf79580b1ee84e8954ff906ff26869d5b7f1f`. The pinned
repository's current file list contains no `LICENSE`, and its README states a
learning/technical-research purpose; no public open-source license was found.
The operator states that the author granted permission for this integration.
Authorization evidence is retained outside Git and this notice does not present
that permission as a public open-source grant. The exact focused scope is
recorded in
[`services/media-crawler/shensi_adapter/vendor/douyin_spider/UPSTREAM.md`](../services/media-crawler/shensi_adapter/vendor/douyin_spider/UPSTREAM.md).

## Optional Douyin action visual locator

The MediaCrawler sidecar pins these optional local runtime packages in the
`visual-locator` dependency group:

- [`rapidocr`](https://github.com/RapidAI/RapidOCR) `3.9.2` — Apache-2.0.
- [`onnxruntime`](https://github.com/microsoft/onnxruntime) `1.29.0` — MIT.

They are installed/loaded only when the deployment explicitly chooses
`DOUYIN_ACTION_VISUAL_LOCATOR=rapidocr`; omission defaults to `disabled`. OCR
may suggest only a missing allowlisted comment entry/send control before exact
DOM rebind. It does not choose account, target, recipient, text, or receipt, and
action screenshots/recognized text are not persisted or logged.

## noVNC browser client

The frontend pins [`@novnc/novnc`](https://github.com/novnc/noVNC) `1.7.0` and
uses its RFB client for the authenticated Douyin live-login tab. noVNC is
licensed under the Mozilla Public License 2.0 (MPL-2.0). Shensi bundles the
client library into its frontend assets; it does not expose or deploy noVNC as
an unauthenticated standalone service. The server-side WebSocket bridge is
Shensi-owned code and does not include websockify.

## tldts

The backend uses [`tldts`](https://github.com/remusao/tldts) `7.4.10` and its
`tldts-core` `7.4.10` runtime to recognize ICANN public suffixes, including
Unicode/IDN suffixes. Both packages are MIT licensed. The exact versions and
integrity hashes are pinned in `backend/package.json`, `pnpm-workspace.yaml`,
and `pnpm-lock.yaml`; no minimum-release-age exception is used.
