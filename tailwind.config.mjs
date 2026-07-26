/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        paper: '#f2efe6',
        'paper-raised': '#faf8f2',
        ink: '#17150f',
        sky: '#a2d6f9',
        'sky-deep': '#6fb4e0',
        'sky-wash': '#e2effa',
        gold: '#fdd85d',
        'gold-deep': '#b58a12',
        // heading and accent are the original token names, remapped so pages
        // that still reference them land on the new palette.
        heading: '#17150f',
        accent: '#fdd85d',
        'accent-soft': '#a2d6f9',
      },
      fontFamily: {
        display: ['"PP Editorial New"', 'Georgia', 'serif'],
        body: ['"Neue Montreal"', 'system-ui', 'sans-serif'],
        sans: ['"Neue Montreal"', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      letterSpacing: {
        label: '0.14em',
      },
    },
  },
  plugins: [],
};
