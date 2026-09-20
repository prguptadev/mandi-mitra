/* Devanagari -> readable Hinglish, tuned for UP mandi supplier names.
 *
 * This is deliberately NOT ITRANS/IAST. Nobody writes "Phūlsiṃh Varmā" on a
 * CSV — they write "Phoolsingh Verma". So: a phonetic base pass, Hindi schwa
 * deletion, then a name-component override table for the words that appear on
 * every sheet and have a settled English spelling.
 *
 * The result is a STARTING POINT. adati.nameHinglish is editable and, once a
 * human touches it, nameHinglishLocked stops us from ever overwriting it.
 */

const INDEPENDENT_VOWELS: Record<string, string> = {
  "अ": "a", "आ": "a", "इ": "i", "ई": "i", "उ": "u", "ऊ": "u",
  "ऋ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au",
  "ऑ": "o", "ऍ": "e",
};

const MATRAS: Record<string, string> = {
  "ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u",
  "ृ": "ri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au",
  "ॉ": "o", "ॅ": "e",
};

const CONSONANTS: Record<string, string> = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "ng",
  "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
  "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
  "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
  "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
  "य": "y", "र": "r", "ल": "l", "व": "v", "ळ": "l",
  "श": "sh", "ष": "sh", "स": "s", "ह": "h",
  "क़": "q", "ख़": "kh", "ग़": "g", "ज़": "z", "ड़": "r",
  "ढ़": "rh", "फ़": "f", "य़": "y",
};

const VIRAMA = "्";
const ANUSVARA = "ं";
const CHANDRABINDU = "ँ";
const VISARGA = "ः";
const NUKTA = "़";
const LABIALS = new Set(["प", "फ", "ब", "भ", "म"]);

/** Words with a settled English spelling that the phonetic pass gets wrong. */
const WORD_OVERRIDES: Record<string, string> = {
  // surnames / titles
  "सिंह": "Singh", "सिह": "Singh", "वर्मा": "Verma", "शर्मा": "Sharma",
  "यादव": "Yadav", "जोशी": "Joshi", "चौधरी": "Chaudhary", "चौहान": "Chauhan",
  "राठोर": "Rathore", "राठौर": "Rathore", "कुमार": "Kumar", "लाल": "Lal",
  "पाल": "Pal", "गुप्ता": "Gupta", "अग्रवाल": "Agarwal", "मिश्रा": "Mishra",
  "पाण्डेय": "Pandey", "पांडेय": "Pandey", "तिवारी": "Tiwari", "दुबे": "Dubey",
  "ठाकुर": "Thakur", "जाटव": "Jatav", "कुशवाहा": "Kushwaha", "बघेल": "Baghel",
  "दिवाकर": "Diwakar", "सक्सेना": "Saxena", "श्रीवास्तव": "Srivastava",
  // given names seen on the sheets
  "फूल": "Phool", "फूलसिंह": "Phoolsingh", "राकेश": "Rakesh", "शिवम": "Shivam",
  "अरविन्द": "Arvind", "अरविंद": "Arvind", "वीरेन्द्र": "Virendra",
  "वीरेंद्र": "Virendra", "वरिन्द": "Virendra", "सुरेन्द्र": "Surendra",
  "पुष्पेन्द्र": "Pushpendra", "पुष्पेंद्र": "Pushpendra", "रामवीर": "Ramveer",
  "सहदेव": "Sahdev", "संत": "Sant", "राधा": "Radha", "श्याम": "Shyam",
  "गणेश": "Ganesh", "ज्योति": "Jyoti", "धर्मपाल": "Dharampal",
  "रामपाल": "Rampal", "सूर्य": "Surya", "प्रकाश": "Prakash", "चरन": "Charan",
  "अमित": "Amit", "संजीव": "Sanjeev", "दिनेश": "Dinesh", "कृष्ण": "Krishna",
  "शान्ति": "Shanti", "शांति": "Shanti", "स्वरूप": "Swaroop", "स्वरुप": "Swaroop",
  "मोहनी": "Mohani", "केशी": "Keshi", "अरुण": "Arun", "मुन्ना": "Munna",
  "बाबू": "Babu", "देवी": "Devi", "प्रसाद": "Prasad", "नाथ": "Nath",
  "बिहारी": "Bihari", "मुरारी": "Murari", "हरि": "Hari", "ओम": "Om",
  // firm words
  "इंटरप्राइजेज": "Enterprises", "इन्टरप्राइजेज": "Enterprises",
  "एंटरप्राइजेज": "Enterprises", "ट्रेडर्स": "Traders", "ट्रेडिंग": "Trading",
  "कंपनी": "Company", "कम्पनी": "Company", "एण्ड": "and", "एंड": "and",
  "संस": "Sons", "ब्रदर्स": "Brothers", "फर्म": "Firm", "मिल": "Mill",
  "एग्रो": "Agro", "फूड्स": "Foods", "इंडस्ट्रीज": "Industries",
  "ठेकेदार": "Thekedar", "आढ़ती": "Adati", "आढती": "Adati",
};

/** Leave these exactly as written — they are already Latin on the sheets. */
const PASSTHROUGH = /^[A-Za-z0-9][A-Za-z0-9.\-&/]*$/;

function transliterateWord(word: string): string {
  const direct = WORD_OVERRIDES[word];
  if (direct) return direct;
  if (PASSTHROUGH.test(word)) return word;

  const chars = Array.from(word.normalize("NFC"));
  let out = "";
  let i = 0;

  while (i < chars.length) {
    let ch = chars[i];

    // fold a following nukta into the base glyph (क + ़ = क़)
    if (i + 1 < chars.length && chars[i + 1] === NUKTA && CONSONANTS[ch + NUKTA]) {
      ch = ch + NUKTA;
      i += 1;
    }

    if (CONSONANTS[ch]) {
      out += CONSONANTS[ch];
      const next = chars[i + 1];

      if (next === VIRAMA) {
        i += 2; // conjunct — no inherent vowel
        continue;
      }
      if (next && MATRAS[next]) {
        out += MATRAS[next];
        i += 2;
        // nasal directly after the matra
        if (chars[i] === ANUSVARA || chars[i] === CHANDRABINDU) {
          out += LABIALS.has(stripNukta(chars[i + 1] ?? "")) ? "m" : "n";
          i += 1;
        }
        continue;
      }
      if (next === ANUSVARA || next === CHANDRABINDU) {
        out += "a" + (LABIALS.has(stripNukta(chars[i + 2] ?? "")) ? "m" : "n");
        i += 2;
        continue;
      }
      if (next === VISARGA) {
        out += "ah";
        i += 2;
        continue;
      }
      // inherent 'a' — dropped word-finally (Hindi schwa deletion)
      out += i === chars.length - 1 ? "" : "a";
      i += 1;
      continue;
    }

    if (INDEPENDENT_VOWELS[ch]) {
      out += INDEPENDENT_VOWELS[ch];
      i += 1;
      if (chars[i] === ANUSVARA || chars[i] === CHANDRABINDU) {
        out += LABIALS.has(stripNukta(chars[i + 1] ?? "")) ? "m" : "n";
        i += 1;
      }
      continue;
    }

    if (ch === ANUSVARA || ch === CHANDRABINDU) { out += "n"; i += 1; continue; }
    if (ch === VISARGA) { out += "h"; i += 1; continue; }
    if (ch === VIRAMA || ch === NUKTA) { i += 1; continue; }
    if (ch === "ॐ") { out += "Om"; i += 1; continue; }

    out += ch; // digits, punctuation, Latin
    i += 1;
  }

  return tidy(out);
}

function stripNukta(s: string) {
  return s.replace(NUKTA, "");
}

function tidy(s: string): string {
  return s
    .replace(/aa+/g, "a")
    .replace(/([aeiou])\1+/g, "$1$1")
    .replace(/^./, (c) => c.toUpperCase());
}

/** Hindi (Devanagari) -> Hinglish. Safe on mixed or already-Latin input. */
export function toHinglish(input: string): string {
  if (!input) return "";
  const whole = WORD_OVERRIDES[input.trim()];
  if (whole) return whole;

  return input
    .normalize("NFC")
    .split(/(\s+)/)
    .map((tok) => (/^\s+$/.test(tok) ? " " : transliterateWord(tok)))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------ fuzzy matching */

/** Consonant groups that OCR and handwriting routinely swap in Devanagari. */
const FOLD: Record<string, string> = {
  "ष": "स", "श": "स", "ब": "व", "ड़": "र", "ढ़": "र", "ण": "न", "ङ": "न",
  "ञ": "न", "ट": "त", "ठ": "थ", "ड": "द", "ढ": "ध", "क़": "क", "ख़": "ख",
  "ग़": "ग", "ज़": "ज", "फ़": "फ", "ळ": "ल", "ऱ": "र",
};

/**
 * Collapse a Devanagari string to a match key: drop every matra, nasal and
 * virama, fold confusable consonants. "फूलसिंह" and "फुलसिह" both become the
 * same key, so an OCR misread still finds the right supplier.
 */
export function normKey(input: string): string {
  if (!input) return "";
  const stripped = Array.from(input.normalize("NFC"))
    .filter((c) => !MATRAS[c] && c !== ANUSVARA && c !== CHANDRABINDU && c !== VISARGA && c !== VIRAMA && c !== NUKTA)
    .map((c) => FOLD[c] ?? c)
    .join("");
  return stripped
    .toLowerCase()
    .replace(/[^ऀ-ॿa-z0-9]/g, "");
}

/** Damerau-Levenshtein, capped for speed on short name strings. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev2 = new Array<number>(b.length + 1);
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
      }
    }
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j];
    const swap = prev; prev = cur; cur = swap;
  }
  return prev[b.length];
}

/** 0..1 similarity on normalised keys. */
export function similarity(a: string, b: string): number {
  const ka = normKey(a);
  const kb = normKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  const d = editDistance(ka, kb);
  return Math.max(0, 1 - d / Math.max(ka.length, kb.length));
}
