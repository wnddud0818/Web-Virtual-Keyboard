const { test } = require('node:test');
const assert = require('node:assert/strict');
const { packet, SerialClient } = require('../protocol.js');
const { filters, baudDivisor, Ch340UsbPort, request } = require('../ch340-usb.js');

// Answers each command in two fragments after an empty transfer, as a CH340 may.
function acknowledge(bytes, push) {
  const response = bytes[3] === 1 ? packet(0x81, [0x31,1,0,0,0,0,0,0], bytes[2]) : packet(bytes[3] | 0x80, [0], bytes[2]);
  push([]); push(response.slice(0, 3)); push(response.slice(3));
}
function mockDevice({ version = 0x31, respond = acknowledge, claim } = {}) {
  const controls = [], writes = [], queue = []; let waiter = null;
  const abort = (name, message) => { waiter?.reject(new DOMException(message, name)); waiter = null; };
  function flush() {
    if (!waiter || !queue.length) return;
    const w = waiter; waiter = null; w.resolve({ status:'ok', data:new DataView(queue.shift().buffer) });
  }
  const push = bytes => { queue.push(Uint8Array.from(bytes)); flush(); };
  return {
    vendorId:0x1a86, productId:0x7523, opened:false, configuration:null, claimed:null, controls, writes,
    async open() { this.opened = true; },
    async close() { this.opened = false; abort('AbortError', 'The device was closed.'); },
    async selectConfiguration(value) {
      assert.equal(value, 1);
      this.configuration = { interfaces:[{ interfaceNumber:0, alternate:{ endpoints:[
        { endpointNumber:1, direction:'in', type:'interrupt', packetSize:8 },
        { endpointNumber:2, direction:'in', type:'bulk', packetSize:32 },
        { endpointNumber:2, direction:'out', type:'bulk', packetSize:32 }
      ] }, alternates:[] }] };
    },
    async claimInterface(number) { if (claim) throw claim; this.claimed = number; },
    async releaseInterface() { this.claimed = null; abort('AbortError', 'The interface was released.'); },
    async controlTransferIn(setup, length) {
      assert.equal(setup.requestType, 'vendor'); assert.equal(setup.recipient, 'device');
      controls.push([setup.request, setup.value, setup.index, length]);
      return { status:'ok', data:new DataView(Uint8Array.from([version, 0]).buffer) };
    },
    async controlTransferOut(setup, data) {
      assert.equal(setup.requestType, 'vendor'); assert.equal(data, undefined);
      controls.push([setup.request, setup.value, setup.index]);
      return { status:'ok', bytesWritten:0 };
    },
    transferIn(endpoint, length) {
      assert.equal(endpoint, 2); assert.ok(length >= 32);
      return new Promise((resolve, reject) => { waiter = { resolve, reject }; flush(); });
    },
    async transferOut(endpoint, data) {
      assert.equal(endpoint, 2);
      const bytes = Uint8Array.from(data); writes.push(bytes); respond(bytes, push);
      return { status:'ok', bytesWritten:bytes.byteLength };
    },
    unplug() { abort('NotFoundError', 'The device was disconnected.'); }
  };
}

test('baud divisors match the Linux ch341 driver for every supported speed', () => {
  assert.deepEqual([9600,19200,38400,57600,115200].map(baudDivisor), [0xb202,0xd902,0x6403,0x9803,0xcc03]);
  for (const bad of [45, 3000001, 1.5, NaN]) assert.throws(() => baudDivisor(bad), /통신 속도/);
});

test('open claims the bulk interface and configures 8N1 before any data', async () => {
  const device = mockDevice(), port = new Ch340UsbPort(device, null);
  await port.open({ baudRate:57600, dataBits:8, stopBits:1, parity:'none', flowControl:'none', bufferSize:4096 });
  assert.equal(device.claimed, 0);
  assert.deepEqual(device.controls, [[0x5f,0,0,2],[0xa1,0,0],[0x9a,0x1312,0x9883],[0x9a,0x2518,0xc3],[0xa4,0xff9f,0]]);
  assert.equal(device.writes.length, 0);
  await port.close(); assert.equal(device.opened, false); assert.equal(device.claimed, null);
});

test('chips up to 0x27 keep the Linux prescaler bit and skip the separate LCR write', async () => {
  const device = mockDevice({ version:0x27 }), port = new Ch340UsbPort(device, null);
  await port.open({ baudRate:9600 });
  assert.deepEqual(device.controls, [[0x5f,0,0,2],[0xa1,0,0],[0x9a,0x1312,0xb202],[0xa4,0xff9f,0]]);
  await port.close();
});

test('SerialClient runs over USB with empty and fragmented bulk transfers', async () => {
  const device = mockDevice(), client = new SerialClient();
  await client.open(new Ch340UsbPort(device, null), 9600, 0);
  assert.deepEqual(await client.info(), { version:0x31, usb:true, capsLock:false, numLock:false });
  await client.tap(2, [4]);
  assert.deepEqual(device.writes.map(bytes => bytes[3]), [1,2,2]);
  assert.deepEqual([...device.writes[1].slice(5,13)], [2,0,4,0,0,0,0,0]);
  assert.deepEqual([...device.writes[2].slice(5,13)], Array(8).fill(0));
  await client.close();
  assert.equal(device.opened, false); assert.equal(client.connected, false);
});

test('unplugging rejects the pending command once and poisons the connection', async () => {
  let faults = 0;
  const device = mockDevice({ respond() {} }), client = new SerialClient({ onFault() { faults++; } });
  await client.open(new Ch340UsbPort(device, null));
  const pending = client.keyboard(0, [4]); await new Promise(resolve => setTimeout(resolve, 1));
  device.unplug();
  await assert.rejects(pending, /USB 케이블/);
  assert.equal(faults, 1); assert.equal(client.connected, false);
  await client.close();
});

test('the navigator.usb disconnect event also stops the connection', async () => {
  const usb = new EventTarget(), device = mockDevice({ respond() {} });
  const client = new SerialClient({ onFault() {} });
  await client.open(new Ch340UsbPort(device, usb));
  const pending = client.keyboard(0, [4]); await new Promise(resolve => setTimeout(resolve, 1));
  const event = new Event('disconnect'); event.device = device; usb.dispatchEvent(event);
  await assert.rejects(pending, /USB 케이블/);
  await client.close(); assert.equal(device.opened, false);
});

test('unsupported framing and a busy interface fail before claiming or leave the device closed', async () => {
  const idle = mockDevice(), port = new Ch340UsbPort(idle, null);
  await assert.rejects(port.open({ baudRate:9600, parity:'even' }), /8N1/);
  assert.equal(idle.opened, false);
  const busy = mockDevice({ claim:new DOMException('Unable to claim interface.', 'NetworkError') });
  await assert.rejects(new Ch340UsbPort(busy, null).open({ baudRate:9600 }), /claim/);
  assert.equal(busy.opened, false); assert.equal(busy.controls.length, 0);
});

test('the device chooser only offers CH340/CH341 serial IDs', async () => {
  let options;
  const port = await request({ async requestDevice(value) { options = value; return mockDevice(); } });
  assert.ok(port instanceof Ch340UsbPort);
  assert.deepEqual(options.filters, filters);
  assert.ok(filters.some(f => f.vendorId === 0x1a86 && f.productId === 0x7523));
});
