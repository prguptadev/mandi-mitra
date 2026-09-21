/* Repro for "only the first suggestion fills": four unmatched rows, each with
   a suggestion, on the owner's real sheet image. */
import fs from "node:fs";
import path from "node:path";
import { sqlite } from "../server/db/client.ts";
import { uuidv7 } from "uuidv7";

const biz = (sqlite.prepare("select id from businesses where short_code='VLDM'").get() as any).id;
const grm = (sqlite.prepare("select id from merchants where business_id=? and code='GRM'").get(biz) as any).id;
const j = (sqlite.prepare("select id from jins where business_id=? and code='1509'").get(biz) as any).id;
const src = "data/scans/01a0bf73-255a-7bb8-88c4-70e2b80daefa/00.jpg";

const id = uuidv7();
fs.mkdirSync(path.resolve("data/scans", id), { recursive: true });
fs.copyFileSync(src, path.resolve("data/scans", id, "00.jpg"));
const bytes = fs.statSync(src).size;

const names = [["701", "अरुण यादव", 19.2], ["702", "वीरेंद जोसी", 17.3], ["703", "धरमपाल", 11.3], ["704", "रामपाल यादव", 32.5]] as const;
const rows = names.map(([rst, name, g], i) => ({
  id: `r${i}`,
  ocr: { rstNo: rst, adatiName: name, grossQtl: g, katauti: Math.floor(g + 0.5),
         netQtl: +(g - Math.floor(g + 0.5) / 100).toFixed(2), rate: 3500, confidence: 0.9, struckThrough: false },
  rstNo: rst, adatiId: null, adatiRawText: name,
  grossGrams: Math.round(g * 100000), katautiOverride: null,
  ratePaisePerQtl: 350000, excluded: false, nameCorrected: false,
}));
const now = Math.floor(Date.now() / 1000);
sqlite.prepare(`insert into scan_batches (id,business_id,source_kind,file_paths,slip_date,merchant_id,jins_id,model,parsed_rows,status,created_at)
  values (?,?,?,?,?,?,?,?,?,?,?)`).run(
  id, biz, "upload", JSON.stringify([{ name: "00.jpg", mimeType: "image/jpeg", bytes }]),
  "2026-09-25", grm, j, "repro", JSON.stringify(rows), "review", now);
console.log(id);
