/* Latin -> Devanagari, so the munshi can type on an ordinary keyboard.
 *
 * Hinglish is lossy: "verma" and "varma" are the same word, and the writer
 * drops the inherent 'a' wherever they feel like. A purely phonetic engine
 * therefore gets a minority of names slightly wrong, which is fine only
 * because the result is shown live and can be corrected in place.
 *
 * Order of resort:
 *   1. the supplier master — the operator's own spellings are the truth
 *   2. a word dictionary, the reverse of the Hinglish overrides
 *   3. phonetic transliteration
 */

const DICT: Record<string, string> = {
  // surnames and titles
  singh: "सिंह", verma: "वर्मा", varma: "वर्मा", sharma: "शर्मा",
  yadav: "यादव", joshi: "जोशी", chaudhary: "चौधरी", chaudhari: "चौधरी",
  chauhan: "चौहान", rathore: "राठोर", rathor: "राठोर", kumar: "कुमार",
  lal: "लाल", pal: "पाल", gupta: "गुप्ता", agarwal: "अग्रवाल",
  mishra: "मिश्रा", pandey: "पाण्डेय", tiwari: "तिवारी", dubey: "दुबे",
  thakur: "ठाकुर", jatav: "जाटव", kushwaha: "कुशवाहा", baghel: "बघेल",
  diwakar: "दिवाकर", saxena: "सक्सेना", srivastava: "श्रीवास्तव",
  devi: "देवी", prasad: "प्रसाद", nath: "नाथ", bihari: "बिहारी",
  murari: "मुरारी", hari: "हरि", om: "ओम", babu: "बाबू",
  // given names seen on the sheets
  phool: "फूल", phul: "फूल", phoolsingh: "फूलसिंह", rakesh: "राकेश",
  shivam: "शिवम", arvind: "अरविन्द", arbind: "अरविन्द",
  virendra: "वीरेन्द्र", veerendra: "वीरेन्द्र", surendra: "सुरेन्द्र",
  pushpendra: "पुष्पेन्द्र", ramveer: "रामवीर", ramvir: "रामवीर",
  sahdev: "सहदेव", sant: "संत", radha: "राधा", radhe: "राधे",
  shyam: "श्याम", ganesh: "गणेश", jyoti: "ज्योति", dharampal: "धर्मपाल",
  rampal: "रामपाल", ramlakhan: "रामलखन", ramlal: "रामलाल",
  ramkumar: "रामकुमार", surya: "सूर्य", prakash: "प्रकाश", charan: "चरन",
  amit: "अमित", sanjeev: "संजीव", sanjiv: "संजीव", dinesh: "दिनेश",
  krishna: "कृष्ण", krishnapal: "कृष्णपाल", shanti: "शान्ति",
  swaroop: "स्वरूप", swarup: "स्वरूप", mohani: "मोहनी", keshi: "केशी",
  arun: "अरुण", munna: "मुन्ना", raju: "राजू", gaurav: "गौरव",
  chaturbhuj: "चतुर्भुज", samra: "सामरा", shri: "श्री", sri: "श्री",
  // firm words
  trading: "ट्रेडिंग", traders: "ट्रेडर्स", company: "कंपनी", co: "कंपनी",
  tc: "ट्रेडिंग कंपनी", enterprises: "इंटरप्राइजेज", enterprise: "इंटरप्राइजेज",
  and: "एण्ड", sons: "संस", brothers: "ब्रदर्स", firm: "फर्म",
  mill: "मिल", agro: "एग्रो", foods: "फूड्स", industries: "इंडस्ट्रीज",
  thekedar: "ठेकेदार", adati: "आढ़ती",
};

/* Longest first — "chh" must beat "ch", "aa" must beat "a". */
const CONSONANTS: [string, string][] = [
  ["chh", "छ"], ["shh", "ष"], ["kh", "ख"], ["gh", "घ"], ["ch", "च"],
  ["jh", "झ"], ["th", "थ"], ["dh", "ध"], ["ph", "फ"], ["bh", "भ"],
  ["sh", "श"], ["ng", "ङ"], ["ny", "ञ"], ["tr", "त्र"], ["gy", "ज्ञ"],
  ["k", "क"], ["g", "ग"], ["c", "च"], ["j", "ज"], ["t", "त"], ["d", "द"],
  ["n", "न"], ["p", "प"], ["b", "ब"], ["m", "म"], ["y", "य"], ["r", "र"],
  ["l", "ल"], ["v", "व"], ["w", "व"], ["s", "स"], ["h", "ह"], ["f", "फ"],
  ["z", "ज़"], ["q", "क"], ["x", "क्स"],
];

const VOWELS: [string, string, string][] = [
  // latin, independent, matra
  ["aa", "आ", "ा"], ["ai", "ऐ", "ै"], ["au", "औ", "ौ"],
  ["ee", "ई", "ी"], ["oo", "ऊ", "ू"], ["ii", "ई", "ी"],
  ["uu", "ऊ", "ू"], ["ri", "ऋ", "ृ"],
  ["a", "अ", ""], ["i", "इ", "ि"], ["u", "उ", "ु"],
  ["e", "ए", "े"], ["o", "ओ", "ो"],
];

const VIRAMA = "्";
const ANUSVARA = "ं";

function matchAt(s: string, i: number, table: [string, string][] | [string, string, string][]) {
  for (const row of table) {
    const key = row[0];
    if (s.startsWith(key, i)) return row;
  }
  return null;
}

/** Phonetic pass over a single Latin word. */
function phonetic(word: string): string {
  const w = word.toLowerCase();
  let out = "";
  let i = 0;
  let atStart = true;

  while (i < w.length) {
    // "n" or "m" before another consonant becomes the nasal dot
    if ((w[i] === "n" || w[i] === "m") && i > 0 && i + 1 < w.length) {
      const next = matchAt(w, i + 1, CONSONANTS);
      const nextIsVowel = matchAt(w, i + 1, VOWELS as never);
      if (next && !nextIsVowel && !atStart) {
        out += ANUSVARA;
        i += 1;
        continue;
      }
    }

    const cons = matchAt(w, i, CONSONANTS) as [string, string] | null;
    if (cons) {
      out += cons[1];
      i += cons[0].length;
      const vow = matchAt(w, i, VOWELS as never) as [string, string, string] | null;
      if (vow) {
        /* A word-final "a" is आ, not the inherent schwa. Hinglish writers drop
           the schwa they do not pronounce ("kamal", not "kamala"), so an "a"
           they did write at the end is a real long vowel: bhola -> भोला. */
        const atEnd = i + vow[0].length >= w.length;
        out += atEnd && vow[0] === "a" ? "\u093E" : vow[2];
        i += vow[0].length;
      } else {
        // another consonant follows, or the word ends -> no inherent vowel
        const more = matchAt(w, i, CONSONANTS);
        if (more || i >= w.length) out += VIRAMA;
      }
      atStart = false;
      continue;
    }

    const vow = matchAt(w, i, VOWELS as never) as [string, string, string] | null;
    if (vow) {
      out += vow[1]; // independent form
      i += vow[0].length;
      atStart = false;
      continue;
    }

    out += w[i];
    i += 1;
  }

  // a trailing virama is wrong at the end of a word — Hindi drops the schwa
  // there anyway, so the bare consonant is what should be written
  return out.replace(new RegExp(VIRAMA + "$"), "");
}

const DEVANAGARI = /[ऀ-ॿ]/;
export const hasDevanagari = (s: string) => DEVANAGARI.test(s ?? "");

/** True when the text is plain Latin worth converting. */
export function looksLatin(s: string): boolean {
  const t = (s ?? "").trim();
  return t.length > 0 && !hasDevanagari(t) && /[a-zA-Z]/.test(t);
}

export interface DevanagariOptions {
  /** nameHinglish -> nameHi from the supplier master; consulted first. */
  known?: Map<string, string>;
}

/** Convert a Latin string to Devanagari, word by word. */
export function toDevanagari(input: string, opts: DevanagariOptions = {}): string {
  const text = (input ?? "").trim();
  if (!text || hasDevanagari(text)) return text;

  // the whole phrase may already be a known supplier
  const wholeKey = text.toLowerCase().replace(/\s+/g, " ");
  const whole = opts.known?.get(wholeKey);
  if (whole) return whole;

  return text
    .split(/(\s+)/)
    .map((tok) => {
      if (/^\s+$/.test(tok)) return " ";
      const bare = tok.toLowerCase().replace(/[.,]/g, "");
      if (!bare) return tok;
      const fromMaster = opts.known?.get(bare);
      if (fromMaster) return fromMaster;
      if (DICT[bare]) return DICT[bare];
      if (!/[a-z]/.test(bare)) return tok; // digits, punctuation
      return phonetic(bare);
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}
