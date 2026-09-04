# Mono-Color Design System

A design system for **one-ink and controlled two-ink editorial print** — posters, zines, covers, packaging,
merchandise and visual field notes. It is not a product UI system. Its output is printed matter: a sheet of
paper, one or two printing plates, visible substrate, and one deliberate disruption.

Everything here is derived from a single source: the `mono-color` agent skill, a print-design skill whose
machine-readable catalogs (inks, typography roles, composition geometry, carriers, rhythm, print
imperfections) are the shared contract between its reference boards, its recipes and its validators.

## Sources

| Source | Location |
|---|---|
| Skill repository (as provided) | <https://github.com/Software0802/skills> — subtree `skills/mono-color/`, branch `main` |
| Upstream project named in that skill's README | <https://github.com/yanliudesign/mono-color-skill> |
| Catalogs read | `design-system/colors.json`, `typography.json`, `compositions.json`, `carriers.json`, `rhythm.json`, `imperfections.json`, `BOARD-DIRECTION.md` |
| Prose read | `SKILL.md` (trigger rules, visual DNA, prompt compiler, quality gate), `README.md` |
| Renderers read for exact geometry | `scripts/build_design_system_board.py`, `scripts/build_vibe_coding_poster.py` |
| Assets copied | `swatches/*.svg` (17 files) → `assets/swatches/`; `examples/mono-color-design-system-board.png` → `assets/reference/` |

Read those repositories directly when you need more than this system carries — particularly `SKILL.md`, which
holds the full input-reading procedure, the recipe manifest, and the failure signals a generated image is
checked against.

**Asset licensing.** The skill's code and instructions are MIT. The images in its `examples/` folder are
© 2026 Yan Liu and are *not* MIT — see `assets/reference/ASSET-LICENSE.md`. Only the small system board
image was copied here, as a reference for how the system presents itself.

**No logo.** The source ships no logo or brand mark. Wherever a mark would sit, the name is set in plain
type: `MONO-COLOR` in monospace at 2px tracking above `VISUAL SYSTEM` in bold grotesk. Do not draw one.

**Font substitution — needs your input.** The source names Helvetica Neue, Avenir Next, Avenir Next
Condensed, Courier New, Bodoni 72 and PingFang SC, and ships **no font binaries**. Every token stack names
the real face first and falls back to a Google Fonts substitute: Archivo (Helvetica Neue), Jost (Avenir
Next), Archivo Narrow (Avenir Next Condensed), Courier Prime (Courier New), Libre Bodoni (Bodoni 72),
Noto Sans SC (PingFang SC). Send the real font files and the substitutes drop away.

---

## Content fundamentals

The voice is an independent cultural poster, a field journal, or a community print notice. Not a brand.

- **Terse and observant.** Display copy is 2-8 words. Everything else is sparse. `still open`,
  `after sunset`, `field note 07`, `the quiet hour`, `we kept the window open`, `north by foot`.
- **Romantic without sentiment.** For summer, movement, travel, leisure, music and night subjects, romantic
  freedom is the default register, expressed through a physical sensation, an open direction, or an unhurried
  gesture — never a motivational slogan. `START BEFORE YOU FEEL READY`, `NO PERMISSION REQUIRED`.
- **Factual where facts matter.** For civic, scientific or archival subjects, clarity overrides the romantic
  default: `SPECIMEN / 07 / NORTH`, `OPEN PRACTICE / 05:00`, `PLATE 04`, `SUBJECT 60-80% / PAPER 20-40%`.
- **Casing carries the register.** Lowercase for intimate statements, uppercase for public declarations.
  Microcopy, labels, ids and hex values are uppercase monospace; catalog ids stay lowercase and verbatim
  (`composition_overprint_collage`) because they are a machine contract.
- **First and second person are both rare.** The voice observes rather than addresses. `每个人都可以`
  ("anyone can") is about as close to *you* as the system gets. No "we", no "our team", no manifesto.
- **Never invented.** No organisations, sponsors, URLs, QR codes, fake mastheads or signatures. If a date or
  venue is not supplied, it does not appear — plausible microtype is texture, not fabricated fact.
- **No sales language.** No CTA, no hype, no productivity slogan. Dry wit is allowed; enthusiasm is not.
- **No emoji.** Anywhere. The source uses none in artifacts.
- **Supplied words are law.** User wording is preserved exactly, in its original language, and never
  translated or re-broken unless asked. Invented words default to natural English.

## Visual foundations

**Substrate.** Paper is chosen, not assumed: Neutral White `#FAFAF7` for crisp cultural, social, event and
image-led work; Cool Gray `#E9E9E5` for architecture, technology and charcoal-led systems; Pale Beige
`#F5F1E8` for tactile, food, travel, intimate and archival subjects. The substrate is never counted as an
ink. Halftone and limited inks describe reproduction, not an era — nothing is yellowed, sepia, distressed
or antique unless the brief asks for it.

**Ink.** Two plates maximum, one when the brief says one ink. The dominant plate carries 70-85% of printed
area, the accent 15-30% with a specific assigned job (dates, annotations, one selected object, overprint
intersections). Overlap darkening is a physical consequence, not a third ink. Cobalt `#2148B8` +
Terracotta `#C65F38` is the fallback pair. Generic colour words resolve consistently: blue → Cobalt,
green → Botanical Green, orange → Terracotta, red → Signal Red, purple → Aubergine, black → Charcoal.

**Type.** Responsive cast, not a house font: literary serif, wide cultural grotesk, heavy condensed civic,
engineered programmatic, rotated display, handwritten interjection, or word-as-object. One display voice per
page plus one monospaced support voice; a handwritten third voice is optional and never carries facts. One
dramatic scale jump — the largest text is 5x-12x the microcopy. Board sizes are literal: 72px masthead,
34px/600 section titles, 15px/600 labels, 11-13px mono microcopy, 1.2px tracking on indices.

**Spacing and layout.** 1800×3000 board, 90px margins (5% of width; posters run 5-9%), 1620px live measure.
Most elements align to one invisible left edge or a 2-3 column editorial grid; nothing is centred by
default. 25-55% of the page stays visibly empty, 35% by default, and that emptiness is pacing rather than
leftover room. Fixed steps do the rhythm: 162/178px for ink plates, 405px for type specimens, 540/290px for
composition thumbs, 230px for carriers.

**Backgrounds.** Flat, front-facing paper. No mockups, frames, desks, gradients or cast shadows. The
"image" is always a screened plate: photographs become halftone dots, risograph grain, cyanotype exposure
or photocopy breakup. Exposed paper must form a visible shape *inside* the image — clipped highlights,
knockout gaps, halftone fade-outs — not only an outer margin. There are no repeating decorative patterns;
the only texture is fractal paper grain (0.72 frequency, 3 octaves, 0.085 alpha, multiplied).

**Borders, cards and radii.** There are no cards. Structure comes from rules: 5px poster rule, 4px board
masthead, 2px section rule, 1px hairline between specimens. Corners are square — `--radius-none` is the
default and the only curve in the system is the 10px screen corner on the social-cover carrier silhouette.

**Shadows, transparency and blur.** None. No drop shadows, no inner shadows, no protection gradients, no
capsules, no glass, no blur. A single sheet edge is drawn as a 1px inset rule. The only transparency is
physical: 78% overprint fill where two plates cross, 0.42/0.24/0.18 dot opacities in a halftone screen, and
a 0.13 ghost for a pale second impression.

**Imperfection.** Composition, wording, palette and hierarchy are deterministic; looseness lives only in
the reproduction layer, seeded by a stable hash so retries reproduce the same marks. Contemporary work takes
0-2 effects, tactile or archival work 2-3: uneven ink density 6-12%, dry-edge breakup 1-4%, halftone drift
5-10%, registration drift 1-3mm, one broken manual gesture with a 4-12% gap. Never on microcopy.

**Gesture.** Exactly one manual gesture family per page — a circled fact, a hand-drawn line, a registration
mark, a rotated label, or a ruled data strip. Mixing families turns a page into scrapbook decoration.

**Colour vibe of imagery.** Not warm, not cool, not black and white: single-hue. An image is whatever the
ink is, at whatever density the screen gives it, with paper for highlights. Medium contrast, no glossy
photographic depth.

**Animation, hover and press.** The source is print; it has no motion language. Nothing in an artifact
animates. The UI kits in this project use the smallest possible affordances instead of inventing one: a
2px ink outline for selection, a 1px hairline for the unselected state, and `--dur-base 160ms` with
`--ease-plate` if a transition is unavoidable. No fades on content, no bounces, no opacity hovers on type.

## Iconography

**There is no icon set, and none was substituted.** The source contains no icon font, no sprite sheet, no
Lucide/Heroicons dependency, and no UI icons at all — because it produces printed artifacts rather than
interfaces. Nothing was pulled from a CDN to fill the gap; inventing an icon language would be a fabrication.

What the system does use in place of icons:

- **Printer's marks.** Registration crosshairs, plate indices (`01`, `PLATE 04`), and rules. Shipped here
  as `RegistrationMark`, `PlateBadge` and `SectionRule`.
- **Miniature diagrams.** The nine composition families are taught as 180×226 miniature posters, and the
  seven carriers as recognisable physical silhouettes (poster sheet, zine spread with a spine, phone crop,
  square sleeve, packaging fold, garment, portfolio spread). Both come from the board renderer's exact path
  data — copied, not redrawn.
- **Swatch files.** 17 SVG colour chips in `assets/swatches/` — 8 one-ink, 9 two-ink. These are the only
  standalone image assets the source ships. Reference them directly rather than re-drawing swatches.
- **Unicode, sparingly.** `·` as a metadata separator, `/` inside microcopy strings, `→` in documentation
  flow diagrams. Never as decoration inside an artifact.
- **Emoji: never.**

If a consuming project genuinely needs interface icons, say so and choose a set explicitly — treat it as an
addition to this system, documented as such, not as something inherited from mono-color.

---

## Components

Reusable primitives, grouped by concern. Each directory holds `<Name>.jsx`, `<Name>.d.ts`,
`<Name>.prompt.md`, and one `@dsCard` HTML showing its states.

**`components/plate/`** — the printing layer
- `InkSwatch` — one ink as a solid plate with its catalog id and exact hex.
- `InkPair` — an approved two-ink recipe drawn at its true 75/25 split.
- `PaperSheet` — substrate with the fractal paper grain.
- `HalftoneField` — a screened plate: ink knocked out by three paper dots per cell.

**`components/type/`** — the two voices
- `DisplayHeading` — the page's single display voice (literary, cultural, condensed, programmatic, word-as-object; optionally rotated).
- `MicroLabel` — monospaced support voice for ids, hex values, dates and facts.
- `SpecimenCaption` — name, catalog id, tabular fact rows, one quiet note.

**`components/marks/`** — printer's marks
- `SectionRule` — numbered section header over a full-measure rule.
- `PlateBadge` — bold mono index number.
- `RegistrationMark` — registration crosshair; one of the permitted manual gestures.

**`components/information/`** — the metadata tier
- `RuledDataStrip` — a rule plus a row of monospaced facts.
- `CarrierBadge` — carrier name, catalog id, and legal ratios.

**`components/poster/`** — the page itself
- `PosterSheet` — a flat printed sheet at a legal ratio with the source margin band.
- `CompositionThumb` — miniature diagram of any of the nine composition families.

### Intentional additions

The source defines catalogs, not React components, so every component above is a direct rendering of a
catalog concept or of a device drawn by the board/poster renderers. Two are conveniences with no single
source counterpart, kept because the alternative is copy-pasted inline styling:

- `SpecimenCaption` — factors out the name/id/facts/note block the board repeats beside every specimen.
- `PlateBadge` — factors out the bold mono index the board repeats in four sections.

Nothing else was added. There is no Button, Input, Card, Tab, Toast or Avatar in this system, because there
is no interface in the source to take them from.

## UI kits

- **`ui_kits/reference-board/`** — the printed index board, rebuilt from `build_design_system_board.py` at
  its exact 1800×3000 geometry. Ink plates and composition thumbs are click-selectable.
- **`ui_kits/printed-artifacts/`** — a press-sheet view of the one-ink poster built by
  `build_vibe_coding_poster.py`, with one-ink and substrate selection and a paper-grain toggle.

Each kit has its own README recording the departures from the source script.

## Templates

- **`templates/one-ink-poster/`** — 3:4 poster on a single plate: mono eyebrow, 5px rule, oversized
  headline, screened plate, ruled fact band. Substrate and screen ruling are tweakable.
- **`templates/specimen-board/`** — printer's index page: numbered sections, ink plates, composition
  thumbs, carrier labels.

## Index

| Path | What it is |
|---|---|
| `styles.css` | The single entry point consumers link. `@import` lines only. |
| `tokens/fonts.css` | Google Fonts substitutes for the six named faces. |
| `tokens/colors.css` | 3 substrates, 19 inks, board neutrals, semantic aliases, plate budget. |
| `tokens/typography.css` | Font stacks, the display and microcopy scale, weights, tracking, leading. |
| `tokens/spacing.css` | Page geometry, margins, rule weights, grid steps, paper-exposure budget. |
| `tokens/print.css` | Halftone, paper noise, ink wobble, imperfection ranges, ghost impression. |
| `guidelines/colors/` | 6 cards: one-ink palette, second-plate inks, two-ink recipes, substrates, plate split, board neutrals. |
| `guidelines/type/` | 4 cards: display voices, support voice, scale jump, type roles. |
| `guidelines/spacing/` | 3 cards: page grid, rule weights, paper exposure. |
| `guidelines/print/` | 4 cards: halftone screen, paper grain, registration drift, imperfection ranges. |
| `guidelines/brand/` | 3 cards: swatch assets, wordmark, carriers. |
| `components/` | 14 primitives in 5 groups (above). |
| `ui_kits/` | 2 recreations (above). |
| `templates/` | 2 starting points (above). |
| `assets/swatches/` | 17 SVG colour chips copied from the source. |
| `assets/reference/` | The source's own system board image, plus its asset licence. |
| `thumbnail.html` | Homepage tile. |
| `SKILL.md` | Agent Skills entry point, for use with Claude Code. |
| `github.md` | Source-repository association and sync record. |
