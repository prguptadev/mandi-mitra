import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { Loader2, X, Check } from "lucide-react";

/* ------------------------------------------------------------------ Button */

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type Size = "sm" | "md" | "lg" | "icon";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand text-brand-ink hover:brightness-110 active:brightness-95 shadow-sm",
  secondary: "bg-surface text-ink border border-line hover:bg-raised",
  ghost: "text-muted hover:bg-raised hover:text-ink",
  danger: "bg-bad text-white hover:brightness-110",
  subtle: "bg-raised text-ink hover:bg-line/60",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-2.5 text-[13px] gap-1.5 rounded-lg",
  md: "h-9.5 px-3.5 text-sm gap-2 rounded-lg",
  lg: "h-11 px-5 text-[15px] gap-2 rounded-xl",
  icon: "h-9 w-9 rounded-lg justify-center",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "secondary", size = "md", loading, icon, children, disabled, ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center font-medium transition-all select-none",
        "disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap",
        VARIANTS[variant], SIZES[size], className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin shrink-0" /> : icon}
      {children}
    </button>
  );
});

/* ------------------------------------------------------------------- Field */

export function Field({
  label, hint, error, required, children, className, htmlFor, suffix,
}: {
  label?: string; hint?: string; error?: string; required?: boolean;
  children: ReactNode; className?: string; htmlFor?: string; suffix?: ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      {label && (
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor={htmlFor} className="block text-[13px] font-medium text-ink">
            {label}
            {required && <span className="text-bad ml-0.5">*</span>}
          </label>
          {suffix}
        </div>
      )}
      {children}
      {error
        ? <p className="text-xs text-bad leading-snug">{error}</p>
        : hint ? <p className="text-xs text-faint leading-snug">{hint}</p> : null}
    </div>
  );
}

const CONTROL = "w-full rounded-lg border bg-surface px-3 text-sm text-ink placeholder:text-faint transition-colors hover:border-faint/60 focus:border-brand disabled:opacity-60 disabled:bg-raised";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; mono?: boolean }>(
  function Input({ className, invalid, mono, ...rest }, ref) {
    return <input ref={ref} className={cn(CONTROL, "h-9.5", mono && "num", invalid && "border-bad", className)} {...rest} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  function Textarea({ className, invalid, ...rest }, ref) {
    return <textarea ref={ref} className={cn(CONTROL, "py-2 min-h-[72px] resize-y", invalid && "border-bad", className)} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(
  function Select({ className, invalid, children, ...rest }, ref) {
    return (
      <select ref={ref} className={cn(CONTROL, "h-9.5 pr-8 appearance-none cursor-pointer", invalid && "border-bad", className)}
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23888' stroke-width='1.5'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E")`,
          backgroundRepeat: "no-repeat", backgroundPosition: "right 0.6rem center", backgroundSize: "1rem",
        }}
        {...rest}
      >
        {children}
      </select>
    );
  },
);

/* --------------------------------------------------------------- Switch */

export function Switch({
  checked, onChange, label, hint, disabled, id,
}: {
  checked: boolean; onChange: (v: boolean) => void;
  label?: ReactNode; hint?: string; disabled?: boolean; id?: string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <button
        type="button" role="switch" aria-checked={checked} id={id} disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          // text-left matters: a <button> centres its content, which would move
          // the knob's static origin to the middle of the track and stack with
          // the transform. left-0.5 pins it instead of relying on that origin.
          "relative h-5 w-9 shrink-0 rounded-full transition-colors mt-0.5 text-left",
          "disabled:opacity-50 disabled:pointer-events-none",
          checked ? "bg-brand" : "bg-line",
        )}
      >
        <span className={cn(
          "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
          checked ? "translate-x-4" : "translate-x-0",
        )} />
      </button>
      {(label || hint) && (
        <div className="min-w-0">
          {label && <label htmlFor={id} className="block text-[13px] font-medium text-ink cursor-pointer">{label}</label>}
          {hint && <p className="text-xs text-faint leading-snug mt-0.5">{hint}</p>}
        </div>
      )}
    </div>
  );
}

export function Checkbox({
  checked, onChange, label, disabled, indeterminate,
}: {
  checked: boolean; onChange: (v: boolean) => void;
  label?: ReactNode; disabled?: boolean; indeterminate?: boolean;
}) {
  return (
    <label className={cn("inline-flex items-center gap-2 cursor-pointer select-none", disabled && "opacity-50 pointer-events-none")}>
      <button
        type="button" role="checkbox" aria-checked={indeterminate ? "mixed" : checked} disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "h-4 w-4 shrink-0 rounded border flex items-center justify-center transition-colors",
          checked || indeterminate ? "bg-brand border-brand text-brand-ink" : "bg-surface border-line hover:border-faint",
        )}
      >
        {indeterminate
          ? <span className="h-0.5 w-2 bg-current rounded-full" />
          : checked ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
      </button>
      {label && <span className="text-[13px] text-ink">{label}</span>}
    </label>
  );
}

/* ---------------------------------------------------------------- Surfaces */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-xl border border-line bg-surface shadow-card", className)}>{children}</div>;
}

export function CardHeader({ title, sub, action, className }: { title: ReactNode; sub?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start justify-between gap-4 px-4 py-3.5 border-b border-line", className)}>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-ink leading-tight">{title}</h3>
        {sub && <p className="text-xs text-muted mt-1 leading-snug">{sub}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

type Tone = "neutral" | "ok" | "warn" | "bad" | "brand";
const TONES: Record<Tone, string> = {
  neutral: "bg-raised text-muted border-line",
  ok: "bg-ok-soft text-ok border-ok/25",
  warn: "bg-warn-soft text-warn border-warn/25",
  bad: "bg-bad-soft text-bad border-bad/25",
  brand: "bg-brand/10 text-brand border-brand/25",
};

export function Badge({ tone = "neutral", className, children, title }: { tone?: Tone; className?: string; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cn(
      "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-tight whitespace-nowrap",
      TONES[tone], className,
    )}>
      {children}
    </span>
  );
}

/* A closed message stays closed until its words change. A warning or note
   stays closed until the app is closed (it would only say the same again); an
   error or a "saved" closes for this time only, so a repeat still shows. */
const closedKey = (tone: Tone, text: string) => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `mm.alertClosed.${tone}.${h.toString(36)}.${text.length}`;
};
const remembered = (tone: Tone) => tone === "warn" || tone === "neutral" || tone === "brand";
function wasClosed(key: string) {
  try { return sessionStorage.getItem(key) === "1"; } catch { return false; }
}

export function Alert({ tone = "warn", title, children, className, closable = true }: {
  tone?: Tone; title?: ReactNode; children?: ReactNode; className?: string;
  /** Every message can be closed with ×; false only where closing would hide the very thing being asked. */
  closable?: boolean;
}) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const key = useRef<string | null>(null);
  const [closed, setClosed] = useState(false);
  // after each render, before it is painted: new words show again, words closed before stay closed
  useLayoutEffect(() => {
    if (!closable) return;
    const k = closedKey(tone, box.current?.textContent ?? "");
    if (k === key.current) return;
    key.current = k;
    setClosed(remembered(tone) && wasClosed(k));
  });
  const close = () => {
    setClosed(true);
    if (key.current && remembered(tone)) { try { sessionStorage.setItem(key.current, "1"); } catch { /* private window: closed for now only */ } }
  };
  return (
    // kept in the page while closed, so changed words can bring it back
    <div ref={box} hidden={closed} style={closed ? { display: "none" } : undefined} className={cn("rounded-lg border px-3 py-2.5 text-[13px] leading-snug", closable && "relative pr-8", TONES[tone], className)}>
      {title && <p className="font-semibold mb-0.5">{title}</p>}
      {children}
      {closable && (
        <button type="button" onClick={close} title={t("common.close")} aria-label={t("common.close")}
          className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-md opacity-60 transition hover:bg-surface/60 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

export function EmptyState({ icon, title, sub, action }: { icon?: ReactNode; title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-3 text-faint">{icon}</div>}
      <p className="text-sm font-semibold text-ink">{title}</p>
      {sub && <p className="text-[13px] text-muted mt-1.5 max-w-sm leading-relaxed">{sub}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ Dialog */

/** Boxes open now, oldest first: a box opened over another answers Escape alone. */
const openDialogs: number[] = [];
let dialogSeq = 0;

export function Dialog({
  open, onClose, title, sub, children, footer, wide,
}: {
  open: boolean; onClose: () => void; title: ReactNode; sub?: ReactNode;
  children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  // Escape closes the top box only, as its × does (a picker open inside keeps its own Escape)
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const id = ++dialogSeq;
    openDialogs.push(id);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && openDialogs[openDialogs.length - 1] === id) closeRef.current(); };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); openDialogs.splice(openDialogs.indexOf(id), 1); };
  }, [open]);
  if (!open) return null;
  /* Drawn at the page's top level: inside a bar with a blur or transform, a
     "fixed" box is trapped in that bar instead of covering the screen. */
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-6">
      <div className="fixed inset-0 bg-black/45" onClick={onClose} />
      <div
        role="dialog" aria-modal="true"
        className={cn(
          "relative z-10 my-auto w-full rounded-2xl border border-line bg-surface shadow-pop animate-fade-up",
          wide ? "max-w-3xl" : "max-w-lg",
        )}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 border-b border-line">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-ink leading-tight">{title}</h2>
            {sub && <p className="text-xs text-muted mt-1 leading-snug">{sub}</p>}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close" className="-mr-1 -mt-0.5">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-line bg-raised/40 rounded-b-2xl">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------- Table */

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={cn("w-full text-sm border-collapse", className)}>{children}</table>
    </div>
  );
}

export function Th({ children, className, align = "left", numeric, sortDir, onSort, title }: {
  children?: ReactNode; className?: string; align?: "left" | "right" | "center"; numeric?: boolean;
  /** Set with onSort to make the heading sort the table (see lib/useSort). */
  sortDir?: "asc" | "desc" | null; onSort?: () => void; title?: string;
}) {
  const right = align === "right" || numeric;
  return (
    // a plain fill, no see-through blur: rows scroll under a stuck heading, and a blur is
    // worked out again on every frame of the scroll — slow on a shop computer's graphics
    <th
      onClick={onSort}
      title={title}
      aria-sort={sortDir === "asc" ? "ascending" : sortDir === "desc" ? "descending" : undefined}
      className={cn(
        "sticky top-0 z-10 bg-raised px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted border-b border-line whitespace-nowrap",
        right ? "text-right" : align === "center" ? "text-center" : "text-left",
        onSort && "group cursor-pointer select-none hover:text-ink",
        sortDir && "text-ink",
        className,
      )}>
      <span className={cn("inline-flex items-center gap-1", right && "flex-row-reverse")}>
        <span>{children}</span>
        {onSort && (
          <span className={cn("text-[10px] leading-none", sortDir ? "text-brand" : "text-faint opacity-0 group-hover:opacity-100")}>
            {sortDir === "asc" ? "▲" : sortDir === "desc" ? "▼" : "↕"}
          </span>
        )}
      </span>
    </th>
  );
}

export function Td({ children, className, align = "left", numeric, colSpan, title }: {
  children?: ReactNode; className?: string; align?: "left" | "right" | "center"; numeric?: boolean; colSpan?: number; title?: string;
}) {
  return (
    <td colSpan={colSpan} title={title} className={cn(
      "px-3 py-2 border-b border-line/70 align-middle",
      numeric && "num tabular-nums",
      align === "right" || numeric ? "text-right" : align === "center" ? "text-center" : "text-left",
      className,
    )}>
      {children}
    </td>
  );
}

export function Tr({ children, className, onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  return (
    <tr onClick={onClick} className={cn("transition-colors", onClick && "cursor-pointer hover:bg-raised/60", className)}>
      {children}
    </tr>
  );
}

/* -------------------------------------------------------------------- Tabs */

export function Tabs<T extends string>({
  value, onChange, tabs, className,
}: {
  value: T; onChange: (v: T) => void;
  tabs: { value: T; label: ReactNode; count?: number }[];
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-1 border-b border-line", className)}>
      {tabs.map((tb) => (
        <button
          key={tb.value} type="button" onClick={() => onChange(tb.value)}
          className={cn(
            "relative px-3 py-2 text-[13px] font-medium transition-colors -mb-px border-b-2",
            value === tb.value
              ? "text-brand border-brand"
              : "text-muted border-transparent hover:text-ink",
          )}
        >
          {tb.label}
          {tb.count !== undefined && (
            <span className="ml-1.5 num text-[11px] text-faint">{tb.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-4 w-4 animate-spin text-faint", className)} />;
}
