import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const decoderPath = new URL("../web/decoder.html", import.meta.url);
const html = fs.readFileSync(decoderPath, "utf8");

assert.equal(Buffer.from(html, "utf8").some(byte => byte > 0x7f), false,
  "decoder.html must stay US-ASCII so it can be typed by HID");

const match = html.match(/<script>([\s\S]*?)<\/script>/i);
assert.ok(match, "decoder.html must contain one inline script");

const elements = new Map();
function element(id = "") {
  if (!elements.has(id)) {
    elements.set(id, {
      id,
      value: "",
      textContent: "",
      className: "",
      disabled: false,
      addEventListener() {},
      appendChild() {},
      remove() {},
      click() {}
    });
  }
  return elements.get(id);
}

const context = vm.createContext({
  Uint8Array,
  Uint32Array,
  DataView,
  Blob,
  Number,
  String,
  Error,
  Math,
  TextDecoder,
  URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
  setTimeout,
  atob: value => Buffer.from(value, "base64").toString("binary"),
  document: {
    body: { appendChild() {} },
    getElementById: id => element(id),
    createElement: () => element("created"),
    querySelectorAll: () => []
  }
});

vm.runInContext(`${match[1]}\n;globalThis.protocol = { crc32, sha256, fromBase64, parseWvk, asText };`, context);
const { crc32, sha256, fromBase64, parseWvk, asText } = context.protocol;

const ascii = value => new Uint8Array(Buffer.from(value, "ascii"));
assert.equal(crc32(ascii("123456789")), "CBF43926");
assert.equal(sha256(new Uint8Array()),
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
assert.equal(sha256(ascii("abc")),
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
assert.deepEqual(Array.from(fromBase64("AAEC/w==")), [0, 1, 2, 255]);

const chunks = [
  new Uint8Array([0, 1, 2, 3, 4]),
  new Uint8Array([250, 251, 252, 253, 254, 255])
];
const original = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
let offset = 0;
for (const chunk of chunks) {
  original.set(chunk, offset);
  offset += chunk.length;
}

const records = chunks.map((chunk, index) => {
  const sequence = String(index + 1).padStart(6, "0");
  const base64 = Buffer.from(chunk).toString("base64");
  return `C|${sequence}|${crc32(chunk)}|${base64}`;
});
const envelope = [
  "WVK1",
  "NAME=round-trip.bin",
  `SIZE=${original.length}`,
  `CHUNKS=${chunks.length}`,
  `SHA256=${sha256(original)}`,
  "",
  ...records,
  "END",
  ""
].join("\n");

const decoded = parseWvk(envelope);
assert.equal(decoded.name, "round-trip.bin");
assert.equal(decoded.chunks, 2);
assert.deepEqual(Array.from(decoded.bytes), Array.from(original));

assert.throws(() => parseWvk(envelope.replace(records[0], records[0].replace("|", "|00000000|"))));
assert.throws(() => parseWvk(envelope.replace(`SIZE=${original.length}`, "SIZE=999")), /파일 크기 불일치/);
assert.throws(() => parseWvk(envelope.replace("C|000002", "C|000003")), /청크 순서 오류/);
assert.throws(() => parseWvk(envelope.replace(/SHA256=[0-9a-f]+/, `SHA256=${"0".repeat(64)}`)), /SHA-256이 일치하지 않/);

// --- text preview: valid UTF-8 is shown, binary is not ---
const mixed = "한글 and English — 효율 100%\n둘째 줄\ttab\n";
const mixedBytes = new Uint8Array(Buffer.from(mixed, "utf8"));
assert.equal(asText(mixedBytes), mixed, "mixed Korean/English UTF-8 must decode back unchanged");
assert.equal(asText(new Uint8Array()), "");
assert.equal(asText(ascii("plain ascii\t\r\n")), "plain ascii\t\r\n");
assert.equal(asText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), null,
  "a PNG signature must not be shown as text");
assert.equal(asText(new Uint8Array([65, 0, 66])), null, "NUL means binary");
assert.equal(asText(mixedBytes.subarray(0, 2)), null,
  "a truncated Hangul syllable must be reported as binary, not shown as mojibake");

// --- the same text survives a full WVK1 round trip ---
const textEnvelope = [
  "WVK1",
  "NAME=message.txt",
  `SIZE=${mixedBytes.length}`,
  "CHUNKS=1",
  `SHA256=${sha256(mixedBytes)}`,
  "",
  `C|000001|${crc32(mixedBytes)}|${Buffer.from(mixedBytes).toString("base64")}`,
  "END",
  ""
].join("\n");
const textFile = parseWvk(textEnvelope);
assert.equal(textFile.name, "message.txt");
assert.equal(asText(textFile.bytes), mixed);

console.log("decoder protocol tests passed");
