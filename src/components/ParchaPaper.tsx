import type { ParchaDoc } from "@/lib/api.ts";
import { printedLabel, indianMoney, qtl2, dmy, partyHeading, roundOffPaise, paperShowsDara } from "@server/lib/parchaLabels.ts";
import { cn } from "@/lib/utils.ts";

/* The kaccha parcha as it prints: the same boxes, order and wording as the
   owner's own invoice 196, black on white whatever the screen theme is.
   Only this element prints (see .print-area in index.css). */

const B = "border border-black";
const cellL = cn(B, "px-2 py-[3px] text-left");
const cellR = cn(B, "px-2 py-[3px] text-right tabular-nums");
const cellC = cn(B, "px-2 py-[3px] text-center");
const head = "font-bold";

export function ParchaPaper({ doc, draft, voided, className }: { doc: ParchaDoc; draft?: boolean; voided?: boolean; className?: string }) {
  const w = doc.weights;
  const r = doc.result;
  const advSubtract = doc.config.advance.treatment === "subtract";
  const roundOff = roundOffPaise(r, doc.config);
  const lines = [...doc.lines];
  const blanks = Math.max(0, 2 - lines.length);
  // two or three commodities on one truck: a total line for each, before the truck's total
  const codes = [...new Set(lines.map((l) => l.jinsCode))];
  const perJins = codes.length > 1 ? codes.map((code) => {
    const mine = lines.filter((l) => l.jinsCode === code);
    const netGrams = mine.reduce((s, l) => s + l.netGrams, 0);
    const amountPaise = mine.reduce((s, l) => s + l.amountPaise, 0);
    return { code, netGrams, amountPaise, rate: netGrams ? Math.round((amountPaise * 100_000) / netGrams) : 0 };
  }) : [];
  const charges = r.lines.filter((l) => l.kind !== "goods" && l.kind !== "total" && l.key !== "dara" && l.key !== "advance");
  const money = (p: number) => indianMoney(p);
  // every amount inside the grand total is printed: a dara added to it shows even where the mill's layout hides the row
  const daraShown = paperShowsDara(r, doc.config);
  // a truck approved again after a void: this paper replaces the one given before (older parchas carry only the version)
  const revision = doc.revision ?? doc.version;

  return (
    <div className={cn("parcha-paper relative mx-auto w-full max-w-[720px] bg-white p-6 text-[12.5px] leading-tight text-black", className)}
      style={{ fontFamily: "Calibri, 'Segoe UI', Arial, sans-serif" }}>
      {(draft || voided) && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center overflow-hidden">
          <span className={cn("rotate-[-24deg] select-none text-[72px] font-black tracking-widest", voided ? "text-black/[0.16]" : "text-black/[0.07]")}>
            {voided ? "VOID" : "DRAFT"}
          </span>
        </div>
      )}
      <table className="w-full border-collapse">
        <colgroup>
          {[10, 11, 13, 12, 12, 16, 12, 14].map((pct, i) => <col key={i} style={{ width: `${pct}%` }} />)}
        </colgroup>
        <tbody>
          <tr><td colSpan={8} className={cn(cellC, "py-1.5 text-[19px] font-bold tracking-wide")} style={{ fontFamily: "'Times New Roman', serif" }}>{doc.title}</td></tr>
          <tr>
            <td colSpan={4} className={cn(cellC, "h-[74px] text-[15px] font-semibold")}>{partyHeading(doc.business)}</td>
            <td colSpan={4} className={cn(cellC, "text-[15px] font-semibold")}>{partyHeading(doc.mill)}</td>
          </tr>
          <tr>
            <td colSpan={2} className={cn(cellL, head)}>TRUCK NO:-</td>
            <td colSpan={3} className={cellC}>{doc.truckNo ?? ""}</td>
            <td colSpan={3} rowSpan={2} className={cn(cellC, "text-[15px] font-bold")}>INVOICE NO:-</td>
          </tr>
          <tr>
            <td colSpan={2} className={cn(cellL, head)}>DHARAM KANTA</td>
            <td colSpan={3} className={cellR}>{qtl2(w.grossGrams)}</td>
          </tr>
          <tr>
            <td colSpan={2} className={cn(cellL, head)}>BARDANA WEIGHT</td>
            <td colSpan={3} className={cellR}>{qtl2(w.bardanaGrams)}</td>
            <td colSpan={3} rowSpan={2} className={cn(cellC, "text-[17px]")}>
              {doc.invoiceNo ?? ""}
              {revision > 1 && (
                <span className="block text-[11px] font-bold tracking-wide">REVISED ({revision}){doc.revisedOn ? ` ${dmy(doc.revisedOn)}` : ""}</span>
              )}
            </td>
          </tr>
          <tr>
            <td colSpan={2} className={cn(cellL, head)}>NET WEIGHT</td>
            <td colSpan={3} className={cellR}>{qtl2(w.netGrams)}</td>
          </tr>
          <tr>
            <td rowSpan={2} className={cn(cellC, head)}>BAGS</td>
            <td className={cn(cellC, head)}>KATTE</td>
            <td colSpan={2} className={cn(cellC, head)}>BORE</td>
            <td colSpan={2} className={cn(cellC, head)}>KATTE BARDANA</td>
            <td colSpan={2} className={cn(cellC, head)}>BORE BARDANA</td>
          </tr>
          <tr>
            <td className={cellC}>{w.katte || ""}</td>
            <td colSpan={2} className={cellC}>{w.bore || ""}</td>
            <td colSpan={2} className={cellR}>{qtl2(w.katteBardanaGrams)}</td>
            <td colSpan={2} className={cellR}>{w.boreBardanaGrams ? qtl2(w.boreBardanaGrams) : "0"}</td>
          </tr>
          <tr>
            <td colSpan={6} className={cn(cellC, head)}>WEIGHT DETAILS</td>
            <td colSpan={2} rowSpan={2} className={cn(cellC, "text-[14px] font-bold")}>INVOICE DATE</td>
          </tr>
          <tr>
            {["PO", "JEANS", "DATE", "WEIGHT", "RATE", "AMOUNT"].map((h) => <td key={h} className={cn(cellC, head)}>{h}</td>)}
          </tr>
          {lines.map((l, i) => (
            <tr key={i}>
              <td className={cellC}>{l.po}</td>
              <td className={cellC}>{l.jinsCode}</td>
              <td className={cellC}>{dmy(l.date)}</td>
              <td className={cellR}>{qtl2(l.netGrams)}</td>
              <td className={cellR}>{money(l.ratePaisePerQtl)}</td>
              <td className={cellR}>{money(l.amountPaise)}</td>
              {i === 0 && <td colSpan={2} rowSpan={lines.length + blanks + perJins.length} className={cn(cellC, "text-[16px] font-bold")}>{dmy(doc.invoiceDate)}</td>}
            </tr>
          ))}
          {perJins.map((x) => (
            <tr key={`j${x.code}`}>
              <td colSpan={3} className={cn(cellC, "font-semibold")}>TOTAL {x.code}</td>
              <td className={cn(cellR, "font-semibold")}>{qtl2(x.netGrams)}</td>
              <td className={cellR}>{money(x.rate)}</td>
              <td className={cn(cellR, "font-semibold")}>{money(x.amountPaise)}</td>
            </tr>
          ))}
          {Array.from({ length: blanks }, (_, i) => (
            <tr key={`b${i}`}>
              <td className={cellC}>{lines.length + i + 1}</td>
              <td className={cellC} /><td className={cellC} />
              <td className={cellR}>-</td><td className={cellR} /><td className={cellR}>-</td>
            </tr>
          ))}
          <tr>
            <td colSpan={3} className={cn(cellC, head)}>TOTAL AMOUNT</td>
            <td className={cellR}>{qtl2(doc.totals.netGrams)}</td>
            <td className={cellR}>{money(doc.totals.ratePaisePerQtl)}</td>
            <td className={cellR}>{money(doc.totals.goodsPaise)}</td>
            <td colSpan={2} className={B} />
          </tr>
          {charges.map((l) => {
            const total = l.kind === "subtotal";
            const zero = l.kind === "charge" && l.amountPaise === 0;
            return (
              <tr key={l.key}>
                <td colSpan={5} className={cn(total ? cellC : cellL, total && head)}>{total ? "TOTAL AMOUNT" : printedLabel(l)}</td>
                <td colSpan={3} className={cn(cellR, total && head)}>
                  {zero ? "-" : (l.sign === "subtract" ? "-" : "") + money(l.amountPaise)}
                </td>
              </tr>
            );
          })}
          {roundOff !== 0 && (
            <tr>
              <td colSpan={5} className={cellL}>ROUND OFF</td>
              <td colSpan={3} className={cellR}>{(roundOff > 0 ? "+" : "-") + money(Math.abs(roundOff))}</td>
            </tr>
          )}
          <tr>
            <td colSpan={5} className={cn(cellC, head)}>{doc.config.dara.includeInGrandTotal ? "TOTAL DARA (IN GRAND TOTAL)" : "TOTAL DARA"}</td>
            <td className={cn(cellL, head)}>{advSubtract ? "LESS ADVANCE" : "ADVANCE"}</td>
            <td colSpan={2} className={cellR}>{r.advancePaise && doc.config.advance.treatment !== "exclude" ? (advSubtract ? "-" : "") + money(r.advancePaise) : "-"}</td>
          </tr>
          <tr>
            <td colSpan={5} className={cn(cellR, "h-9")}>{daraShown ? money(r.daraPaise) : "-"}</td>
            <td className={cn(cellL, head)}>GRAND TOTAL</td>
            <td colSpan={2} className={cn(cellR, "text-[14px] font-bold")}>{money(r.grandTotalPaise)}</td>
          </tr>
        </tbody>
      </table>
      {doc.ewayBillNo && <p className="mt-2 text-[11px]">E-way bill: {doc.ewayBillNo}</p>}
    </div>
  );
}
