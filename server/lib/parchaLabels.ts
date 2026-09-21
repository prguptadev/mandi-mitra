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

/** Up to three decimals, no trailing zeros: 1.5, 0.125 (never rounded to 0.13). */
const num = (n: number) => String(Number(n.toFixed(3)));

export function printedLabel(l: LabelledLine): string {
  const name = l.label.toUpperCase();
  if (l.rate == null || !l.per) return name;
  if (l.per === "pct") return `${name} @ ${num(l.rate)}%`;
  const unit = l.per === "bag" ? "PER BAG" : l.per === "qtl" ? "PER QUINTAL" : "PER TRUCK";
  // "9.50" per bag, as the paper writes paise; a finer rate keeps its digits
  const rs = l.per === "bag" && !Number.isInteger(l.rate) && Number.isInteger(Math.round(l.rate * 1000) / 10) ? l.rate.toFixed(2) : num(l.rate);
  return `${name} @ Rs ${rs}/- ${unit}`;
}

/**
 * What the grand-total rounding added (+) or took (−), in paise, so the paper
 * adds up line by line: total ± advance (+ dara when it is in the total) + this.
 */
export function roundOffPaise(
  r: { totalPaise?: number; advancePaise: number; daraPaise: number; grandTotalPaise: number },
  cfg: { advance: { treatment: string }; dara: { includeInGrandTotal?: boolean } },
): number {
  if (r.totalPaise == null) return 0;
  const adv = cfg.advance.treatment === "add" ? r.advancePaise : cfg.advance.treatment === "subtract" ? -r.advancePaise : 0;
  return r.grandTotalPaise - (r.totalPaise + adv + (cfg.dara.includeInGrandTotal ? r.daraPaise : 0));
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
