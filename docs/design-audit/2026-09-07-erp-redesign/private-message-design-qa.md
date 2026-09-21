# Product Design QA — 抖音私信二次确认

## Comparison target

- Source visual truth:
  - `/var/folders/8r/807dkr895rd328bk48vxnkfh0000gn/T/codex-clipboard-3d497817-0760-4c79-b801-7bafa7753bb4.png`
  - `/var/folders/8r/807dkr895rd328bk48vxnkfh0000gn/T/codex-clipboard-d5a1236f-e719-4dcd-8bfe-6fe1f82ac7f9.png`
- Browser-rendered implementation:
  - `http://127.0.0.1:5699/design-qa.html` (temporary QA harness using the production `renderOutreachBatchView` implementation)
- Implementation screenshots:
  - `.runtime/design-qa/private-message-natural.png`
  - `.runtime/design-qa/private-message-desktop-focus.png`
  - `.runtime/design-qa/private-message-mobile-focus-raw.png`
- Combined comparison evidence:
  - `.runtime/design-qa/private-message-comparison.png`
- State: approved comment actions with platform receipts; two eligible candidates; editable private-message drafts; default daily limit 20; second confirmation not yet checked; receipts collapsed.
- State alignment note: the source captures predate an available private-message transport and therefore show the earlier disabled private-message state. The comparison judges the established visual language, density, cards, form controls, and confirmation hierarchy; it does not claim pixel equivalence for the newly introduced success state.

## Viewport and density

- Source candidate-card capture: 1942 x 1228 pixels; CSS viewport and source density metadata unavailable.
- Source confirmation capture: 1788 x 344 pixels; CSS viewport and source density metadata unavailable.
- Desktop implementation: 1280 x 720 CSS viewport at browser DPR 2; the in-app Browser normalized the screenshot to 1280 x 720 pixels.
- Mobile implementation: 520 x 1200 requested CSS viewport; visible implementation capture is 520 x 1098 pixels after scrolling to the target region.
- Combined comparison: 1280 x 720 pixels. Source and implementation were scaled proportionally with `object-fit`-free intrinsic aspect ratios; no non-uniform stretching, sharpening, or content editing was applied.

## Full-view comparison evidence

The 1280 x 720 browser viewport confirms that the existing approval workspace retains its black canvas, restrained dark cards, thin neutral borders, fluorescent-green action emphasis, compact metadata hierarchy, and two-column desktop density. The new private-message step remains subordinate to the approved comment cards and does not displace the page's existing information architecture.

## Focused region comparison evidence

The focused desktop capture and combined comparison make the forms and action hierarchy readable. The implementation preserves the source card treatment and text-area density while removing duplicated profile URLs, account details, batch metadata, and technical status from the second step. The mobile capture confirms that candidate drafts, quota, confirmation, and CTA form one column without horizontal overflow.

## Findings

- No actionable P0, P1, or P2 fidelity findings remain.
- Fonts and typography: the implementation reuses the product's Inter / system / PingFang SC stack, established weights, compact labels, line heights, and white/muted/green hierarchy. Long Chinese drafts wrap cleanly without truncation.
- Spacing and layout rhythm: existing card radii, one-pixel borders, section gaps, input padding, and two-column density are preserved. At 900 px, controls stack while draft cards remain readable; at 520 px, drafts and confirmation become one column. Measured document and body scroll widths equal the viewport at both breakpoints.
- Colors and visual tokens: existing `--replica-bg`, surface, line, text, muted, accent, amber, and danger tokens remain authoritative. No new palette or style direction was introduced. Disabled and enabled confirmation states remain visually distinct.
- Image quality and asset fidelity: this flow contains no product imagery, custom illustration, logo, or icon asset to reproduce. No placeholder image, handcrafted SVG, emoji, CSS illustration, or substitute asset was added. Both comparison captures remain sharp at their recorded sizes.
- Copy and content: the new copy names the independent authorization boundary, reports only batch-local sendable count and configured limit, explains server-side quota authority, and uses Chinese status text for sending, success, partial success, and failure. It does not mislabel batch-local data as authoritative daily remaining quota.
- Accessibility and interaction: the region, status, spinbutton, text areas, checkbox, button, and disclosure are semantic and labelled. The approval button stays disabled until the single confirmation checkbox is checked. Existing focus-visible treatment is retained.

## Primary interactions tested

- Daily limit `1`: two-candidate batch blocked; confirmation and send button disabled.
- Daily limit `100`: confirmation enabled; send button remains disabled until explicit checkbox confirmation.
- Confirmation checked: send button enabled.
- Local QA send action: status changed to `已确认本次 2 条私信，等待服务器回执。`; no external platform action was invoked by this visual harness.
- Draft editing: character counter updated to `19 / 800`.
- Receipt disclosure: collapsed by default and expanded on activation.
- Console: zero warnings and zero errors during the tested flow.

## Comparison history

- Pass 1: the normalized source/implementation comparison found no actionable P0/P1/P2 visual mismatch. No product visual fix was required after comparison.
- QA-harness-only layout setup and in-app Browser full-page stitching artifacts were excluded from the product comparison; the final evidence uses the natural viewport and focused captures of the actual production component.

## Open questions

- None blocking. The source does not contain a successful-private-message state, so copy accuracy and behavior were validated against the implemented product contract and interaction tests rather than an unavailable historical visual.

## Implementation checklist

- [x] Preserve black / fluorescent-green design tokens and existing typography.
- [x] Keep comment and private-message authorization separate.
- [x] Show only recipients, per-candidate drafts, configured limit, one confirmation, one primary action, and result summary in the private-message step.
- [x] Block over-limit submission without silent truncation.
- [x] Collapse technical receipts by default.
- [x] Verify desktop, 900 px, and 520 px layouts without horizontal overflow.
- [x] Verify editing, quota validation, confirmation gating, disclosure, and status copy.

## Follow-up polish

- No P3 recommendation is necessary for handoff.

final result: passed
