import test from 'node:test';
import assert from 'node:assert/strict';
import { answerKeys, isClose, toKey } from '../src/core/normalize.js';
import { ENTRIES, parseCustomWords, pickEntries } from '../src/core/words.js';

test('Arabic spelling variants all match the answer', () => {
  const answers = answerKeys({ ar: ['قطة', 'قط'] }, ['ar']);
  for (const guess of ['قطة', 'قطه', 'القطة', 'القطه', 'قِطَّة', 'قـطـة', '  قطة! ', 'قط']) {
    assert.ok(answers.includes(toKey(guess)), guess);
  }
  assert.ok(!answers.includes(toKey('كلب')));
});

test('hamza, alef maqsura and digits are normalised', () => {
  assert.equal(toKey('أسد'), toKey('اسد'));
  assert.equal(toKey('إبريق'), toKey('ابريق'));
  assert.equal(toKey('آيس كريم'), toKey('ايسكريم'));
  assert.equal(toKey('مستشفى'), toKey('مستشفي'));
  assert.equal(toKey('الأرض'), toKey('ارض'));
  assert.equal(toKey('كرة القدم'), toKey('كره قدم'));
  assert.equal(toKey('٣'), '3');
});

test('English guesses ignore case, accents, punctuation and articles', () => {
  assert.equal(toKey('The Ice-Cream!'), toKey('ice cream'));
  assert.equal(toKey('Café'), 'cafe');
  assert.equal(toKey('an apple'), 'apple');
  assert.equal(toKey('a'), 'a');
});

test('close guesses are detected without false alarms', () => {
  assert.ok(isClose(toKey('elefant'), [toKey('elephant')]));
  assert.ok(isClose(toKey('زرافا'), [toKey('زرافة')]));
  assert.ok(!isClose(toKey('cow'), [toKey('cat')]));
  assert.ok(!isClose(toKey('bus'), [toKey('bed')]));
});

test('every built-in word has English and Arabic answers', () => {
  assert.ok(ENTRIES.length >= 200);
  for (const entry of ENTRIES) {
    assert.ok(entry.en.length && entry.ar.length, entry.key);
    assert.ok(answerKeys(entry, ['en']).length && answerKeys(entry, ['ar']).length, entry.en[0]);
    assert.ok(entry.ar.every(w => /[؀-ۿ]/.test(w)), entry.en[0]);
    assert.ok(entry.en.every(w => !/[؀-ۿ]/.test(w)), entry.en[0]);
  }
});

test('custom words split by script and separator', () => {
  const entries = parseCustomWords('cat|قطة|قط, dog\nبيت، house');
  assert.deepEqual(entries.map(e => [e.en, e.ar]), [
    [['cat'], ['قطة', 'قط']],
    [['dog'], []],
    [[], ['بيت']],
    [['house'], []],
  ]);
});

test('word picking respects language and custom-only mode', () => {
  const custom = parseCustomWords('one, two, three, اربعة');
  const picked = pickEntries(3, 'en', custom, true, new Set());
  assert.equal(picked.length, 3);
  assert.ok(picked.every(e => custom.includes(e) && e.en.length));
  const arabic = pickEntries(3, 'ar', [], false, new Set());
  assert.equal(new Set(arabic.map(e => e.key)).size, 3);
  assert.ok(arabic.every(e => e.ar.length));
});
