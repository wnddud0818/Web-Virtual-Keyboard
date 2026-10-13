const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const WVK = require('../transfer.js');
const Diff = require('../diff.js');
const { textReportCount } = require('../protocol.js');
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, { value:'', files:[], textContent:'', disabled:false, addEventListener() {}, appendChild() {}, remove() {}, click() {} });
  return elements.get(id);
}
const context = vm.createContext({ Uint8Array, Uint32Array, DataView, Blob, TextDecoder, DecompressionStream, atob, setTimeout,
  URL:{ createObjectURL:() => 'blob:test', revokeObjectURL() {} },
  document:{ getElementById:element, querySelectorAll:() => [], createElement:() => element('created'), body:{ appendChild() {} } } });
const html = fs.readFileSync(path.join(__dirname, '../decoder.html'), 'utf8');
vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/i)[1] + '\n;globalThis.decoder={decodeWvk,applyPatch,decode};', context);
const bytes = text => Buffer.from(text, 'utf8');
const payload = patch => bytes(JSON.stringify(patch));
const apply = (patch, base) => Buffer.from(context.decoder.applyPatch(payload(patch), base).bytes);
const sample = () => {
  const base = bytes('\uFEFF' + Array.from({ length:180 }, (_, i) => 'const value' + i + ' = "한글 ' + i + '";\r\n').join(''));
  const next = bytes(base.toString().replace('한글 2"', '변경 😀 2"').replace('const value80', '// 설명\r\nconst value80').replace('const value150 = "한글 150";\r\n', '').replace(/\r\n$/, ''));
  return { base, next };
};

test('multiple insert/delete/replace hunks preserve BOM, Hangul, emoji, CRLF and missing final newline', async () => {
  const { base, next } = sample();
  const { patch } = await Diff.createPatch(base, next, 'source.ts');
  assert.ok(patch.ops.length >= 4, 'distant edits should remain separate');
  assert.deepEqual(apply(patch, base), next);
  assert.deepEqual(base.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
});

test('empty files, whole deletion, repeated lines, CR-only text, BOM-only change and extensionless text round trip', async () => {
  for (const [old, next] of [
    ['', '한글\n'], ['abc\n', ''], ['x\nx\ny\n', 'x\ny\nx\n'],
    ['a\rb\rc', 'A\rb\rC'], ['\uFEFFtext', 'text'], ['text', '\uFEFFtext'],
    ['line\n', 'line'], ['line', 'line\n'], ['', '\uFEFF']
  ]) {
    const { patch } = await Diff.createPatch(bytes(old), bytes(next), 'Dockerfile');
    assert.deepEqual(apply(patch, bytes(old)), bytes(next));
  }
  assert.equal((await Diff.prepare(bytes('same'), bytes('same'), 'same.txt')).unchanged, true);
});

test('deterministic mixed edits reconstruct exact bytes across 200 revisions', async () => {
  let seed = 73;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let revision = 0; revision < 200; revision++) {
    const old = Array.from({ length:random(40) }, () => ['repeat\n', '한글\r\n', '😀\n', 'x\n'][random(4)]);
    const next = old.slice();
    for (let edit = 0; edit < 6; edit++) next.splice(random(next.length + 1), random(3), ...['', 'new\n', '한글!\r\n'][random(3)].split(/(?<=\n)/).filter(Boolean));
    const base = bytes(old.join('')), result = bytes(next.join(''));
    const delta = await Diff.createPatch(base, result, 'test.txt');
    if (delta.unchanged) assert.deepEqual(base, result);
    else assert.deepEqual(apply(delta.patch, base), result, 'revision ' + revision);
  }
});

test('large edit distance and line-count limit use a bounded exact replacement', async () => {
  for (const [old, next] of [
    ['old\n'.repeat(800), 'new\n'.repeat(800)],
    ['x\n'.repeat(100001), 'x\n'.repeat(50000) + 'y\n' + 'x\n'.repeat(50000)]
  ]) {
    const base = bytes(old), result = bytes(next);
    assert.deepEqual(apply((await Diff.createPatch(base, result, 'test.txt')).patch, base), result);
  }
});

test('non-UTF-8, UTF-16 and binary formats fall back to exact full-file transfer', async () => {
  for (const [base, next, name] of [
    [Buffer.from([0xb0, 0xa1]), Buffer.from([0xb0, 0xa2]), 'cp949.txt'],
    [Buffer.from('old', 'utf16le'), Buffer.from('new', 'utf16le'), 'utf16.txt'],
    [bytes('%PDF-1.4 old'), bytes('%PDF-1.4 new'), 'document.pdf'],
    [Buffer.from([0, 1, 2]), Buffer.from([0, 1, 3]), 'image.png']
  ]) {
    const plan = await Diff.prepare(base, next, name);
    assert.equal(plan.patch, undefined);
    assert.match(plan.note, /UTF-8/);
    assert.deepEqual(Buffer.from((await context.decoder.decodeWvk(plan.text)).bytes), next);
  }
  const tiny = await Diff.prepare(bytes('a'), bytes('b'), 'tiny.txt');
  assert.equal(tiny.patch, undefined);
  assert.match(tiny.note, /효율적/);
  await assert.rejects(Diff.prepare(new Uint8Array(16 * 1024 * 1024 + 1), bytes('x'), 'large.txt'), /16 MiB/);
});

test('patch envelope compresses, verifies and resumes using the existing transport', async () => {
  const { base, next } = sample();
  const plan = await Diff.prepare(base, next, 'source.ts', 'source.ts', text => textReportCount(text, true));
  assert.equal(plan.patch, true);
  assert.ok(plan.text.length < plan.fullCharacters);
  const file = await context.decoder.decodeWvk(plan.text);
  assert.equal(file.content, 'patch-v1');
  assert.deepEqual(Buffer.from(context.decoder.applyPatch(file.bytes, base).bytes), next);
  const patch = (await Diff.createPatch(base, next, 'source.ts')).patch;
  const uncompressed = await WVK.envelope(payload(patch), 'source.wvkpatch', null, 128, 'patch-v1');
  const starts = WVK.chunkStarts(uncompressed);
  assert.ok(starts.length >= 2);
  const received = uncompressed.slice(0, starts[1] + 30);
  const resumed = received.slice(0, received.lastIndexOf('\n') + 1) + uncompressed.slice(starts[1]);
  assert.deepEqual(Buffer.from(context.decoder.applyPatch((await context.decoder.decodeWvk(resumed)).bytes, base).bytes), next);
  await assert.rejects(context.decoder.decodeWvk(plan.text.replace(/SHA256=[a-f0-9]{64}/, 'SHA256=' + '0'.repeat(64))), /SHA-256/);
  await assert.rejects(context.decoder.decodeWvk(plan.text.replace('CONTENT=patch-v1', 'CONTENT=patch-v9')), /변경분/);
});

test('receiver rejects wrong baselines, wrong result hash, overlapping/out-of-range/malformed edits and sizes', async () => {
  const base = bytes('one\ntwo\nthree\n'), next = bytes('ONE\ntwo\nTHREE\n');
  const { patch } = await Diff.createPatch(base, next, 'test.txt');
  assert.throws(() => apply(patch, bytes('one\ntwo\nother\n')), /기준 파일/);
  assert.throws(() => apply(patch, base.subarray(1)), /기준 파일/);
  for (const mutate of [
    p => { p.resultSha256 = '0'.repeat(64); },
    p => { p.ops[1].offset = 0; },
    p => { p.ops[0].offset = -1; },
    p => { p.ops[0].deleteBytes = base.length + 1; },
    p => { p.ops[0].dataBase64 = '???'; },
    p => { p.ops[0].offset = 0.5; },
    p => { p.resultSize++; },
    p => { p.resultSize = 16 * 1024 * 1024 + 1; },
    p => { p.ops = []; },
    p => { p.ops = Array(4097).fill(p.ops[0]); },
    p => { p.format = 'other'; }
  ]) {
    const invalid = JSON.parse(JSON.stringify(patch)); mutate(invalid);
    assert.throws(() => apply(invalid, base));
  }
  assert.throws(() => context.decoder.applyPatch(bytes('not JSON'), base), /형식/);
  assert.deepEqual(apply(patch, base), next, 'failed validation must not modify the baseline');
});

test('decoder action requires a selected baseline and clears stale output on failures', async () => {
  const { base, next } = sample(), { patch } = await Diff.createPatch(base, next, 'source.ts');
  const plan = await WVK.prepare(payload(patch), 'source.wvkpatch', true, 'patch-v1');
  element('data').value = plan.text; element('baseFile').files = [];
  await context.decoder.decode();
  assert.equal(element('status').className, 'err');
  assert.match(element('status').textContent, /기준 파일/);
  assert.equal(element('patchOptions').open, true);
  element('baseFile').files = [new Blob([base])];
  await context.decoder.decode();
  assert.equal(element('status').className, 'ok');
  assert.equal(element('preview').hidden, false);
  assert.equal(element('out').value, next.toString().replace(/^\uFEFF/, ''));
  element('baseFile').files = [new Blob([bytes('wrong')])];
  await context.decoder.decode();
  assert.equal(element('status').className, 'err');
  assert.equal(element('preview').hidden, true);
  assert.equal(element('out').value, '');
  assert.equal(element('baseFile').disabled, false);
});
