import { Fragment, useState } from "react";
import { FileText, Trash2, RotateCcw, Sparkles, Check } from "lucide-react";
import type { ScanRow } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useFormat, GRAMS_PER_QTL } from "@/lib/format.tsx";
import { NumberInput } from "@/components/NumberInput.tsx";
import { SupplierPicker } from "@/components/SupplierPicker.tsx";
import { Button, Badge } from "@/components/ui/index.tsx";
import { cn } from "@/lib/utils.ts";

export type Field = "rst" | "name" | "gross" | "katauti" | "rate";

/** red = must fix before approving; amber = worth a look; null = fine */
type Flag = { level: "bad" | "doubt"; why: string } | null;

const LOW = 0.75;

/**
 * Why a cell deserves attention. Red cannot be waved through; amber can —
 * one click on its star accepts the value, and editing it accepts the edit.
 * Either way the operator's decision is final and the mark goes away.
 */
function flagFor(r: ScanRow, f: Field, t: (k: never, v?: Record<string, string | number>) => string): Flag {
  const done = (r.confirmed ?? []).includes(f);
  const has = (code: string) => r.issues.some((i) => i.code === code);
  const conf = r.ocr.confidence ?? 1;

  if (f === "rst") {
    if (has("rst_missing")) return { level: "bad", why: t("scan.fix.rstMissing" as never) };
    if (has("rst_dupe")) return { level: "bad", why: t("issue.rst_dupe" as never, { rst: r.rstNo }) };
    if (has("rst_exists")) return { level: "bad", why: t("scan.fix.rstExists" as never) };
    if (!done && conf < LOW) return { level: "doubt", why: t("issue.low_confidence" as never) };
  }
  if (f === "name") {
    if (!r.chosen && !r.match) return { level: "bad", why: t("scan.fix.pickName" as never) };
    if (!done && !r.chosen && r.match?.via === "fuzzy")
      return { level: "doubt", why: t("issue.name_fuzzy" as never, { name: r.adatiRawText }) };
  }
  if (f === "gross") {
    if (r.grossGrams === null) return { level: "bad", why: t("scan.fix.grossMissing" as never) };
    if (has("net_nonpositive")) return { level: "bad", why: t("scan.fix.netNonPositive" as never) };
    if (!done && r.netAgrees === false)
      return { level: "doubt", why: t("scan.whyGross" as never, { net: (r.ocr.netQtl ?? 0).toFixed(2) }) };
    if (!done && (has("gross_small") || has("gross_large"))) return { level: "doubt", why: t("issue.gross_small" as never) };
    if (!done && conf < LOW) return { level: "doubt", why: t("issue.low_confidence" as never) };
  }
  if (f === "katauti") {
    if (!done && has("katauti_mismatch") && r.katautiOverride === null)
      return { level: "doubt", why: t("issue.katauti_mismatch" as never, { sheet: r.ocr.katauti ?? "", calculated: r.derivedKatautiUnits ?? "" }) };
  }
  if (f === "rate") {
    if (!done && r.ratePaisePerQtl === null) return { level: "doubt", why: t("issue.rate_missing" as never) };
    if (!done && has("rate_range")) return { level: "doubt", why: t("issue.rate_range" as never) };
    if (!done && conf < LOW) return { level: "doubt", why: t("issue.low_confidence" as never) };
  }
  return null;
}

const CELL = "h-7 w-full rounded border bg-surface px-1.5 text-[12px] num text-right focus:border-brand disabled:opacity-60";

/* Border colour carries the signal: orange means "worth a look", and goes the
   moment the operator edits the cell; red means "cannot approve until fixed". */
function cellClass(flag: Flag) {
  if (!flag) return "border-line";
  return flag.level === "bad" ? "border-bad border-2 bg-bad-soft/30" : "border-warn border-2";
}

/** A red cell has to say what to do, in words, right under it. */
function FixHint({ flag }: { flag: Flag }) {
  if (!flag || flag.level !== "bad") return null;
  return <p className="mt-0.5 text-left text-[10px] leading-tight text-bad">{flag.why}</p>;
}

export function ScanGrid({
  rows, pageCount, locked, canRate, onPatch, onPageClick,
}: {
  rows: ScanRow[];
  pageCount: number;
  locked: boolean;
  canRate: boolean;
  /** `confirm` names the field the operator has now dealt with. */
  onPatch: (id: string, patch: Partial<ScanRow>, confirm?: Field) => void;
  onPageClick?: (page: number) => void;
}) {
  const { t } = useI18n();
  const f = useFormat();
  const [editingName, setEditingName] = useState<string | null>(null);

  const tt = t as unknown as (k: never, v?: Record<string, string | number>) => string;
  const multi = pageCount > 1;

  const rowsWithRst = new Map<string, number[]>();
  rows.forEach((r, i) => {
    if (r.excluded || !r.rstNo) return;
    const list = rowsWithRst.get(r.rstNo) ?? [];
    list.push(i + 1);
    rowsWithRst.set(r.rstNo, list);
  });

  return (
    /* a floor on the width: a narrow pane scrolls sideways instead of
       squeezing "19.20" down to "19" */
    <table className="w-full min-w-[1000px] border-collapse text-[13px]">
      <thead>
        <tr className="bg-raised/80">
          {([
            ["#", "w-9", false], [t("scan.slipCol"), "w-24", false], [t("daily.supplier"), "min-w-[200px]", false],
            [t("daily.gross"), "w-24", true], [t("daily.bags"), "w-16", true], [t("daily.katautiWt"), "w-20", true],
            [t("daily.net"), "w-24", true], [`${t("daily.rate")}${f.symbol ? " " + f.symbol : ""}`, "w-24", true],
            [`${t("daily.amount")}${f.symbol ? " " + f.symbol : ""}`, "w-28", true], [t("scan.conf"), "w-14", true], ["", "w-10", false],
          ] as const).map(([label, w, num], k) => (
            <th key={k} className={cn(
              "sticky top-0 z-20 border-b border-line bg-raised px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted",
              num ? "text-right" : "text-left", w,
            )}>{label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const dead = r.excluded || locked;
          const pageStart = multi && (i === 0 || (rows[i - 1].page ?? 1) !== (r.page ?? 1));
          const name = r.chosen ?? r.match;
          const others = (rowsWithRst.get(r.rstNo) ?? []).filter((n) => n !== i + 1);
          const rstFlag = flagFor(r, "rst", tt);
          const fl = {
            rst: rstFlag && r.issues.some((x) => x.code === "rst_dupe") && others.length
              ? { level: "bad" as const, why: t("scan.alsoOnRow", { rows: others.join(", ") }) }
              : rstFlag,
            name: flagFor(r, "name", tt), gross: flagFor(r, "gross", tt),
            katauti: flagFor(r, "katauti", tt), rate: flagFor(r, "rate", tt),
          };

          return (
            <Fragment key={r.id}>
              {pageStart && (
                <tr>
                  <td colSpan={11} className="border-b border-line bg-raised/70 px-2 py-1">
                    <button type="button" onClick={() => onPageClick?.(r.page ?? 1)}
                      className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted hover:text-brand">
                      <FileText className="h-3 w-3" />
                      {t("scan.page", { n: r.page ?? 1 })}
                      <span className="font-normal normal-case text-faint">
                        · {t("scan.rowsOnPage", { n: rows.filter((x) => (x.page ?? 1) === (r.page ?? 1)).length })}
                      </span>
                    </button>
                  </td>
                </tr>
              )}

              <tr className={cn("transition-colors hover:bg-raised/30", r.excluded && "bg-raised/50 opacity-55")}>
                <td className="num border-b border-line/70 px-2 py-1 text-[11px] text-faint">{i + 1}</td>

                <td className="border-b border-line/70 px-1 py-1">
                  <div className="relative">
                    <input value={r.rstNo} disabled={dead} placeholder="RST" title={fl.rst?.why}
                      onChange={(e) => onPatch(r.id, { rstNo: e.target.value }, "rst")}
                      className={cn(CELL, "text-left", cellClass(fl.rst))} />
                    <FixHint flag={fl.rst} />
                  </div>
                </td>

                <td className="border-b border-line/70 px-1 py-1">
                  <div className="relative">
                    {name && editingName !== r.id ? (
                      /* click the name itself to change it — no separate clear button */
                      <button type="button" disabled={dead} title={fl.name?.why ?? t("scan.clickToChange")}
                        onClick={() => setEditingName(r.id)}
                        className={cn(
                          "flex w-full items-center gap-1.5 rounded border px-1.5 py-0.5 text-left transition-colors",
                          fl.name ? cellClass(fl.name) : "border-transparent hover:border-line hover:bg-surface",
                        )}>
                        <span className="min-w-0 flex-1">
                          <span lang="hi" className="block truncate text-[14px] leading-tight text-ink">{name.nameHi}</span>
                          <span className="block truncate text-[10px] leading-tight text-faint">
                            {name.nameHinglish}
                            {r.ocr.adatiName && r.ocr.adatiName !== name.nameHi && (
                              <span lang="hi"> · {t("scan.ocrSaid")}: {r.ocr.adatiName}</span>
                            )}
                          </span>
                        </span>
                        {r.chosen
                          ? <Badge tone="brand" className="shrink-0"><Check className="h-2.5 w-2.5" /></Badge>
                          : r.match && <Badge tone={r.match.via === "fuzzy" ? "warn" : "ok"} className="shrink-0">
                              {t(`scan.matchedBy.${r.match.via}` as never)}
                            </Badge>}
                      </button>
                    ) : (
                      <SupplierPicker
                        value={r.adatiId}
                        selectedLabel={name ? { nameHi: name.nameHi, nameHinglish: name.nameHinglish } : null}
                        disabled={dead}
                        invalid={!name}
                        autoFocus={editingName === r.id}
                        placeholder={r.adatiRawText || t("scan.pickName")}
                        onChange={(v) => { if (v) { onPatch(r.id, { adatiId: v, nameCorrected: true }, "name"); setEditingName(null); } }}
                        onBlurEmpty={() => setEditingName(null)}
                      />
                    )}
                    <FixHint flag={fl.name} />
                  </div>
                </td>

                <td className="border-b border-line/70 px-1 py-1">
                  <div className="relative">
                    <NumberInput disabled={dead} title={fl.gross?.why} decimals={2}
                      className={cn(CELL, cellClass(fl.gross))}
                      value={r.grossGrams === null ? null : r.grossGrams / GRAMS_PER_QTL}
                      onValueChange={(n) => onPatch(r.id, { grossGrams: n === null ? null : Math.round(n * GRAMS_PER_QTL) }, "gross")} />
                    <FixHint flag={fl.gross} />
                  </div>
                </td>

                <td className="border-b border-line/70 px-1 py-1">
                  <div className="relative">
                    <NumberInput integer disabled={dead} title={fl.katauti?.why}
                      className={cn(CELL, cellClass(fl.katauti), r.katautiOverride === null && !fl.katauti && "text-faint")}
                      placeholder={r.derivedKatautiUnits === null ? "" : String(r.derivedKatautiUnits)}
                      value={r.katautiOverride}
                      onValueChange={(n) => onPatch(r.id, { katautiOverride: n }, "katauti")} />
                    <FixHint flag={fl.katauti} />
                  </div>
                </td>

                <td className="num border-b border-line/70 px-2 py-1 text-right text-faint">
                  {r.derivedNetGrams === null || r.grossGrams === null ? "—" : f.weight(r.grossGrams - r.derivedNetGrams)}
                </td>

                {/* net is always gross − katauti, so the parcha arithmetic holds;
                    fix a wrong net at its source, the gross */}
                <td className="num border-b border-line/70 px-2 py-1 text-right font-semibold">
                  {r.derivedNetGrams === null ? "—" : f.weight(r.derivedNetGrams)}
                </td>

                <td className="border-b border-line/70 px-1 py-1">
                  <div className="relative">
                    <NumberInput disabled={dead || !canRate} title={fl.rate?.why} decimals={2}
                      className={cn(CELL, cellClass(fl.rate))}
                      value={r.ratePaisePerQtl === null ? null : r.ratePaisePerQtl / 100}
                      onValueChange={(n) => onPatch(r.id, { ratePaisePerQtl: n === null ? null : Math.round(n * 100) }, "rate")} />
                    <FixHint flag={fl.rate} />
                  </div>
                </td>

                <td className="num border-b border-line/70 px-2 py-1 text-right font-semibold text-brand">
                  {r.derivedAmountPaise === null ? "—" : f.amount(r.derivedAmountPaise)}
                </td>

                <td className="num border-b border-line/70 px-2 py-1 text-right">
                  {r.ocr.confidence == null ? "—" : (
                    <Badge tone={r.ocr.confidence >= 0.8 ? "ok" : r.ocr.confidence >= 0.6 ? "warn" : "bad"} className="num">
                      {Math.round(r.ocr.confidence * 100)}
                    </Badge>
                  )}
                </td>

                <td className="border-b border-line/70 px-1 py-1">
                  <Button size="icon" variant="ghost" className="h-6 w-6" disabled={locked}
                    title={r.excluded ? t("scan.include") : t("scan.exclude")}
                    onClick={() => onPatch(r.id, { excluded: !r.excluded })}>
                    {r.excluded ? <RotateCcw className="h-3 w-3" /> : <Trash2 className="h-3 w-3 text-bad/70" />}
                  </Button>
                </td>
              </tr>

              {/* the three closest, one tap each; only while nothing is chosen */}
              {!r.excluded && !r.chosen && !r.match && r.suggestions.length > 0 && (
                <tr>
                  <td className="border-b border-line/70" />
                  <td className="border-b border-line/70" />
                  <td colSpan={9} className="border-b border-line/70 px-1 pb-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Sparkles className="h-2.5 w-2.5 shrink-0 text-faint" />
                      {r.suggestions.slice(0, 3).map((sg) => (
                        <button key={sg.adatiId} type="button" disabled={dead}
                          onClick={() => onPatch(r.id, { adatiId: sg.adatiId, nameCorrected: true }, "name")}
                          className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[11px] hover:border-brand hover:bg-brand/5">
                          <span lang="hi">{sg.nameHi}</span>
                          <span className="num text-faint">{Math.round(sg.confidence * 100)}%</span>
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
