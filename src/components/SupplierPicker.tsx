import { useEffect, useLayoutEffect, useRef, useState, forwardRef } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus, Check, Languages } from "lucide-react";
import { api } from "@/lib/api.ts";
import { convertFinishedWord } from "@/lib/hindiTyping.ts";
import { cn } from "@/lib/utils.ts";
import { useI18n } from "@/lib/i18n.tsx";
import type { Adati } from "@/lib/api.ts";

export interface SupplierOption {
  id: string; nameHi: string; nameHinglish: string; village: string | null;
}

const DEVANAGARI = /[ऀ-ॿ]/;

/**
 * Keyboard-first supplier lookup.
 *
 * Matching happens on the server so this stays usable with thousands of
 * suppliers: at most 20 come back per keystroke and the list never renders
 * more than that. Typing in Hinglish finds the Devanagari name, and the
 * Devanagari is what is shown — the operator reads the sheet in Hindi.
 */
export const SupplierPicker = forwardRef<HTMLInputElement, {
  /** Optional preloaded list; only used to show the current selection. */
  suppliers?: Adati[] | SupplierOption[];
  /** The selected supplier's name, when the caller already has it. Avoids
   *  loading the whole master just to render one row. */
  selectedLabel?: { nameHi: string; nameHinglish?: string } | null;
  value: string | null;
  onChange: (adatiId: string | null) => void;
  onCommit?: () => void;
  onCreate?: (name: string) => void;
  /** What is typed when nothing is picked, so the page can save it as a new supplier. */
  onQueryChange?: (query: string) => void;
  invalid?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  /** Fired when the box loses focus with nothing picked. */
  onBlurEmpty?: () => void;
  /** Start the box with this text — what the reader made of the handwriting,
   *  there to be corrected rather than retyped. */
  initialText?: string;
  /** A name typed and finished (Enter, Tab or leaving the box) with nobody
   *  picked: the caller saves it, making the supplier if there is none. */
  onCommitText?: (text: string) => void;
}>(function SupplierPicker(
  { suppliers, selectedLabel, value, onChange, onCommit, onCreate, onQueryChange, invalid, disabled, placeholder, className, autoFocus, onBlurEmpty, initialText, onCommitText }, ref,
) {
  const { t, lang } = useI18n();
  const [query, setQuery] = useState(initialText ?? "");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);

  /* The grid scrolls horizontally, and a scroll container clips anything
     absolutely positioned inside it. The list is therefore rendered into the
     body and positioned against the input's viewport rectangle. */
  useLayoutEffect(() => {
    if (!open) { setRect(null); return; }
    const measure = () => {
      const el = inputRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect({ left: r.left, top: r.bottom + 4, width: Math.max(r.width, 300) });
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open]);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query), 140);
    return () => clearTimeout(id);
  }, [query]);

  /* Typing Latin should show the Hindi it means, both so the operator can read
     it against the paper and so a new supplier is created in Devanagari. */
  const [asHindi, setAsHindi] = useState<string | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (!q || !/[a-zA-Z]/.test(q)) { setAsHindi(null); return; }
    let cancelled = false;
    const id = setTimeout(async () => {
      try {
        const r = await api.post<{ hindi: string; converted: boolean }>("/adati/to-devanagari", { text: q });
        if (!cancelled) setAsHindi(r.converted && r.hindi !== q ? r.hindi : null);
      } catch { if (!cancelled) setAsHindi(null); }
    }, 200);
    return () => { cancelled = true; clearTimeout(id); };
  }, [query]);

  const results = useQuery({
    queryKey: ["adati", "search", debounced],
    queryFn: () => api.get<{ rows: SupplierOption[]; total: number; truncated: boolean }>(
      `/adati/search?${new URLSearchParams({ q: debounced, limit: "20" })}`),
    enabled: open && !disabled,
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });

  const matches = results.data?.rows ?? [];
  const total = results.data?.total ?? 0;

  // the picker remembers what was just chosen, so no caller has to
  const [picked, setPicked] = useState<SupplierOption | null>(null);
  const known = !value ? null
    : (picked?.id === value ? picked : null)
      ?? (suppliers as SupplierOption[] | undefined)?.find((s) => s.id === value)
      ?? matches.find((s) => s.id === value)
      ?? (selectedLabel
        ? { id: value, nameHi: selectedLabel.nameHi, nameHinglish: selectedLabel.nameHinglish ?? "", village: null }
        : null);
  // set by the page (a filter, a new supplier just made) with no name to hand: look it up
  const one = useQuery({
    queryKey: ["adati", "one", value],
    queryFn: () => api.get<Adati>(`/adati/${value}`),
    enabled: Boolean(value) && !known,
    staleTime: 60_000,
  });
  const selected = known ?? (value && one.data ? { id: value, nameHi: one.data.nameHi, nameHinglish: one.data.nameHinglish, village: one.data.village } : null);

  // show the Hindi name; that is what the paper says
  const display = selected && !query ? (lang === "hi" ? selected.nameHi : selected.nameHi || selected.nameHinglish) : query;

  useEffect(() => { setActive(0); }, [debounced]);
  useEffect(() => { onQueryChange?.(query); }, [query]);
  // the row came back from the server with a name: the box follows it
  useEffect(() => { if (value) { setQuery(""); sent.current = ""; } }, [value]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const choose = (s: SupplierOption) => {
    setPicked(s);
    onChange(s.id);
    setQuery("");
    setOpen(false);
  };

  /* Leaving the box with a name typed and nobody picked saves that name. The
     text stays on screen: the row is about to come back naming the supplier. */
  const sent = useRef("");
  const touched = useRef(false);
  const commitText = () => {
    const text = query.trim();
    if (!onCommitText || !text || text === sent.current) return false;
    sent.current = text;
    setOpen(false);
    onCommitText(text);
    return true;
  };

  /* A name that is none of the suggestions can always be added as a new
     supplier: the last line of the list says so, and Enter on it saves it.
     Only where the page can take a new name (a sheet line or a create). */
  const typed = query.trim();
  const typedHi = asHindi ?? typed;
  const exact = matches.some((m) => m.nameHi === typedHi || m.nameHinglish.toLowerCase() === typed.toLowerCase());
  const canAddNew = Boolean((onCommitText || onCreate) && typed && !selected && !exact);
  const addNewAt = matches.length; // the line after the suggestions
  const addNew = () => {
    if (onCommitText) { commitText(); return; }
    onCreate?.(typedHi);
    setQuery(""); setOpen(false);
  };

  return (
    <div className="relative">
      <input
        ref={(el) => {
          inputRef.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref) (ref as React.MutableRefObject<HTMLInputElement | null>).current = el;
        }}
        disabled={disabled}
        value={display}
        lang={DEVANAGARI.test(display) ? "hi" : undefined}
        placeholder={placeholder ?? t("daily.searchSupplier")}
        onChange={(e) => {
          // typing always lets go of the supplier that was set, shown or not
          if (value) onChange(null);
          setQuery(e.target.value);
          setOpen(true);
          /* Space finishes a word: "amit trading " becomes "अमित ट्रेडिंग " in
             this same box, one word at a time. The search then runs on the
             Hindi, which is how the master is written. */
          if (!selected) convertFinishedWord(e.target, query, setQuery);
        }}
        autoFocus={autoFocus}
        onFocus={(e) => {
          setOpen(true);
          /* The box opens holding a name — the reading, or the supplier being
             changed. The first look selects it, so typing replaces it and an
             arrow key keeps it for a one-letter correction. */
          if (!touched.current) { touched.current = true; e.target.select(); }
        }}
        onBlur={() => setTimeout(() => {
          setOpen(false);
          if (!value && !commitText()) onBlurEmpty?.();
        }, 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault(); setOpen(true);
            setActive((i) => Math.min(i + 1, canAddNew ? addNewAt : matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault(); setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            if (open && canAddNew && active === addNewAt) {
              e.preventDefault(); e.stopPropagation();
              addNew();
              return;
            }
            if (open && matches[active] && !selected) {
              e.preventDefault(); e.stopPropagation();
              choose(matches[active]);
              return;
            }
            if (!selected && commitText()) { e.preventDefault(); e.stopPropagation(); }
            setOpen(false);
            onCommit?.();
          } else if (e.key === "Tab") {
            setOpen(false); // the typed name stays; the next box gets the focus
            if (!selected) commitText();
          } else if (e.key === "Escape") {
            if (open) { e.stopPropagation(); setOpen(false); }
          } else if (e.key === "Backspace" && selected) {
            onChange(null); setQuery("");
          }
        }}
        className={cn(
          "h-8 w-full rounded-md border bg-surface px-2 text-[13px] text-ink placeholder:text-faint",
          "focus:border-brand disabled:opacity-60",
          DEVANAGARI.test(display) && "text-[14px]",
          invalid && "border-bad",
          className,
        )}
      />

      {open && !disabled && rect && createPortal(
        <div ref={listRef}
          style={{ position: "fixed", left: rect.left, top: rect.top, width: rect.width }}
          className="z-[60] max-h-64 overflow-y-auto rounded-lg border border-line bg-surface shadow-pop">
          {matches.length === 0 ? (
            <div className="px-2.5 py-2">
              <p className="text-[12px] text-faint">
                {results.isFetching ? t("common.loading") : t("daily.noSupplierFound")}
              </p>
              {asHindi && !results.isFetching && (
                <p className="mt-1 flex items-center gap-1.5 text-[11px]">
                  <Languages className="h-3 w-3 shrink-0 text-brand" />
                  <span className="text-faint">{t("hindi.reading")}</span>
                  <span lang="hi" className="text-[14px] text-ink">{asHindi}</span>
                </p>
              )}
              {canAddNew && !results.isFetching && (
                <button type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    // always create in Devanagari, whatever was typed
                    addNew();
                  }}
                  className="mt-1.5 inline-flex items-center gap-1.5 text-[12px] font-medium text-brand hover:underline">
                  <Plus className="h-3 w-3" />
                  {t("daily.createSupplier", { name: asHindi ?? query.trim() })}
                </button>
              )}
            </div>
          ) : (
            <>
              {matches.map((s, i) => (
                <button key={s.id} type="button" data-i={i}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => { e.preventDefault(); choose(s); }}
                  className={cn(
                    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left",
                    i === active ? "bg-brand/12" : "hover:bg-raised",
                  )}>
                  <span className="min-w-0 flex-1">
                    <span lang="hi" className="block truncate text-[14px] text-ink">{s.nameHi}</span>
                    <span className="block truncate text-[11px] text-faint">
                      {s.nameHinglish}{s.village ? ` · ${s.village}` : ""}
                    </span>
                  </span>
                  {s.id === value && <Check className="h-3.5 w-3.5 shrink-0 text-brand" />}
                </button>
              ))}
              {canAddNew && (
                <button type="button" data-i={addNewAt}
                  onMouseEnter={() => setActive(addNewAt)}
                  onMouseDown={(e) => { e.preventDefault(); addNew(); }}
                  className={cn(
                    "flex w-full items-center gap-1.5 border-t border-line px-2.5 py-1.5 text-left text-[12px] font-medium text-brand",
                    active === addNewAt ? "bg-brand/12" : "hover:bg-raised",
                  )}>
                  <Plus className="h-3 w-3 shrink-0" />
                  <span lang="hi" className="min-w-0 truncate">{t("daily.addNewSupplier", { name: typedHi })}</span>
                </button>
              )}
              {results.data?.truncated && (
                <p className="border-t border-line px-2.5 py-1.5 text-[10px] text-faint">
                  {t("adati.showingOf", { n: matches.length, total })} · {t("adati.typeToSearch")}
                </p>
              )}
              {asHindi && (
                <p className="flex items-center gap-1.5 border-t border-line px-2.5 py-1.5 text-[11px]">
                  <Languages className="h-3 w-3 shrink-0 text-brand" />
                  <span className="text-faint">{t("hindi.reading")}</span>
                  <span lang="hi" className="text-[14px] text-ink">{asHindi}</span>
                </p>
              )}
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
});
