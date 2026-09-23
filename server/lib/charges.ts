import { z } from "zod";
import { amountPaise, pctPaise, perUnitPaise, divHalfUp, GRAMS_PER_QTL } from "./money.ts";

/** Bags × kg a bag, rounded half up to a whole kg: the parcha prints weight to 0.01 qtl (1 kg). */
export function bardanaKg(bags: number, kgPerBag: number): number {
  return Number(divHalfUp(BigInt(bags) * BigInt(Math.round(kgPerBag * 1000)), 1000n)) * 1000;
}

/* Every number on the kaccha parcha is driven from here. Nothing is hardcoded,
   because the terms differ per mill — including WHICH BASE a percentage applies
   to, which is the part that silently costs money if you get it wrong. */

export const PctBase = z.enum(["amount", "amount_plus_adat", "total_before_charge"]);
export const WeightBase = z.enum(["gross", "net"]);
/** Which bags a per-bag charge is counted on. Katte are plastic (PP) bags,
 *  bore are jute sacks; the parcha keeps separate columns for each. */
export const BagKind = z.enum(["all", "katte", "bore"]);

  /**
   * Katauti on the purchase side. Verified against 45 rows of the 20-09-2026
   * sheets: the KATAUTI column is the gross weight rounded to the nearest
   * whole quintal, and 1 kg is deducted per unit — i.e. 1 kg per quintal.
   * It is NOT the bag count; the parcha's 800 katte is a different quantity.
   */
export const KatautiSchema = z.object({
  mode: z.enum(["per_quintal_rounded", "per_quintal_exact", "per_bag", "none"])
    .default("per_quintal_rounded"),
  kgPerUnit: z.number().finite().min(0).max(5).default(1),
  /**
   * half_up is what your munshi uses: it matched 45/45 rows, and every exact
   * .50 case rounds up (32.50 -> 33, 28.50 -> 29, 17.50 -> 18). A bigger
   * katauti is a bigger deduction, so rounding up favours the owner.
   */
  rounding: z.enum(["half_up", "up", "down", "half_even"]).default("half_up"),
}).default({});

export const ChargeConfigSchema = z.object({
  katauti: KatautiSchema,
  /** Bardana weight per katta (plastic bag) as the destination mill counts it:
   *  4.56 qtl over 800 katte on invoice 196. */
  millBardanaKgPerBag: z.number().finite().min(0).max(5).default(0.57),
  /** Bardana per bora (jute sack). Not on any paper seen yet — an assumption. */
  millBoreBardanaKgPerBag: z.number().finite().min(0).max(5).default(1),

  adat: z.object({
    enabled: z.boolean().default(true),
    pct: z.number().finite().min(0).max(100).default(2),
    label: z.string().default("Kacchi Adat"),
  }).default({}),

  /* Invoice 196 prints LABOUR @ 9.50 (800 katte -> 7,600) and LABOUR @ 15.50
     with a dash while the BORE column is empty, so 15.50 is read as the rate
     for jute bags. Which bags each rate counts is a setting, not code. */
  labour1: z.object({
    enabled: z.boolean().default(true),
    perBagRupees: z.number().finite().min(0).default(9.5),
    appliesTo: BagKind.default("katte"),
    label: z.string().default("Labour"),
  }).default({}),

  labour2: z.object({
    enabled: z.boolean().default(true),
    perBagRupees: z.number().finite().min(0).default(15.5),
    appliesTo: BagKind.default("bore"),
    label: z.string().default("Labour"),
  }).default({}),

  sutli: z.object({
    enabled: z.boolean().default(true),
    perBagRupees: z.number().finite().min(0).default(1),
    appliesTo: BagKind.default("all"),
    label: z.string().default("Sutli"),
  }).default({}),

  gaushala: z.object({
    enabled: z.boolean().default(true),
    perQtlRupees: z.number().finite().min(0).default(1.25),
    /** Your 20-09-2026 parcha charges this on GROSS, not net. */
    base: WeightBase.default("gross"),
    label: z.string().default("Gaushala"),
  }).default({}),

  mandiTax: z.object({
    enabled: z.boolean().default(true),
    pct: z.number().finite().min(0).max(100).default(1.5),
    /** Verified: 1.5% x (amount + adat) = 16,228.64 on your parcha. */
    base: PctBase.default("amount_plus_adat"),
    label: z.string().default("Mandi Tax"),
  }).default({}),

  commission: z.object({
    enabled: z.boolean().default(true),
    pct: z.number().finite().min(0).max(100).default(1),
    base: PctBase.default("amount_plus_adat"),
    label: z.string().default("Commission"),
  }).default({}),

  gatePass: z.object({
    enabled: z.boolean().default(true),
    perTruckRupees: z.number().finite().min(0).default(100),
    label: z.string().default("Gate Pass"),
  }).default({}),

  /** Extra rows this mill wants that nobody else does. */
  extraCharges: z.array(z.object({
    key: z.string(),
    label: z.string(),
    labelHi: z.string().optional(),
    kind: z.enum(["per_bag", "per_qtl", "per_truck", "pct", "flat"]),
    value: z.number().finite(),
    base: PctBase.optional(),
    weightBase: WeightBase.optional(),
    sign: z.enum(["add", "subtract"]).default("add"),
  })).default([]),

  dara: z.object({
    mode: z.enum(["none", "per_bag", "per_qtl", "pct", "manual"]).default("manual"),
    value: z.number().finite().default(0),
    weightBase: WeightBase.default("net"),
    /** On your sample parcha Dara is printed but NOT inside the grand total. */
    includeInGrandTotal: z.boolean().default(false),
    label: z.string().default("Dara"),
    labelHi: z.string().default("दारा"),
  }).default({}),

  advance: z.object({
    /** Your parcha ADDS the advance (freight you paid, recovered from the mill). */
    treatment: z.enum(["add", "subtract", "exclude"]).default("add"),
    label: z.string().default("Advance"),
  }).default({}),

  grandTotalRounding: z.enum(["none", "nearest_rupee", "up_rupee", "nearest_ten"]).default("none"),

  parcha: z.object({
    title: z.string().default("KACCHA PARCHA"),
    titleHi: z.string().default("कच्चा पर्चा"),
    numberPrefix: z.string().default(""),
    showBoreColumns: z.boolean().default(true),
    showDaraRow: z.boolean().default(true),
    footerNote: z.string().default(""),
    footerNoteHi: z.string().default(""),
  }).default({}),

  paymentTermsDays: z.number().finite().int().min(0).default(0),
  notes: z.string().default(""),
});

export type ChargeConfig = z.infer<typeof ChargeConfigSchema>;
export type Katauti = z.infer<typeof KatautiSchema>;

function roundBy(x: number, mode: Katauti["rounding"]): number {
  if (mode === "up") return Math.ceil(x);
  if (mode === "down") return Math.floor(x);
  if (mode === "half_even") {
    const fl = Math.floor(x);
    const frac = x - fl;
    if (frac > 0.5) return fl + 1;
    if (frac < 0.5) return fl;
    return fl % 2 === 0 ? fl : fl + 1;
  }
  return Math.floor(x + 0.5); // half_up — the owner-favouring default
}

/**
 * How many katauti units a slip carries, and what that deducts.
 * `override` is the number written on the sheet, when it differs from ours.
 */
export function deriveKatauti(
  grossGrams: number,
  cfg: Katauti,
  override?: number | null,
): { units: number; deductionGrams: number } {
  let units: number;
  if (override != null) units = override;
  else if (cfg.mode === "none") units = 0;
  else if (cfg.mode === "per_quintal_rounded") units = roundBy(grossGrams / 100_000, cfg.rounding);
  else if (cfg.mode === "per_quintal_exact") units = grossGrams / 100_000;
  else units = 0; // per_bag needs a bag count the daily list does not carry
  return { units, deductionGrams: Math.round(units * cfg.kgPerUnit * 1000) };
}

export const defaultChargeConfig = (): ChargeConfig => ChargeConfigSchema.parse({});

export interface ParchaInput {
  grossGrams: number;
  /** Total bags. When katte/bore are not given, all of them count as katte. */
  bags?: number;
  katte?: number;
  bore?: number;
  /** Optional — derived from bags x kg per bag when absent. */
  bardanaGrams?: number;
  katteBardanaGrams?: number;
  boreBardanaGrams?: number;
  netGrams?: number;
  ratePaisePerQtl: number;
  trucks?: number;
  advancePaise?: number;
  manualDaraPaise?: number;
  /** When the goods are several rows at different rates: their summed amount. */
  goodsPaise?: number;
}

export interface ParchaLine {
  key: string;
  label: string;
  labelHi?: string;
  detail?: string;
  /** The rate the line is charged at, for the printed "@ Rs 9.50/- PER BAG". */
  rate?: number;
  per?: "pct" | "bag" | "qtl" | "truck";
  amountPaise: number;
  kind: "goods" | "charge" | "subtotal" | "total" | "info" | "adjust";
  sign?: "add" | "subtract";
}

export interface ParchaResult {
  grossGrams: number;
  bardanaGrams: number;
  katteBardanaGrams: number;
  boreBardanaGrams: number;
  netGrams: number;
  bags: number;
  katte: number;
  bore: number;
  ratePaisePerQtl: number;
  goodsAmountPaise: number;
  adatPaise: number;
  subtotalPaise: number;
  chargesPaise: number;
  totalPaise: number;
  advancePaise: number;
  daraPaise: number;
  grandTotalPaise: number;
  lines: ParchaLine[];
}

export function computeParcha(cfg: ChargeConfig, input: ParchaInput): ParchaResult {
  const katte = input.katte ?? (input.bore == null ? (input.bags ?? 0) : Math.max(0, (input.bags ?? 0) - input.bore));
  const bore = input.bore ?? 0;
  const bags = katte + bore;
  const trucks = input.trucks ?? 1;
  const grossGrams = input.grossGrams;

  const katteBardanaGrams = input.katteBardanaGrams ?? bardanaKg(katte, cfg.millBardanaKgPerBag);
  const boreBardanaGrams = input.boreBardanaGrams ?? bardanaKg(bore, cfg.millBoreBardanaKgPerBag);
  const bardanaGrams = input.bardanaGrams ?? katteBardanaGrams + boreBardanaGrams;
  const netGrams = input.netGrams ?? grossGrams - bardanaGrams;
  const bagsOf = (k: z.infer<typeof BagKind>) => (k === "katte" ? katte : k === "bore" ? bore : bags);

  const lines: ParchaLine[] = [];

  const goods = input.goodsPaise ?? amountPaise(netGrams, input.ratePaisePerQtl);
  lines.push({
    key: "goods", label: "Goods value", labelHi: "माल मूल्य",
    detail: `${(netGrams / GRAMS_PER_QTL).toFixed(2)} qtl x ${(input.ratePaisePerQtl / 100).toFixed(2)}`,
    amountPaise: goods, kind: "goods",
  });

  const adat = cfg.adat.enabled ? pctPaise(goods, cfg.adat.pct) : 0;
  if (cfg.adat.enabled) {
    lines.push({
      key: "adat", label: cfg.adat.label, labelHi: "कच्ची आढ़त",
      detail: `${cfg.adat.pct}%`, rate: cfg.adat.pct, per: "pct", amountPaise: adat, kind: "charge",
    });
  }

  const subtotal = goods + adat;
  lines.push({
    key: "subtotal", label: "Total amount", labelHi: "कुल राशि",
    amountPaise: subtotal, kind: "subtotal",
  });

  const baseFor = (b: z.infer<typeof PctBase>, running: number) =>
    b === "amount" ? goods : b === "amount_plus_adat" ? subtotal : running;

  const weightFor = (b: z.infer<typeof WeightBase>) =>
    b === "gross" ? grossGrams : netGrams;

  let charges = 0;
  const push = (l: ParchaLine) => {
    lines.push(l);
    charges += l.sign === "subtract" ? -l.amountPaise : l.amountPaise;
  };

  // no bags of that kind on this truck: the line is left off, not printed as a zero
  if (cfg.labour1.enabled && bagsOf(cfg.labour1.appliesTo) > 0) {
    const n = bagsOf(cfg.labour1.appliesTo);
    push({
      key: "labour1", label: cfg.labour1.label, labelHi: "लेबर",
      detail: `Rs ${cfg.labour1.perBagRupees}/bag x ${n}${cfg.labour1.appliesTo === "all" ? "" : " " + cfg.labour1.appliesTo}`,
      rate: cfg.labour1.perBagRupees, per: "bag",
      amountPaise: perUnitPaise(n, 1, cfg.labour1.perBagRupees), kind: "charge",
    });
  }
  // no bags of that kind on this truck: the line is left off, not printed as a zero
  if (cfg.labour2.enabled && bagsOf(cfg.labour2.appliesTo) > 0) {
    const n = bagsOf(cfg.labour2.appliesTo);
    push({
      key: "labour2", label: cfg.labour2.label, labelHi: "लेबर (दूसरा)",
      detail: `Rs ${cfg.labour2.perBagRupees}/bag x ${n}${cfg.labour2.appliesTo === "all" ? "" : " " + cfg.labour2.appliesTo}`,
      rate: cfg.labour2.perBagRupees, per: "bag",
      amountPaise: perUnitPaise(n, 1, cfg.labour2.perBagRupees), kind: "charge",
    });
  }
  // no bags of that kind on this truck: the line is left off, not printed as a zero
  if (cfg.sutli.enabled && bagsOf(cfg.sutli.appliesTo) > 0) {
    const n = bagsOf(cfg.sutli.appliesTo);
    push({
      key: "sutli", label: cfg.sutli.label, labelHi: "सुतली",
      detail: `Rs ${cfg.sutli.perBagRupees}/bag x ${n}${cfg.sutli.appliesTo === "all" ? "" : " " + cfg.sutli.appliesTo}`,
      rate: cfg.sutli.perBagRupees, per: "bag",
      amountPaise: perUnitPaise(n, 1, cfg.sutli.perBagRupees), kind: "charge",
    });
  }
  if (cfg.gaushala.enabled) {
    const w = weightFor(cfg.gaushala.base);
    push({
      key: "gaushala", label: cfg.gaushala.label, labelHi: "गौशाला",
      detail: `Rs ${cfg.gaushala.perQtlRupees}/qtl on ${cfg.gaushala.base} ${(w / GRAMS_PER_QTL).toFixed(2)}`,
      rate: cfg.gaushala.perQtlRupees, per: "qtl",
      amountPaise: perUnitPaise(w, GRAMS_PER_QTL, cfg.gaushala.perQtlRupees), kind: "charge",
    });
  }
  if (cfg.mandiTax.enabled) {
    push({
      key: "mandiTax", label: cfg.mandiTax.label, labelHi: "मंडी टैक्स",
      detail: `${cfg.mandiTax.pct}% of ${cfg.mandiTax.base}`, rate: cfg.mandiTax.pct, per: "pct",
      amountPaise: pctPaise(baseFor(cfg.mandiTax.base, subtotal + charges), cfg.mandiTax.pct),
      kind: "charge",
    });
  }
  if (cfg.commission.enabled) {
    push({
      key: "commission", label: cfg.commission.label, labelHi: "कमीशन",
      detail: `${cfg.commission.pct}% of ${cfg.commission.base}`, rate: cfg.commission.pct, per: "pct",
      amountPaise: pctPaise(baseFor(cfg.commission.base, subtotal + charges), cfg.commission.pct),
      kind: "charge",
    });
  }
  if (cfg.gatePass.enabled) {
    push({
      key: "gatePass", label: cfg.gatePass.label, labelHi: "गेट पास",
      detail: `Rs ${cfg.gatePass.perTruckRupees}/truck x ${trucks}`, rate: cfg.gatePass.perTruckRupees, per: "truck",
      amountPaise: perUnitPaise(trucks, 1, cfg.gatePass.perTruckRupees), kind: "charge",
    });
  }

  for (const ex of cfg.extraCharges) {
    let amt = 0;
    if (ex.kind === "per_bag") amt = perUnitPaise(bags, 1, ex.value);
    else if (ex.kind === "per_qtl") amt = perUnitPaise(weightFor(ex.weightBase ?? "net"), GRAMS_PER_QTL, ex.value);
    else if (ex.kind === "per_truck") amt = perUnitPaise(trucks, 1, ex.value);
    else if (ex.kind === "pct") amt = pctPaise(baseFor(ex.base ?? "amount_plus_adat", subtotal + charges), ex.value);
    else amt = perUnitPaise(1, 1, ex.value);
    push({ key: `extra:${ex.key}`, label: ex.label, labelHi: ex.labelHi, amountPaise: amt, kind: "charge", sign: ex.sign });
  }

  const total = subtotal + charges;
  lines.push({ key: "total", label: "Total amount", labelHi: "कुल राशि", amountPaise: total, kind: "subtotal" });

  // Dara — computed but, by default, reported outside the grand total.
  let dara = 0;
  if (cfg.dara.mode === "per_bag") dara = perUnitPaise(bags, 1, cfg.dara.value);
  else if (cfg.dara.mode === "per_qtl") dara = perUnitPaise(weightFor(cfg.dara.weightBase), GRAMS_PER_QTL, cfg.dara.value);
  else if (cfg.dara.mode === "pct") dara = pctPaise(total, cfg.dara.value);
  else if (cfg.dara.mode === "manual") dara = input.manualDaraPaise ?? 0;
  if (cfg.parcha.showDaraRow && cfg.dara.mode !== "none") {
    lines.push({
      key: "dara", label: cfg.dara.label, labelHi: cfg.dara.labelHi,
      detail: cfg.dara.includeInGrandTotal ? undefined : "not included in grand total",
      amountPaise: dara, kind: "info",
    });
  }

  const advance = input.advancePaise ?? 0;
  if (cfg.advance.treatment !== "exclude" && advance !== 0) {
    lines.push({
      key: "advance", label: cfg.advance.label, labelHi: "एडवांस",
      amountPaise: advance, kind: "adjust",
      sign: cfg.advance.treatment === "subtract" ? "subtract" : "add",
    });
  }

  let grand = total;
  if (cfg.advance.treatment === "add") grand += advance;
  else if (cfg.advance.treatment === "subtract") grand -= advance;
  if (cfg.dara.includeInGrandTotal) grand += dara;

  if (cfg.grandTotalRounding === "nearest_rupee") grand = Math.round(grand / 100) * 100;
  else if (cfg.grandTotalRounding === "up_rupee") grand = Math.ceil(grand / 100) * 100;
  else if (cfg.grandTotalRounding === "nearest_ten") grand = Math.round(grand / 1000) * 1000;

  lines.push({ key: "grand", label: "Grand total", labelHi: "महायोग", amountPaise: grand, kind: "total" });

  return {
    grossGrams, bardanaGrams, katteBardanaGrams, boreBardanaGrams, netGrams, bags, katte, bore,
    ratePaisePerQtl: input.ratePaisePerQtl,
    goodsAmountPaise: goods, adatPaise: adat, subtotalPaise: subtotal,
    chargesPaise: charges, totalPaise: total,
    advancePaise: advance, daraPaise: dara, grandTotalPaise: grand,
    lines,
  };
}
