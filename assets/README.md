# the golden turn — assets

Source assets for the site's identity. Everything here is generated from the
two typefaces the site uses, so the marks are the real letterforms rather than
a lookalike serif a viewer may not have installed. The glyph outlines are
embedded as paths, which is why none of these files need a font to render.

## Files

| File | What it is | Where it is used |
| --- | --- | --- |
| `mark.svg` | the `g`, gold with an ink border on sky, square | shipped as `public/favicon.svg` |
| `mark-ink.svg` | the same mark on ink | for placing against a light ground |
| `mark-512.png` | `mark.svg` at 512px | app icons, anywhere SVG is not accepted |
| `wordmark.svg` | "the golden turn", gold with an ink border, transparent | headers, slides, print |
| `wordmark-sky.svg` | the wordmark on a sky panel | matches the home page masthead |
| `og-image.svg` / `.png` | 1200×630 sharing card | shipped as `public/og-image.png` |

`public/` also carries `apple-touch-icon.png` (180px), rendered from `mark.svg`.

## Palette

| Token | Value | Role |
| --- | --- | --- |
| paper | `#f2efe6` | page ground |
| paper raised | `#faf8f2` | panels, inputs, the waveform bed |
| ink | `#17150f` | text, rules, borders |
| sky | `#a2d6f9` | the masthead and footer bands, neg speeches, pressed toggles |
| sky deep | `#6fb4e0` | focus rings |
| sky wash | `#e2effa` | row hover |
| gold | `#fdd85d` | the wordmark, aff speeches, the play button, accepted edits |
| gold deep | `#b58a12` | warnings on paper |

These are defined as custom properties in `src/styles/global.css`; that file is
the source of truth, and this table is a copy for use outside the site.

## Type

- **Display** — PP Editorial New Ultralight, weight 300, always lowercase, and
  never bolded. The wordmark tracks at `-0.02em`.
- **Body and UI** — Neue Montreal, 400 for prose and 500 for labels and
  controls.

The wordmark's ink border sits *outside* the glyph: in CSS it is an eight-way
`text-shadow` and in these SVGs it is a stroke with `paint-order="stroke"`. A
centred stroke, which is the default, eats the ultralight strokes until the
letterforms break up.

## Regenerating

The marks were produced by reading the glyph outlines out of the OTFs with
fontTools and laying them out at the same tracking the site uses. Nothing here
is hand-drawn, so a change of typeface means regenerating rather than redrawing.

## Licensing

PP Editorial New and Neue Montreal are Pangram Pangram fonts, used here under
their free-for-personal-use terms. These assets embed their outlines. A
commercial licence is needed before the site or these files are used
commercially.
