/* Two-page scan on the owner's real sheet image, for exercising the page
 * order step ("uploaded") or the grouped grid ("review").
 * Usage: npx tsx scripts/dev-two-page-scan.ts [uploaded|review]
 */
import fs from "node:fs";
import path from "node:path";
import { uuidv7 } from "uuidv7";
import { sqlite } from "../server/db/client.ts";

const mode = process.argv[2] === "review" ? "review" : "uploaded";
const biz = (sqlite.prepare("select id from businesses where short_code='VLDM'").get() as any).id;
const grm = (sqlite.prepare("select id from merchants where business_id=? and code='GRM'").get(biz) as any).id;
const j = (sqlite.prepare("select id from jins where business_id=? and code='1509'").get(biz) as any).id;
const src = "data/scans/01a0bf73-255a-7bb8-88c4-70e2b80daefa/00.jpg";

const id = uuidv7();
const dir = path.resolve("data/scans", id);
fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(src, path.join(dir, "00.jpg"));
fs.copyFileSync(src, path.join(dir, "01.jpg"));
const bytes = fs.statSync(src).size;
const files = [{ name: "00.jpg", mimeType: "image/jpeg", bytes }, { name: "01.jpg", mimeType: "image/jpeg", bytes }];

const page1 = [["626", "फूलसिंह वर्मा", 19.2, 3500], ["627", "फूलसिंह वर्मा", 19.7, 3525], ["1474", "राकेश वर्मा", 8.7, 3480]] as const;
const page2 = [["705", "शिवम ट्रेडिंग", 23.85, 3631], ["710", "अमित ट्रेडिंग", 13.4, 3450]] as const;
const mk = (list: readonly (readonly [string, string, number, number])[], page: number, off: number) =>
  list.map(([rst, name, g, rate], i) => ({
    id: `r${off + i}`, page,
    ocr: { rstNo: rst, adatiName: name, grossQtl: g, katauti: Math.floor(g + 0.5),
           netQtl: +(g - Math.floor(g + 0.5) / 100).toFixed(2), rate, confidence: 0.92, struckThrough: false },
    rstNo: rst, adatiId: null, adatiRawText: name, grossGrams: Math.round(g * 100000),
    katautiOverride: null, ratePaisePerQtl: rate * 100, excluded: false, nameCorrected: false,
  }));
const rows = [...mk(page1, 1, 0), ...mk(page2, 2, 3)];

sqlite.prepare(`insert into scan_batches (id,business_id,source_kind,file_paths,slip_date,merchant_id,jins_id,model,parsed_rows,status,created_at)
  values (?,?,?,?,?,?,?,?,?,?,?)`).run(
  id, biz, "upload", JSON.stringify(files), "2026-09-26", grm, j,
  mode === "review" ? "gemini-2.5-flash" : null,
  mode === "review" ? JSON.stringify(rows) : null, mode, Math.floor(Date.now() / 1000));
console.log(id);
