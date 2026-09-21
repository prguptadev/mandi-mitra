import { forwardRef, useState, type InputHTMLAttributes } from "react";
import { parseLooseNumber } from "@/lib/format.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * A number field you can actually edit.
 *
 * The obvious way — `value={n.toFixed(2)}` with `onChange={parse}` — rewrites
 * the text on every keystroke. Delete a digit from "19.20" and it becomes
 * "19.2", which parses back to 19.2 and is redrawn as "19.20": the deletion
 * is undone, the cursor jumps, and only the last digit can ever change. With
 * `Number(x) || 0` it is worse — typing "1." becomes "1", so 1.5 can never be
 * entered, and clearing the box puts a 0 back.
 *
 * So: while the field has focus it shows exactly what was typed; the parsed
 * value still goes to the parent on every keystroke, so totals update live;
 * and the text is tidied to `decimals` only when the field is left.
 */
/** Half-up to `d` places without binary drift (1.005 → 1.01, not 1.00). */
function roundTo(n: number, d: number): number {
  const sign = n < 0 ? -1 : 1;
  return sign * Number(`${Math.round(Number(`${Math.abs(n)}e${d}`))}e-${d}`);
}

export const NumberInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: number | null | undefined;
  onValueChange: (n: number | null) => void;
  /** Digits after the point when not being edited. Omit to show as-is. */
  decimals?: number;
  /** Integers only: the decimal point is not accepted. */
  integer?: boolean;
  allowNegative?: boolean;
  /** What an emptied field means. Defaults to null. */
  emptyValue?: number | null;
}>(function NumberInput(
  { value, onValueChange, decimals, integer, allowNegative, emptyValue = null, className, onFocus, onBlur, ...rest }, ref,
) {
  const [text, setText] = useState<string | null>(null);

  const format = (n: number | null | undefined) =>
    n === null || n === undefined || Number.isNaN(n) ? ""
    : decimals !== undefined ? n.toFixed(decimals)
    : String(n);

  const shown = text ?? format(value);

  return (
    <input
      ref={ref}
      {...rest}
      inputMode={integer ? "numeric" : "decimal"}
      value={shown}
      onFocus={(e) => {
        /* Leave the cursor where the click put it. Selecting everything on
           focus overrides that one frame later, so a click between two digits
           would select the whole number — the opposite of editing one digit. */
        setText(format(value));
        onFocus?.(e);
      }}
      onChange={(e) => {
        let raw = e.target.value;
        // keep what a person can legitimately be halfway through typing
        raw = raw.replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d)));
        raw = raw.replace(integer ? /[^\d,-]/g : /[^\d.,-]/g, "");
        if (!allowNegative) raw = raw.replace(/-/g, "");
        else raw = raw.replace(/(?!^)-/g, "");
        // commas are thousands separators here (50,000 / 1,08,190.36), never a decimal point
        raw = raw.replace(/,/g, "");
        if (!integer) {
          const i = raw.indexOf(".");
          if (i !== -1) raw = raw.slice(0, i + 1) + raw.slice(i + 1).replace(/\./g, "");
        }
        setText(raw);
        const n = raw.trim() === "" || raw === "." || raw === "-" ? emptyValue : parseLooseNumber(raw);
        onValueChange(n === null ? emptyValue : integer && n !== null ? Math.trunc(n) : n);
      }}
      onBlur={(e) => {
        // what is stored is what is shown: 100.005 becomes 100.01 in both
        if (decimals !== undefined && text !== null && value != null && Number.isFinite(value)) {
          const rounded = roundTo(value, decimals);
          if (rounded !== value) onValueChange(rounded);
        }
        setText(null);
        onBlur?.(e);
      }}
      className={cn("num", className)}
    />
  );
});
