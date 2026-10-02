import "./_guard.ts";
import path from "node:path";
import Database from "better-sqlite3";
/* End-to-end: one scanned sheet, or the same slips, added on two computers.
 * Runs after e2e-cloud.ts, on the computers it leaves joined to the fake
 * cloud (A and B), with test databases only. Every sheet is put in as if the
 * reader had read it (as e2e-scan-review does), so no read is spent.
 * Run through: npm run test:e2e
 */
const PG = process.env.MANDI_FAKE_PG!;
const PG_SWITCH = `http://127.0.0.1:${Number(new URL(PG).port) + 2000}`;
const PIN = process.env.MANDI_PIN ?? "482915";
let bad = 0;
const check = (label: string, ok: boolean, got?: unknown) => {
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label}${ok || got === undefined ? "" : `   ${JSON.stringify(got)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const internet = (on: boolean) => fetch(`${PG_SWITCH}/${on ? "up" : "down"}`);

function computer(name: string, base: string, dir: string) {
  let cookie = "";
  async function raw(method: string, p: string, body?: unknown, form?: FormData) {
    const res = await fetch(base + p, {
      method, headers: { ...(form ? {} : { "Content-Type": "application/json" }), ...(cookie ? { cookie } : {}) },
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
  async function call(method: string, p: string, body?: unknown, form?: FormData) {
    const r = await raw(method, p, body, form);
    if (r.status >= 400) throw new Error(`${name}: ${method} ${p} -> ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  }
  function q<T = any>(sql: string, ...args: unknown[]): T[] {
    const d = new Database(path.join(dir, "mandi.db"), { readonly: true });
    try { return d.prepare(sql).all(...args) as T[]; } finally { d.close(); }
  }
  /** A write straight into this computer's books, as a reader or an older version would leave it (the sync triggers see it). */
  function w(sql: string, ...args: unknown[]) {
    const d = new Database(path.join(dir, "mandi.db"));
    try { d.pragma("busy_timeout = 5000"); return d.prepare(sql).run(...args); } finally { d.close(); }
  }
  async function login(user = "Test Owner", pin = PIN) {
    cookie = "";
    const users = await call("GET", "/auth/users");
    const u = users.find((x: any) => x.name === user);
    if (!u) throw new Error(`${name}: nobody called ${user}`);
    await call("POST", "/auth/login", { userId: u.id, pin });
    const me = await call("GET", "/auth/me");
    const vldm = me.businesses.find((b: any) => b.shortCode === "VLDM");
    if (vldm && me.activeBusinessId !== vldm.businessId) await call("POST", "/auth/switch-business", { businessId: vldm.businessId });
    return me;
  }
  const sync = () => call("POST", "/cloud/sync");
  return { name, raw, call, q, w, login, sync };
}
type PC = ReturnType<typeof computer>;
const A = computer("A", process.env.MANDI_API!, process.env.MANDI_DATA_DIR!);
const B = computer("B", process.env.MANDI_API_B!, process.env.MANDI_DATA_DIR_B!);
const BOTH = [A, B];

/** Sync both computers until a whole round moves nothing. */
async function settle() {
  for (let round = 0; round < 6; round++) {
    let moved = 0;
    for (const x of BOTH) { const r = await x.sync(); moved += r.pushed + r.pulled; }
    if (!moved) return round;
  }
  return -1;
}

/* A fake sheet picture: a real 1x1 PNG, made unique by a tag after its end. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const picture = (tag: string) => Buffer.concat([PNG, Buffer.from(tag.padEnd(64, "."))]);

type Line = { rst: string; name: string; grossQtl: number; rate: number; page?: number; row?: number };
let refs: { grm: string; j1509: string };
async function upload(x: PC, pics: Buffer[], date: string) {
  const fd = new FormData();
  for (const [i, p] of pics.entries()) fd.append("files", new File([p], `page-${i + 1}.png`, { type: "image/png" }));
  fd.append("slipDate", date);
  fd.append("merchantId", refs.grm);
  fd.append("jinsId", refs.j1509);
  return x.call("POST", "/scans", undefined, fd) as Promise<{ id: string; pages: number; samePictures: number }>;
}
/** As if the reader had read every page: the sheet waits for review. */
function putReading(x: PC, scanId: string, lines: Line[]) {
  const rows = lines.map((r, i) => ({
    id: `r${r.row ?? i}`, page: r.page ?? 1,
    ocr: { rstNo: r.rst, adatiName: r.name, grossQtl: r.grossQtl, katauti: Math.round(r.grossQtl), netQtl: null, rate: r.rate, confidence: 0.95, struckThrough: null },
    rstNo: r.rst, adatiId: null, adatiRawText: r.name, grossGrams: Math.round(r.grossQtl * 100_000),
    katautiOverride: null, ratePaisePerQtl: Math.round(r.rate * 100), excluded: false, nameCorrected: false, modelPick: null,
  }));
  x.w("update scan_batches set parsed_rows = ?, status = 'review', model = 'simulated', pages_done = json_array_length(file_paths) where id = ?", JSON.stringify(rows), scanId);
}
const commit = (x: PC, scanId: string) => x.raw("POST", `/scans/${scanId}/commit`, {});
const statusOf = (x: PC, scanId: string) => x.q<{ status: string }>("select status from scan_batches where id = ?", scanId)[0]?.status;
/** The sheet's slips on one computer, every field that carries a figure, in id order. */
const slipsOf = (x: PC, scanId: string) => x.q<Record<string, unknown>>(
  `select id, slip_date, rst_no, adati_id, gross_grams, katauti_units, net_grams, rate_paise_per_qtl, amount_paise,
          commission_paise, gaushala_paise, payable_paise, created_at, updated_at
     from purchase_slips where scan_batch_id = ? order by id`, scanId);
const grams = (x: PC, scanId: string) => slipsOf(x, scanId).reduce((s, r) => s + Number(r.gross_grams), 0);
async function day(x: PC, date: string) {
  const d = await x.call("GET", `/slips?date=${date}`);
  return {
    rows: d.totals.rows as number, grossGrams: d.totals.grossGrams as number, payablePaise: d.totals.payablePaise as number,
    repeated: d.rows.filter((r: any) => (r.rstDay ?? 1) > 1).map((r: any) => r.rstNo) as string[],
    order: d.rows.map((r: any) => r.rstNo) as string[], ids: d.rows.map((r: any) => r.id) as string[],
  };
}
/** Confirms every page check still open, as the operator would before pressing Add. */
async function confirmPages(x: PC, scanId: string) {
  const v = await x.call("GET", `/scans/${scanId}`);
  for (const p of (v.pageChecks ?? []).filter((p: any) => !p.confirmed)) {
    await x.raw("PUT", `/scans/${scanId}/page-confirm`, { page: p.page, what: String(p.code).replace(/^page_/, ""), on: true });
  }
}

try {
  await internet(true);
  await A.login();
  await B.login();
  const mills = await A.call("GET", "/merchants");
  const jins = await A.call("GET", "/jins");
  refs = { grm: mills.find((m: any) => m.code === "GRM").id, j1509: jins.find((j: any) => j.code === "1509").id };
  const KNOWN = ["स्कैन सिंक रामपाल", "स्कैन सिंक श्यामलाल", "स्कैन सिंक मोहनलाल"];
  for (const n of KNOWN) await A.call("POST", "/adati", { nameHi: n });
  await settle();

  console.log("\nThe same sheet added on two computers while one is out of step");
  const D1 = "2026-09-14";
  const L1: Line[] = [
    { rst: "1101", name: KNOWN[0], grossQtl: 20.00, rate: 3400 },
    { rst: "1102", name: KNOWN[1], grossQtl: 10.50, rate: 3450 },
    { rst: "1103", name: KNOWN[2], grossQtl: 5.00, rate: 3500 },
  ];
  const s1 = await upload(A, [picture("e2e-sync-scans-1")], D1);
  putReading(A, s1.id, L1);
  await settle();
  check("the other computer sees the sheet waiting", statusOf(B, s1.id) === "review", statusOf(B, s1.id));
  const a1 = await commit(A, s1.id);
  check("A adds it", a1.status === 200 && a1.json.created === 3, a1.json);
  await A.sync();
  await internet(false);
  const b1 = await commit(B, s1.id);
  check("B, offline, has not heard and adds it too", b1.status === 200 && b1.json.created === 3, b1.json);
  await internet(true);
  await settle();
  for (const x of BOTH) {
    const s = slipsOf(x, s1.id);
    check(`  ...${x.name} holds each line once: 3 slips, 35.50 qtl`, s.length === 3 && grams(x, s1.id) === 3_550_000, { slips: s.length, grams: grams(x, s1.id) });
    const d = await day(x, D1);
    check(`  ...${x.name}'s daily list: 3 rows, no RST twice, in the sheet's order`,
      d.rows === 3 && d.grossGrams === 3_550_000 && d.repeated.length === 0 && d.order.join() === "1101,1102,1103", d);
    check(`  ...${x.name} shows the sheet as added`, statusOf(x, s1.id) === "committed", statusOf(x, s1.id));
  }
  check("  ...both computers hold the very same slips, field for field", JSON.stringify(slipsOf(A, s1.id)) === JSON.stringify(slipsOf(B, s1.id)),
    { A: slipsOf(A, s1.id).map((r) => `${r.rst_no}:${r.id}`), B: slipsOf(B, s1.id).map((r) => `${r.rst_no}:${r.id}`) });
  const again1 = await commit(A, s1.id);
  check("adding it again says it is already on the daily list", again1.status === 409 && again1.json.code === "already_committed", again1.json);

  console.log("\nThe same sheet with new names, added on both computers while both are offline");
  const D2 = "2026-09-16";
  const L2: Line[] = [
    { rst: "1401", name: "स्कैन सिंक नया एक", grossQtl: 20.00, rate: 3400 },
    { rst: "1402", name: "स्कैन सिंक नया दो", grossQtl: 10.50, rate: 3450 },
  ];
  const s2 = await upload(A, [picture("e2e-sync-scans-2")], D2);
  putReading(A, s2.id, L2);
  await settle();
  await internet(false);
  const a2 = await commit(A, s2.id);
  const b2 = await commit(B, s2.id);
  check("each computer adds it on its own", a2.status === 200 && b2.status === 200, { A: a2.json, B: b2.json });
  await internet(true);
  await settle();
  for (const x of BOTH) {
    const d = await day(x, D2);
    check(`  ...${x.name}: 2 slips, 30.50 qtl, RST 1401 once — nothing doubled, so nothing to clean up twice`,
      slipsOf(x, s2.id).length === 2 && d.rows === 2 && d.grossGrams === 3_050_000 && d.repeated.length === 0, { slips: slipsOf(x, s2.id).length, ...d });
  }
  check("  ...the same slips on both computers", JSON.stringify(slipsOf(A, s2.id)) === JSON.stringify(slipsOf(B, s2.id)));
  check("  ...and the same day's money on both", JSON.stringify(await day(A, D2)) === JSON.stringify(await day(B, D2)));

  console.log("\n'Rows checked' ticked on one computer just as the other adds the sheet");
  const D3 = "2026-09-17";
  const L3: Line[] = [
    { rst: "1501", name: KNOWN[0], grossQtl: 20.00, rate: 3400 },
    { rst: "1502", name: KNOWN[1], grossQtl: 10.50, rate: 3450 },
  ];
  const s3 = await upload(A, [picture("e2e-sync-scans-3")], D3);
  putReading(A, s3.id, L3);
  await settle();
  check("A adds the sheet", (await commit(A, s3.id)).status === 200);
  await A.sync();
  const tick = await B.raw("PUT", `/scans/${s3.id}/page-confirm`, { page: 1, what: "rows", on: true });
  check("B, not yet pulled, ticks page 1 'rows checked'", tick.status === 200, tick.json);
  await B.sync();
  await A.sync();
  await settle();
  for (const x of BOTH) {
    const v = await x.call("GET", `/scans/${s3.id}`);
    check(`  ...${x.name}'s review still says it is added`, v.status === "committed", { status: v.status });
  }
  await confirmPages(A, s3.id);
  const again3 = await commit(A, s3.id);
  check("  ...and Add again is refused: already on the daily list", again3.status === 409 && again3.json.code === "already_committed", again3.json);
  await settle();
  for (const x of BOTH) {
    const d = await day(x, D3);
    check(`  ...${x.name}: 2 rows, 30.50 qtl, nothing doubled`, d.rows === 2 && d.grossGrams === 3_050_000 && d.repeated.length === 0, d);
    check(`  ...${x.name}'s books count the sheet as added, not waiting`, statusOf(x, s3.id) === "committed", statusOf(x, s3.id));
  }

  const D4 = "2026-09-18";
  const s4 = await upload(A, [picture("e2e-sync-scans-4")], D4);
  putReading(A, s4.id, [{ rst: "1601", name: KNOWN[2], grossQtl: 20.00, rate: 3400 }]);
  await settle();
  await internet(false);
  await B.raw("PUT", `/scans/${s4.id}/page-confirm`, { page: 1, what: "rows", on: true });
  await sleep(1100);
  check("the tick made a second before the Add on the other computer", (await commit(A, s4.id)).status === 200);
  await internet(true);
  await A.sync(); await B.sync(); await A.sync();
  await settle();
  for (const x of BOTH) {
    check(`  ...${x.name}: the sheet stays added, with its one slip`, statusOf(x, s4.id) === "committed" && slipsOf(x, s4.id).length === 1,
      { status: statusOf(x, s4.id), slips: slipsOf(x, s4.id).length });
  }

  console.log("\nA sheet's lines keep the sheet's order on both computers");
  const D5 = "2026-10-04";
  // pages put in order after reading: the lines read first now sit on page 2
  const s5 = await upload(A, [picture("e2e-sync-scans-5a"), picture("e2e-sync-scans-5b")], D5);
  putReading(A, s5.id, [
    { rst: "2702", name: KNOWN[0], grossQtl: 10.00, rate: 3400, page: 2, row: 0 },
    { rst: "2703", name: KNOWN[1], grossQtl: 11.00, rate: 3400, page: 2, row: 1 },
    { rst: "2701", name: KNOWN[2], grossQtl: 12.00, rate: 3400, page: 1, row: 2 },
  ]);
  await confirmPages(A, s5.id);
  const a5 = await commit(A, s5.id);
  check("a two-page sheet is added", a5.status === 200 && a5.json.created === 3, a5.json);
  await settle();
  for (const x of BOTH) {
    const d = await day(x, D5);
    check(`  ...${x.name} lists page 1 first, then page 2`, d.order.join() === "2701,2702,2703", d.order);
  }

  console.log("\nSlips typed in the same second on two computers");
  const D6 = "2026-10-03";
  const sup = (await A.call("GET", "/adati")).find((s: any) => s.nameHi === KNOWN[0]);
  await internet(false);
  const ta = await A.call("POST", "/slips", { slipDate: D6, rstNo: "1331", adatiId: sup.id, jinsId: refs.j1509, merchantId: refs.grm, grossGrams: 2_000_000, ratePaisePerQtl: 340_000 });
  const tb = await B.call("POST", "/slips", { slipDate: D6, rstNo: "1331", adatiId: sup.id, jinsId: refs.j1509, merchantId: refs.grm, grossGrams: 1_500_000, ratePaisePerQtl: 340_000 });
  // the very same second on both
  const T = Math.floor(Date.now() / 1000);
  A.w("update purchase_slips set created_at = ? where id = ?", T, ta.id);
  B.w("update purchase_slips set created_at = ? where id = ?", T, tb.id);
  await internet(true);
  await settle();
  const oa = await day(A, D6), ob = await day(B, D6);
  check("both computers list them in the same order", oa.ids.length === 2 && oa.ids.join() === ob.ids.join(), { A: oa.ids, B: ob.ids });
  const stmt = async (x: PC) => (await x.call("GET", `/ledger/${sup.id}?from=${D6}&to=${D6}`)).entries.map((e: any) => `${e.id}:${e.balancePaise}`).join();
  check("  ...and the supplier's statement runs the same, line by line", await stmt(A) === await stmt(B), { A: await stmt(A), B: await stmt(B) });
  const dara = async (x: PC) => (await x.call("GET", `/reports/mill?merchantId=${refs.grm}&date=${D6}&sort=entry&format=json`)).rows.map((r: any) => r.grossGrams).join();
  check("  ...and so does the mill's report", await dara(A) === await dara(B), { A: await dara(A), B: await dara(B) });
  check("  ...each flagged as the same RST twice (a flag, never a block)", oa.repeated.length === 2 && ob.repeated.length === 2, { A: oa.repeated, B: ob.repeated });

  console.log("\nThe same picture again, of a sheet saved before 01-10-2026, on the other computer");
  const D7 = "2026-09-19";
  const old = picture("e2e-sync-scans-old");
  const s7 = await upload(A, [old], D7);
  putReading(A, s7.id, [{ rst: "1701", name: KNOWN[0], grossQtl: 20.00, rate: 3400 }]);
  check("the older sheet is added on A", (await commit(A, s7.id)).status === 200);
  // as a sheet saved before 01-10-2026 is stored: no fingerprint per page
  const fp = JSON.parse(A.q("select file_paths from scan_batches where id = ?", s7.id)[0].file_paths).map(({ sha256: _s, ...f }: any) => f);
  A.w("update scan_batches set file_paths = ? where id = ?", JSON.stringify(fp), s7.id);
  await settle();
  check("  ...B holds it without fingerprints", !String(B.q("select file_paths from scan_batches where id = ?", s7.id)[0].file_paths).includes("sha256"));
  // what A does once when it starts: fingerprint the older pages whose pictures it holds
  const { fingerprintOldPages } = await import("../server/routes/scans.ts");
  check("  ...A, holding the pictures, fingerprints its older pages", fingerprintOldPages() >= 1);
  await settle();
  const onB = await upload(B, [old], D7);
  check("  ...the same picture scanned again on B is noticed", onB.samePictures === 1, onB);
  putReading(B, onB.id, [{ rst: "1701", name: KNOWN[0], grossQtl: 20.00, rate: 3400 }]);
  const rv = await B.call("GET", `/scans/${onB.id}`);
  check("  ...and its review names the sheet already added", rv.samePictures?.some((s: any) => s.scanId === s7.id && s.status === "committed"), rv.samePictures);
  check("  ...its RST is flagged, never blocked", rv.rows.some((r: any) => r.issues.some((i: any) => i.code === "rst_exists")) && !rv.rows.some((r: any) => r.blocking), rv.rows.map((r: any) => r.issues.map((i: any) => i.code)));
  await B.call("DELETE", `/scans/${onB.id}`);
} catch (e) {
  bad++;
  console.log(` FAIL  ${(e as Error).message}`);
} finally {
  // the internet back on, and both computers in step, for the checks that follow
  await internet(true);
  try { await settle(); } catch (e) { bad++; console.log(` FAIL  could not settle at the end: ${(e as Error).message}`); }
}

console.log(bad === 0 ? "\nOne sheet on two computers is one sheet." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
