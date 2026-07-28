import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import mdx from '@astrojs/mdx';
import { typst } from 'astro-typst';

export default defineConfig({
  site: 'https://goldenturn.org',
  integrations: [
    tailwind(),
    mdx(),
    typst({
      target: (_id) => 'html',
      htmlMode: 'text',
    }),
  ],
  output: 'static',
  // Curriculum and lectures are one page now. The old addresses are in search
  // results and in people's history, so they point at it rather than 404.
  redirects: {
    '/curriculum': '/learn',
    '/lectures': '/learn',
  },
});
