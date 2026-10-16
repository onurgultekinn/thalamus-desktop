/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        obsidian: {
          bg: '#100F0F',       /* Deep slate main background */
          panel: '#1C1B1A',    /* Base-950 — card and panel surface */
          button: '#34332F',   /* Neutral buttons */
          border: 'rgba(242, 240, 229, 0.08)', /* Warm white, thin pencil line */
          text: '#F2F0E5',     /* Base-200 — paper white */
          muted: '#87857F'     /* Muted text tone */
        }
      },
      fontFamily: {
        sans: ['Segoe UI Variable', 'Segoe UI', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['Cascadia Code', 'Ubuntu Sans Mono', 'ui-monospace', 'SFMono-Regular', 'Consolas', 'monospace'],
      }
    },
  },
  plugins: [],
}
