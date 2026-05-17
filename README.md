# the golden turn

An open-source resource site for college parliamentary debate, hosted at [goldenturn.org](https://goldenturn.org). It consolidates a written curriculum (textbook), a recordings index, a files and playbooks archive, and a K reference into one searchable surface. It replaces and supersedes [npdavideos.appspot.com](https://npdavideos.appspot.com).

## Local development

```
npm install
npm run dev
```

The site runs at `http://localhost:4321` by default.

## Contributing

Content contributions are welcome. The contribution guide lives at [goldenturn.org/contribute](https://goldenturn.org/contribute) (coming soon). For recordings submissions, use the form at `/recordings/add`, which opens a pre-filled GitHub issue. For written content (curriculum articles, K pages, files), open a pull request against `main` with your MDX file in the appropriate `src/content/` subdirectory.

## Tech stack

- [Astro](https://astro.build) with TypeScript and MDX
- [Tailwind CSS](https://tailwindcss.com) for styling
- [Algolia](https://www.algolia.com) for search
- [Adobe Typekit](https://fonts.adobe.com) for typography (kit `ten2ahn`)
- [GitHub Pages](https://pages.github.com) for hosting, deployed via GitHub Actions
