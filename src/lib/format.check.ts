/* Run: npx tsx src/lib/format.check.ts */
import { DEFAULT_DISPLAY, wordAmount, parseRupeesToPaise, parseQtlToGrams, parseLooseNumber, type DisplayConfig } from "./format.tsx";

function groupIndian(i: string) {
  if (i.length <= 3) return i;
  return i.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + i.slice(-3);
}
function fmt(paise: number, cfg: DisplayConfig) {
  const fixed = Math.abs(paise / 100).toFixed(cfg.moneyDecimals);
  const [int, frac] = fixed.split(".");
  const g = cfg.numberFormat === "indian" ? groupIndian(int)
    : cfg.numberFormat === "international" ? int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : int;
  const body = frac ? `${g}.${frac}` : g;
  const sym = cfg.showCurrencySymbol ? cfg.currencySymbol : "";
  const out = sym + body;
  return paise < 0 ? (cfg.negativeStyle === "brackets" ? `(${out})` : `-${out}`) : out;
}

let fail = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label.padEnd(34)} ${JSON.stringify(got)}${ok ? "" : "  want " + JSON.stringify(want)}`);
};

console.log("Indian grouping (default)");
const d = DEFAULT_DISPLAY;
eq("grand total from the parcha", fmt(112785122, d), "₹11,27,851.22");
eq("goods value", fmt(106069545, d), "₹10,60,695.45");
eq("adat", fmt(2121391, d), "₹21,213.91");
eq("gate pass", fmt(10000, d), "₹100.00");
eq("one lakh", fmt(10000000, d), "₹1,00,000.00");
eq("one thousand", fmt(100000, d), "₹1,000.00");
eq("one crore", fmt(1000000000, d), "₹1,00,00,000.00");
eq("negative", fmt(-2121391, d), "-₹21,213.91");

console.log("\nSymbol off, no grouping, 0 decimals");
const plain: DisplayConfig = { ...d, showCurrencySymbol: false, numberFormat: "plain", moneyDecimals: 0 };
eq("plain", fmt(112785122, plain), "1127851");

console.log("\nInternational grouping");
eq("international", fmt(112785122, { ...d, numberFormat: "international" }), "₹1,127,851.22");

console.log("\nBrackets for negative, Rs. symbol");
eq("brackets", fmt(-2121391, { ...d, negativeStyle: "brackets", currencySymbol: "Rs." }), "(Rs.21,213.91)");

console.log("\nWord amounts");
eq("11.28 lakh", wordAmount(112785122, d), "11.28 lakh");
eq("1.00 crore", wordAmount(1000000000, d), "1.00 crore");
eq("21.21 thousand", wordAmount(2121391, d), "21.21 thousand");
eq("under 1000 -> none", wordAmount(10000, d), null);
eq("disabled -> none", wordAmount(112785122, { ...d, showWordAmount: false }), null);

console.log("\nParsing what an operator types");
eq("grouped rupees", parseRupeesToPaise("11,27,851.22"), 112785122);
eq("with symbol", parseRupeesToPaise("₹ 3413.45"), 341345);
eq("bare", parseRupeesToPaise("3413.45"), 341345);
eq("devanagari digits", parseLooseNumber("३४१३"), 3413);
eq("quintal to grams", parseQtlToGrams("315.30"), 31530000);
eq("net quintal", parseQtlToGrams("310.74"), 31074000);
eq("empty", parseLooseNumber(""), null);
eq("junk", parseLooseNumber("abc"), null);
eq("lone dot", parseLooseNumber("."), null);
eq("trailing dot is fine mid-typing", parseLooseNumber("19."), 19);

console.log(fail === 0 ? "\nAll format checks passed." : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
