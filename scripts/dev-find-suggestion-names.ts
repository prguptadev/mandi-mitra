import { sqlite } from "../server/db/client.ts";
import { loadResolver } from "../server/lib/adatiResolve.ts";
const biz = (sqlite.prepare("select id from businesses where short_code='VLDM'").get() as any).id;
const r = await loadResolver(biz);
const cands = ["राकेश शर्मा","अरुण यादव","पुष्पेंद्र","दिनेस यादव","वीरेंद जोसी","केसी राठौर","गौरव ट्रेडर","अमित ट्रेडर","धरमपाल","सूरज प्रकाश वर्मा","रामपाल यादव","ज्योति टेडर्स","शांति सरूप","राधा चरण"];
for (const c of cands) {
  const x = r.resolve(c);
  const band = !x.match && x.suggestions.length > 0;
  console.log((band ? "SUGGEST" : x.match ? "auto   " : "none   ").padEnd(8), c.padEnd(20), "|",
    x.match ? "match " + x.match.nameHi + " " + x.match.confidence : x.suggestions.map((s) => s.nameHi + " " + s.confidence).join(", "));
}
