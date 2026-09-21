import { Fragment, useState } from "react";
import { FileText, Trash2, RotateCcw, Sparkles, Check } from "lucide-react";
import type { ScanRow } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useFormat, GRAMS_PER_QTL } from "@/lib/format.tsx";
import { NumberInput } from "@/components/NumberInput.tsx";
import { SupplierPicker } from "@/components/SupplierPicker.tsx";
import { Button, Badge } from "@/components/ui/index.tsx";
import { cn } from "@/lib/utils.ts";

export type Field = "rst" | "name" | "gross" | "katauti" | "rate" | "struck";

/** red = must fix before approving; amber = worth a look; null = fine. `key` is what the ✓ confirms. */
type Flag = { level: "bad" | "doubt"; why: string; confirmable?: boolean; key?: Field } | null;

const LOW = 0.75;

/**
 * Why a cell deserves attention. Amber is worth a look. Red blocks approval:
 * a value that is plainly wrong must be fixed; a value that only looks wrong
 * (the sheet's net disagrees, a huge weight, an unusual rate) can be accepted
 * with the ✓ beside it. Typing a new value is not accepting it: the new value
 * is checked again like the one that was read.
 */
function flagFor(r: ScanRow, f: Field, t: (k: never, v?: Record<string, string | number>) => string): Flag {
  const done = (r.confirmed ?? []).includes(f);
  const has = (code: string) => r.issues.some((i) => i.code === code);
  const conf = r.ocr.confidence ?? 1;

  if (f === "rst") {
    // colour only, never a tick and never a block: red = already entered or twice on the sheet, yellow = may be misread
    if (has("rst_exists")) return { level: "bad", why: t("issue.rst_exists" as never, { rst: r.rstNo }) };
    if (has("rst_dupe")) return { level: "bad", why: t("issue.rst_dupe" as never, { rst: r.rstNo }) };
    if (has("rst_missing")) return { level: "doubt", why: t("scan.fix.rstMissing" as never) };
    if (conf < LOW) return { level: "doubt", why: t("issue.low_confidence" as never) };
  }
  if (f === "name") {
    if (!r.chosen && !r.match) return { level: "bad", why: t("scan.fix.pickName" as never) };
    // struck out on the paper, but put back in: only a ✓ says it really belongs
    if (has("struck_included")) return { level: "bad", why: t("issue.struck_included" as never), confirmable: true, key: "struck" };
    // this page may have slid (checked for the whole page, in the note above the table)
    const slid = r.issues.find((i) => i.code === "page_slid");
    if (slid) return { level: "bad", why: t("issue.page_slid" as never, slid.params as Record<string, string | number>) };
    const mark = r.issues.find((i) => ["sr_gap", "sr_repeat", "sr_back", "name_only", "figures_only"].includes(i.code));
    if (mark) return { level: "doubt", why: t(`issue.${mark.code}` as never, mark.params as Record<string, string | number>) };
    if (!done && !r.chosen && r.match?.via === "fuzzy")
      return { level: "doubt", why: t("issue.name_fuzzy" as never, { name: r.adatiRawText }) };
    const close = r.issues.find((i) => i.code === "name_close");
    if (!done && close) return { level: "doubt", why: t("issue.name_close" as never, close.params as Record<string, string | number>) };
  }
  if (f === "gross") {
    if (r.grossGrams === null) return { level: "bad", why: t("scan.fix.grossMissing" as never) };
    if (has("net_nonpositive")) return { level: "bad", why: t("scan.fix.netNonPositive" as never) };
    if (!done && r.netAgrees === false)
      return { level: "bad", why: t("scan.whyGross" as never, { net: (r.ocr.netQtl ?? 0).toFixed(2) }), confirmable: true };
    if (!done && has("gross_large")) return { level: "bad", why: t("issue.gross_large" as never), confirmable: true };
    const unchecked = r.issues.find((i) => i.code === "net_unchecked");
    if (!done && unchecked) return { level: unchecked.level === "error" ? "bad" : "doubt", why: t("issue.net_unchecked" as never), confirmable: true };
    if (!done && has("gross_small")) return { level: "doubt", why: t("issue.gross_small" as never) };
    if (!done && conf < LOW) return { level: "doubt", why: t("issue.low_confidence" as never) };
  }
  if (f === "katauti") {
    if (!done && has("katauti_mismatch") && r.katautiOverride === null)
      return { level: "doubt", why: t("issue.katauti_mismatch" as never, { sheet: r.ocr.katauti ?? "", calculated: r.derivedKatautiUnits ?? "" }) };
  }
  if (f === "rate") {
    if (!done && r.ratePaisePerQtl === null) return { level: "doubt", why: t("issue.rate_missing" as never) };
    if (has("rate_negative")) return { level: "bad", why: t("issue.rate_negative" as never) };
    if (!done && has("rate_range")) {
      const p = r.issues.find((i) => i.code === "rate_range")?.params;
      return { level: "bad", why: p ? t("issue.rate_rangeOf" as never, { floor: p.floor, ceil: p.ceil }) : t("issue.rate_range" as never), confirmable: true };
    }
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

/** One click: "I have checked this value, it is right as read." */
function Accept({ flag, onAccept, label }: { flag: Flag; onAccept: () => void; label: string }) {
  if (!flag || (flag.level === "bad" && !flag.confirmable)) return null;
  return (
    <button type="button" onClick={onAccept} title={label} aria-label={label}
      className="absolute -right-1 -top-1.5 grid h-4 w-4 place-items-center rounded-full border border-line bg-surface text-ok shadow-sm hover:bg-ok hover:text-white">
      <Check className="h-2.5 w-2.5" strokeWidth={3} />
    </button>
  );
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


  return (
    /* a floor on the width: a narrow pane scrolls sideways instead of
       squeezing "19.20" down to "19" */
    <table className="w-full min-w-[1000px] border-collapse text-[13px]">
      <thead>
        <tr className="bg-raised/80">
          {([
            [t("scan.srCol"), "w-9", false], [t("scan.slipCol"), "w-24", false], [t("daily.supplier"), "min-w-[200px]", false],
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
          const fl = {
            rst: flagFor(r, "rst", tt),
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
                <td className={cn("num border-b border-line/70 px-2 py-1 text-[11px]",
                  r.issues.some((x) => x.code.startsWith("sr_") || x.code === "name_only" || x.code === "figures_only") ? "font-bold text-bad" : "text-faint")}
                  title={t("scan.srNoHint")}>{r.ocr.srNo ?? i + 1}</td>

                <td className="border-b border-line/70 px-1 py-1">
                  <div className="relative">
                    <input value={r.rstNo} disabled={dead} placeholder="RST" title={fl.rst?.why}
                      onChange={(e) => onPatch(r.id, { rstNo: e.target.value.replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d))).replace(/\s+/g, "") })}
                      className={cn(CELL, "text-left", cellClass(fl.rst))} />
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
                    {!dead && <Accept flag={fl.name} label={t("scan.acceptRow")} onAccept={() => onPatch(r.id, {}, fl.name?.key ?? "name")} />}
                  </div>
                </td>

                <td className="border-b border-line/70 px-1 py-1">
                  <div className="relative">
                    <NumberInput disabled={dead} title={fl.gross?.why} decimals={2}
                      className={cn(CELL, cellClass(fl.gross))}
                      value={r.grossGrams === null ? null : r.grossGrams / GRAMS_PER_QTL}
                      onValueChange={(n) => onPatch(r.id, { grossGrams: n === null ? null : Math.round(n * GRAMS_PER_QTL) })} />
                    {!dead && <Accept flag={fl.gross} label={t("scan.acceptValue")} onAccept={() => onPatch(r.id, {}, "gross")} />}
                    {!dead && fl.gross && r.grossSuggestGrams != null && (
                      <button type="button" title={t("scan.useSuggest", { v: (r.grossSuggestGrams / GRAMS_PER_QTL).toFixed(2) })}
                        className="mt-0.5 block w-full rounded bg-brand/10 px-1 text-right text-[10px] font-medium text-brand hover:bg-brand/20"
                        onClick={() => onPatch(r.id, { grossGrams: r.grossSuggestGrams! })}>
                        → {(r.grossSuggestGrams / GRAMS_PER_QTL).toFixed(2)}
                      </button>
                    )}
                  </div>
                </td>

                <td className="border-b border-line/70 px-1 py-1">
                  <div className="relative">
                    <NumberInput integer disabled={dead} title={fl.katauti?.why}
                      className={cn(CELL, cellClass(fl.katauti), r.katautiOverride === null && !fl.katauti && "text-faint")}
                      placeholder={r.derivedKatautiUnits === null ? "" : String(r.derivedKatautiUnits)}
                      value={r.katautiOverride}
                      onValueChange={(n) => onPatch(r.id, { katautiOverride: n })} />
                    {!dead && <Accept flag={fl.katauti} label={t("scan.acceptValue")} onAccept={() => onPatch(r.id, {}, "katauti")} />}
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
                      onValueChange={(n) => onPatch(r.id, { ratePaisePerQtl: n === null ? null : Math.round(n * 100) })} />
                    {!dead && canRate && <Accept flag={fl.rate} label={t("scan.acceptValue")} onAccept={() => onPatch(r.id, {}, "rate")} />}
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
