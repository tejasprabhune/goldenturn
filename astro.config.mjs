import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import mdx from '@astrojs/mdx';
import remarkMath from './src/remark/math.mjs';

export default defineConfig({
  site: 'https://goldenturn.org',
  integrations: [tailwind(), mdx()],
  output: 'static',
  markdown: {
    remarkPlugins: [remarkMath],
  },
});
