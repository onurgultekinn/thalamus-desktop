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
        },
        /* ── Themeable semantic tokens ──────────────────────────────────────
           Values live in App.css as channel triplets (e.g. `16 15 15`);
           `html[data-theme='nord-red']` overrides them, so every utility below
           switches with the theme. `<alpha-value>` keeps `/opacity` modifiers
           working (e.g. bg-surface/60). */
        ink: 'rgb(var(--tlm-ink) / <alpha-value>)',
        panel: 'rgb(var(--tlm-panel) / <alpha-value>)',
        surface: 'rgb(var(--tlm-surface) / <alpha-value>)',
        line: 'rgb(var(--tlm-line) / <alpha-value>)',
        raise: 'rgb(var(--tlm-raise) / <alpha-value>)',
        fg: 'rgb(var(--tlm-fg) / <alpha-value>)',
        'fg-soft': 'rgb(var(--tlm-fg-soft) / <alpha-value>)',
        'fg-muted': 'rgb(var(--tlm-fg-muted) / <alpha-value>)',
        'fg-faint': 'rgb(var(--tlm-fg-faint) / <alpha-value>)',
        'fg-dim': 'rgb(var(--tlm-fg-dim) / <alpha-value>)',
        accent: 'rgb(var(--tlm-accent) / <alpha-value>)',
        'accent-deep': 'rgb(var(--tlm-accent-deep) / <alpha-value>)',
        aqua: 'rgb(var(--tlm-aqua) / <alpha-value>)',
        'aqua-soft': 'rgb(var(--tlm-aqua-soft) / <alpha-value>)',
        gold: 'rgb(var(--tlm-gold) / <alpha-value>)',
        danger: 'rgb(var(--tlm-danger) / <alpha-value>)',
        'danger-soft': 'rgb(var(--tlm-danger-soft) / <alpha-value>)',
        warn: 'rgb(var(--tlm-warn) / <alpha-value>)'
      },
      fontFamily: {
        sans: ['Segoe UI Variable', 'Segoe UI', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['Cascadia Code', 'Ubuntu Sans Mono', 'ui-monospace', 'SFMono-Regular', 'Consolas', 'monospace'],
      }
    },
  },
  plugins: [],
}
