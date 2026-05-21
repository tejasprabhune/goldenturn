# the golden turn

An open-source resource site for college parliamentary debate, hosted at [goldenturn.org](https://goldenturn.org). It consolidates a written curriculum (textbook), a recordings index, a files and playbooks archive, and a K reference into one searchable surface. It replaces and supersedes [npdavideos.appspot.com](https://npdavideos.appspot.com).

## Local development

```
npm install
npm run dev
```

The site runs at `http://localhost:4321` by default.

## Writing curriculum articles in Typst

Curriculum articles can be written in either MDX or [Typst](https://typst.app). The Typst pipeline is handled by two vendored packages in `vendor/`: `kern-typst` (compiles `.typ` to HTML and renders math via kern) and `kern-typst-astro` (Astro Content Layer loader that calls it).

### Prerequisite

`typst` must be installed and on your `PATH`:

```
brew install typst
```

### Article format

Create a `.typ` file anywhere under `src/content/curriculum/`. Start with the preamble import and show rule, then write prose:

```typst
#import "/_kern_preamble.typ": article

#show: article.with(
  title: "Your Title",
  section: "foundations",
  order: 3,
  prerequisites: ("foundations/framing-and-goals",),
  related_articles: (),
  related_ks: (),
  related_recordings_tags: (),
  related_files: (),
  draft: false,
)

Opening paragraph here.

= Section heading

Body text. Inline math: $P(A) > 0.5$. Display math:

$ sum_(i=1)^n x_i = 1 $
```

The fields in `article.with(...)` match the `curriculum` collection schema defined in `src/content.config.ts`. The `section` field must be one of `foundations`, `aff`, `neg`, `theory`, `advanced`, or `meta`. The `order` field controls the display order within a section.

### How it works

When the dev server or build runs, the `typstLoader` in `vendor/kern-typst-astro` finds every `*.typ` file under `src/content/curriculum/`, compiles each one with `typst compile --format html`, extracts the frontmatter (base64-encoded JSON embedded in a `<meta>` tag by the preamble), and stores the resulting HTML in the content store alongside any MDX entries. The `render()` call in the curriculum page template then serves that HTML directly.

Math expressions are compiled by typst to Typst repr strings, which kern then renders client-side to HTML. Typst's standard `$...$` (inline) and `$ ... $` (display) syntax works as you would expect.

HMR works. When you save a `.typ` file in dev mode, the watcher rebuilds only that entry and any entries that share a dependency (such as a shared include file).

### LSP and editor support

The root `_kern_preamble.typ` file exists so that editors with typst-lsp support (tinymist, typst-concealer) can resolve the `/_kern_preamble.typ` import when you open a `.typ` file directly. It is the same file that the compiler copies into place at build time; keep them in sync if you modify the preamble.

## Contributing

Content contributions are welcome. The contribution guide lives at [goldenturn.org/contribute](https://goldenturn.org/contribute) (coming soon). For recordings submissions, use the form at `/recordings/add`, which opens a pre-filled GitHub issue. For written content (curriculum articles, K pages, files), open a pull request against `main` with your MDX or `.typ` file in the appropriate `src/content/` subdirectory.

## Tech stack

- [Astro](https://astro.build) with TypeScript and MDX
- [Typst](https://typst.app) for curriculum articles (via vendored `kern-typst` and `kern-typst-astro`)
- [Tailwind CSS](https://tailwindcss.com) for styling
- [Algolia](https://www.algolia.com) for search
- [Adobe Typekit](https://fonts.adobe.com) for typography (kit `ten2ahn`)
- [GitHub Pages](https://pages.github.com) for hosting, deployed via GitHub Actions
