import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { convertFinishedWord, hasLatin } from "@/lib/hindiTyping.ts";
import { Languages, Check } from "lucide-react";
import { api } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { cn } from "@/lib/utils.ts";

const DEVANAGARI = /[ऀ-ॿ]/;

/**
 * Type in Hinglish, get Hindi. The operator has an ordinary keyboard, so
 * "phoolsingh verma" becomes फूलसिंह वर्मा as they type. Conversion is
 * suggested, never forced: Enter or Tab accepts it, Escape keeps the Latin.
 *
 * The business's own supplier spellings are consulted first, so a name is
 * written the way that office already writes it rather than however a
 * phonetic engine would guess.
 */
export const HindiInput = forwardRef<HTMLInputElement, {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Convert as soon as the field loses focus, without waiting for Enter. */
  convertOnBlur?: boolean;
  /** Set on screens with no session yet (signup), where the master is unreachable. */
  publicOnly?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}>(function HindiInput(
  { value, onChange, placeholder, className, disabled, autoFocus, convertOnBlur = true, publicOnly, onKeyDown }, ref,
) {
  const { t } = useI18n();
  const inner = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inner.current as HTMLInputElement);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissed = useRef<string | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    // a suggestion belongs to the text it was made for: "राम" must not replace "ramesh"
    setSuggestion(null);
    if (!hasLatin(value) || dismissed.current === value) return;
    let stale = false;
    timer.current = setTimeout(async () => {
      setBusy(true);
      try {
        // the business's own spellings first; the public converter is the
        // fallback for signup, where there is no master to consult yet
        const path = publicOnly ? "/auth/to-devanagari" : "/adati/to-devanagari";
        let r: { hindi: string; converted: boolean };
        try {
          r = await api.post(path, { text: value });
        } catch {
          r = await api.post("/auth/to-devanagari", { text: value });
        }
        if (!stale) setSuggestion(r.converted && r.hindi && r.hindi !== value ? r.hindi : null);
      } catch {
        if (!stale) setSuggestion(null);
      } finally {
        if (!stale) setBusy(false);
      }
    }, 220);
    return () => { stale = true; setBusy(false); if (timer.current) clearTimeout(timer.current); };
  }, [value]);

  const accept = () => {
    if (!suggestion) return false;
    onChange(suggestion);
    setSuggestion(null);
    return true;
  };

  return (
    <div className="relative">
      <input
        ref={inner}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        lang={DEVANAGARI.test(value) ? "hi" : undefined}
        onChange={(e) => {
          dismissed.current = null;
          onChange(e.target.value);
          // space after a Hinglish word turns that word into Hindi, in place
          convertFinishedWord(e.target, value, (text) => { setSuggestion(null); onChange(text); }, publicOnly);
        }}
        onBlur={() => { if (convertOnBlur) accept(); }}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === "Tab") && suggestion) {
            if (accept()) {
              if (e.key === "Enter") { e.preventDefault(); return; }
            }
          } else if (e.key === "Escape" && suggestion) {
            e.stopPropagation();
            dismissed.current = value;
            setSuggestion(null);
            return;
          }
          onKeyDown?.(e);
        }}
        className={cn(
          "h-9.5 w-full rounded-lg border bg-surface px-3 text-sm text-ink placeholder:text-faint",
          "transition-colors hover:border-faint/60 focus:border-brand disabled:opacity-60",
          suggestion && "pr-9",
          className,
        )}
      />

      {suggestion && (
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); accept(); }}
          title={t("hindi.accept")}
          className="absolute right-1.5 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-brand hover:bg-brand/10"
        >
          <Check className="h-4 w-4" />
        </button>
      )}

      {suggestion && (
        <div className="absolute left-0 top-full z-40 mt-1 flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 shadow-pop">
          <Languages className="h-3.5 w-3.5 shrink-0 text-brand" />
          <span lang="hi" className="text-[15px] text-ink">{suggestion}</span>
          <span className="text-[10px] text-faint">{t("hindi.hint")}</span>
        </div>
      )}
      {busy && !suggestion && (
        <Languages className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-pulse text-faint" />
      )}
    </div>
  );
});
