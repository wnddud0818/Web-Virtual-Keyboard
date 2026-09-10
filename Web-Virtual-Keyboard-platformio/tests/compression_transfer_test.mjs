import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { context, getElement } from "./index_script_test.mjs";
import { decoderContext, decoderElement } from "./decoder_protocol_test.mjs";

const run = code => vm.runInContext(code, context);
const decodeWvk = vm.runInContext("decodeWvk", decoderContext);
const parseWvk = vm.runInContext("parseWvk", decoderContext);
const response = data => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const prepare = async (bytes, mode = "wvk1", name = "test.bin") => {
  const job = run("makeTransfer")(new Uint8Array(bytes), name, mode);
  await run("prepareTransfer")(job);
  return job;
};
function envelope(job, overrides = {}) {
  const head = {
    NAME: job.filename, SIZE: job.bytes.length, CHUNKS: job.total, SHA256: job.sha256,
    ...(job.mode === "wvk2" ? { ENCODING: "gzip", ORIGINAL_SIZE: job.originalSize, ORIGINAL_SHA256: job.originalSha256 } : {}),
    ...overrides
  };
  const records = Array.from({ length: job.total }, (_, i) => {
    const chunk = run("transferChunk")(job, i);
    return `C|${String(i + 1).padStart(6, "0")}|${chunk.crc32}|${chunk.data}`;
  });
  return [job.mode.toUpperCase(), ...Object.entries(head).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`), "", ...records, "END", ""].join("\n");
}

// Compression spans the entire file before chunking, preserving UTF-8 and CRLF.
getElement("chunkSize").value = "97"; // padding for non-multiples of three matters
const mixed = Buffer.from("한글 and English\r\n둘째 줄\ttab\r\n".repeat(1000));
const job = await prepare(mixed, "auto", "message.txt");
assert.equal(job.mode, "wvk2");
assert.deepEqual(gunzipSync(job.bytes), mixed);
assert.equal(job.originalSha256, run("sha256Hex")(mixed));
const encoded = envelope(job);
assert.equal(run("transferCharCount")(job.mode, job.bytes.length, job.chunkBytes, job.filename, job.originalSize), encoded.length);
const decoded = await decodeWvk(encoded);
assert.equal(decoded.name, "message.txt");
assert.deepEqual(Buffer.from(decoded.bytes), mixed);
assert.equal(vm.runInContext("asText", decoderContext)(decoded.bytes), mixed.toString());

// Automatic ASCII mode compresses only if the complete envelope beats raw input.
assert.equal((await prepare(Buffer.from("abc"), "auto")).mode, "raw");
assert.equal((await prepare(Buffer.from("x".repeat(150)), "auto")).mode, "raw", "gzip alone is smaller, but headers cost more than raw input");
assert.equal((await prepare(Buffer.from("x".repeat(10000)), "auto")).mode, "wvk2");
const raw = await prepare(Buffer.from("x\r\ny\r".repeat(1000)), "raw");
assert.equal(raw.mode, "raw");
assert.equal(Buffer.from(raw.bytes).toString(), "x\ny\n".repeat(1000));

// Binary, empty, already compressed, tiny, and incompressible data remain exact.
const binary = Buffer.from(Array.from({ length: 10000 }, (_, i) => i % 256));
const binaryJob = await prepare(binary);
assert.equal(binaryJob.mode, "wvk2");
assert.deepEqual(Buffer.from((await decodeWvk(envelope(binaryJob))).bytes), binary);
for (const bytes of [Buffer.alloc(0), Buffer.from([255]), randomBytes(8192), gzipSync(randomBytes(8192))]) {
  const plainJob = await prepare(bytes);
  assert.equal(plainJob.mode, "wvk1");
  assert.deepEqual(Buffer.from((await decodeWvk(envelope(plainJob))).bytes), bytes);
  assert.equal(run("transferCharCount")(plainJob.mode, bytes.length, plainJob.chunkBytes, plainJob.filename), envelope(plainJob).length);
}

// Missing/browser-failed compression falls back without damaging or renaming data.
context.CompressionStream = undefined;
const unsupported = await prepare(mixed);
assert.equal(unsupported.mode, "wvk1");
assert.match(unsupported.compressionNote, /사용할 수 없어/);
assert.deepEqual(Buffer.from(unsupported.bytes), mixed);
context.CompressionStream = class { constructor() { throw new Error("unavailable"); } };
assert.equal((await prepare(mixed)).mode, "wvk1");
context.CompressionStream = CompressionStream;

// Receiver rejects corrupted transport, missing metadata, bad gzip and bad originals.
for (const overrides of [
  { ENCODING: "brotli" }, { ENCODING: undefined },
  { ORIGINAL_SIZE: undefined }, { ORIGINAL_SIZE: "" }, { ORIGINAL_SIZE: "-1" },
  { SHA256: undefined }, { SHA256: "" }, { ORIGINAL_SHA256: undefined },
  { ORIGINAL_SHA256: "bad" }
]) { await assert.rejects(decodeWvk(envelope(job, overrides))); }
await assert.rejects(decodeWvk(envelope(job, { SHA256: "0".repeat(64) })), /SHA-256/);
await assert.rejects(decodeWvk(envelope(job, { ORIGINAL_SHA256: "0".repeat(64) })), /원본의 SHA-256/);
await assert.rejects(decodeWvk(envelope(job, { ORIGINAL_SIZE: 1 })), /원본 크기/);
await assert.rejects(decodeWvk(envelope(job, { ORIGINAL_SIZE: mixed.length + 1 })), /원본 크기/);
await assert.rejects(decodeWvk(encoded.replace(/(C\|\d{6}\|)[A-F0-9]{8}/, "$100000000")), /CRC32/);
await assert.rejects(decodeWvk(encoded.replace("END", "")), /END/);
await assert.rejects(decodeWvk(encoded + "junk"), /END/);
await assert.rejects(decodeWvk(encoded.replace("ENCODING=gzip", "ENCODING=gzip\nENCODING=gzip")), /중복/);
const damaged = { ...job, bytes: job.bytes.slice(0, -6) };
damaged.total = Math.ceil(damaged.bytes.length / damaged.chunkBytes);
damaged.sha256 = run("sha256Hex")(damaged.bytes);
await assert.rejects(decodeWvk(envelope(damaged)), /압축 데이터/);
assert.throws(() => parseWvk(encoded.replace(/^WVK2/, "WVK1")), /압축 형식/);
decoderContext.DecompressionStream = undefined;
await assert.rejects(decodeWvk(encoded), /최신 Chrome/);
assert.deepEqual(Buffer.from((await decodeWvk(envelope(unsupported))).bytes), mixed, "legacy decoding needs no decompression API");
decoderContext.DecompressionStream = DecompressionStream;

// Exercise the real decode action: compressed text is previewed; failures clear it.
decoderElement("data").value = encoded;
await vm.runInContext("decode()", decoderContext);
assert.equal(decoderElement("out").value, mixed.toString());
assert.equal(decoderElement("preview").hidden, false);
decoderElement("data").value = envelope(job, { ORIGINAL_SHA256: "0".repeat(64) });
await vm.runInContext("decode()", decoderContext);
assert.equal(decoderElement("preview").hidden, true);
assert.equal(decoderElement("status").className, "err");

// Selection shows the final mode before the user chooses the receiving input.
await run("selectTransferFile")({ name: "message.txt", arrayBuffer: async () => mixed });
assert.match(getElement("transferHint").textContent, /대상 디코더/);
assert.match(getElement("transferHint").textContent, /자동 압축/);
await run("selectTransferFile")({ name: "small.txt", arrayBuffer: async () => Buffer.from("abc") });
assert.match(getElement("transferHint").textContent, /대상 편집기/);
const pendingSelection = deferred();
const oldSelection = run("selectTransferFile")({ name: "old.txt", arrayBuffer: () => pendingSelection.promise });
await run("selectTransferFile")(null);
pendingSelection.resolve(mixed);
await oldSelection;
assert.equal(run("selectedBytes"), null, "late reads cannot restore an obsolete selection");

// A lost start response must reuse the exact compressed bytes, hashes and ID.
context.setTimeout = (fn, ms) => setTimeout(fn, ms === 10000 ? ms : 0);
context.job = run("makeTransfer")(new Uint8Array(mixed), "message.txt", "wvk1");
let startForm, session, starts = 0, chunks = 0;
context.fetch = async (path, options) => {
  const form = new URLSearchParams(options?.body);
  if (path === "/transfer/start") {
    starts++;
    if (!startForm) {
      startForm = form.toString();
      session = { id: form.get("id"), state: "ready", next: 0 };
      assert.equal(form.get("mode"), "wvk2");
      assert.equal(Number(form.get("originalSize")), mixed.length);
      assert.equal(form.get("originalSha256"), job.originalSha256);
      throw new Error("accepted, response lost");
    }
    assert.equal(form.toString(), startForm);
    return response(session);
  }
  if (path === "/transfer/chunk") {
    const i = Number(form.get("index"));
    assert.equal(i, chunks++);
    assert.equal(form.get("data"), run("transferChunk")(context.job, i).data);
    session = { ...session, next: i + 1, state: i + 1 === context.job.total ? "complete" : "ready" };
    return response(session);
  }
  assert.equal(path, "/transfer/status");
  return response(session);
};
await run("runTransfer(job)");
assert.equal(starts, 2);
assert.equal(chunks, context.job.total);
assert.equal(run("activeTransfer"), null);
assert.match(getElement("compressionSummary").textContent, /입력량.*감소/);

// Stop during compression stays local; completion cannot send a late start.
const compressEntered = deferred(), compressResult = deferred();
const realCompress = run("compressFile");
context.compressFile = async () => { compressEntered.resolve(); return compressResult.promise; };
context.fetch = async () => { assert.fail("cancelled preparation must not contact the device"); };
context.job = run("makeTransfer")(new Uint8Array(mixed), "message.txt", "wvk1");
const preparing = run("runTransfer(job)");
await compressEntered.promise;
await run("stopActiveTransfer()");
compressResult.resolve({ bytes: new Uint8Array(gzipSync(mixed)) });
await preparing;
assert.equal(context.job.cancelConfirmed, true);
assert.equal(run("activeTransfer"), null);
assert.equal(run("transferBusy"), false);
context.compressFile = realCompress;

const sample = fs.readFileSync(new URL("../web/index.html", import.meta.url));
const sampleJob = await prepare(sample, "auto", "index.html");
console.log(`compression transfer tests passed (index.html: ${sample.length} -> ${sampleJob.bytes.length} bytes)`);
