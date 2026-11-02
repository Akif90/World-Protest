# Layout audit and refinement — 2 November 2026

Scope: the live World Protest page, the supplied screenshots, and the implemented desktop/mobile layouts. Reviewed against the [Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines/blob/main/command.md), with emphasis on layout, content overflow, focus, and touch interaction. This is a targeted visual audit, not a certification of every guideline.

## Design direction

Keep the geographic visualization as the focal point. Retain Avenir Next for the interface, the existing cool palette (`#edf3f5` background, `#ffffff` surfaces, `#183545` text, `#536e7d` secondary text, `#176d89` interactive accent), and warm event-density colors. Use one page gutter and normal-flow grid rows for the header, explorer, and coverage strip. Give the map an explicit boundary and place its caption outside that boundary. Avoid adding decorative cards, typography, or animations unrelated to exploration.

## Findings addressed

### Page structure and margins

- `frontend/src/App.tsx:88` — Replaced independently positioned intro/map/panel regions with a sidebar and map workspace in normal grid flow. The selected-region list occupies the available sidebar height instead of floating at a fixed page coordinate.
- `frontend/src/App.css:22` — Shared page gutters now align the brand, coverage divider, map right edge, and header controls. The live baseline mixed 30 px, 32 px, and percentage offsets.
- `frontend/src/App.css:25` — Header no longer overlaps the map. At the live 1920×992 baseline, the header ended at y=94 and the map began at y=72: 22 px of overlap. The refined desktop layout reserves a 24 px gap.
- `frontend/src/App.css:48` — Caption no longer touches the map edge. The live baseline had the caption begin 1 px before the map ended. The caption now sits in its own row, 16 px below the map on desktop and 12 px on mobile.
- `frontend/src/App.css:49` — Added a subtle map frame so a zoomed-in surface has an intentional edge. Navigation controls use consistent internal insets.

### Content rhythm and responsive behavior

- `frontend/src/App.css:62` — Coverage columns use consistent padding, title rhythm, and minimum widths. Long place names truncate within their column; full names remain in accessible button text and the location title attribute.
- `frontend/src/App.css:80` — The event panel has a scrollable list, a fixed-size 44 px close control, and wrapping region headings. Narrow desktop layouts reserve 260 px for this sidebar.
- `frontend/src/EventPanel.tsx:145` — Grouped metadata so dates and mention counts are not split mid-value across narrow lines.
- `frontend/src/App.css:113` — Mobile search, intro, filters, map, caption, and coverage toggle flow vertically with shared 20 px gutters. Expanded coverage scrolls within its drawer. Selected-region results remain a bottom sheet.
- Short landscape phones use a compact header and sidebar/map arrangement. Very short viewports can scroll vertically rather than having controls collide or disappear behind clipped page content.

### Interaction details

- `frontend/src/App.tsx:77` — Added a keyboard skip link targeting the globe controls region.
- `frontend/src/SearchBar.tsx:90` — Search uses a native search input, a name, and an explicit autocomplete preference. Keyboard place selection remains supported.
- `frontend/src/EventPanel.tsx:114` — Named the selected-region landmark using its heading.
- `frontend/src/App.css:19` — Added deliberate touch behavior and missing hover feedback. Retained visible focus outlines and theme-aware surfaces.

## Verification

Chrome layout checks found no horizontal page overflow and aligned header/map/caption right edges at every size below:

| Viewport | Header/map relationship | Map/caption gap |
| --- | --- | --- |
| 1920×992 | 24 px separation | 16 px |
| 1366×768 | 24 px separation | 16 px |
| 1024×768 | 24 px separation | 16 px |
| 768×1024 | Intro row between header and map | 12 px |
| 390×844 | Intro and filters between header and map | 12 px |
| 320×568 | Vertical scrolling on the short viewport | 12 px |
| 740×390 | Compact landscape; 16 px separation | 12 px |

Visually checked the overview, zoomed map, light/dark appearances, mobile coverage drawer, selected-region sheet, desktop sidebar results, long location labels, search dropdown and Enter selection, and the empty Most read view. Existing frontend tests: 71 passed. Production build and lint passed. No new implementation-mirroring CSS tests were added; the layout was verified in the real browser.

The live site's article data and local API content differ, so screenshots compare layout rather than identical headlines. VM deployment must be verified separately after the source is pulled and the frontend image rebuilt.
