import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { STRINGS, type Lang, type StringKey } from "./strings.ts";

const KEY = "mandi.lang";

interface Ctx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: StringKey, vars?: Record<string, string | number>) => string;
  /** Picks the Hindi field when the UI is in Hindi and one exists. */
  pick: (en: string | null | undefined, hi: string | null | undefined) => string;
}

const I18nCtx = createContext<Ctx | null>(null);

function read(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "en" || v === "hi") return v;
  } catch { /* ignore */ }
  return "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(read);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dataset.lang = lang;
  }, [lang]);

  const setLang = (l: Lang) => {
    setLangState(l);
    try { localStorage.setItem(KEY, l); } catch { /* ignore */ }
  };

  const t = (key: StringKey, vars?: Record<string, string | number>) => {
    const table = STRINGS[lang] as Record<string, string>;
    let s = table[key] ?? (STRINGS.en as Record<string, string>)[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  };

  const pick = (en: string | null | undefined, hi: string | null | undefined) =>
    (lang === "hi" ? hi || en : en || hi) ?? "";

  return <I18nCtx.Provider value={{ lang, setLang, t, pick }}>{children}</I18nCtx.Provider>;
}

export function useI18n() {
  const c = useContext(I18nCtx);
  if (!c) throw new Error("useI18n outside I18nProvider");
  return c;
}
