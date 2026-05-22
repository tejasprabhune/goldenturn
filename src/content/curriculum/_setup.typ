// Shared helpers for curriculum articles.
// Import with: #import "../_setup.typ": frame
// (adjust path depth as needed)

// Renders any Typst content as inline SVG via html.frame.
// Use this for CeTZ diagrams, showybox callouts, or any package that relies
// on Typst layout primitives the HTML exporter cannot convert directly.
// width: explicit layout width for the SVG; auto-width content like showybox
// needs this or Typst will produce a 0-wide SVG. 500pt matches the prose
// column at typical viewport sizes.
// Requires Typst HTML features (always active under astro-typst).
// tinymist/PDF preview will error on files that call frame() -- this is
// expected since these articles are HTML-only output.
#let frame(body, width: 500pt) = html.frame(block(width: width, body))
