/* Wire-level tests against WCH CH9329 protocol sections 2.2.8–2.2.11. */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {packet, SerialClient, ChipError} = require('../protocol.js');

// Keep each fake device's closure isolated, including concurrent tests.
function mock(handle) {
  let input;
  const port = {
    writes:[],
    readable:new ReadableStream({start(controller) { input = controller; }}),
    writable:new WritableStream({write(bytes) { port.writes.push(bytes.slice()); return handle(bytes, reply => input.enqueue(reply)); }}),
    async open() {}, async close() {}
  };
  return port;
}
const ack = (bytes, send) => send(packet(bytes[3] | 0x80, [0], bytes[2]));
const currentConfig = (flags = 0) => {
  const data = Uint8Array.from({length:50}, (_, n) => n + 10);
  data[0] = 0x81; data[1] = 0x80; data[36] = flags;
  return data;
};
const identity = (manufacturer = true, serialNumber = true) => ({
  manufacturer:{enabled:manufacturer, value:'My Keyboard'},
  serialNumber:{enabled:serialNumber, value:'KB-0001'}
});

test('USB strings accept empty/23-byte values and fragmented replies at a nonzero address', async () => {
  const values = ['', 'USB Product', 'S'.repeat(23)];
  const port = mock((bytes, send) => {
    assert.equal(bytes[3], 0x0a); assert.equal(bytes[4], 1);
    const type = bytes[5], value = values[type];
    const response = packet(0x8a, [type, value.length, ...Buffer.from(value)], bytes[2]);
    send(response.slice(0,4)); send(response.slice(4));
  });
  const client = new SerialClient(); await client.open(port,57600,17);
  try {
    for (let type = 0; type < 3; type++) assert.equal(await client.usbString(type), values[type]);
    assert.throws(() => client.usbString(3), /종류/);
    assert.equal(port.writes.length,3);
  } finally { await client.close(); }
});

test('wrong descriptor type, missing length, mismatched length and oversized data fault the connection', async () => {
  for (const data of [[2,1,65], [0], [0,2,65], [0,24,...Array(24).fill(65)], [0,0,65]]) {
    const port = mock((bytes,send) => send(packet(0x8a,data)));
    const client = new SerialClient(); await client.open(port);
    try {
      await assert.rejects(client.usbString(0), /응답 형식/);
      assert.equal(client.connected,false);
    } finally { await client.close(); }
  }
});

test('unsupported GET_USB_STRING reports a chip error without inventing a default string', async () => {
  const port = mock((bytes,send) => send(packet(0xca,[0xe3])));
  const client = new SerialClient(); await client.open(port);
  try {
    await assert.rejects(client.usbString(0), ChipError);
    assert.equal(client.connected,true);
  } finally { await client.close(); }
});

test('save writes vendor/SN before their enable flags and preserves unrelated configuration', async () => {
  const port = mock(ack), client = new SerialClient(); await client.open(port,57600,17);
  const current = currentConfig(0xfa), original = current.slice();
  try {
    await client.saveUsbIdentity(current,identity());
    assert.deepEqual(port.writes.map(bytes => bytes[3]),[0x0b,0x0b,9]);
    assert.deepEqual([...port.writes[0].slice(5,-1)],[0,11,...Buffer.from('My Keyboard')]);
    assert.deepEqual([...port.writes[1].slice(5,-1)],[2,7,...Buffer.from('KB-0001')]);
    for (const bytes of port.writes) {
      assert.equal(bytes[2],17);
      assert.equal(bytes.at(-1),bytes.slice(0,-1).reduce((a,b)=>a+b,0)&255);
    }
    const expected = original.slice(); expected[0] = 1; expected[1] = 0; expected[36] = 0xff;
    assert.deepEqual(port.writes[2].slice(5,-1),expected);
    assert.deepEqual(current,original);
  } finally { await client.close(); }
});

test('enabling or disabling each string preserves the effective product setting and reserved bits', async () => {
  const port = mock(ack), client = new SerialClient(); await client.open(port);
  try {
    for (const flags of [0,2,0x80,0x82,0x85,0xff]) {
      for (const manufacturer of [false,true]) for (const serialNumber of [false,true]) {
        const start = port.writes.length;
        await client.saveUsbIdentity(currentConfig(flags), identity(manufacturer,serialNumber));
        const changed = port.writes.slice(start), out = changed.at(-1)[5+36];
        assert.equal(changed.length,1+Number(manufacturer)+Number(serialNumber));
        assert.equal((out&0x84)===0x84,manufacturer);
        assert.equal((out&0x81)===0x81,serialNumber);
        assert.equal((out&0x82)===0x82,(flags&0x82)===0x82);
        assert.equal(out&0x78,flags&0x78);
        assert.ok(changed.filter(b=>b[3]===0x0b).every(b=>b[5]!==1));
      }
    }
  } finally { await client.close(); }
});

test('all fields and modes validate before any persistent write; 23 printable ASCII bytes work', async () => {
  const port = mock(ack), client = new SerialClient(); await client.open(port);
  try {
    for (const value of ['', '   ', 'x'.repeat(24), '한글', 'é', 'a\0b', 'a\nb']) {
      const bad = identity(); bad.serialNumber.value = value;
      await assert.rejects(client.saveUsbIdentity(currentConfig(),bad), /1–23자/);
    }
    await assert.rejects(client.saveUsbIdentity(new Uint8Array(49),identity()), /50바이트/);
    const wrongMode = currentConfig(); wrongMode[1] = 0x81;
    await assert.rejects(client.saveUsbIdentity(wrongMode,identity()), /프로토콜/);
    await assert.rejects(client.saveUsbIdentity(currentConfig(),{}), /사용 여부/);
    assert.equal(port.writes.length,0);
    const longest = identity(); longest.serialNumber.value = 'Z'.repeat(23);
    await client.saveUsbIdentity(currentConfig(),longest);
    assert.equal(port.writes[1][4],25);
  } finally { await client.close(); }
});

test('a rejected write stops immediately, reports possible partial persistence and never retries', async () => {
  for (const failAt of [0,1,2]) {
    let count = 0;
    const port = mock((bytes,send) => {
      if (count++ === failAt) send(packet(bytes[3]|0xc0,[0xe6])); else ack(bytes,send);
    });
    const client = new SerialClient(); await client.open(port);
    try {
      await assert.rejects(client.saveUsbIdentity(currentConfig(),identity()), error =>
        error instanceof ChipError && error.usbIdentityWriteAttempted && /일부 값/.test(error.message));
      assert.equal(port.writes.length,failAt+1);
    } finally { await client.close(); }
  }
});

test('a timed-out write faults the session and sends neither a duplicate nor enable flags', async () => {
  const port = mock(() => {}), client = new SerialClient({timeout:25}); await client.open(port);
  try {
    await assert.rejects(client.saveUsbIdentity(currentConfig(),identity()), error =>
      error.usbIdentityWriteAttempted && /초과/.test(error.message));
    assert.equal(port.writes.length,1); assert.equal(client.connected,false);
  } finally { await client.close(); }
});

test('all three strings use descriptor types 0/1/2 and independent enable bits', async () => {
  const port = mock(ack), client = new SerialClient(); await client.open(port,57600,17);
  try {
    for (const flags of [0,2,0x80,0x82,0x85,0xff]) {
      for (const manufacturer of [false,true]) for (const product of [false,true]) for (const serialNumber of [false,true]) {
        const settings = {...identity(manufacturer,serialNumber),product:{enabled:product,value:'HID Desk Keyboard'}};
        const current = currentConfig(flags), original = current.slice(), start = port.writes.length;
        await client.saveUsbIdentity(current,settings);
        const changed = port.writes.slice(start), types = [manufacturer ? 0 : null,product ? 1 : null,serialNumber ? 2 : null].filter(n=>n!==null);
        assert.deepEqual(changed.slice(0,-1).map(b=>b[5]),types);
        assert.ok(changed.slice(0,-1).every(b=>b[3]===0x0b && b[2]===17));
        const selected = Number(manufacturer)*4+Number(product)*2+Number(serialNumber);
        const expected = original.slice(); expected[0]=1; expected[1]=0; expected[36]=(flags&0x78)|selected|(selected?0x80:0);
        assert.deepEqual(changed.at(-1).slice(5,-1),expected); assert.deepEqual(current,original);
        const writtenProduct=changed.find(b=>b[3]===0x0b && b[5]===1);
        if(product) assert.deepEqual([...writtenProduct.slice(5,-1)],[1,17,...Buffer.from('HID Desk Keyboard')]);
      }
    }
  } finally { await client.close(); }
});

test('invalid product is rejected before writes and product write failures never enable partial settings', async () => {
  const port = mock(ack), client = new SerialClient(); await client.open(port);
  try {
    for (const value of ['', ' ', 'x'.repeat(24), '한글', 'a\nb', 'a\0b']) {
      await assert.rejects(client.saveUsbIdentity(currentConfig(),{...identity(),product:{enabled:true,value}}), /제품명.*1–23자/);
    }
    assert.equal(port.writes.length,0);
    await client.saveUsbIdentity(currentConfig(),{...identity(false,false),product:{enabled:true,value:'P'.repeat(23)}});
    assert.equal(port.writes[0][4],25); assert.equal(port.writes[0][5],1);
  } finally { await client.close(); }
  for (const failAt of [0,1,2,3]) {
    let count=0;
    const failing = mock((bytes,send)=>count++===failAt ? send(packet(bytes[3]|0xc0,[0xe6])) : ack(bytes,send));
    const candidate = new SerialClient(); await candidate.open(failing);
    try {
      await assert.rejects(candidate.saveUsbIdentity(currentConfig(),{...identity(),product:{enabled:true,value:'Keyboard'}}), error=>
        error instanceof ChipError && error.usbIdentityWriteAttempted && /일부 값/.test(error.message) && (failAt!==1 || /제품명/.test(error.message)));
      assert.equal(failing.writes.length,failAt+1);
      if(failAt<3) assert.equal(failing.writes.some(b=>b[3]===9),false);
    } finally { await candidate.close(); }
  }
});
