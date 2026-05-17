/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        paper: '#fcefef',
        ink: '#1a1a1a',
        heading: '#2f4858',
        accent: '#ced530',
        'accent-soft': '#edf09a',
      },
      fontFamily: {
        display: ['swear-display', 'Georgia', 'serif'],
        body: ['freight-text-pro', 'neue-haas-unica', 'Georgia', 'serif'],
        sans: ['neue-haas-unica', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
