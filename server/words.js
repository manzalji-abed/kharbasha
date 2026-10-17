import { randomInt } from 'node:crypto';
import { WORD_PAIRS } from './wordlist.js';

const ARABIC = /[؀-ۿ]/;
const split = s => s.split('|').map(x => x.trim()).filter(Boolean);

export const ENTRIES = WORD_PAIRS.map(([en, ar], i) => ({ key: `w${i}`, en: split(en), ar: split(ar) }));

// Host-supplied words: comma (, or ،) or newline separated; "|" joins alternatives
// and translations, e.g. "cat|قطة|قط". Each alternative is sorted by script.
export function parseCustomWords(text) {
  const seen = new Set();
  const out = [];
  for (const item of String(text).split(/[,،\n]/)) {
    const alts = item.split('|').map(s => s.trim().slice(0, 30)).filter(Boolean);
    if (!alts.length) continue;
    const key = `c:${alts.join('|').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, en: alts.filter(a => !ARABIC.test(a)), ar: alts.filter(a => ARABIC.test(a)) });
    if (out.length >= 500) break;
  }
  return out;
}

function fits(entry, lang) {
  return lang === 'both' ? entry.en.length > 0 || entry.ar.length > 0 : entry[lang].length > 0;
}

function sample(pool, n) {
  const copy = [...pool];
  const out = [];
  while (out.length < n && copy.length) out.push(copy.splice(randomInt(copy.length), 1)[0]);
  return out;
}

// Picks `n` word options, avoiding words already used this game until the pool runs dry.
// Custom words get half the slots unless the room uses custom words only.
export function pickEntries(n, lang, custom, customOnly, used) {
  const fresh = list => {
    const unused = list.filter(e => !used.has(e.key));
    return unused.length >= n ? unused : list;
  };
  const customPool = fresh(custom.filter(e => fits(e, lang)));
  const builtinPool = fresh(ENTRIES.filter(e => fits(e, lang)));

  if (customOnly && customPool.length >= n) return sample(customPool, n);
  const fromCustom = sample(customPool, customOnly ? customPool.length : Math.ceil(n / 2));
  const rest = sample(builtinPool.filter(e => !fromCustom.includes(e)), n - fromCustom.length);
  return sample([...fromCustom, ...rest], n);
}
