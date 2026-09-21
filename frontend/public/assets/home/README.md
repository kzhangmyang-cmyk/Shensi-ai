# Home showroom assets

The home view uses pre-rendered 3D-style PNG artwork and a separate lightweight
Canvas particle layer. It is not a live WebGL scene. Titles, links, task state,
account identity and navigation remain real DOM and existing business state.

Selected layout: `docs/design/home/selected-showroom-reference.png`.
The two current illustrations follow the user-approved
`docs/design/home/selected-radar-collaboration-reference.png` on 2026-09-20.
These are visual references, not flattened clickable pages or account data.

- `showroom.png`: generated empty black-green architectural environment with a
  reflective stone floor, ribbed walls and warm metal details.
- `acquisition-radar.png`: tilted glass radar with customer nodes, three distinct
  selected busts and a blank pedestal. The scanning sector is drawn at runtime.
- `agents-collaboration.png`: six glass professionals around enterprise documents,
  matching the six-role center without inventing role labels or analysis results.
- `simulation-sculpture.png`: generated cyan orbit sculpture and blank pedestal.

All four active images were generated with the selected references through the image-generation
tool. No new runtime image service or external asset request is required.
The home implementation is under `frontend/src/home/`; it does not modify the
decision-simulation workspace's approved galaxy assets or motion.

The Canvas layer renders 32 particles per visible entry, a radar sector and
selected-node highlights, at most 30 frames per
second and a device-pixel ratio of 1.5. It stops offscreen, in hidden documents,
on small viewports, for reduced-motion preferences or low reported concurrency;
missing Canvas/observer support leaves the static image and DOM links usable.
The home header's pause button stops all decorative motion without disabling
links; resume still respects system reduced motion and visibility. Disconnecting
an entry cancels its frame and observers and clears its canvas.

Generation prompts: isolate the approved left radar or right collaboration
sculpture on genuine transparency; preserve cyan glass, black metal and brass;
keep text off the image and leave a blank pedestal for real UI copy. Radar
omits a baked sweep. Collaboration has six professionals rather than the
reference's illustrative five, and does not rename actual product roles.
The original funnel/sphere files are retained but no longer referenced by home.

No Three.js or other engine was added. The existing application requires only
this bounded decorative layer, not mesh rendering or a new scene lifecycle.
Reference implementation research considered Three.js (MIT) and css-doodle
(MIT); neither dependency nor upstream source code was imported.
