import "./_guard.ts";
/* End-to-end: one truck carrying two commodities. Each row is priced from
   its own commodity's purchase day for the mill, the rows add up to the
   mill's net, the parcha prints both with a total each, stock and the
   challan count each commodity under its own, a PO must match the row's
   commodity, and a truck with no bore has no bore labour line. */
const BASE = process.env.MANDI_API!;
let bad = 0;
const check = (label: string, ok: boolean, got?: unknown) => {
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label}${ok || got === undefined ? "" : `   ${JSON.stringify(got).slice(0, 300)}`}`);
};
let cookie = "";
const req = async (m: string, p: string, b?: unknown) => {
  const r = await fetch(BASE + p, { method: m, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const call = async (m: string, p: string, b?: unknown) => { const r = await req(m, p, b); if (r.status >= 400) throw new Error(`${m} ${p} ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
const users = (await req("GET", "/auth/users")).json;
await call("POST", "/auth/login", { userId: users.find((u: any) => u.name === "Test Owner").id, pin: process.env.MANDI_PIN ?? "482915" });
const me = await call("GET", "/auth/me");
const v = me.businesses.find((b: any) => b.shortCode === "VLDM");
if (v && me.activeBusinessId !== v.businessId) await call("POST", "/auth/switch-business", { businessId: v.businessId });
const q = (qtl: number) => Math.round(qtl * 100_000);
const rs = (r: number) => Math.round(r * 100);
const jins = await call("GET", "/jins");
const j1509 = jins.find((j: any) => j.code === "1509"), j1121 = jins.find((j: any) => j.code === "1121");
const lb = (await call("GET", "/merchants")).find((m: any) => m.code === "LB");
const sup = (await call("GET", "/adati"))[0];
const D1 = "2026-11-10", D2 = "2026-11-11";
const slip = (d: string, rst: string, j: any, gross: number, rate: number) => call("POST", "/slips", { slipDate: d, rstNo: rst, adatiId: sup.id, jinsId: j.id, merchantId: lb.id, grossGrams: q(gross), ratePaisePerQtl: rs(rate) });

console.log("Stock for two commodities");
await slip(D1, "M1", j1509, 30, 3400);                      // 1509: 29.70 net at 3400
await slip(D2, "M2", j1121, 10, 3000); await slip(D2, "M3", j1121, 20, 3200); // 1121: 9.90 + 19.80 = 29.70 net, average 3133.33
const s1121 = (await call("GET", `/stock/${lb.id}?jinsId=${j1121.id}`)).days.find((d: any) => d.date === D2);
check("the 1121 day's average is weighted: (9.90×3000 + 19.80×3200) / 29.70 = 3,133.33", s1121?.avgRatePaisePerQtl === 313333, s1121);

console.log("\nOne truck, two commodities");
const load = await call("POST", "/loads", { loadDate: "2026-11-12", merchantId: lb.id, jinsId: j1509.id, stockDate: D1, truckNo: "UP00MULTI" });
// gross 59.97 − bardana 100 katte × 0.57 kg = 0.57 → net 59.40: 29.70 of 1121 typed, the rest (29.70) is 1509
await call("PUT", `/loads/${load.id}`, { millGrossGrams: q(59.97), katteCount: 100, boreCount: 0, advancePaise: 0, daraPaise: 0, invoiceNo: "901", invoiceDate: "2026-11-12" });
const line2 = await call("POST", `/loads/${load.id}/lines`, { stockDate: D2, jinsId: j1121.id, netGrams: q(29.70) });
let st = await call("GET", `/loads/${load.id}`);
const rowOf = (code: string) => st.lines.find((x: any) => x.jinsCode === code);
check("the truck lists both commodities", st.jinsList.map((j: any) => j.code).join("+") === "1509+1121", st.jinsList);
check("the 1121 row is priced from the 1121 day (3,133.33), the 1509 row from the 1509 day (3,400)", rowOf("1121")?.ratePaisePerQtlUsed === 313333 && rowOf("1509")?.ratePaisePerQtlUsed === 340000, st.lines.map((x: any) => [x.jinsCode, x.ratePaisePerQtlUsed]));
check("the 1509 row takes the rest of the mill net: 29.70", rowOf("1509")?.weightGrams === q(29.70) && rowOf("1509")?.weightIsRest, rowOf("1509"));
const sj = (code: string) => st.stockByJins.find((x: any) => x.jinsCode === code);
check("each commodity's stock is its own: all 1121 taken (0.00 left), 1509 untouched by the 1121 row", sj("1121")?.leftGrams === 0 && sj("1121")?.thisTruckGrams === q(29.70) && sj("1509")?.thisTruckGrams === q(29.70) && sj("1509")?.leftGrams === sj("1509")?.boughtNetGrams - sj("1509")?.otherTrucksGrams - q(29.70), st.stockByJins);
check("nothing blocks approval", st.blockers.length === 0, st.blockers);
check("no bore on the truck: no bore labour line on the parcha", !st.doc.result.lines.some((l: any) => l.key === "labour2"), st.doc.result.lines.map((l: any) => l.key));
check("…but the katte labour and sutli are there", st.doc.result.lines.some((l: any) => l.key === "labour1") && st.doc.result.lines.some((l: any) => l.key === "sutli"));
const goods = q(29.70) / 100_000 * 313333 + q(29.70) / 100_000 * 340000;
check("goods = 29.70 × 3133.33 + 29.70 × 3400", Math.abs(st.doc.totals.goodsPaise - goods) < 2, { doc: st.doc.totals.goodsPaise, byHand: goods });
check("the parcha carries a line per commodity", st.doc.lines.map((l: any) => l.jinsCode).sort().join("+") === "1121+1509", st.doc.lines);

console.log("\nA PO must match the row's commodity");
const po1121 = await call("POST", "/orders", { merchantId: lb.id, jinsId: j1121.id, poDate: D2, qtyGrams: q(30) });
const po1509 = await call("POST", "/orders", { merchantId: lb.id, jinsId: j1509.id, poDate: D1, qtyGrams: q(30) });
check("a 1509 PO on the 1121 row is refused", (await req("PUT", `/loads/${load.id}/lines/${line2.id}`, { poId: po1509.id })).json?.code === "po_jins");
check("the 1121 PO on the 1121 row is taken", (await req("PUT", `/loads/${load.id}/lines/${line2.id}`, { poId: po1121.id })).status === 200);
st = await call("GET", `/loads/${load.id}`);
check("the PO balance counts this row: 30 − 29.70 = 0.30 left", st.pos.find((p: any) => p.id === po1121.id)?.balanceGrams === q(0.30), st.pos);
check("changing the row to 1509 drops the 1121 PO", (await call("PUT", `/loads/${load.id}/lines/${line2.id}`, { jinsId: j1509.id })) && (await call("GET", `/loads/${load.id}`)).lines.find((x: any) => x.id === line2.id).poId === null);
await call("PUT", `/loads/${load.id}/lines/${line2.id}`, { jinsId: j1121.id, stockDate: D2, poId: po1121.id });

console.log("\nApproved: the parcha, stock, challan and dashboard count each commodity under its own");
st = await call("GET", `/loads/${load.id}`);
const ap = await req("POST", `/loads/${load.id}/approve`, { expectedGrandTotalPaise: st.doc.result.grandTotalPaise });
check("the parcha is approved", ap.status === 200, ap.json);
const stock1121 = (await call("GET", `/stock/${lb.id}?jinsId=${j1121.id}`)).days.find((d: any) => d.date === D2);
const stock1509 = (await call("GET", `/stock/${lb.id}?jinsId=${j1509.id}`)).days.find((d: any) => d.date === D1);
check("stock: 1121 of the 11th loaded 29.70, nothing left", stock1121?.loadedNet === q(29.70) && stock1121?.stockNet === 0, stock1121);
check("stock: 1509 of the 10th loaded 29.70, nothing left", stock1509?.loadedNet === q(29.70) && stock1509?.stockNet === 0, stock1509);
const ch = (await call("GET", `/challan?merchantId=${lb.id}`)).rows.find((r: any) => r.truckNo === "UP00MULTI");
check("the challan names both commodities on the truck", ch?.jinsCode === "1509 + 1121", ch?.jinsCode);
const ch1121 = (await call("GET", `/challan?merchantId=${lb.id}&jinsId=${j1121.id}`)).rows.find((r: any) => r.truckNo === "UP00MULTI");
check("filtered to 1121, the truck shows only its 1121 weight and value", ch1121?.weightGrams === q(29.70) && ch1121?.goodsPaise === Math.round(q(29.70) / 100_000 * 313333), ch1121);
const chAll = await call("GET", `/challan?merchantId=${lb.id}`);
const truck196 = chAll.rows.find((r: any) => r.parchaNo === "196");
const doc196 = truck196 ? (await call("GET", `/loads/${truck196.loadId}`)).approved?.doc : null;
check("the challan shows the freight advance the parcha recovers from the mill", Boolean(truck196) && truck196.advancePaise === doc196?.result.advancePaise && truck196.advancePaise > 0, { challan: truck196?.advancePaise, parcha: doc196?.result.advancePaise });
check("…and adds the advances up", chAll.totals.advancePaise === chAll.rows.reduce((s: number, r: any) => s + (r.advancePaise ?? 0), 0));
const list = (await call("GET", "/loads")).find((r: any) => r.id === load.id);
check("the truck list shows 1509 + 1121", list?.jinsCodes.join(" + ") === "1509 + 1121", list?.jinsCodes);
const bc = await call("GET", "/audit/books-check");
check("the books check still re-works every figure", bc.problems === 0, bc.businesses[0]?.sections.flatMap((s: any) => s.lines.filter((l: any) => l.ok === false).map((l: any) => l.text)));

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
