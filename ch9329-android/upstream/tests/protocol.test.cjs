const { test } = require('node:test');
const assert = require('node:assert/strict');
const { packet, Parser, SerialClient, ChipError, asciiReport, shortcut, normalizeText, textReports, textReportCount } = require('../protocol.js');

function mockPort(handle) {
  const writes = []; let input;
  return {
    writes, options:null, closed:false,
    readable:new ReadableStream({ start(controller) { input = controller; } }),
    writable:new WritableStream({ write(value) { const bytes = Uint8Array.from(value); writes.push(bytes); return handle(bytes, response => input.enqueue(response)); } }),
    async open(options) { this.options = options; }, async close() { this.closed = true; },
    unplug() { input.error(new Error('unplugged')); }
  };
}
function acknowledge(bytes, send) { send(packet(bytes[3] | 0x80, [0], bytes[2])); }

test('official golden key reports and config-read checksum', () => {
  assert.deepEqual([...packet(2, [0,0,4,0,0,0,0,0])], [0x57,0xab,0,2,8,0,0,4,0,0,0,0,0,0x10]);
  assert.deepEqual([...packet(8)], [0x57,0xab,0,8,0,0x0a]);
  assert.throws(() => packet(1, [], 255), /주소/);
});

test('fragmented/coalesced packets, noise and bad checksum recover', () => {
  const received = []; const parser = new Parser(frame => received.push(frame));
  const good = packet(0x82, [0]); const bad = good.slice(); bad[bad.length - 1] ^= 1;
  parser.push([0x12,0x57,0x01,...bad,0x57,0xab]);
  parser.push(good.slice(2,4)); assert.equal(received.length, 0);
  parser.push([...good.slice(4),...packet(0x85,[0])]);
  assert.deepEqual(received.map(f => f.command), [0x82,0x85]);
});

test('all printable US-ASCII is mapped; no non-ASCII silently drops', () => {
  for (let i = 32; i <= 126; i++) {
    const report = asciiReport(String.fromCharCode(i));
    assert.ok(report.keys[0] >= 4 && report.keys[0] <= 56);
  }
  assert.deepEqual(asciiReport('A'), { modifier:2, keys:[4] });
  assert.deepEqual(asciiReport('~'), { modifier:2, keys:[53] });
  assert.deepEqual(asciiReport('"'), { modifier:2, keys:[52] });
  assert.deepEqual(asciiReport('?'), { modifier:2, keys:[56] });
  assert.throws(() => asciiReport('한'), /디코더/);
  assert.equal(normalizeText('a\r\nb\rc'), 'a\nb\nc');
  assert.throws(() => normalizeText('a\0b'), /디코더/);
  assert.deepEqual(shortcut('CTRL+ALT+DEL'), { modifier:5, keys:[76] });
  assert.deepEqual(shortcut('RALT'), { modifier:64, keys:[] });
  assert.deepEqual(shortcut('F12'), { modifier:0, keys:[69] });
  assert.throws(() => shortcut('CTRL+TYPO'), /알 수 없는/);
});

test('one outstanding command, wrong command/address ignored, release follows press', async () => {
  let inFlight = 0, maximum = 0;
  const port = mockPort((bytes, send) => {
    inFlight++; maximum = Math.max(maximum, inFlight);
    send(packet(0x88, [0], 8)); send(packet(0x82, [0], 9));
    setTimeout(() => { inFlight--; acknowledge(bytes, send); }, 5);
  });
  const client = new SerialClient(); await client.open(port, 9600, 8);
  await Promise.all([client.tap(2,[4]), client.relative(-20,30,-1)]);
  assert.equal(maximum, 1);
  assert.deepEqual([...port.writes[0].slice(5,13)], [2,0,4,0,0,0,0,0]);
  assert.deepEqual([...port.writes.at(-1).slice(5,13)], Array(8).fill(0));
  const mouse = port.writes.find(frame => frame[3] === 5);
  assert.deepEqual([...mouse.slice(5,-1)], [1,0,236,30,255]);
  assert.equal(port.options.parity, 'none');
  await client.close(); assert.ok(port.closed);
});

test('error response rejects and pressed key is released', async () => {
  let count = 0;
  const port = mockPort((bytes, send) => send(packet(++count === 1 ? 0xc2 : 0x82, [count === 1 ? 0xe6 : 0])));
  const client = new SerialClient(); await client.open(port);
  await assert.rejects(client.tap(0,[4]), ChipError);
  assert.equal(port.writes.length, 2);
  assert.deepEqual([...port.writes[1].slice(5,13)], Array(8).fill(0));
  await client.close();
});

test('timeout poisons connection; no retry or queued duplicate', async () => {
  let fault = 0;
  const port = mockPort(() => {});
  const client = new SerialClient({ timeout:25, onFault() { fault++; } }); await client.open(port);
  const first = client.keyboard(0,[4]), second = client.keyboard(0,[5]);
  await assert.rejects(first, /초과/); await assert.rejects(second, /연결/);
  assert.equal(port.writes.length, 1); assert.equal(fault, 1); assert.equal(client.connected, false);
  await client.close();
});

test('unplug rejects pending command', async () => {
  const port = mockPort(() => {}); const client = new SerialClient(); await client.open(port);
  const pending = client.keyboard(0,[4]); await new Promise(resolve => setTimeout(resolve, 1));
  port.unplug(); await assert.rejects(pending, /unplugged/); assert.equal(client.connected, false); await client.close();
});

test('all four operating modes preserve other config bytes and reject invalid writes', async () => {
  const port = mockPort(acknowledge); const client = new SerialClient(); await client.open(port);
  const current = Uint8Array.from({ length:50 }, (_, i) => i + 20); const original = current.slice();
  for (const mode of [0,1,2,3]) {
    await client.saveOperatingMode(current, mode);
    const written = port.writes.at(-1); assert.equal(written[3], 9); assert.equal(written[4], 50);
    assert.deepEqual([...written.slice(5,7)], [mode,0]);
    assert.deepEqual(written.slice(7,-1), original.slice(2)); assert.deepEqual(current, original);
  }
  for (const length of [0,49,51]) assert.throws(() => client.saveOperatingMode(new Uint8Array(length),1), /50바이트/);
  for (const mode of [-1,4,0x81,1.5,NaN,undefined,'1',null]) assert.throws(() => client.saveOperatingMode(current,mode), /동작 모드/);
  assert.equal(port.writes.length, 4); await client.close();
});

test('connection recovery only releases inputs supported by the active mode', async () => {
  const expected = [[2,5],[2],[2,5],[]];
  for (const mode of [0,1,2,3]) {
    const port = mockPort((bytes, send) => {
      assert.ok(expected[mode].includes(bytes[3]), 'unsupported input command');
      acknowledge(bytes, send);
    });
    const client = new SerialClient(); await client.open(port);
    await client.releaseAll(mode);
    assert.deepEqual(port.writes.map(bytes => bytes[3]), expected[mode]);
    await client.close();
  }
});

test('USB info and absolute mouse wire encoding', async () => {
  const port = mockPort((bytes, send) => bytes[3] === 1 ? send(packet(0x81,[0x31,1,2,0,0,0,0,0])) : acknowledge(bytes, send));
  const client = new SerialClient(); await client.open(port);
  assert.deepEqual(await client.info(), { version:49, usb:true, capsLock:true, numLock:false });
  await client.absolute(4095,2048); assert.deepEqual([...port.writes.at(-1).slice(5,-1)], [2,0,255,15,0,8,0]);
  assert.throws(() => client.absolute(4096,0), /좌표/); await client.close();
});

test('fast typing preserves repeated usages, case changes, symbols and CRLF', () => {
  const lookup = new Map();
  for (const char of '\t\n' + Array.from({ length:95 }, (_, i) => String.fromCharCode(i + 32)).join('')) {
    const r = asciiReport(char); lookup.set(r.modifier + ':' + r.keys[0], char);
  }
  function received(reports) {
    let held = new Set(), text = '';
    for (const r of reports) {
      for (const key of r.keys) if (!held.has(key)) text += lookup.get(r.modifier + ':' + key);
      held = new Set(r.keys);
    }
    return text;
  }
  for (const text of ['bookkeeper aAa A%& !! 1122\r\n', [...lookup.values()].join('').repeat(3)]) {
    assert.equal(received(textReports(text,true)), normalizeText(text));
    assert.equal(received(textReports(text,false)), normalizeText(text));
  }
  assert.equal(textReportCount('abcd',true), 5);
  assert.equal(textReportCount('abcd',false), 9);
  assert.equal(textReportCount('aaaa',true), 8);
  assert.throws(() => [...textReports('hello한글')], /디코더/);
});

test('baud change writes big-endian speed and preserves active modes and other settings', async () => {
  const port = mockPort(acknowledge); const client = new SerialClient(); await client.open(port);
  const current = Uint8Array.from({ length:50 }, (_, i) => i); current[0] = 0x82; current[1] = 0x80;
  const snapshot = current.slice();
  await client.saveBaudRate(current, 57600);
  const data = port.writes[0].slice(5,-1);
  assert.equal(new DataView(data.buffer,data.byteOffset,data.byteLength).getUint32(3,false),57600);
  assert.deepEqual([...data.slice(0,3)],[2,0,2]); assert.deepEqual(data.slice(7),snapshot.slice(7)); assert.deepEqual(current,snapshot);
  assert.throws(() => client.saveBaudRate(current,921600), /지원하지/);
  const ascii = current.slice(); ascii[1] = 0x81; assert.throws(() => client.saveBaudRate(ascii,57600), /프로토콜/);
  await client.close();
});
