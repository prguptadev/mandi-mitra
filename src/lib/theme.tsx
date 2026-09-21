import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";

export type Theme = "light" | "dark" | "system";

/* How the screens look on this computer: light or dark, the accent colour
   (buttons, links, the selected menu item) and whether table rows alternate.
   Kept in this browser; each computer can have its own. */

const KEY = "mandi.theme";
const ACCENT_KEY = "mandi.accent";
const ZEBRA_KEY = "mandi.zebra";

/** Solid accent colours, each tuned for light and dark screens (HSL, as the stylesheet's variables). */
export const ACCENTS = {
  green:  { light: ["158 62% 27%", "0 0% 100%"], dark: ["158 48% 48%", "158 70% 8%"] },
  teal:   { light: ["186 75% 28%", "0 0% 100%"], dark: ["184 55% 50%", "186 70% 8%"] },
  blue:   { light: ["214 80% 42%", "0 0% 100%"], dark: ["214 85% 66%", "214 70% 10%"] },
  indigo: { light: ["238 52% 50%", "0 0% 100%"], dark: ["236 80% 74%", "238 60% 12%"] },
  purple: { light: ["272 48% 45%", "0 0% 100%"], dark: ["270 65% 72%", "272 50% 12%"] },
  maroon: { light: ["350 62% 38%", "0 0% 100%"], dark: ["350 72% 66%", "350 60% 12%"] },
  orange: { light: ["22 88% 42%", "0 0% 100%"], dark: ["26 90% 60%", "24 80% 10%"] },
  brown:  { light: ["28 45% 32%", "0 0% 100%"], dark: ["32 55% 60%", "28 50% 10%"] },
  slate:  { light: ["215 22% 32%", "0 0% 100%"], dark: ["215 18% 68%", "215 25% 10%"] },
} as const;
export type Accent = keyof typeof ACCENTS;

interface Ctx {
  theme: Theme; resolved: "light" | "dark"; setTheme: (t: Theme) => void; cycle: () => void;
  accent: Accent; setAccent: (a: Accent) => void;
  zebra: boolean; setZebra: (on: boolean) => void;
}
const ThemeCtx = createContext<Ctx | null>(null);

function read<T extends string>(key: string, ok: (v: string) => boolean, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v && ok(v)) return v as T;
  } catch { /* private window, blocked storage */ }
  return fallback;
}
const store = (key: string, v: string) => { try { localStorage.setItem(key, v); } catch { /* this computer forgets */ } };

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => read<Theme>(KEY, (v) => v === "light" || v === "dark" || v === "system", "system"));
  const [accent, setAccentState] = useState<Accent>(() => read<Accent>(ACCENT_KEY, (v) => v in ACCENTS, "green"));
  const [zebra, setZebraState] = useState<boolean>(() => read(ZEBRA_KEY, (v) => v === "on" || v === "off", "on") === "on");
  const [systemDark, setSystemDark] = useState(
    () => typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const resolved: "light" | "dark" = theme === "system" ? (systemDark ? "dark" : "light") : theme;

  // before the first paint, so the screen never flashes the old colour
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
  }, [theme]);
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (accent === "green") { root.style.removeProperty("--brand"); root.style.removeProperty("--brand-ink"); return; }
    const [brand, ink] = ACCENTS[accent][resolved];
    root.style.setProperty("--brand", brand);
    root.style.setProperty("--brand-ink", ink);
  }, [accent, resolved]);
  useLayoutEffect(() => { document.documentElement.setAttribute("data-zebra", zebra ? "on" : "off"); }, [zebra]);

  const setTheme = (t: Theme) => { setThemeState(t); store(KEY, t); };
  const setAccent = (a: Accent) => { setAccentState(a); store(ACCENT_KEY, a); };
  const setZebra = (on: boolean) => { setZebraState(on); store(ZEBRA_KEY, on ? "on" : "off"); };
  const cycle = () => setTheme(resolved === "dark" ? "light" : "dark");

  return <ThemeCtx.Provider value={{ theme, resolved, setTheme, cycle, accent, setAccent, zebra, setZebra }}>{children}</ThemeCtx.Provider>;
}

export function useTheme() {
  const c = useContext(ThemeCtx);
  if (!c) throw new Error("useTheme outside ThemeProvider");
  return c;
}
