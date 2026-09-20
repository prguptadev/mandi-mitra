/* Dev helper: creates a scan sitting in "review" with a simulated reading,
 * so the review screen can be exercised without spending a Gemini call.
 * Usage: npx tsx scripts/dev-make-review-scan.ts
 */
import { sqlite } from "../server/db/client.ts";
const BASE = "http://localhost:8787/api";
let cookie = "";
async function call(m: string, p: string, b?: unknown) {
  const r = await fetch(BASE + p, { method: m, headers: { "Content-Type": "application/json", ...(cookie?{cookie}:{}) }, body: b===undefined?undefined:JSON.stringify(b) });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  return JSON.parse(await r.text());
}
const users = await call("GET", "/auth/users");
await call("POST", "/auth/login", { userId: users.find((u:any)=>u.name==="Test Owner").id, pin: "482915" });
const grm = (await call("GET","/merchants")).find((m:any)=>m.code==="GRM");
const j = (await call("GET","/jins")).find((x:any)=>x.code==="1509");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==","base64");
const fd = new FormData();
fd.append("files", new File([PNG], "sheet.png", { type: "image/png" }));
fd.append("slipDate", "2026-09-22"); fd.append("merchantId", grm.id); fd.append("jinsId", j.id);
const up = await fetch(`${BASE}/scans`, { method:"POST", body: fd, headers:{cookie} });
const { id } = await up.json() as any;
const OCR = [
  ["626","फूलसिंह वर्मा",19.20,19,19.01,3500,0.94,false],
  ["627","फुलसिह वर्मा",19.70,20,19.50,3525,0.71,false],
  ["631","अज्ञात नाम",9.95,10,9.85,3480,0.52,false],
  ["632","वीरेन्द्र जोशी",32.50,33,32.17,3500,0.88,false],
  ["638","अरुण कुमार यादव",19.20,19,19.91,3500,0.83,false],
  ["644","सहदेव सिंह ट्रेडिंग",40.40,40,40.00,null,0.80,false],
  ["634","शिवम ट्रेडिंग",41.25,41,40.84,3550,0.86,true],
] as const;
const rows = OCR.map(([rst,name,g,k,n,rate,conf,struck],i)=>({
  id:`r${i}`, ocr:{rstNo:rst,adatiName:name,grossQtl:g,katauti:k,netQtl:n,rate,confidence:conf,struckThrough:struck},
  rstNo:rst, adatiId:null, adatiRawText:name, grossGrams:Math.round((g as number)*100000),
  katautiOverride:null, ratePaisePerQtl: rate===null?null:Math.round((rate as number)*100),
  excluded: struck===true, nameCorrected:false,
}));
sqlite.prepare("update scan_batches set parsed_rows=?, status='review', model='gemini-2.5-flash', tokens_in=2841, tokens_out=1190 where id=?").run(JSON.stringify(rows), id);
console.log(id);
