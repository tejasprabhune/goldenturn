// Shared helpers for curriculum articles.
// Import with: #import "../_setup.typ": diagram
// (adjust path depth as needed)

// Renders content as inline SVG via html.frame.
// Requires Typst HTML features (always active under astro-typst).
// tinymist/PDF preview will error on files that call diagram() -- this is
// expected since these articles are HTML-only output.
#let diagram(body) = html.frame(body)
