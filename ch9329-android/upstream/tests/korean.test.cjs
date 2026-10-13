const { test } = require('node:test');
const assert = require('node:assert/strict');
const { asciiReport, hangulKeys, normalizeKoreanText, koreanTextReports } = require('../protocol.js');

test('all 11,172 modern syllables match their Unicode-decomposed two-set strokes', () => {
  const strokes = new Map();
  // Unicode conjoining-jamo ranges, independent of the syllable-index formula.
  ['r R s e E f a q Q t T d w W c z x v g',
    'k o i O j p u P h hk ho hl y n nj np nl b m ml l',
    'r R rt s sw sg e f fr fa fq ft fx fv fg a q qt t T d w c z x v g']
    .forEach((keys, row) => keys.split(' ').forEach((key, i) => strokes.set(String.fromCharCode([0x1100,0x1161,0x11a8][row] + i), key)));
  for (let code = 0xac00; code <= 0xd7a3; code++) {
    const char = String.fromCharCode(code);
    assert.equal(hangulKeys(char), [...char.normalize('NFD')].map(jamo => strokes.get(jamo)).join(''), char);
  }
  for (const [char, expected] of Object.entries({ 한:'gks', 글:'rmf', 값:'rkqt', 꿨:'RnjT', 뷁:'qnpfr', 힣:'glg', ㄲ:'R', ㅒ:'O', ㅠ:'b' })) {
    assert.equal(hangulKeys(char), expected);
  }
});

test('mixed text validates the entire input before yielding any key', () => {
  assert.equal(normalizeKoreanText('한'.normalize('NFD') + '\r\nhello\rㄱ'), '한\nhello\nㄱ');
  for (const char of ['😀', '漢', 'é', '“', '\0', '\b', 'ㄳ', 'ㅘ', 'ᄀ']) {
    const reports = koreanTextReports('hello 한글 ' + char);
    assert.throws(() => reports.next(), /디코더/, char);
  }
});

test('physical key transitions isolate syllables, preserve English and finish in English', () => {
  const lookup = new Map();
  for (const char of '\t\n' + Array.from({ length:95 }, (_, i) => String.fromCharCode(i + 32)).join('')) {
    const r = asciiReport(char); lookup.set(r.modifier + ':' + r.keys[0], char);
  }
  // Observe newly pressed physical keys, rather than counting reports. Korean
  // sessions must be committed separately, including ambiguous syllable edges.
  const observe = reports => {
    let held = new Set(), previousModifier = 0, korean = false, english = '', strokes = '', advance = 0, waits = 0;
    const sessions = [];
    for (const r of reports) {
      if ((r.modifier & 64) && !(previousModifier & 64)) {
        korean = !korean;
        assert.equal(r.ime, korean ? 'korean' : 'english');
        if (!korean) { sessions.push(strokes); strokes = ''; }
      }
      for (const key of r.keys) if (!held.has(key)) {
        const char = lookup.get(r.modifier + ':' + key);
        assert.ok(char !== undefined, 'unmapped key');
        if (korean) strokes += char; else english += char;
      }
      if (r.wait) { assert.equal(r.wait, 100); assert.equal(r.modifier, 0); assert.equal(r.keys.length, 0); waits++; }
      advance += r.advance; previousModifier = r.modifier; held = new Set(r.keys);
    }
    assert.equal(korean, false); assert.equal(previousModifier, 0); assert.equal(held.size, 0);
    return { sessions, english, advance, waits };
  };
  const text = 'Hi 간아 값이 ㄱ아 kk 꿨뷁!\tOK\r\n';
  for (const fast of [true, false]) {
    assert.deepEqual(observe(koreanTextReports(text, fast)), {
      sessions:['rks','dk','rkqt','dl','r','dk','RnjT','qnpfr'], english:'Hi    kk !\tOK\n',
      advance:normalizeKoreanText(text).length, waits:16
    });
    assert.deepEqual(observe(koreanTextReports('aaAA!!\n', fast)), { sessions:[], english:'aaAA!!\n', advance:7, waits:0 });
  }
});
