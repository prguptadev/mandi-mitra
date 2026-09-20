import { useEffect, useMemo, useRef, useState, forwardRef } from "react";
import { Plus, Check } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { useI18n } from "@/lib/i18n.tsx";
import type { Adati } from "@/lib/api.ts";

/** Same fold the server uses, so typing "barma" or "वरमा" still finds वर्मा. */
const FOLD: Record<string, string> = {
  "ष": "स", "श": "स", "ब": "व", "ड़": "र", "ढ़": "र", "ण": "न", "ङ": "न",
  "ञ": "न", "ट": "त", "ठ": "थ", "ड": "द", "ढ": "ध", "ळ": "ल",
};
const MATRA = /[ा-्ंँः़]/g;

function key(s: string) {
  return Array.from((s || "").normalize("NFC").replace(MATRA, ""))
    .map((c) => FOLD[c] ?? c).join("")
    .toLowerCase().replace(/[^ऀ-ॿa-z0-9]/g, "");
}

export interface SupplierPickerHandle { focus: () => void }

/**
 * Keyboard-first combobox. Down/Up move, Enter accepts the highlighted row and
 * lets the parent advance to the next field, Escape closes without choosing.
 */
export const SupplierPicker = forwardRef<HTMLInputElement, {
  suppliers: Adati[];
  value: string | null;
  onChange: (adatiId: string | null) => void;
  onCommit?: () => void;
  onCreate?: (name: string) => void;
  invalid?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}>(function SupplierPicker(
  { suppliers, value, onChange, onCommit, onCreate, invalid, disabled, placeholder, className }, ref,
) {
  const { t, lang } = useI18n();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = suppliers.find((s) => s.id === value) ?? null;
  const display = selected ? (lang === "hi" ? selected.nameHi : selected.nameHinglish) : query;

  const indexed = useMemo(
    () => suppliers.map((s) => ({ s, k: key(s.nameHi) + "|" + key(s.nameHinglish) })),
    [suppliers],
  );

  const matches = useMemo(() => {
    const q = key(query);
    if (!q) return suppliers.slice(0, 40);
    const starts: Adati[] = [];
    const contains: Adati[] = [];
    for (const { s, k } of indexed) {
      const parts = k.split("|");
      if (parts.some((p) => p.startsWith(q))) starts.push(s);
      else if (k.includes(q)) contains.push(s);
    }
    return [...starts, ...contains].slice(0, 40);
  }, [query, indexed, suppliers]);

  useEffect(() => { setActive(0); }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const choose = (s: Adati) => {
    onChange(s.id);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className="relative">
      <input
        ref={ref}
        disabled={disabled}
        value={display}
        placeholder={placeholder ?? t("daily.searchSupplier")}
        onChange={(e) => {
          if (selected) onChange(null);
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault(); setOpen(true);
            setActive((i) => Math.min(i + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            if (open && matches[active] && !selected) {
              e.preventDefault();
              e.stopPropagation();
              choose(matches[active]);
              return;
            }
            setOpen(false);
            onCommit?.();
          } else if (e.key === "Escape") {
            if (open) { e.stopPropagation(); setOpen(false); }
          } else if (e.key === "Backspace" && selected) {
            onChange(null);
            setQuery("");
          }
        }}
        className={cn(
          "h-8 w-full rounded-md border bg-surface px-2 text-[13px] text-ink placeholder:text-faint",
          "focus:border-brand disabled:opacity-60",
          lang === "hi" && "text-[14px]",
          invalid && "border-bad",
          className,
        )}
      />

      {open && !disabled && (
        <div
          ref={listRef}
          className="absolute left-0 top-full z-40 mt-1 max-h-64 w-[320px] overflow-y-auto rounded-lg border border-line bg-surface shadow-pop"
        >
          {matches.length === 0 ? (
            <div className="px-2.5 py-2">
              <p className="text-[12px] text-faint">{t("daily.noSupplierFound")}</p>
              {onCreate && query.trim() && (
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); onCreate(query.trim()); setQuery(""); setOpen(false); }}
                  className="mt-1.5 inline-flex items-center gap-1.5 text-[12px] font-medium text-brand hover:underline"
                >
                  <Plus className="h-3 w-3" />
                  {t("daily.createSupplier", { name: query.trim() })}
                </button>
              )}
            </div>
          ) : (
            matches.map((s, i) => (
              <button
                key={s.id} type="button" data-i={i}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); choose(s); }}
                className={cn(
                  "flex w-full items-center gap-2 px-2.5 py-1.5 text-left",
                  i === active ? "bg-brand/12" : "hover:bg-raised",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span lang="hi" className="block truncate text-[13px] text-ink">{s.nameHi}</span>
                  <span className="block truncate text-[11px] text-faint">
                    {s.nameHinglish}{s.village ? ` · ${s.village}` : ""}
                  </span>
                </span>
                {s.id === value && <Check className="h-3.5 w-3.5 shrink-0 text-brand" />}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
});
