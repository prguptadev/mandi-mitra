import type { Config } from "tailwindcss";

export default {
  darkMode: ["class", '[data-theme="dark"]'],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "hsl(var(--bg))",
        surface: "hsl(var(--surface))",
        raised: "hsl(var(--raised))",
        line: "hsl(var(--line))",
        ink: "hsl(var(--ink))",
        muted: "hsl(var(--muted))",
        faint: "hsl(var(--faint))",
        brand: "hsl(var(--brand))",
        "brand-ink": "hsl(var(--brand-ink))",
        ok: "hsl(var(--ok))",
        warn: "hsl(var(--warn))",
        bad: "hsl(var(--bad))",
        "ok-soft": "hsl(var(--ok-soft))",
        "warn-soft": "hsl(var(--warn-soft))",
        "bad-soft": "hsl(var(--bad-soft))",
      },
      fontFamily: {
        // Mangal is the Devanagari face every Windows PC has, and what Tally and
        // Word print here; Nirmala UI is the newer one. Latin still comes from Inter.
        sans: ["Inter", "Noto Sans Devanagari", "Nirmala UI", "Mangal", "system-ui", "sans-serif"],
        num: ["Roboto Mono", "ui-monospace", "monospace"],
      },
      spacing: { "4.5": "1.125rem", "8.5": "2.125rem", "9.5": "2.375rem" },
      borderRadius: { xl: "0.875rem", "2xl": "1.125rem" },
      boxShadow: {
        card: "0 1px 2px hsl(var(--shadow) / 0.06), 0 1px 3px hsl(var(--shadow) / 0.04)",
        pop: "0 10px 30px -8px hsl(var(--shadow) / 0.22)",
      },
      keyframes: {
        shimmer: { "100%": { transform: "translateX(100%)" } },
        "fade-up": { from: { opacity: "0", transform: "translateY(4px)" }, to: { opacity: "1", transform: "none" } },
      },
      animation: { shimmer: "shimmer 1.6s infinite", "fade-up": "fade-up .18s ease-out" },
    },
  },
} satisfies Config;
