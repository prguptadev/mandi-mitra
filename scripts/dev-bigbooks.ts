import "./_guard.ts";
/* A big, realistic book for timing the app on a slow laptop: about two years
 * of a busy mandi in Vijay Laxmi Dal Mill and a smaller V C Enterprises.
 *
 * Everything with money or weight in it goes in through the app's own API
 * (a server started here, on a fresh test folder, exactly as a new install
 * starts), so every stored figure is the app's own math. Only the scanned
 * sheets' records (no pictures) are filed straight into the database at the
 * end, and they carry no figure of their own. Last, every figure is re-worked
 * (scripts/money-check.ts): it must say "Every figure re-works exactly".
 *
 *   DIR=/private/tmp/…/bigbooks-test      a NEW folder; its name must contain "test"
 *   MANDI_DATA_DIR=$DIR MANDI_API=http://127.0.0.1:12610/api npx tsx scripts/dev-bigbooks.ts
 *
 * About 3 minutes on a Mac for the full size (~340 MB). BIG_SCALE=0.05 makes a small
 * one in seconds; BIG_SEED gives another set of names and figures.
 * Never the real data folder: the guard above refuses it, and so does this
 * script when the folder already holds a database.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { uuidv7 } from "uuidv7";

const API = process.env.MANDI_API!;
const DIR = path.resolve(process.env.MANDI_DATA_DIR!);
const PORT = new URL(API).port;
const SCALE = Math.max(0.01, Math.min(1, Number(process.env.BIG_SCALE ?? 1) || 1));
const SEED = Number(process.env.BIG_SEED ?? 20261002) || 20261002;
const PIN = "7747";
/** A smaller book has smaller trucks, so it still has trucks. */
const TRUCK = Math.max(SCALE, 0.1);

if (fs.existsSync(path.join(DIR, "mandi.db"))) {
  console.error(`\n  REFUSING: ${DIR} already holds a database. This script only fills a fresh, empty test folder.\n`);
  process.exit(2);
}
fs.mkdirSync(DIR, { recursive: true });

/* ------------------------------------------------------------------ random */

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = rng(SEED);
const int = (lo: number, hi: number) => lo + Math.floor(R() * (hi - lo + 1));
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(R() * xs.length)];
const chance = (p: number) => R() < p;
/** An index into weights, in proportion. */
function weighted(weights: readonly number[]) {
  const total = weights.reduce((s, w) => s + w, 0);
  let x = R() * total;
  for (let i = 0; i < weights.length; i++) { x -= weights[i]; if (x <= 0) return i; }
  return weights.length - 1;
}

/* ------------------------------------------------------------------- dates */

const dayMs = 86400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const TODAY = new Date().toLocaleDateString("en-CA");
const END = Date.parse(`${TODAY}T00:00:00Z`);
const START = END - 731 * dayMs;
const DAYS: string[] = [];
for (let t = START; t <= END; t += dayMs) DAYS.push(iso(t));
const shift = (d: string, n: number) => iso(Date.parse(`${d}T00:00:00Z`) + n * dayMs);
const month = (d: string) => Number(d.slice(5, 7));

/* --------------------------------------------------------------- the server */

console.log(`Big test book: ${DAYS[0]} to ${DAYS[DAYS.length - 1]} (${DAYS.length} days), scale ${SCALE}, seed ${SEED}`);
console.log(`  folder ${DIR}\n  server ${API}`);
const server = spawn("npx", ["tsx", "server/index.ts"], {
  // a fresh install as the desktop app starts one: both firms, Admin and two Managers
  env: { ...process.env, PORT, MANDI_DATA_DIR: DIR, MANDI_NO_AUTO_BACKUP: "1", MANDI_NO_GITHUB: "1", MANDI_HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout!.on("data", (d) => { serverLog += d; });
server.stderr!.on("data", (d) => { serverLog += d; });
const stopServer = () => new Promise<void>((resolve) => {
  if (server.exitCode !== null) return resolve();
  server.once("exit", () => resolve());
  server.kill("SIGTERM");
  setTimeout(() => { try { server.kill("SIGKILL"); } catch { /* gone */ } }, 10_000).unref();
});
process.on("exit", () => { try { server.kill("SIGKILL"); } catch { /* gone */ } });

for (let i = 0; ; i++) {
  try { if ((await fetch(`${API}/health`)).ok) break; } catch { /* not yet */ }
  if (i > 240) { console.error(serverLog); throw new Error("the test server did not start"); }
  await new Promise((r) => setTimeout(r, 250));
}

/* --------------------------------------------------------------------- http */

class Client {
  cookie = "";
  async call<T = any>(method: string, url: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`${API}${url}`, {
        method,
        headers: { "Content-Type": "application/json", ...(this.cookie ? { Cookie: this.cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = r.headers.get("set-cookie");
      if (set) this.cookie = set.split(";")[0];
      const text = await r.text();
      if (r.ok) return (text ? JSON.parse(text) : null) as T;
      // the database was busy for a moment (it never is with one writer, but a test machine can be slow)
      if (r.status >= 500 && attempt < 2) { await new Promise((x) => setTimeout(x, 200)); continue; }
      throw new Error(`${method} ${url} -> ${r.status} ${text.slice(0, 400)}\n${JSON.stringify(body)?.slice(0, 400)}`);
    }
  }
  get<T = any>(u: string) { return this.call<T>("GET", u); }
  post<T = any>(u: string, b: unknown = {}) { return this.call<T>("POST", u, b); }
  put<T = any>(u: string, b: unknown) { return this.call<T>("PUT", u, b); }
}

/** Runs fn over items, n at a time, in order of start. */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const x = items[i++]; await fn(x); }
  }));
}

/* ---------------------------------------------------------------- the names */

const FIRST = ["राम", "श्याम", "मोहन", "सोहन", "राकेश", "मुकेश", "सुरेश", "दिनेश", "महेश", "रमेश", "विनोद", "प्रमोद", "अनिल", "सुनील",
  "राजेश", "संजय", "अजय", "विजय", "मनोज", "सरोज", "धर्मपाल", "रामपाल", "जयपाल", "ओमप्रकाश", "वेदप्रकाश", "सूर्यप्रकाश", "हरिओम",
  "रामवीर", "धर्मवीर", "सत्यवीर", "बलवीर", "रणवीर", "फूलसिंह", "रामसिंह", "हरिसिंह", "उदयवीर", "कृष्णपाल", "राधेश्याम", "शिवकुमार",
  "अरविन्द", "पुष्पेन्द्र", "वीरेन्द्र", "नरेन्द्र", "सुरेन्द्र", "महेन्द्र", "जितेन्द्र", "देवेन्द्र", "रविन्द्र", "गौरव", "सौरभ",
  "अमित", "सुमित", "रोहित", "मोहित", "राहुल", "अंकित", "नितिन", "सचिन", "प्रदीप", "संदीप", "कुलदीप", "राजकुमार", "सन्तकुमार", "रामलखन"];
const MIDDLE = ["कुमार", "सिंह", "चन्द्र", "प्रसाद", "लाल", "नाथ"];
const SURNAME = ["वर्मा", "यादव", "जोशी", "शर्मा", "गुप्ता", "अग्रवाल", "बघेल", "राठौर", "चौहान", "शाक्य", "कुशवाह", "लोधी", "राजपूत",
  "सक्सेना", "मिश्रा", "पाण्डेय", "तिवारी", "दुबे", "सोलंकी", "तोमर", "पाल", "प्रजापति", "माहौर", "जादौन", "भदौरिया", "सविता", "कश्यप",
  "गंगवार", "पटेल", "निषाद"];
const FIRM = ["ट्रेडिंग", "ट्रेडिंग कंपनी", "एण्ड संस", "इंटरप्राइजेज", "ट्रेडर्स", "किसान सेवा केन्द्र", "एग्रो"];
const VILLAGES: [string, string][] = [["Etah", "एटा"], ["Jalesar", "जलेसर"], ["Aliganj", "अलीगंज"], ["Marhara", "मारहरा"], ["Awagarh", "अवागढ़"],
  ["Sakit", "सकीट"], ["Nidhauli Kalan", "निधौली कलां"], ["Jaithara", "जैथरा"], ["Shitalpur", "शीतलपुर"], ["Sakarauli", "सकरौली"], ["Mirhachi", "मिरहची"],
  ["Patiyali", "पटियाली"], ["Kasganj", "कासगंज"], ["Soron", "सोरों"], ["Ganjdundwara", "गंजडुंडवारा"], ["Amanpur", "अमांपुर"], ["Sidhpura", "सिढ़पुरा"],
  ["Raja Ka Rampur", "राजा का रामपुर"], ["Malawan", "मलावन"], ["Pilua", "पिलुआ"], ["Bagwala", "बागवाला"], ["Reja", "रेजा"], ["Nagla Pran", "नगला प्राण"],
  ["Barthar", "बरथर"], ["Kailashpur", "कैलाशपुर"], ["Dhumri", "धुमरी"], ["Jinhera", "जिनहेरा"], ["Asrauli", "असरौली"], ["Nayagaon", "नयागांव"], ["Kurawali", "कुरावली"]];

const MILL_WORDS = ["Shri Balaji", "Shri Laxmi Badri", "G.R.M.", "Shri Radhey", "Ganpati", "Annapurna", "Shri Shyam", "Mahalaxmi", "Bharat",
  "Kissan", "Shiv Shakti", "Jai Mata Di", "Shri Krishna", "Om Sai", "Hanuman", "Durga", "Ganga", "Saraswati", "Navdurga", "Shri Ram",
  "Bajrang", "Sai Baba", "Maa Bhagwati", "Swastik", "Vishwakarma", "Kamdhenu", "Gopal", "Narayan"];
const MILL_KIND = ["Rice Mill", "Agro Foods Pvt Ltd", "Dal Mill", "Flour Mill", "Agro Industries", "Rice & Gen Mills", "Foods"];
const CITIES: [string, string][] = [["Etah", "Uttar Pradesh"], ["Kiccha", "Uttarakhand"], ["Rudrapur", "Uttarakhand"], ["Aligarh", "Uttar Pradesh"],
  ["Agra", "Uttar Pradesh"], ["Mathura", "Uttar Pradesh"], ["Bareilly", "Uttar Pradesh"], ["Karnal", "Haryana"], ["Kaithal", "Haryana"], ["Hapur", "Uttar Pradesh"]];

/** Misreadings a sheet gives of a name: a dropped matra, a short vowel for a long one, the words run together. */
function misreadings(name: string): string[] {
  const out = new Set<string>();
  out.add(name.replace(/ /g, ""));
  out.add(name.replace(/ी/g, "ि"));
  out.add(name.replace(/ू/g, "ु"));
  out.add(name.replace(/ा/, ""));
  out.add(name.replace(/ं/g, "न"));
  out.add(`${name} जी`);
  out.delete(name);
  return [...out].filter((x) => x.trim().length > 1);
}

/* -------------------------------------------------------------- commodities */

/** Rs/qtl around which each commodity trades, and its share of the month's slips. */
const JINS_BASE: Record<string, number> = { "1509": 3300, "1121": 3900, "1718": 3500, SARBATI: 2700, WHEAT: 2350, MAIZE: 2050 };
const JINS_ORDER = ["1509", "1121", "1718", "SARBATI", "WHEAT", "MAIZE"];
function jinsMix(m: number): number[] {
  if (m >= 10 || m === 1) return [0.35, 0.25, 0.15, 0.1, 0.05, 0.1];
  if (m <= 3) return [0.1, 0.1, 0.05, 0.05, 0.3, 0.4];
  if (m <= 6) return [0.03, 0.03, 0.02, 0.02, 0.8, 0.1];
  return [0.15, 0.1, 0.1, 0.05, 0.3, 0.3];
}
const seasonFactor = (m: number) => (m >= 10 && m <= 12 ? 1.3 : m === 4 || m === 5 ? 1.2 : m >= 7 && m <= 9 ? 0.7 : 1);

/* ----------------------------------------------------------- one business */

interface Firm {
  label: string; client: Client; bizId: string;
  suppliers: number; mills: number; slipsPerDay: [number, number]; activeDays: number;
  payPerDay: [number, number];
}

interface Totals { suppliers: number; aliases: number; mills: number; slips: number; unpriced: number; trucks: number; approved: number; voided: number; cuts: number; receipts: number; payments: number; paymentsVoided: number; pos: number; notes: number; closed: number }

async function fillFirm(f: Firm, t: Totals) {
  const c = f.client;
  const jinsList = await c.get<{ id: string; code: string }[]>("/jins");
  const jinsIds = JINS_ORDER.map((code) => jinsList.find((j) => j.code === code)!.id);

  /* ------------------------------------------------------------ suppliers */
  const names = new Set<string>();
  while (names.size < f.suppliers) {
    const form = R();
    const n = form < 0.55 ? `${pick(FIRST)} ${pick(SURNAME)}`
      : form < 0.75 ? `${pick(FIRST)} ${pick(MIDDLE)} ${pick(SURNAME)}`
        : form < 0.9 ? `${pick(FIRST)} ${pick(SURNAME)} ${pick(FIRM)}`
          : `${pick(SURNAME)} ${pick(FIRM)}`;
    names.add(n);
  }
  const suppliers: { id: string; nameHi: string; w: number }[] = [];
  const list = [...names];
  await pool(list, 6, async (nameHi) => {
    const [village, villageHi] = pick(VILLAGES);
    const r = await c.post<{ id: string }>("/adati", {
      nameHi, village, villageHi,
      ...(chance(0.6) ? { phone: `${pick(["9", "8", "7", "6"])}${String(int(0, 999_999_999)).padStart(9, "0")}` } : {}),
      ...(chance(0.25) ? { accountNo: String(int(10_000_000, 99_999_999)) + String(int(1000, 9999)), ifsc: `SBIN000${int(1000, 9999)}` } : {}),
      ...(chance(0.04) ? { openingBalanceRupees: int(-20_000, 150_000) } : {}),
    });
    suppliers.push({ id: r.id, nameHi, w: 0 });
  });
  // a few suppliers bring most of the grain
  suppliers.sort((a, b) => a.nameHi.localeCompare(b.nameHi));
  for (let i = suppliers.length - 1; i > 0; i--) { const j = int(0, i); [suppliers[i], suppliers[j]] = [suppliers[j], suppliers[i]]; }
  suppliers.forEach((s, i) => { s.w = 1 / Math.pow(i + 1, 0.75); });
  const supplierWeights = suppliers.map((s) => s.w);
  t.suppliers += suppliers.length;

  // spellings the sheets have shown for them
  const learn: { adatiId: string; rawText: string }[] = [];
  for (const s of suppliers) {
    if (!chance(0.45)) continue;
    for (const raw of misreadings(s.nameHi).slice(0, int(1, 2))) learn.push({ adatiId: s.id, rawText: raw });
  }
  await pool(learn, 6, async (x) => { await c.post("/adati/learn", { ...x, source: "correction" }); });
  t.aliases += learn.length;

  /* ---------------------------------------------------------------- mills */
  const mills: { id: string; code: string; w: number; jins: number[] }[] = [];
  const codes = new Set<string>();
  for (let i = 0; i < f.mills; i++) {
    const word = MILL_WORDS[(i * 7 + (f.label === "VCE" ? 3 : 0)) % MILL_WORDS.length];
    const kind = pick(MILL_KIND);
    let code = word.replace(/[^A-Za-z ]/g, "").split(/\s+/).map((w) => w[0]).join("").toUpperCase().slice(0, 4) + (kind.startsWith("Rice") ? "R" : kind[0]);
    while (codes.has(code)) code += String(int(1, 9));
    codes.add(code);
    const [city, state] = pick(CITIES);
    const r = await c.post<{ id: string }>("/merchants", {
      code, name: `${word} ${kind}`, city, state,
      gstin: `09${crypto.createHash("md5").update(code + f.label).digest("hex").slice(0, 10).toUpperCase()}1Z${int(1, 9)}`,
      mandiLicense: `L/2016/${int(10, 99)}/${int(10_000_000, 99_999_999)}`,
      ...(chance(0.2) ? { openingBalanceRupees: int(0, 500_000) } : {}),
    });
    // each mill buys one paddy and one of wheat or maize, as mills here do
    mills.push({ id: r.id, code, w: 1 / Math.pow(i + 1, 0.6), jins: [i % 4, 4 + (i % 2)] });
  }
  t.mills += mills.length;

  /* ------------------------------------------------------------- the days */
  type StockKey = string; // mill|jins
  const stock = new Map<StockKey, Map<string, number>>(); // date -> grams not yet on a truck (our own estimate)
  const owed = new Map<string, { paise: number; since: number }>();
  const pos = new Map<StockKey, { id: string; until: string }>();
  const receiptsDue: { day: string; millId: string; loadId: string; total: number }[] = [];
  const invoiceNo = new Map<string, number>(); // FY start year -> last number
  let poSerial = 100;
  const fyOf = (d: string) => (Number(d.slice(5, 7)) >= 4 ? Number(d.slice(0, 4)) : Number(d.slice(0, 4)) - 1);
  const drift = (d: string) => 1 + 0.08 * Math.sin((Date.parse(d) / dayMs) / 58) + 0.05 * Math.sin((Date.parse(d) / dayMs) / 211);

  for (let di = 0; di < DAYS.length; di++) {
    const day = DAYS[di];
    const m = month(day);
    const active = chance(f.activeDays);

    /* ----------------------------------------------------------- slips */
    if (active) {
      const [lo, hi] = f.slipsPerDay;
      const n = Math.round(Math.max(lo, Math.min(hi, int(lo, hi) * seasonFactor(m))) * SCALE) || 1;
      const mix = jinsMix(m);
      const dayRate = JINS_ORDER.map((code) => JINS_BASE[code] * drift(day) * (0.97 + R() * 0.06));
      let rst = int(100, 900);
      const todays = Array.from({ length: n }, () => {
        const ji = weighted(mix);
        const buyers = mills.filter((x) => x.jins.includes(ji));
        const mill = buyers.length && chance(0.92) ? buyers[weighted(buyers.map((x) => x.w))] : null;
        const s = suppliers[weighted(supplierWeights)];
        const grossQtl = 5 + 45 * Math.pow(R(), 1.6);
        const grossGrams = Math.round(grossQtl * 20) * 5000; // the kanta weighs to 5 kg
        const rateRs = Math.max(2000, Math.min(4500, Math.round(dayRate[ji] * (0.96 + R() * 0.08) / 5) * 5));
        const unpriced = chance(0.02);
        if (!chance(0.01)) rst++;
        return {
          slipDate: day, rstNo: String(rst), adatiId: s.id, jinsId: jinsIds[ji], merchantId: mill?.id ?? null,
          grossGrams, ratePaisePerQtl: unpriced ? 0 : rateRs * 100,
          ...(chance(0.3) ? { bagsCount: Math.max(1, Math.round(grossGrams / int(40_000, 60_000))) } : {}),
          ...(chance(0.05) ? { katautiUnits: Math.max(0, Math.round(grossGrams / 100_000) + pick([-1, 1])) } : {}),
          _mill: mill?.id ?? null, _ji: ji,
        };
      });
      await pool(todays, 6, async (s) => {
        const { _mill, _ji, ...body } = s;
        const r = await c.post<{ netGrams: number; payablePaise: number }>("/slips", body);
        t.slips++;
        if (!body.ratePaisePerQtl) t.unpriced++;
        const o = owed.get(body.adatiId) ?? { paise: 0, since: di };
        if (o.paise <= 0) o.since = di;
        o.paise += r.payablePaise;
        owed.set(body.adatiId, o);
        if (_mill) {
          const k = `${_mill}|${_ji}`;
          if (!stock.has(k)) stock.set(k, new Map());
          const byDay = stock.get(k)!;
          byDay.set(day, (byDay.get(day) ?? 0) + r.netGrams);
        }
      });
    }

    /* ------------------------------------------------- orders from mills */
    if (di % 45 === 0) {
      for (const mill of mills) {
        if (!chance(0.7)) continue;
        const ji = mill.jins[0];
        const po = await c.post<{ id: string }>("/orders", {
          merchantId: mill.id, jinsId: jinsIds[ji], poNo: chance(0.7) ? `PO/${day.slice(2, 4)}/${++poSerial}` : "",
          poDate: day, qtyGrams: int(1500, 6000) * 100_000, ratePaisePerQtl: Math.round(JINS_BASE[JINS_ORDER[ji]] * drift(day)) * 100,
          validTill: shift(day, 60),
        });
        pos.set(`${mill.id}|${ji}`, { id: po.id, until: shift(day, 60) });
        t.pos++;
      }
    }

    /* ------------------------------------------------------------ trucks */
    const draftsFrom = DAYS.length - 6;
    for (const [k, byDay] of stock) {
      // the newest purchase days first (the app's own default), up to six of them on one truck;
      // what older days still hold stays in hand, as it does in a real mandi
      const live = [...byDay.entries()].filter(([, g]) => g > 0).sort((a, b) => b[0].localeCompare(a[0]));
      const total = live.reduce((s, [, g]) => s + g, 0);
      if (total < 250 * 100_000 * TRUCK) continue;
      if (!chance(active ? 0.7 : 0.3)) continue;
      const [millId, jiStr] = k.split("|");
      const ji = Number(jiStr);
      const target = Math.min(total, Math.round(int(300, 450) * 100_000 * TRUCK));
      const takes: { date: string; grams: number }[] = [];
      let covered = 0;
      for (const [d, g] of live) {
        if (covered >= target || takes.length === 6) break;
        const take = Math.round(Math.min(g, target - covered) / 1000) * 1000;
        if (take <= 0) continue;
        takes.push({ date: d, grams: take });
        covered += take;
      }
      if (covered < target * 0.8) continue;
      // the biggest day's row is "the rest" of the mill's net; the others carry a typed weight
      takes.sort((a, b) => b.grams - a.grams);
      const [rest, ...rows] = takes;
      const typed = rows.reduce((s, r) => s + r.grams, 0);
      // the mill's own weighbridge: a little short of what we bought, as it always is
      const millNet = Math.round((covered * (0.992 + R() * 0.006)) / 10_000) * 10_000;
      if (millNet - typed < 3 * 100_000 * TRUCK) continue;
      const katte = Math.max(1, Math.round(millNet / int(48_000, 52_000)));
      const po = pos.get(k);
      const load = await c.post<{ id: string }>("/loads", {
        loadDate: day, merchantId: millId, jinsId: jinsIds[ji], stockDate: rest.date,
        truckNo: `UP${pick(["82", "80", "81", "83"])}${pick(["AT", "BT", "CT", "T", "AN"])}${int(1000, 9999)}`,
        ...(chance(0.6) ? { transporter: pick(["Sharma Roadlines", "Etah Transport Co", "Yadav Carriers", "Shri Ganesh Logistics"]) } : {}),
        ...(chance(0.5) ? { driverPhone: `9${String(int(0, 999_999_999)).padStart(9, "0")}` } : {}),
        ...(po && po.until >= day && chance(0.35) ? { poId: po.id } : {}),
      });
      t.trucks++;
      for (const r of rows) await c.post(`/loads/${load.id}/lines`, { stockDate: r.date, netGrams: r.grams });
      // what this truck takes off our own estimate of the stock
      for (const r of takes) byDay.set(r.date, (byDay.get(r.date) ?? 0) - r.grams);
      for (const [d, g] of [...byDay]) if (g <= 0) byDay.delete(d);

      const fy = String(fyOf(day));
      const no = (invoiceNo.get(fy) ?? 0) + 1;
      invoiceNo.set(fy, no);
      await c.put(`/loads/${load.id}`, {
        millGrossGrams: millNet + Math.round(katte * 570),
        katteCount: katte,
        ...(chance(0.05) ? { boreCount: int(5, 40) } : {}),
        invoiceNo: String(no),
        advancePaise: chance(0.5) ? int(5, 25) * 100_000 : 0,
      });
      if (di >= draftsFrom && chance(0.6)) continue; // the last few days' trucks are still drafts
      // a day whose only slips have no rate yet gives no rate to bill at: the truck waits as a draft
      let p: { id: string; grandTotalPaise: number };
      try { p = await c.post(`/loads/${load.id}/approve`, {}); } catch (e) { if (/not_ready/.test(String(e))) continue; throw e; }
      t.approved++;
      if (chance(0.012)) {
        // a parcha given again: voided and approved once more (a revised paper)
        await c.post(`/parchas/${p.id}/void`, { reason: pick(["Wrong bags typed", "Mill weight corrected", "Rate of the day changed"]) });
        p = await c.post(`/loads/${load.id}/approve`, {});
        t.voided++;
      }
      if (chance(0.1)) {
        await c.put(`/challan/${load.id}`, { deductionGrams: int(5, 120) * 1000, note: pick(["moisture", "shortage at the mill", "dust and stones"]) });
        t.cuts++;
      }
      if (!chance(0.05)) receiptsDue.push({ day: shift(day, int(5, 40)), millId, loadId: load.id, total: p.grandTotalPaise });
    }

    /* --------------------------------------------------- money from mills */
    const due = receiptsDue.filter((r) => r.day === day);
    for (const r of due) {
      const full = chance(0.88);
      const amount = full ? r.total : Math.round(r.total * (0.5 + R() * 0.4) / 100) * 100;
      const tds = full && chance(0.3) ? Math.round(r.total * 0.001) : 0;
      await c.post("/mill-receipts", {
        merchantId: r.millId, loadId: r.loadId, receiptDate: day, amountPaise: amount - tds, deductionPaise: tds,
        ...(tds ? { deductionNote: "TDS 0.1%" } : {}),
        mode: pick(["bank", "rtgs", "rtgs", "cheque", "upi"]), reference: `UTR${int(100_000_000, 999_999_999)}`,
      });
      t.receipts++;
    }
    if (di % 7 === 3) {
      for (const mill of mills) {
        if (!chance(0.06)) continue;
        await c.post("/mill-receipts", { merchantId: mill.id, receiptDate: day, amountPaise: int(1, 20) * 5_000_000, mode: "bank", notes: "on account" });
        t.receipts++;
      }
    }
    if (di % 30 === 11) {
      for (const mill of mills.slice(0, 12)) {
        await c.post("/mill-followup/notes", { merchantId: mill.id, note: pick(["Spoke to the accountant, payment next week", "Promised by Friday", "Called, no answer"]),
          ...(chance(0.5) ? { promisedPaise: int(1, 30) * 10_000_000 } : {}), nextDate: shift(day, int(3, 10)) });
        t.notes++;
      }
    }

    /* ------------------------------------------------- paying suppliers */
    if (active || chance(0.3)) {
      const [lo, hi] = f.payPerDay;
      const n = Math.round(int(lo, hi) * SCALE) || (chance(SCALE * 10) ? 1 : 0);
      const ready = [...owed.entries()].filter(([, o]) => o.paise > 0 && di - o.since >= 2)
        .sort((a, b) => b[1].paise - a[1].paise).slice(0, n * 3);
      const chosen = ready.filter(() => chance(0.4)).slice(0, n);
      await pool(chosen, 6, async ([adatiId, o]) => {
        const amount = chance(0.6) ? o.paise : Math.max(100_00, Math.floor(o.paise * (0.3 + R() * 0.5) / 100_000) * 100_000);
        const r = await c.post<{ id: string }>("/payments", {
          adatiId, payDate: day, amountPaise: amount, mode: pick(["cash", "cash", "bank", "upi", "cheque"]),
          ...(chance(0.3) ? { reference: `${int(100_000, 999_999)}` } : {}),
        });
        t.payments++;
        if (chance(0.005)) {
          await c.post(`/payments/${r.id}/void`, { reason: "Entered twice" });
          t.paymentsVoided++;
          return;
        }
        o.paise -= amount;
        if (o.paise <= 0) o.since = di;
      });
    }

    /* ------------------------------------------------------- day close */
    const closeDay = shift(day, -10);
    if (closeDay >= DAYS[0] && closeDay <= shift(TODAY, -10)) {
      try { await c.post("/days/close", { day: closeDay }); t.closed++; } catch (e) { if (!/already_closed/.test(String(e))) throw e; }
    }
    if (di % 60 === 0) console.log(`  ${f.label} ${day}: ${t.slips} slips, ${t.trucks} trucks, ${t.payments} payments so far`);
  }
}

/* --------------------------------------------------------------- run it all */

const started = Date.now();
const login = async (businessCode: string) => {
  const c = new Client();
  const users = await c.get<{ id: string; name: string }[]>("/auth/users");
  const admin = users.find((u) => u.name === "Admin");
  if (!admin) throw new Error("no Admin user: is this a fresh install?");
  await c.post("/auth/login", { userId: admin.id, pin: PIN });
  const me = await c.get<{ businesses: { businessId: string; shortCode: string }[] }>("/auth/me");
  const b = me.businesses.find((x) => x.shortCode === businessCode);
  if (!b) throw new Error(`no business ${businessCode}`);
  await c.post("/auth/switch-business", { businessId: b.businessId });
  return { c, bizId: b.businessId };
};
const vldm = await login("VLDM");
const vce = await login("VCE");
const totals: Totals = { suppliers: 0, aliases: 0, mills: 0, slips: 0, unpriced: 0, trucks: 0, approved: 0, voided: 0, cuts: 0, receipts: 0, payments: 0, paymentsVoided: 0, pos: 0, notes: 0, closed: 0 };
const vceTotals: Totals = { ...totals };
try {
  await Promise.all([
    fillFirm({ label: "VLDM", client: vldm.c, bizId: vldm.bizId, suppliers: Math.round(2000 * SCALE) || 20, mills: 25, slipsPerDay: [50, 150], activeDays: 0.82, payPerDay: [14, 28] }, totals),
    fillFirm({ label: "VCE", client: vce.c, bizId: vce.bizId, suppliers: Math.round(300 * SCALE) || 10, mills: 6, slipsPerDay: [8, 30], activeDays: 0.7, payPerDay: [3, 8] }, vceTotals),
  ]);
} catch (e) {
  console.error(String(e));
  console.error("--- server log (last 30 lines) ---\n" + serverLog.trim().split("\n").slice(-30).join("\n"));
  await stopServer();
  process.exit(1);
}
await stopServer();
console.log(`\nAPI part done in ${Math.round((Date.now() - started) / 1000)} s`);
console.log("  VLDM", JSON.stringify(totals));
console.log("  VCE ", JSON.stringify(vceTotals));

/* --------------------------------------------------- the scanned sheets */
/* A sheet is one mill's slips of one day and commodity, read and added. Only
   the records: no pictures, and no figure of their own (the slips carry them).
   Most are added (their slips point at them); a few wait for review or failed. */
const db = new Database(path.join(DIR, "mandi.db"));
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
const bizRows = db.prepare("select id, short_code from businesses").all() as { id: string; short_code: string }[];
const admin = db.prepare("select id from users where name = 'Admin'").get() as { id: string };
const insertScan = db.prepare(`insert into scan_batches (id, business_id, source_kind, file_paths, slip_date, merchant_id, jins_id, model,
  raw_response, parsed_rows, tokens_in, tokens_out, cost_paise, status, error_text, warning_text, pages_done, page_meta, reviewed_by, reviewed_at, created_by, created_at)
  values (@id, @biz, @source, @files, @date, @mill, @jins, @model, null, @rows, @tin, @tout, @cost, @status, @err, null, @pages, @meta, @rby, @rat, @by, @at)`);
const linkSlips = db.prepare("update purchase_slips set scan_batch_id = ?, ocr_confidence = ? where id = ?");
let sheets = 0;
for (const b of bizRows) {
  const want = Math.round((b.short_code === "VLDM" ? 900 : 100) * SCALE) || 5;
  const groups = db.prepare(`select slip_date d, merchant_id m, jins_id j, count(*) n from purchase_slips
    where business_id = ? and merchant_id is not null group by 1, 2, 3 having n >= 4 order by 1`).all(b.id) as { d: string; m: string; j: string; n: number }[];
  const every = Math.max(1, Math.floor(groups.length / want));
  const millName = new Map((db.prepare("select id, name from merchants where business_id = ?").all(b.id) as { id: string; name: string }[]).map((x) => [x.id, x.name]));
  const jinsName = new Map((db.prepare("select id, name_hi from jins where business_id = ?").all(b.id) as { id: string; name_hi: string }[]).map((x) => [x.id, x.name_hi]));
  db.transaction(() => {
    for (let gi = 0; gi < groups.length && sheets < 100_000; gi += every) {
      const g = groups[gi];
      const slips = db.prepare(`select s.id, s.rst_no, s.gross_grams, s.katauti_units, s.net_grams, s.rate_paise_per_qtl, s.adati_id, a.name_hi
        from purchase_slips s join adati a on a.id = s.adati_id where s.business_id = ? and s.slip_date = ? and s.merchant_id = ? and s.jins_id = ?
        order by s.created_at, s.id limit 60`).all(b.id, g.d, g.m, g.j) as { id: string; rst_no: string; gross_grams: number; katauti_units: number; net_grams: number; rate_paise_per_qtl: number; adati_id: string; name_hi: string }[];
      const pages = Math.max(1, Math.ceil(slips.length / 25));
      const r = R();
      const status = r < 0.94 ? "committed" : r < 0.98 ? "review" : "failed";
      const at = Math.floor(Date.parse(`${g.d}T11:00:00+05:30`) / 1000) + int(0, 6 * 3600);
      const id = uuidv7();
      const rows = status === "failed" ? null : slips.map((s, i) => ({
        id: `r${i + 1}`, page: Math.floor(i / 25) + 1,
        ocr: { rstNo: s.rst_no, village: null, adatiName: s.name_hi, grossQtl: s.gross_grams / 100_000, katauti: s.katauti_units, netQtl: s.net_grams / 100_000,
          rate: s.rate_paise_per_qtl ? s.rate_paise_per_qtl / 100 : null, confidence: 0.9 + R() * 0.1, struckThrough: false, srNo: i + 1 },
        rstNo: s.rst_no, adatiId: s.adati_id, adatiRawText: s.name_hi, adatiRawVillage: null, grossGrams: s.gross_grams,
        katautiOverride: null, ratePaisePerQtl: s.rate_paise_per_qtl || null, excluded: false, nameCorrected: false, modelPick: s.name_hi, confirmed: [],
      }));
      insertScan.run({
        id, biz: b.id, source: chance(0.6) ? "scanner" : "upload",
        files: JSON.stringify(Array.from({ length: pages }, (_, p) => ({ name: `page-${p + 1}.jpg`, mimeType: "image/jpeg", bytes: int(600_000, 1_400_000),
          sha256: crypto.createHash("sha256").update(`${id}:${p}`).digest("hex") }))),
        date: g.d, mill: g.m, jins: g.j, model: "gemini-2.5-flash",
        rows: rows ? JSON.stringify(rows) : null, tin: int(3000, 9000) * pages, tout: int(1500, 4000) * pages, cost: 0,
        status, err: status === "failed" ? "Gemini limit reached" : null, pages: status === "failed" ? 0 : pages,
        meta: JSON.stringify(Array.from({ length: pages }, (_, p) => ({ page: p + 1, date: g.d.split("-").reverse().join("-"), millName: millName.get(g.m) ?? null, jins: jinsName.get(g.j) ?? null, total: null }))),
        rby: status === "committed" ? admin.id : null, rat: status === "committed" ? at + 600 : null, by: admin.id, at,
      });
      // a sheet still waiting has put nothing on the list yet; its day's slips were typed by hand
      if (status === "committed") for (const s of slips) linkSlips.run(id, Number((0.9 + R() * 0.1).toFixed(3)), s.id);
      sheets++;
    }
  })();
}
db.pragma("wal_checkpoint(TRUNCATE)");
const counts = Object.fromEntries((db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '\\_%' escape '\\'").pluck().all() as string[])
  .map((tb) => [tb, (db.prepare(`select count(*) n from "${tb}"`).get() as { n: number }).n]));
db.close();
console.log(`  scanned sheets filed: ${sheets}`);
console.log("  rows:", JSON.stringify(counts));
console.log(`  size: ${(fs.statSync(path.join(DIR, "mandi.db")).size / 1048576).toFixed(1)} MB`);

/* --------------------------------------------------------- every figure */
const check = spawn("npx", ["tsx", "scripts/money-check.ts", path.join(DIR, "mandi.db")], { stdio: ["ignore", "pipe", "inherit"] });
let out = "";
check.stdout!.on("data", (d) => { out += d; });
const code = await new Promise<number>((r) => check.once("exit", (x) => r(x ?? 1)));
console.log(out.trim().split("\n").slice(-3).join("\n"));
console.log(code === 0 ? `\nDone in ${Math.round((Date.now() - started) / 1000)} s: ${DIR}/mandi.db` : "\nThe money check FAILED");
process.exit(code);
