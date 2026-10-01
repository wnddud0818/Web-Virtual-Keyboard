/* CH9329 serial protocol adapter. EUPL-1.2; added 2026-09-28. */
(function (root) {
  'use strict';
  function packet(command, data = [], address = 0) {
    if (!Number.isInteger(address) || address < 0 || address > 254) throw new Error('장치 주소는 0–254입니다.');
    if (data.length > 64) throw new Error('패킷이 너무 큽니다.');
    const out = Uint8Array.from([0x57, 0xab, address, command, data.length, ...data, 0]);
    out[out.length - 1] = out.slice(0, -1).reduce((sum, b) => sum + b, 0) & 255;
    return out;
  }
  class Parser {
    constructor(accept) { this.accept = accept; this.bytes = []; }
    push(chunk) {
      this.bytes.push(...chunk);
      while (this.bytes.length >= 2) {
        if (this.bytes[0] !== 0x57 || this.bytes[1] !== 0xab) { this.bytes.shift(); continue; }
        if (this.bytes.length < 5) return;
        const length = this.bytes[4];
        if (length > 64) { this.bytes.shift(); continue; }
        if (this.bytes.length < length + 6) return;
        const frame = this.bytes.slice(0, length + 6);
        if ((frame.slice(0, -1).reduce((a, b) => a + b, 0) & 255) !== frame.at(-1)) {
          this.bytes.shift(); continue;
        }
        this.bytes.splice(0, length + 6);
        this.accept({ address: frame[2], command: frame[3], data: Uint8Array.from(frame.slice(5, -1)) });
      }
    }
  }
  class ChipError extends Error {}
  class SerialClient {
    constructor({ timeout = 1200, onFault = () => {} } = {}) {
      this.timeout = timeout; this.onFault = onFault;
      this.connected = false; this.port = null; this.tail = Promise.resolve();
    }
    async open(port, baudRate = 9600, address = 0) {
      if (this.port) throw new Error('기존 연결을 먼저 닫아 주세요.');
      packet(1, [], address);
      await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 4096 });
      this.port = port; this.address = address; this.baudRate = baudRate;
      this.connected = true; this.closing = false; this.tail = Promise.resolve();
      this.writer = port.writable.getWriter();
      this.parser = new Parser(frame => this.receive(frame));
      this.readTask = this.readLoop();
    }
    async readLoop() {
      const reader = this.port.readable.getReader(); this.reader = reader;
      try {
        while (!this.closing) {
          const { value, done } = await reader.read();
          if (done) break;
          this.parser.push(value);
        }
        if (!this.closing) this.fault(new Error('케이블 연결이 끊겼습니다. 다시 연결해 주세요.'));
      } catch (error) { if (!this.closing) this.fault(error); }
      finally { reader.releaseLock(); if (this.reader === reader) this.reader = null; }
    }
    fault(error) {
      const wasConnected = this.connected; this.connected = false;
      if (this.pending) { const p = this.pending; this.pending = null; clearTimeout(p.timer); p.reject(error); }
      if (wasConnected && !this.closing) this.onFault(error);
    }
    receive(frame) {
      const p = this.pending;
      if (!p || frame.address !== this.address || ![p.command | 0x80, p.command | 0xc0].includes(frame.command)) return;
      this.pending = null; clearTimeout(p.timer);
      if (frame.command === (p.command | 0xc0) || (p.status && (frame.data.length !== 1 || frame.data[0] !== 0))) {
        p.reject(new ChipError('장치가 명령을 거부했습니다 (상태 0x' + (frame.data[0] ?? 255).toString(16) + ').'));
      } else if (!p.status && frame.data.length !== p.length) {
        const error = new Error('지원하지 않는 응답 형식입니다. 장치 버전을 확인해 주세요.');
        p.reject(error); this.fault(error);
      } else p.resolve(frame.data);
    }
    command(command, data = [], length = 1) {
      const work = () => {
        if (!this.connected) throw new Error('케이블을 연결해 주세요.');
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => this.fault(new Error('장치 응답 시간이 초과되었습니다. 일부 입력은 전달됐을 수 있습니다. 다시 연결해 주세요.')), this.timeout);
          this.pending = { command, resolve, reject, timer, length, status: length === 1 };
          this.writer.write(packet(command, data, this.address)).catch(error => this.fault(error));
        });
      };
      const result = this.tail.then(work);
      this.tail = result.catch(() => {});
      return result;
    }
    async info() {
      const d = await this.command(1, [], 8);
      return { version: d[0], usb: d[1] === 1, capsLock: !!(d[2] & 2), numLock: !!(d[2] & 1) };
    }
    config() { return this.command(8, [], 50); }
    saveOperatingMode(current, mode) {
      if (!(current instanceof Uint8Array) || current.length !== 50) throw new Error('현재 설정 50바이트를 먼저 읽어 주세요.');
      if (!Number.isInteger(mode) || mode < 0 || mode > 3) throw new Error('동작 모드는 0–3 중에서 선택해 주세요.');
      const updated = current.slice();
      updated[0] = mode; updated[1] = 0;
      return this.command(9, updated);
    }
    saveBaudRate(current, baudRate) {
      if (!(current instanceof Uint8Array) || current.length !== 50) throw new Error('현재 설정 50바이트를 먼저 읽어 주세요.');
      if (![9600,19200,38400,57600,115200].includes(baudRate)) throw new Error('지원하지 않는 통신 속도입니다.');
      // SET_PARA_CFG accepts software mode values, not the GET response's
      // hardware-source flag. Keep the current mode numbers, freeze them in NVM.
      if ((current[0] & 0x7f) > 3 || (current[1] & 0x7f) !== 0) throw new Error('현재 모드 구성을 확인할 수 없습니다. 프로토콜 모드 설정이 필요합니다.');
      const updated = current.slice(); updated[0] &= 0x7f; updated[1] = 0;
      new DataView(updated.buffer).setUint32(3, baudRate, false);
      return this.command(9, updated);
    }
    keyboard(modifier = 0, keys = []) {
      if (keys.length > 6) throw new Error('일반 키는 최대 6개까지 동시에 누를 수 있습니다.');
      const data = new Uint8Array(8); data[0] = modifier; data.set(keys, 2);
      return this.command(2, data);
    }
    async tap(modifier, keys) {
      try { await this.keyboard(modifier, keys); }
      finally { if (this.connected) await this.keyboard(); }
    }
    relative(x = 0, y = 0, wheel = 0, buttons = 0) {
      if (![x, y, wheel].every(v => Number.isInteger(v) && v >= -127 && v <= 127)) throw new Error('마우스 이동값이 범위를 벗어났습니다.');
      return this.command(5, [1, buttons & 7, x & 255, y & 255, wheel & 255]);
    }
    absolute(x, y, buttons = 0) {
      if (![x, y].every(v => Number.isInteger(v) && v >= 0 && v <= 4095)) throw new Error('좌표 범위를 확인해 주세요.');
      return this.command(4, [2, buttons & 7, x & 255, x >> 8, y & 255, y >> 8, 0]);
    }
    async releaseAll(mode = 0) {
      let first;
      if ([0,1,2].includes(mode)) { try { await this.keyboard(); } catch (error) { first = error; } }
      if (this.connected && [0,2].includes(mode)) { try { await this.relative(); } catch (error) { first ||= error; } }
      if (first) throw first;
    }
    async close() {
      this.closing = true; this.fault(new Error('연결을 종료했습니다.'));
      try { await this.reader?.cancel(); } catch {}
      try { await this.readTask; } catch {}
      try { this.writer?.releaseLock(); } catch {}
      const port = this.port;
      this.port = null; this.writer = null; this.reader = null;
      try { await port?.close(); } catch {}
    }
  }
  const keys = { ENTER:40, ESC:41, BKSP:42, BACKSPACE:42, TAB:43, SPACE:44, CAPS:57,
    PRTSC:70, SCRLK:71, PAUSE:72, INS:73, HOME:74, PGUP:75, DEL:76, DELETE:76,
    END:77, PGDN:78, RIGHT:79, LEFT:80, DOWN:81, UP:82, NUMLK:83, MENU:101 };
  for (let i = 1; i <= 12; i++) keys['F' + i] = 57 + i;
  const modifiers = { CTRL:1, SHIFT:2, ALT:4, WIN:8, META:8, CMD:8, RCTRL:16, RSHIFT:32, RALT:64, RWIN:128 };
  function asciiReport(char) {
    if (char.length !== 1) throw new Error('한 문자씩 입력해야 합니다.');
    const code = char.charCodeAt(0);
    if (code >= 97 && code <= 122) return { modifier:0, keys:[code - 93] };
    if (code >= 65 && code <= 90) return { modifier:2, keys:[code - 61] };
    if (code >= 49 && code <= 57) return { modifier:0, keys:[code - 19] };
    if (char === '0') return { modifier:0, keys:[39] };
    const plain = " -=[]\\;'`,./", shifted = '_+{}|:"~<>?';
    const usages = [44,45,46,47,48,49,51,52,53,54,55,56];
    let at = plain.indexOf(char);
    if (at >= 0) return { modifier:0, keys:[usages[at]] };
    at = shifted.indexOf(char);
    if (at >= 0) return { modifier:2, keys:[usages[at + 1]] };
    at = '!@#$%^&*()'.indexOf(char);
    if (at >= 0) return { modifier:2, keys:[at === 9 ? 39 : 30 + at] };
    if (char === '\n' || char === '\r') return { modifier:0, keys:[40] };
    if (char === '\t') return { modifier:0, keys:[43] };
    throw new Error('직접 입력은 영문·숫자·기호만 지원합니다. 한글은 “디코더로 보내기”를 사용해 주세요.');
  }
  function shortcut(value) {
    let modifier = 0; const usages = [];
    for (const part of value.trim().toUpperCase().split('+')) {
      if (modifiers[part]) modifier |= modifiers[part];
      else if (keys[part]) usages.push(keys[part]);
      else if (/^[A-Z0-9]$/.test(part)) usages.push(asciiReport(part.toLowerCase()).keys[0]);
      else throw new Error('알 수 없는 키: ' + part);
    }
    if (usages.length > 6 || (!modifier && !usages.length)) throw new Error('단축키를 확인해 주세요.');
    return { modifier, keys:usages };
  }
  function normalizeText(value) {
    const text = String(value).replace(/\r\n?/g, '\n');
    if (/[^\x09\x0a\x20-\x7e]/.test(text)) throw new Error('직접 입력은 영문·숫자·기호만 지원합니다. 한글은 “디코더로 보내기”를 사용해 주세요.');
    return text;
  }
  function* textReports(value, fast = true) {
    let previous = null;
    for (const char of normalizeText(value)) {
      const report = asciiReport(char);
      if (fast) {
        // A new report removes the old key and presses the next one. Repeated
        // usages and modifier transitions need a separate release first.
        if (previous && (previous.keys[0] === report.keys[0] || previous.modifier !== report.modifier)) {
          yield { modifier:0, keys:[], advance:0 };
        }
        yield { ...report, advance:1 };
        previous = report;
      } else {
        yield { ...report, advance:0 };
        yield { modifier:0, keys:[], advance:1 };
      }
    }
    // Caller must release in finally, including on abort/error.
  }
  function textReportCount(value, fast = true) {
    let count = 0; for (const report of textReports(value, fast)) count++;
    return count ? count + 1 : 0;
  }
  const api = { packet, Parser, SerialClient, ChipError, asciiReport, shortcut, normalizeText, textReports, textReportCount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CH9329 = api;
})(globalThis);
