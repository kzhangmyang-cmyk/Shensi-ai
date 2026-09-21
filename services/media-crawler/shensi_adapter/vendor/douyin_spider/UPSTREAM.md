# DouYin_Spider focused source

Source: `https://github.com/cv-cat/DouYin_Spider`

Pinned commit: `9afaf79580b1ee84e8954ff906ff26869d5b7f1f`

The pinned repository's current file list contains no `LICENSE`, and its README
describes the project as intended for learning and technical research. No public
open-source license was found. The operator states that the author granted
permission for this integration; the authorization evidence is retained outside
Git and is not represented here as a public open-source grant.

Shensi vendors only
the modules required for authenticated recipient resolution, conversation
creation, protobuf text-message sending, request signing, and transport. The
upstream imports are mechanically namespaced under
`shensi_adapter.vendor.douyin_spider` so they cannot shadow MediaCrawler's own
top-level `utils`, `builder`, or `static` packages.

Shensi never exposes browser cookies, security SDK keys, conversation tickets,
or private-message text through its HTTP API or logs. Those values are read
inside the workspace-bound sidecar immediately before an already-approved
action and are discarded after the one send attempt.
