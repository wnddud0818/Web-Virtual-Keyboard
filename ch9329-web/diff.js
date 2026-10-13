/* Exact UTF-8 deltas; no network or runtime dependencies. EUPL-1.2. */
(function (root) {
  'use strict';
  const WVK = typeof module !== 'undefined' && module.exports ? require('./transfer.js') : root.WVK;
  const LIMIT = 16 * 1024 * 1024, MAX_LINES = 100000, MAX_EDITS = 512;
  const encoder = new TextEncoder();
  const binaryName = /\.(?:bin|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|bmp|ico|avif|heic|exe|msi|dll|so|dylib|wasm|class|jar|zip|gz|7z|rar|tar|mp[34]|wav|ogg|mov|woff2?|ttf)$/i;
  function text(bytes, name) {
    if (binaryName.test(name) || bytes.some(b => b === 127 || (b < 32 && b !== 9 && b !== 10 && b !== 13))) return null;
    try { return new TextDecoder('utf-8', { fatal:true, ignoreBOM:true }).decode(bytes); }
    catch { return null; }
  }
  function lines(value) {
    if (!value) return [];
    const parts = value.split('\n', MAX_LINES + 1);
    if (parts.length > MAX_LINES) return null;
    return parts.map((line, i) => line + (i < parts.length - 1 ? '\n' : '')).filter(line => line.length);
  }
  // Bounded Myers diff. Large/very different inputs use one exact byte range instead.
  function changes(a, b) {
    let first = 0, endA = a.length, endB = b.length;
    while (first < endA && first < endB && a[first] === b[first]) first++;
    while (endA > first && endB > first && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const n = endA - first, m = endB - first, limit = Math.min(MAX_EDITS, n + m);
    if (Math.abs(n - m) > limit) return null;
    const shift = limit + 1, v = new Int32Array(2 * limit + 3).fill(-1), trace = [];
    v[shift + 1] = 0;
    let work = 0;
    for (let d = 0; d <= limit; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        if (++work > 2000000) return null;
        let x = k === -d || (k !== d && v[shift + k - 1] < v[shift + k + 1]) ? v[shift + k + 1] : v[shift + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && a[first + x] === b[first + y]) { x++; y++; if (++work > 2000000) return null; }
        v[shift + k] = x;
        if (x < n || y < m) continue;
        const steps = [];
        for (let depth = d; depth > 0; depth--) {
          const prev = trace[depth], diagonal = x - y;
          const prevK = diagonal === -depth || (diagonal !== depth && prev[shift + diagonal - 1] < prev[shift + diagonal + 1]) ? diagonal + 1 : diagonal - 1;
          const prevX = prev[shift + prevK], prevY = prevX - prevK;
          while (x > prevX && y > prevY) { steps.push('same'); x--; y--; }
          if (x === prevX) { steps.push('add'); y--; } else { steps.push('remove'); x--; }
        }
        while (x > 0 && y > 0) { steps.push('same'); x--; y--; }
        steps.reverse();
        let oldAt = first, newAt = first, run = null;
        const result = [];
        for (const step of steps) {
          if (step === 'same') {
            if (run) { result.push(run); run = null; }
            oldAt++; newAt++;
          } else {
            if (!run) run = { oldStart:oldAt, oldEnd:oldAt, newStart:newAt, newEnd:newAt };
            if (step === 'remove') run.oldEnd = ++oldAt; else run.newEnd = ++newAt;
          }
        }
        if (run) result.push(run);
        return result;
      }
    }
    return null;
  }
  function offsets(parts) {
    const result = [0];
    for (const part of parts) result.push(result[result.length - 1] + encoder.encode(part).length);
    return result;
  }
  function base64(bytes) {
    let value = '';
    for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(value);
  }
  function operation(base, next, oldStart, oldEnd, newStart, newEnd) {
    while (oldStart < oldEnd && newStart < newEnd && base[oldStart] === next[newStart]) { oldStart++; newStart++; }
    while (oldEnd > oldStart && newEnd > newStart && base[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
    if (oldStart === oldEnd && newStart === newEnd) return null;
    return { offset:oldStart, deleteBytes:oldEnd - oldStart, dataBase64:base64(next.subarray(newStart, newEnd)) };
  }
  async function createPatch(base, next, name, baseName = name) {
    if (base.length > LIMIT || next.length > LIMIT) throw new Error('기준 파일과 수정본은 각각 최대 16 MiB까지 지원합니다.');
    const oldText = text(base, baseName), newText = text(next, name);
    if (oldText === null || newText === null) return { reason:'UTF-8 텍스트 파일이 아니므로 전체 파일로 전송합니다.' };
    if (oldText === newText) return { unchanged:true };
    const oldLines = lines(oldText), newLines = lines(newText);
    const runs = oldLines && newLines ? changes(oldLines, newLines) : null;
    let ops;
    if (runs) {
      const oldOffsets = offsets(oldLines), newOffsets = offsets(newLines);
      ops = runs.map(run => operation(base, next, oldOffsets[run.oldStart], oldOffsets[run.oldEnd], newOffsets[run.newStart], newOffsets[run.newEnd])).filter(Boolean);
    } else ops = [operation(base, next, 0, base.length, 0, next.length)];
    return { patch:{ format:'WVKPATCH1', name:WVK.safeFilename(name), baseSize:base.length, baseSha256:await WVK.sha256(base),
      resultSize:next.length, resultSha256:await WVK.sha256(next), ops } };
  }
  async function prepare(base, next, name, baseName = name, cost = value => value.length) {
    const delta = await createPatch(base, next, name, baseName);
    if (delta.unchanged) return { unchanged:true };
    const full = await WVK.prepare(next, name);
    if (!delta.patch) return { ...full, note:delta.reason };
    const payload = encoder.encode(JSON.stringify(delta.patch));
    if (payload.length > LIMIT) return { ...full, note:'변경분이 커서 전체 파일로 전송합니다.' };
    const plan = await WVK.prepare(payload, WVK.safeFilename(name).slice(0, 119) + '.wvkpatch', true, 'patch-v1');
    if (cost(plan.text) >= cost(full.text)) return { ...full, note:'전체 파일의 압축 전송이 더 효율적이므로 전체 파일로 전송합니다.' };
    return { ...plan, mode:'변경분 · ' + plan.mode, patch:true, original:next.length, saved:0,
      changes:delta.patch.ops.length, fullCharacters:full.text.length, baseHash:delta.patch.baseSha256,
      note:`변경 구간 ${delta.patch.ops.length}개 · 전체 전송 ${full.text.length.toLocaleString()}자 → 변경분 ${plan.text.length.toLocaleString()}자\n대상 디코더에서 수정 전 기준 파일을 선택하세요. 기준 파일이 다르면 적용하지 않습니다.` };
  }
  const api = { createPatch, prepare };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WVKDiff = api;
})(globalThis);
