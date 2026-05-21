// kern-article.typ — preamble for kern-compatible Typst HTML export.
//
// Authors import this package and apply the `article` show-rule template.
// In HTML mode it emits kern math placeholders and semantic heading elements.
// In paged (PDF) mode it falls through to standard Typst rendering.
//
// Usage:
//   #import "@preview/kern-article:0.1.0": article
//   #show: article.with(title: "My Title", section: "foundations", order: 1)

// --- base64 encoder ---

#let _b64t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

#let _base64(s) = {
  let bs = array(bytes(s))
  let out = ""
  let n = bs.len()
  let i = 0
  while i < n {
    let b0 = bs.at(i)
    let b1 = if i + 1 < n { bs.at(i + 1) } else { 0 }
    let b2 = if i + 2 < n { bs.at(i + 2) } else { 0 }
    out += _b64t.at(calc.quo(b0, 4))
    out += _b64t.at(calc.rem(b0, 4) * 16 + calc.quo(b1, 16))
    out += if i + 1 < n { _b64t.at(calc.rem(b1, 16) * 4 + calc.quo(b2, 64)) } else { "=" }
    out += if i + 2 < n { _b64t.at(calc.rem(b2, 64)) } else { "=" }
    i += 3
  }
  out
}

// --- frontmatter value converter ---
// Converts Typst values to JSON-compatible representations.
// Delegates to json.encode for primitives; handles datetime and content explicitly.

#let _to-json-val(val) = {
  let t = type(val)
  if t == dictionary {
    let d = (:)
    for (k, v) in val { d.insert(k, _to-json-val(v)) }
    d
  } else if t == array {
    val.map(v => _to-json-val(v))
  } else if t == datetime {
    let y = str(val.year())
    let m = str(val.month())
    let d = str(val.day())
    let mm = if m.len() < 2 { "0" + m } else { m }
    let dd = if d.len() < 2 { "0" + d } else { d }
    y + "-" + mm + "-" + dd
  } else if t == content {
    // Rich content in frontmatter is serialized as repr — put data in fields, not content.
    repr(val)
  } else {
    val
  }
}

// --- article template ---
//
// Named arguments (other than `title`) are passed through verbatim to frontmatter.
// The host site defines its own schema; this library imposes none.
//
// Example:
//   #show: article.with(
//     title: "Burdens Theory",
//     section: "foundations",
//     order: 2,
//     prerequisites: ("framing-and-goals",),
//   )

#let article(title: none, ..args, body) = {
  // kern-typst passes --input target=html at build time.
  // Tools without that flag (tinymist, typst-concealer) get "pdf" by default
  // and never evaluate the html.elem branch.
  let is_html = sys.inputs.at("target", default: "pdf") == "html"

  if is_html {
    let fm = (:)
    if title != none { fm.insert("title", _to-json-val(title)) }
    for (k, v) in args.named() {
      fm.insert(k, _to-json-val(v))
    }

    html.elem("meta", attrs: (
      "name": "kern-frontmatter",
      "content": _base64(json.encode(fm)),
    ))

    show math.equation.where(block: false): it => html.elem("span", attrs: (
      "data-kern-math": "",
      "data-display": "inline",
    ))[#repr(it.body)]

    show math.equation.where(block: true): it => html.elem("span", attrs: (
      "data-kern-math": "",
      "data-display": "block",
    ))[#repr(it.body)]

    show heading.where(level: 1): it => html.elem("h2", it.body)
    show heading.where(level: 2): it => html.elem("h3", it.body)
    show heading.where(level: 3): it => html.elem("h4", it.body)
    show heading.where(level: 4): it => html.elem("h5", it.body)
    show heading.where(level: 5): it => html.elem("h6", it.body)

    body
  } else {
    set page(paper: "us-letter", margin: (x: 1in, y: 1in))
    set text(font: "New Computer Modern", size: 11pt)

    if title != none {
      align(center, text(size: 18pt, weight: "bold")[#title])
      v(0.5em)
    }

    body
  }
}
