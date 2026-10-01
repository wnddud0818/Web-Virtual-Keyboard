const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomBytes } = require('node:crypto');
const WVK = require('../transfer.js');
const { textReportCount } = require('../protocol.js');
const html = fs.readFileSync(path.join(__dirname,'../decoder.html'),'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/i)[1];
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, { value:'', textContent:'', addEventListener() {}, appendChild() {}, remove() {}, click() {} });
  return elements.get(id);
}
const context = vm.createContext({ Uint8Array, Uint32Array, DataView, Blob, DecompressionStream, TextDecoder, atob, setTimeout, URL:{ createObjectURL:() => 'blob:test', revokeObjectURL() {} }, document:{ getElementById:element, querySelectorAll:() => [], createElement:() => element('created'), body:{ appendChild() {} } } });
vm.runInContext(source + '\n;globalThis.decoder={decodeWvk,parseWvk,asText};',context);

test('embedded decoder matches original and stays typable ASCII', () => {
  const original = fs.readFileSync(path.join(__dirname,'../../Web-Virtual-Keyboard-platformio/web/decoder.html'),'utf8');
  assert.equal(html, original); assert.ok(!/[^\x00-\x7f]/.test(html));
  const embedded = { window:{} }; vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../decoder-source.js'),'utf8'),embedded);
  assert.equal(Buffer.from(embedded.window.WVK_DECODER_BASE64,'base64').toString(),html);
});
test('CRC golden vector and empty file round trip', async () => {
  assert.equal(WVK.crc32(new TextEncoder().encode('123456789')), 'CBF43926');
  const result = await WVK.prepare(new Uint8Array(), 'empty.txt');
  const decoded = await context.decoder.decodeWvk(result.text); assert.equal(decoded.bytes.length, 0);
});
test('binary multi-chunk WVK1 round trip with original decoder', async () => {
  const bytes = randomBytes(2317);
  const result = await WVK.prepare(bytes, '../보고서.bin', false);
  const decoded = await context.decoder.decodeWvk(result.text);
  assert.equal(result.mode, 'WVK1 · Base64'); assert.deepEqual(Buffer.from(decoded.bytes), bytes);
  assert.equal(decoded.chunks, 4); assert.ok(!decoded.name.includes('/')); assert.ok(!result.text.includes('보고서'));
});
test('Korean/emoji gzip WVK2 round trip with original decoder', async () => {
  const text = '한글도 그대로 복원됩니다. 🐳\n'.repeat(300);
  const result = await WVK.prepare(new TextEncoder().encode(text), 'message.txt');
  assert.equal(result.mode, 'WVK2 · gzip'); assert.ok(result.saved > 0);
  const decoded = await context.decoder.decodeWvk(result.text);
  assert.equal(new TextDecoder().decode(decoded.bytes),text);
});
test('corruption, missing END, and missing chunks fail validation', async () => {
  const result = await WVK.prepare(new Uint8Array(1600).fill(23), 'test.bin', false);
  const corrupted = result.text.replace(/(C\|000001\|[A-F0-9]{8}\|)./, '$1Z');
  await assert.rejects(context.decoder.decodeWvk(corrupted));
  await assert.rejects(context.decoder.decodeWvk(result.text.replace('END\n','')));
  await assert.rejects(context.decoder.decodeWvk(result.text.replace(/C\|000002[^\n]*\n/,'')));
});
test('oversize source rejected before compression', async () => {
  await assert.rejects(WVK.prepare(new Uint8Array(16 * 1024 * 1024 + 1),'big.bin'), /16 MiB/);
});

test('compressed installer restores exact decoder, validates digest, and types less', async () => {
  const installer = fs.readFileSync(path.join(__dirname,'../decoder-installer.html'),'utf8');
  const embedded = { window:{} }; vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../decoder-source.js'),'utf8'),embedded);
  assert.equal(Buffer.from(embedded.window.WVK_INSTALLER_BASE64,'base64').toString(),installer);
  assert.ok(!/[^\x00-\x7f]/.test(installer));
  assert.ok(installer.length < html.length * 0.6);
  assert.ok(textReportCount(installer,true) < textReportCount(html,false) * 0.5);
  const script = installer.match(/<script>([\s\S]*?)<\/script>/i)[1];
  let written = ''; const status = {};
  const environment = { Uint8Array, Blob, Response, TextDecoder, DecompressionStream, crypto, atob,
    document:{ open() {}, write(value) { written = value; }, close() {}, getElementById() { return status; } } };
  await vm.runInNewContext(script,environment); assert.equal(written,html);
  written = '';
  await vm.runInNewContext(script.replace(/h!=="[a-f0-9]{64}"/, 'h!=="' + '0'.repeat(64) + '"'),environment);
  assert.equal(written,''); assert.match(status.textContent,/corrupted/);
});
