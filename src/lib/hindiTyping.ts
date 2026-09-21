import { api } from "./api.ts";

const DEVANAGARI = /[ऀ-ॿ]/;
export const hasLatin = (s: string) => /[a-zA-Z]/.test(s ?? "");
export const hasDevanagari = (s: string) => DEVANAGARI.test(s ?? "");

async function toHindi(text: string, publicOnly?: boolean): Promise<string | null> {
  const path = publicOnly ? "/auth/to-devanagari" : "/adati/to-devanagari";
  try {
    const r = await api.post<{ hindi: string; converted: boolean }>(path, { text });
    return r.converted ? r.hindi : null;
  } catch {
    try {
      const r = await api.post<{ hindi: string; converted: boolean }>("/auth/to-devanagari", { text });
      return r.converted ? r.hindi : null;
    } catch { return null; }
  }
}

/**
 * Space finishes a word. When a change inserts text ending in a space, this
 * names the stretch just finished — the word before the space, or every word
 * of a pasted or keyboard-suggested chunk — so only that is converted:
 * "सिंह raam" + space gives "सिंह राम ", and earlier words are left as they
 * are. Works from the change itself rather than the key, because phone
 * keyboards and IMEs do not report a usable key for space.
 */
export function finishedWord(prev: string, next: string, caret: number): { start: number; word: string } | null {
  const added = next.length - prev.length;
  if (added < 1 || next[caret - 1] !== " ") return null;
  // back from where the insertion began to the start of the word it touched
  let start = Math.max(0, caret - added);
  while (start > 0 && !/\s/.test(next[start - 1])) start--;
  const word = next.slice(start, caret - 1).replace(/\s+$/, "");
  if (!word.trim() || !hasLatin(word)) return null;
  const lead = word.length - word.trimStart().length;
  return { start: start + lead, word: word.trimStart() };
}

/** The Hindi for one word, or null when there is none. */
export async function hindiWord(word: string, publicOnly?: boolean): Promise<string | null> {
  const h = await toHindi(word, publicOnly);
  return h && h !== word ? h : null;
}

/**
 * Put the Hindi in place of the word, in whatever the box holds by the time
 * the lookup returns, so letters typed in the meantime are kept. Null when
 * the word has since been edited away.
 */
export function replaceWord(current: string, start: number, word: string, hindi: string) {
  if (current.slice(start, start + word.length) !== word) return null;
  return {
    text: current.slice(0, start) + hindi + current.slice(start + word.length),
    shift: hindi.length - word.length,
  };
}

/**
 * Wire the three together for an input. `set` receives the new text; the
 * cursor is moved along with it.
 */
export function convertFinishedWord(
  el: HTMLInputElement, prev: string, set: (text: string) => void, publicOnly?: boolean,
) {
  const w = finishedWord(prev, el.value, el.selectionStart ?? el.value.length);
  if (!w) return;
  void hindiWord(w.word, publicOnly).then((hindi) => {
    if (!hindi || !el.isConnected) return;
    const pos = el.selectionStart ?? el.value.length;
    const r = replaceWord(el.value, w.start, w.word, hindi);
    if (!r) return;
    set(r.text);
    const at = pos > w.start ? pos + r.shift : pos;
    requestAnimationFrame(() => { if (document.activeElement === el) el.setSelectionRange(at, at); });
  });
}

/** Convert every Latin word left in the text (Enter, Tab, leaving the box). */
export async function convertAll(text: string, publicOnly?: boolean): Promise<string | null> {
  if (!hasLatin(text)) return null;
  const hindi = await toHindi(text, publicOnly);
  return hindi && hindi !== text ? hindi : null;
}
