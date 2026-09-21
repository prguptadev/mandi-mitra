/* The wording and number style of the printed kaccha parcha, shared by the
   print view (browser) and the Excel file (server) so both read like the
   paper: "LABOUR @ Rs 9.50/- PER BAG", "MANDI TAX @ 1.5 %", 10,60,695.45.
   No imports: this file is loaded on both sides. */

export interface LabelledLine {
  key: string;
  label: string;
  rate?: number;
  per?: "pct" | "bag" | "qtl" | "truck";
}

const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ""));

export function printedLabel(l: LabelledLine): string {
  const name = l.label.toUpperCase();
  if (l.rate == null || !l.per) return name;
  if (l.per === "pct") return `${name} @ ${num(l.rate)}%`;
  const unit = l.per === "bag" ? "PER BAG" : l.per === "qtl" ? "PER QUINTAL" : "PER TRUCK";
  const rs = l.per === "bag" && !Number.isInteger(l.rate) ? l.rate.toFixed(2) : num(l.rate);
  return `${name} @ Rs ${rs}/- ${unit}`;
}

/** 1060695.45 -> "10,60,695.45": Indian grouping, always two decimals. */
export function indianMoney(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100).toString();
  const p = String(abs % 100).padStart(2, "0");
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${rest ? rest + "," : ""}${last3}.${p}`;
}

/** grams -> "310.74" quintals. */
export const qtl2 = (grams: number) => {
  // whole kg, half up, in integers; then "310.74"
  const kg = Math.round(Math.abs(grams) / 1000);
  return `${grams < 0 ? "-" : ""}${Math.floor(kg / 100)}.${String(kg % 100).padStart(2, "0")}`;
};

/** "2026-09-20" -> "20-09-2026", as the parcha writes it. */
export const dmy = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}-${m}-${y}` : iso;
};

/** "VIJAY LAXMI DAL MILL - ETAH (U.P)" */
export function partyHeading(p: { name: string; city: string | null; state: string | null }): string {
  const st = p.state && /uttar\s*pradesh/i.test(p.state) ? "(U.P)" : "";
  const city = p.city ? ` - ${p.city}` : "";
  return `${p.name}${city}${st && p.city ? " " + st : ""}`.toUpperCase();
}
