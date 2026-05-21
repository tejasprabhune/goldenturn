import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import mdx from '@astrojs/mdx';
import remarkMath from './src/remark/math.mjs';
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
  markdown: {
    remarkPlugins: [remarkMath],
  },
});
