# Product Design QA

## Target flow

The flow under test is: `#acquisition` → generate an outreach batch → approve comments → receive one durable comment receipt → edit and independently confirm the unlocked direct message → observe the queued server action.

## Environment and evidence

- Browser: Codex in-app Browser
- Local URL: `http://127.0.0.1:5388/#acquisition`
- Desktop viewport: 1440 × 900
- Narrow viewport: 390 × 844
- Reference: `/var/folders/8r/807dkr895rd328bk48vxnkfh0000gn/T/codex-clipboard-d5a1236f-e719-4dcd-8bfe-6fe1f82ac7f9.png`
- Reference/implementation comparison: `/tmp/shensi-dm-approval-comparison.png`
- Desktop queued state: `/tmp/shensi-dm-queued-fixed.png`
- Narrow pre-queue approval state: `/tmp/shensi-dm-mobile-approval.png`
- Narrow queued state: `/tmp/shensi-dm-mobile.png`

The no-write fixture stops at a version-2 queued direct-message action and records no external platform write.

## Mismatch ledger

| Severity | Visible mismatch | Resolution |
| --- | --- | --- |
| P1 | The direct-message approval row exceeded the content width at the desktop test viewport, which compressed and clipped the primary action. | The existing black/green panel now uses a two-column, two-row grid and collapses to one column at narrow widths. |
| P1 | After the server accepted a direct-message action, the card still showed a stale local-draft re-confirmation hint next to the queued state. | A server action now owns the card state; the local dirty hint is hidden once the action exists. A regression test covers the queued case. |
| P2 | Narrow-screen behavior needed proof that the page uses document scrolling without horizontal overflow. | At 390 px, document and shell widths both equal the viewport, document scrolling advances, the shell remains at scroll position zero, and the queued card stays within the viewport. |

## Checks

| Check | Result |
| --- | --- |
| Page identity | Passed — URL and title match the local acquisition page. |
| Meaningful content | Passed — acquisition controls, candidates, approval cards, and receipts render. |
| Framework overlay | Passed — no Vite or runtime error overlay is present. |
| Console health | Passed — no browser warnings or errors during the desktop and narrow flows. |
| Interaction proof | Passed — invalid limit disables approval; valid limit plus independent confirmation queues one fixture direct-message action. |
| Desktop visual check | Passed — the approval/action region has no clipping or horizontal overflow. |
| Narrow visual check | Passed — the pre-queue approval panel, confirmation, limit input, and full-width CTA remain inside the 390 px viewport; the queued card also has no horizontal overflow or scroll trap. |
| Reference comparison | Passed — existing typography, black surfaces, green accents, borders, and radii remain consistent; the extra limit control is an intentional second-stage requirement. |

final result: passed
