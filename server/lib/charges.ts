import { z } from "zod";
import { amountPaise, pctPaise, roundHalfUp, GRAMS_PER_QTL } from "./money.ts";

/* Every number on the kaccha parcha is driven from here. Nothing is hardcoded,
   because the terms differ per mill — including WHICH BASE a percentage applies
   to, which is the part that silently costs money if you get it wrong. */

export const PctBase = z.enum(["amount", "amount_plus_adat", "total_before_charge"]);
export const WeightBase = z.enum(["gross", "net"]);

export const ChargeConfigSchema = z.object({
  /** Deduction per bag when weighing IN from the supplier (your side). */
  purchaseKatautiKgPerBag: z.number().min(0).max(5).default(1),
  /** Bardana weight per bag as the destination mill counts it. */
  millBardanaKgPerBag: z.number().min(0).max(5).default(0.57),

  adat: z.object({
    enabled: z.boolean().default(true),
    pct: z.number().min(0).max(100).default(2),
    label: z.string().default("Kacchi Adat"),
  }).default({}),

  labour1: z.object({
    enabled: z.boolean().default(true),
    perBagRupees: z.number().min(0).default(9.5),
    label: z.string().default("Labour"),
  }).default({}),

  labour2: z.object({
    enabled: z.boolean().default(false),
    perBagRupees: z.number().min(0).default(15.5),
    label: z.string().default("Labour (second slab)"),
  }).default({}),

  sutli: z.object({
    enabled: z.boolean().default(true),
    perBagRupees: z.number().min(0).default(1),
    label: z.string().default("Sutli"),
  }).default({}),

  gaushala: z.object({
    enabled: z.boolean().default(true),
    perQtlRupees: z.number().min(0).default(1.25),
    /** Your 20-09-2026 parcha charges this on GROSS, not net. */
    base: WeightBase.default("gross"),
    label: z.string().default("Gaushala"),
  }).default({}),

  mandiTax: z.object({
    enabled: z.boolean().default(true),
    pct: z.number().min(0).max(100).default(1.5),
    /** Verified: 1.5% x (amount + adat) = 16,228.64 on your parcha. */
    base: PctBase.default("amount_plus_adat"),
    label: z.string().default("Mandi Tax"),
  }).default({}),

  commission: z.object({
    enabled: z.boolean().default(true),
    pct: z.number().min(0).max(100).default(1),
    base: PctBase.default("amount_plus_adat"),
    label: z.string().default("Commission"),
  }).default({}),

  gatePass: z.object({
    enabled: z.boolean().default(true),
    perTruckRupees: z.number().min(0).default(100),
    label: z.string().default("Gate Pass"),
  }).default({}),

  /** Extra rows this mill wants that nobody else does. */
  extraCharges: z.array(z.object({
    key: z.string(),
    label: z.string(),
    labelHi: z.string().optional(),
    kind: z.enum(["per_bag", "per_qtl", "per_truck", "pct", "flat"]),
    value: z.number(),
    base: PctBase.optional(),
    weightBase: WeightBase.optional(),
    sign: z.enum(["add", "subtract"]).default("add"),
  })).default([]),

  dara: z.object({
    mode: z.enum(["none", "per_bag", "per_qtl", "pct", "manual"]).default("manual"),
    value: z.number().default(0),
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

  paymentTermsDays: z.number().int().min(0).default(0),
  notes: z.string().default(""),
});

export type ChargeConfig = z.infer<typeof ChargeConfigSchema>;

export const defaultChargeConfig = (): ChargeConfig => ChargeConfigSchema.parse({});

export interface ParchaInput {
  grossGrams: number;
  bags: number;
  /** Optional — derived from bags x millBardanaKgPerBag when absent. */
  bardanaGrams?: number;
  netGrams?: number;
  ratePaisePerQtl: number;
  trucks?: number;
  advancePaise?: number;
  manualDaraPaise?: number;
}

export interface ParchaLine {
  key: string;
  label: string;
  labelHi?: string;
  detail?: string;
  amountPaise: number;
  kind: "goods" | "charge" | "subtotal" | "total" | "info" | "adjust";
  sign?: "add" | "subtract";
}

export interface ParchaResult {
  grossGrams: number;
  bardanaGrams: number;
  netGrams: number;
  bags: number;
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
  const bags = input.bags;
  const trucks = input.trucks ?? 1;
  const grossGrams = input.grossGrams;

  const bardanaGrams =
    input.bardanaGrams ?? Math.round(bags * cfg.millBardanaKgPerBag * 1000);
  const netGrams = input.netGrams ?? grossGrams - bardanaGrams;

  const lines: ParchaLine[] = [];

  const goods = amountPaise(netGrams, input.ratePaisePerQtl);
  lines.push({
    key: "goods", label: "Goods value", labelHi: "माल मूल्य",
    detail: `${(netGrams / GRAMS_PER_QTL).toFixed(2)} qtl x ${(input.ratePaisePerQtl / 100).toFixed(2)}`,
    amountPaise: goods, kind: "goods",
  });

  const adat = cfg.adat.enabled ? pctPaise(goods, cfg.adat.pct) : 0;
  if (cfg.adat.enabled) {
    lines.push({
      key: "adat", label: cfg.adat.label, labelHi: "कच्ची आढ़त",
      detail: `${cfg.adat.pct}%`, amountPaise: adat, kind: "charge",
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

  if (cfg.labour1.enabled) {
    push({
      key: "labour1", label: cfg.labour1.label, labelHi: "लेबर",
      detail: `Rs ${cfg.labour1.perBagRupees}/bag x ${bags}`,
      amountPaise: roundHalfUp(bags * cfg.labour1.perBagRupees * 100), kind: "charge",
    });
  }
  if (cfg.labour2.enabled) {
    push({
      key: "labour2", label: cfg.labour2.label, labelHi: "लेबर (दूसरा)",
      detail: `Rs ${cfg.labour2.perBagRupees}/bag x ${bags}`,
      amountPaise: roundHalfUp(bags * cfg.labour2.perBagRupees * 100), kind: "charge",
    });
  }
  if (cfg.sutli.enabled) {
    push({
      key: "sutli", label: cfg.sutli.label, labelHi: "सुतली",
      detail: `Rs ${cfg.sutli.perBagRupees}/bag x ${bags}`,
      amountPaise: roundHalfUp(bags * cfg.sutli.perBagRupees * 100), kind: "charge",
    });
  }
  if (cfg.gaushala.enabled) {
    const w = weightFor(cfg.gaushala.base);
    push({
      key: "gaushala", label: cfg.gaushala.label, labelHi: "गौशाला",
      detail: `Rs ${cfg.gaushala.perQtlRupees}/qtl on ${cfg.gaushala.base} ${(w / GRAMS_PER_QTL).toFixed(2)}`,
      amountPaise: roundHalfUp((w / GRAMS_PER_QTL) * cfg.gaushala.perQtlRupees * 100), kind: "charge",
    });
  }
  if (cfg.mandiTax.enabled) {
    push({
      key: "mandiTax", label: cfg.mandiTax.label, labelHi: "मंडी टैक्स",
      detail: `${cfg.mandiTax.pct}% of ${cfg.mandiTax.base}`,
      amountPaise: pctPaise(baseFor(cfg.mandiTax.base, subtotal + charges), cfg.mandiTax.pct),
      kind: "charge",
    });
  }
  if (cfg.commission.enabled) {
    push({
      key: "commission", label: cfg.commission.label, labelHi: "कमीशन",
      detail: `${cfg.commission.pct}% of ${cfg.commission.base}`,
      amountPaise: pctPaise(baseFor(cfg.commission.base, subtotal + charges), cfg.commission.pct),
      kind: "charge",
    });
  }
  if (cfg.gatePass.enabled) {
    push({
      key: "gatePass", label: cfg.gatePass.label, labelHi: "गेट पास",
      detail: `Rs ${cfg.gatePass.perTruckRupees}/truck x ${trucks}`,
      amountPaise: roundHalfUp(trucks * cfg.gatePass.perTruckRupees * 100), kind: "charge",
    });
  }

  for (const ex of cfg.extraCharges) {
    let amt = 0;
    if (ex.kind === "per_bag") amt = roundHalfUp(bags * ex.value * 100);
    else if (ex.kind === "per_qtl") amt = roundHalfUp((weightFor(ex.weightBase ?? "net") / GRAMS_PER_QTL) * ex.value * 100);
    else if (ex.kind === "per_truck") amt = roundHalfUp(trucks * ex.value * 100);
    else if (ex.kind === "pct") amt = pctPaise(baseFor(ex.base ?? "amount_plus_adat", subtotal + charges), ex.value);
    else amt = roundHalfUp(ex.value * 100);
    push({ key: `extra:${ex.key}`, label: ex.label, labelHi: ex.labelHi, amountPaise: amt, kind: "charge", sign: ex.sign });
  }

  const total = subtotal + charges;
  lines.push({ key: "total", label: "Total amount", labelHi: "कुल राशि", amountPaise: total, kind: "subtotal" });

  // Dara — computed but, by default, reported outside the grand total.
  let dara = 0;
  if (cfg.dara.mode === "per_bag") dara = roundHalfUp(bags * cfg.dara.value * 100);
  else if (cfg.dara.mode === "per_qtl") dara = roundHalfUp((weightFor(cfg.dara.weightBase) / GRAMS_PER_QTL) * cfg.dara.value * 100);
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
    grossGrams, bardanaGrams, netGrams, bags,
    ratePaisePerQtl: input.ratePaisePerQtl,
    goodsAmountPaise: goods, adatPaise: adat, subtotalPaise: subtotal,
    chargesPaise: charges, totalPaise: total,
    advancePaise: advance, daraPaise: dara, grandTotalPaise: grand,
    lines,
  };
}
