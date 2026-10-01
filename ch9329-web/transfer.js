/* WVK envelopes compatible with the original project's offline decoder. EUPL-1.2. */
(function (root) {
  'use strict';
  const table = Uint32Array.from({ length:256 }, (_, n) => {
    let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  function crc32(bytes) {
    let c = 0xffffffff; for (const b of bytes) c = table[(c ^ b) & 255] ^ (c >>> 8);
    return ((c ^ 0xffffffff) >>> 0).toString(16).toUpperCase().padStart(8, '0');
  }
  async function sha256(bytes) {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  }
  function base64(bytes) {
    let result = ''; for (const b of bytes) result += String.fromCharCode(b);
    return btoa(result);
  }
  function safeFilename(name) { return String(name || 'download.bin').replace(/[^\x20-\x7e]|[\\/:*?"<>|]/g, '_').trim().slice(0, 128) || 'download.bin'; }
  async function envelope(bytes, name, original = null, chunkSize = 768) {
    const chunks = Math.ceil(bytes.length / chunkSize);
    if (chunks > 999999) throw new Error('파일이 너무 큽니다.');
    let result = `${original ? 'WVK2' : 'WVK1'}\nNAME=${safeFilename(name)}\nSIZE=${bytes.length}\nCHUNKS=${chunks}\nSHA256=${await sha256(bytes)}\n`;
    if (original) result += `ENCODING=gzip\nORIGINAL_SIZE=${original.length}\nORIGINAL_SHA256=${await sha256(original)}\n`;
    result += '\n';
    for (let i = 0; i < chunks; i++) {
      const part = bytes.subarray(i * chunkSize, (i + 1) * chunkSize);
      result += `C|${String(i + 1).padStart(6, '0')}|${crc32(part)}|${base64(part)}\n`;
    }
    return result + 'END\n';
  }
  async function prepare(bytes, name, compress = true) {
    if (bytes.length > 16 * 1024 * 1024) throw new Error('한 번에 최대 16 MiB를 준비할 수 있습니다. 키보드 전송에는 작은 파일을 권장합니다.');
    const plain = await envelope(bytes, name);
    if (compress && typeof CompressionStream === 'function') {
      try {
        const zipped = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
        if (zipped.length < bytes.length) {
          const compressed = await envelope(zipped, name, bytes);
          if (compressed.length < plain.length) return { text:compressed, mode:'WVK2 · gzip', original:bytes.length, saved:plain.length - compressed.length };
        }
      } catch { /* Optional compression can fall back to a fully verified WVK1. */ }
    }
    return { text:plain, mode:'WVK1 · Base64', original:bytes.length, saved:0 };
  }
  const api = { crc32, sha256, envelope, prepare, safeFilename };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WVK = api;
})(globalThis);
