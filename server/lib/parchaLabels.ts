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

/**
 * Whether the paper prints the dara amount. Every amount inside the grand
 * total is printed, so a dara added to it shows even where the mill's layout
 * hides the dara row; a dara kept out of the total shows only where the layout asks.
 */
export function paperShowsDara(
  r: { daraPaise: number },
  cfg: { dara: { mode: string; includeInGrandTotal?: boolean }; parcha: { showDaraRow?: boolean } },
): boolean {
  return r.daraPaise !== 0 && (Boolean(cfg.dara.includeInGrandTotal) || (Boolean(cfg.parcha.showDaraRow) && cfg.dara.mode !== "none"));
}

/** One line of a parcha as the screen lists it (the shape of charges.ts ParchaLine). */
export interface ScreenLine {
  key: string; label: string; labelHi?: string; detail?: string;
  rate?: number; per?: "pct" | "bag" | "qtl" | "truck";
  amountPaise: number; kind: "goods" | "charge" | "subtotal" | "total" | "info" | "adjust"; sign?: "add" | "subtract";
}

/**
 * The parcha's lines as the truck screen lists them (goods aside), with what
 * the paper also prints so the column re-adds to the grand total: a dara
 * inside the total that the mill's layout hides, and the round-off.
 */
export function screenLines(
  r: { lines: ScreenLine[]; totalPaise?: number; advancePaise: number; daraPaise: number; grandTotalPaise: number },
  cfg: { advance: { treatment: string }; dara: { mode: string; label: string; labelHi?: string; includeInGrandTotal?: boolean }; parcha: { showDaraRow?: boolean } },
  roundOffLabel: string,
): ScreenLine[] {
  const out = r.lines.filter((x) => x.kind !== "goods");
  if (cfg.dara.includeInGrandTotal && paperShowsDara(r, cfg) && !out.some((x) => x.key === "dara")) {
    out.splice(out.findIndex((x) => x.key === "total") + 1, 0,
      { key: "dara", label: cfg.dara.label, labelHi: cfg.dara.labelHi, amountPaise: r.daraPaise, kind: "charge", sign: "add" });
  }
  const ro = roundOffPaise(r, cfg);
  if (ro) {
    const at = out.findIndex((x) => x.key === "grand");
    out.splice(at < 0 ? out.length : at, 0, { key: "roundOff", label: roundOffLabel, amountPaise: Math.abs(ro), kind: "charge", sign: ro < 0 ? "subtract" : "add" });
  }
  return out;
}

/**
 * What the truck screen prints beside the goods value. One row is net × its
 * rate, exactly. Several rows are each worked at their own day's rate and
 * added, so their rate is an average that net × average need not come back
 * to: it is shown as an average, never as a sum to multiply.
 */
export const goodsAt = (doc: { lines: unknown[]; totals: { netGrams: number; ratePaisePerQtl: number } }) =>
  ({ netGrams: doc.totals.netGrams, ratePaisePerQtl: doc.totals.ratePaisePerQtl, average: doc.lines.length > 1 });

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

/**
 * "196 (2026-27)": a parcha number with its financial year (1 April – 31
 * March). Numbers belong to one live parcha a year, so this is how a number
 * is claimed across computers.
 */
export const fyNumberLabel = (iso: string, no: string) => {
  const y = Number(iso.slice(0, 4)) - (Number(iso.slice(5, 7)) >= 4 ? 0 : 1);
  return `${no.trim()} (${y}-${String((y + 1) % 100).padStart(2, "0")})`;
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

/**
 * Today's date in India, as YYYY-MM-DD, whatever zone the computer's clock is
 * set to: the books are kept in Indian days, so "today" on the server (a day
 * that may be closed, a call due today, a parcha revised today) is India's.
 * India has kept +05:30 all year round since 1945, so it is the instant moved
 * on five and a half hours.
 */
export const officeToday = (now: Date = new Date()) => new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);

/**
 * A day before or after, as a YYYY-MM-DD date.
 *
 * The date is read and written in the office's own time, never through UTC.
 * `new Date("2026-09-25T00:00:00").toISOString()` is 2026-09-24 in India —
 * which once made "yesterday" jump two days and "tomorrow" do nothing at all.
 */
export const shiftDay = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
};
