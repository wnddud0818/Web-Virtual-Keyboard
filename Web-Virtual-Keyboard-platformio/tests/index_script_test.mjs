import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const match = html.match(/<script>([\s\S]*?)<\/script>/i);
assert.ok(match, "index.html must contain one inline script");

const listeners = new Map();
function makeElement(id = "") {
  return {
    id,
    value: id === "transferMode" ? "auto" : id === "chunkSize" ? "768" : id === "keyDelay" ? "5" : "",
    textContent: "",
    className: "",
    innerHTML: "",
    hidden: false,
    disabled: false,
    checked: false,
    files: [],
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(type, handler) { listeners.set(`${id}:${type}`, handler); },
    appendChild() {},
    setAttribute() {},
    focus() {},
    setSelectionRange() {},
    querySelector() { return { setAttribute() {} }; }
  };
}

const elements = new Map();
const getElement = id => {
  if (!elements.has(id)) { elements.set(id, makeElement(id)); }
  return elements.get(id);
};
const radio = makeElement("radio");
radio.value = "plain";

const context = vm.createContext({
  Uint8Array,
  Uint32Array,
  DataView,
  URLSearchParams,
  Number,
  String,
  Error,
  Math,
  Date,
  Promise,
  TextEncoder,
  setTimeout,
  clearTimeout,
  btoa: value => Buffer.from(value, "binary").toString("base64"),
  confirm: () => true,
  window: { matchMedia: () => ({ matches: false }) },
  document: {
    getElementById: getElement,
    createElement: () => makeElement("created"),
    querySelector: () => radio,
    querySelectorAll: () => [radio],
    addEventListener() {}
  },
  fetch: async path => ({
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => String(path) === "/info" ? { fw: "test", storage: "test" } : []
  })
});

vm.runInContext(`${match[1]}\n;globalThis.protocol = { crc32Hex, sha256Hex, safeFilename, isRawSafe, normalizeRawBytes, bytesToBase64, utf8Bytes, isAsciiTypable };`, context);
const protocol = context.protocol;
const ascii = value => new Uint8Array(Buffer.from(value, "ascii"));

assert.equal(protocol.crc32Hex(ascii("123456789")), "CBF43926");
assert.equal(protocol.sha256Hex(ascii("abc")),
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
assert.equal(protocol.bytesToBase64(new Uint8Array([0, 1, 2, 255])), "AAEC/w==");
assert.equal(protocol.safeFilename("../bad:name|.zip"), ".._bad_name_.zip");
assert.equal(protocol.isRawSafe(new Uint8Array([9, 10, 13, 32, 126])), true);
assert.equal(protocol.isRawSafe(new Uint8Array([0, 127, 255])), false);
assert.deepEqual(Array.from(protocol.normalizeRawBytes(new Uint8Array([65, 13, 10, 66, 13, 67]))),
  [65, 10, 66, 10, 67]);

// --- WVK1 text send: UTF-8 encoding, and the ASCII gate on quick typing ---
assert.deepEqual(Array.from(protocol.utf8Bytes("한")), [0xed, 0x95, 0x9c]);
assert.deepEqual(Array.from(protocol.utf8Bytes("A")), [65]);
assert.equal(protocol.utf8Bytes("").length, 0);
assert.equal(protocol.utf8Bytes(null).length, 0);

const mixedText = "한글 mixed with English";
assert.equal(Buffer.from(protocol.utf8Bytes(mixedText)).toString("utf8"), mixedText,
  "mixed Korean/English text must survive UTF-8 encoding for the WVK1 envelope");

// Whatever the gate lets through must also be typable byte-for-byte in raw mode.
assert.equal(protocol.isAsciiTypable("plain ascii\t\r\n"), true);
assert.equal(protocol.isRawSafe(protocol.utf8Bytes("plain ascii\t\r\n")), true);
assert.equal(protocol.isAsciiTypable(mixedText), false, "Hangul has no HID keycode");
assert.equal(protocol.isAsciiTypable("caf" + String.fromCharCode(0xe9)), false,
  "Latin-1 accents have no keycode");
assert.equal(protocol.isAsciiTypable("bell" + String.fromCharCode(7)), false, "control bytes have no keycode either");

console.log("index script tests passed");
