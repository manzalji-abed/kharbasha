// Text normalisation so guesses match answers despite spelling variants.
// Arabic: hamza forms (أ إ آ ؤ ئ) collapse to their base letter, ة → ه, ى → ي,
// tashkeel and tatweel are dropped, and the definite article "ال" is optional.
// English: case, accents, punctuation and a leading "the/a/an" are ignored.

const MARKS = /\p{M}/gu; // after NFKD this covers Latin accents, tashkeel and hamza marks
const TATWEEL = /ـ/g;
const EASTERN_DIGITS = /[٠-٩۰-۹]/g;
const LETTERS = { 'ٱ': 'ا', 'ى': 'ي', 'ی': 'ي', 'ة': 'ه', 'ک': 'ك', 'ڪ': 'ك' };
const EN_ARTICLES = new Set(['the', 'a', 'an']);
const CONTROL = /[\u0000-\u001f\u007f​‎‏‪-‮⁦-⁩]/g;

export function normalize(text) {
  return String(text)
    .normalize('NFKD')
    .replace(MARKS, '')
    .replace(TATWEEL, '')
    .toLowerCase()
    .replace(EASTERN_DIGITS, d => String(d.charCodeAt(0) - (d >= '۰' ? 0x6F0 : 0x660)))
    .replace(/[ٱىیةکڪ]/g, ch => LETTERS[ch])
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Comparison key: normalised, article-free, with spaces removed ("ice cream" = "icecream").
export function toKey(text) {
  const words = normalize(text).split(' ').filter(Boolean);
  if (words.length > 1 && EN_ARTICLES.has(words[0])) words.shift();
  return words.map(w => (w.length > 3 && w.startsWith('ال') ? w.slice(2) : w)).join('');
}

export function answerKeys(entry, langs) {
  const keys = new Set();
  for (const lang of langs) {
    for (const alt of entry[lang] ?? []) {
      const key = toKey(alt);
      if (key) keys.add(key);
    }
  }
  return [...keys];
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// "Close" = one typo away (two for long words), only for answers of 4+ letters.
export function isClose(guessKey, answers) {
  if (!guessKey) return false;
  return answers.some(answer => {
    if (answer.length < 4) return false;
    const max = answer.length >= 8 ? 2 : 1;
    return Math.abs(answer.length - guessKey.length) <= max && levenshtein(guessKey, answer) <= max;
  });
}

// Strips control and bidi-override characters, collapses whitespace, caps length in code points.
export function cleanText(value, max) {
  const text = String(value ?? '').replace(CONTROL, '').replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, max).join('');
}
