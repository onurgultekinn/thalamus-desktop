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
          /* Driven by the --tlm-* variables in App.css so `data-theme` recolours
             every utility (bg-obsidian-panel/30, text-obsidian-muted …) at once. */
          bg: 'rgb(var(--tlm-bg) / <alpha-value>)',       /* Deep slate main background */
          panel: 'rgb(var(--tlm-panel) / <alpha-value>)', /* Base-950 — card and panel surface */
          surface: 'rgb(var(--tlm-surface) / <alpha-value>)',
          button: 'rgb(var(--tlm-raise) / <alpha-value>)',/* Neutral buttons */
          raise: 'rgb(var(--tlm-raise) / <alpha-value>)',
          line: 'rgb(var(--tlm-line) / <alpha-value>)',
          border: 'rgba(242, 240, 229, 0.08)',            /* Warm white, thin pencil line */
          text: 'rgb(var(--tlm-fg) / <alpha-value>)',     /* Base-200 — paper white */
          soft: 'rgb(var(--tlm-fg-soft) / <alpha-value>)',
          muted: 'rgb(var(--tlm-fg-faint) / <alpha-value>)' /* Muted text tone */
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
