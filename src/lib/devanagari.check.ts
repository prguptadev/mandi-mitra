/* Run: npx tsx src/lib/devanagari.check.ts */
import { toDevanagari, looksLatin } from "../../server/lib/devanagari.ts";

const known = new Map<string, string>();
let bad = 0;
const eq = (input: string, want: string) => {
  const got = toDevanagari(input, { known });
  const ok = got === want;
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${input.padEnd(24)} -> ${got}${ok ? "" : "   want " + want}`);
};

console.log("Names from the sheets (dictionary)");
eq("phoolsingh verma", "फूलसिंह वर्मा");
eq("rakesh verma", "राकेश वर्मा");
eq("pushpendra yadav", "पुष्पेन्द्र यादव");
eq("shanti swaroop joshi", "शान्ति स्वरूप जोशी");
eq("radhe shyam and sons", "राधे श्याम एण्ड संस");
eq("shivam trading", "शिवम ट्रेडिंग");
eq("shivam tc", "शिवम ट्रेडिंग कंपनी");
eq("keshi rathore", "केशी राठोर");
eq("sant kumar chaturbhuj", "संत कुमार चतुर्भुज");

console.log("\nUnknown words (phonetic)");
eq("mahesh", "महेश");
eq("bhola", "भोला");
eq("bharat", "भरत");
eq("deepak", "दीपक");
eq("suresh kumar", "सुरेश कुमार");
eq("ankit", "अंकित");
eq("seema", "सीमा");
eq("geeta", "गीता");

console.log("\nLeft alone");
eq("फूलसिंह वर्मा", "फूलसिंह वर्मा");
eq("626", "626");

console.log("\nlooksLatin");
for (const [s, want] of [["rakesh", true], ["राकेश", false], ["", false], ["123", false], ["राकेश verma", false]] as const) {
  const got = looksLatin(s);
  const ok = got === want;
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${JSON.stringify(s).padEnd(18)} -> ${got}`);
}

console.log(bad === 0 ? "\nAll Devanagari checks passed." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
