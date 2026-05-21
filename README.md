# the golden turn

An open-source resource site for college parliamentary debate, hosted at [goldenturn.org](https://goldenturn.org). It consolidates a written curriculum (textbook), a recordings index, a files and playbooks archive, and a K reference into one searchable surface. It replaces and supersedes [npdavideos.appspot.com](https://npdavideos.appspot.com).

## Local development

```
npm install
npm run dev
```

The site runs at `http://localhost:4321` by default.

## Writing curriculum articles in Typst

Curriculum articles can be written in either MDX or [Typst](https://typst.app). The Typst integration is `astro-typst`, which uses `@myriaddreamin/typst-ts-node-compiler` -- a native Node.js binding to the Typst compiler. No system `typst` binary is required.

### Adding an article

Create a `.typ` file anywhere under `src/content/curriculum/`. The `.typ` extension is stripped from the URL: `src/content/curriculum/goals/from-first-principles.typ` is served at `/curriculum/goals/from-first-principles`. No Astro edits are needed as long as the section already exists in `sectionEnum` (see below).

Declare frontmatter with a `#metadata` block at the top of the file, then write prose:

```typst
#metadata((
  title: "Your Title",
  section: "goals",
  order: 3,
  prerequisites: ("goals/from-first-principles",),
  related_articles: (),
  related_ks: (),
  related_recordings_tags: (),
  related_files: (),
  draft: false,
))<frontmatter>

Opening paragraph here.

= Section heading

Body text. Inline math: $P(A) > 0.5$. Display math:

$ sum_(i=1)^n x_i = 1 $
```

The fields match the `curriculum` collection schema in `src/content/config.ts`. The `order` field controls display order within a section. Set `draft: true` to exclude an article from the build.

Math renders as inline SVG. The Typst layout engine typesets equations the same way it does for PDF output, then embeds the result as SVG within the HTML. No client-side JavaScript is involved.

### Adding a section

Four files need to change.

**`src/content/config.ts`** -- add the section name to `sectionEnum`:

```ts
const sectionEnum = z.enum(['goals', 'your-new-section']);
```

**`src/pages/curriculum/index.astro`** -- add the section to `SECTION_ORDER` (controls display order on the index page) and `SECTION_LABELS`:

```ts
const SECTION_ORDER = ['goals', 'your-new-section'] as const;
const SECTION_LABELS: Record<string, string> = {
  goals: 'Goals',
  'your-new-section': 'Your New Section',
};
```

**`src/layouts/CurriculumLayout.astro`** -- the layout that renders individual article pages has its own copies of the same two constants. Update them identically:

```ts
const SECTION_ORDER = ['goals', 'your-new-section'] as const;
const SECTION_LABELS: Record<string, string> = {
  goals: 'Goals',
  'your-new-section': 'Your New Section',
};
```

Then create a subdirectory `src/content/curriculum/your-new-section/` and add `.typ` files with `section: "your-new-section"` in their frontmatter. The article page route (`src/pages/curriculum/[section]/[slug].astro`) requires no changes; it is fully dynamic.

### How it works

The `astro-typst` integration registers `.typ` as a content entry type. When the dev server or build encounters a `.typ` file in a content collection, it compiles it to HTML via the Typst compiler, extracts the `<frontmatter>` metadata, and returns a `Content` component that renders the compiled HTML. HMR works: saving a `.typ` file in dev mode invalidates the relevant modules in Vite's module graph and hot-reloads the page.

## Contributing

Content contributions are welcome. The contribution guide lives at [goldenturn.org/contribute](https://goldenturn.org/contribute) (coming soon). For recordings submissions, use the form at `/recordings/add`, which opens a pre-filled GitHub issue. For written content (curriculum articles, K pages, files), open a pull request against `main` with your MDX or `.typ` file in the appropriate `src/content/` subdirectory.

## Tech stack

- [Astro](https://astro.build) with TypeScript and MDX
- [Typst](https://typst.app) for curriculum articles (via `astro-typst`)
- [Tailwind CSS](https://tailwindcss.com) for styling
- [Algolia](https://www.algolia.com) for search
- [Adobe Typekit](https://fonts.adobe.com) for typography (kit `ten2ahn`)
- [GitHub Pages](https://pages.github.com) for hosting, deployed via GitHub Actions
