const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {SerialClient, packet} = require('../upstream/protocol.js');
const bridge = fs.readFileSync(__dirname + '/../app/src/main/assets/web/android-bridge.js', 'utf8');

function setup({failOpen = false, failWrite = false, split = false} = {}) {
  const messages = [], writes = [], queue = [];
  let next = 0, session = 0, read = null, opened = false;
  const context = vm.createContext({ReadableStream,WritableStream,TextEncoder,Uint8Array,atob,btoa,setTimeout,clearTimeout,Event,dispatchEvent() {}});
  const reply = (id, value, error) => queueMicrotask(() => context.AndroidHid.receive({id,value,error}));
  const flush = () => { if (read && queue.length) { const id = read; read = null; reply(id, {data:Buffer.from(queue.shift()).toString('base64')}); } };
  context.HidNative = {postMessage(raw) {
    const request = JSON.parse(raw); messages.push(request);
    const {id,method,args} = request;
    switch(method) {
      case 'select': reply(id,{device:'/dev/bus/usb/001/003',vendorId:0x1a86,productId:0x7523}); break;
      case 'open':
        if (failOpen) reply(id,null,'USB 권한이 없습니다.');
        else { session = ++next; opened = true; reply(id,{session}); }
        break;
      case 'read':
        if (!opened || args.session !== session) reply(id,{done:true});
        else { assert.equal(read,null,'only one native read at a time'); read = id; flush(); }
        break;
      case 'write': {
        if (failWrite) { reply(id,null,'USB 전송 실패'); break; }
        assert.equal(args.session,session);
        const bytes = Uint8Array.from(Buffer.from(args.data,'base64')); writes.push(bytes);
        const data = bytes[3] === 1 ? [0x31,1,0,0,0,0,0,0] : bytes[3] === 8 ? new Uint8Array(50) : [0];
        const response = packet(bytes[3] | 0x80,data,bytes[2]);
        if (split) queue.push(response.slice(0,3),response.slice(3)); else queue.push(response);
        flush(); reply(id,true); break;
      }
      case 'close':
        if (args.session === session) { opened = false; queue.length = 0; if (read) { reply(read,{done:true}); read = null; } }
        reply(id,true); break;
      case 'save': reply(id,true); break;
      default: reply(id,null,'unknown');
    }
  }};
  vm.runInContext(bridge,context);
  return {context,messages,writes};
}

test('native bridge connects, parses fragmented chip replies, and releases keys', async () => {
  const mock = setup({split:true}), client = new SerialClient();
  assert.equal(mock.context.AndroidHid.available,true);
  await client.open(await mock.context.CH340Usb.request(),57600,3);
  assert.deepEqual(await client.info(),{version:0x31,usb:true,capsLock:false,numLock:false});
  assert.equal((await client.config()).length,50);
  await client.tap(2,[4]);
  assert.deepEqual(mock.writes.map(x => x[3]),[1,8,2,2]);
  assert.deepEqual([...mock.writes[2].slice(5,-1)],[2,0,4,0,0,0,0,0]);
  assert.ok(mock.writes[3].slice(5,-1).every(x => x === 0));
  const open = mock.messages.find(x => x.method === 'open');
  assert.equal(open.args.baud,57600);
  await client.close();
  assert.equal(mock.messages.filter(x => x.method === 'close').length,1);
  assert.equal(client.connected,false);
});
test('native open failure never sends a CH9329 command', async () => {
  const mock = setup({failOpen:true}), client = new SerialClient();
  await assert.rejects(client.open(await mock.context.CH340Usb.request()),/권한/);
  assert.equal(mock.writes.length,0);
});
test('native write failure rejects without retry and the transport closes', async () => {
  const mock = setup({failWrite:true}), client = new SerialClient();
  await client.open(await mock.context.CH340Usb.request());
  await assert.rejects(client.info(),/전송 실패/);
  assert.equal(mock.messages.filter(x => x.method === 'write').length,1);
  assert.equal(client.connected,false); await client.close();
});
test('native detach rejects the pending request and allows a fresh session', async () => {
  const mock = setup(), client = new SerialClient();
  await client.open(await mock.context.CH340Usb.request());
  mock.context.AndroidHid.disconnected('케이블 분리');
  await new Promise(resolve => setTimeout(resolve,10));
  assert.equal(client.connected,false); await client.close();
  await client.open(await mock.context.CH340Usb.request());
  await client.info(); await client.close();
  assert.deepEqual(mock.messages.filter(x => x.method === 'close').map(x => x.args.session),[1,2]);
});
test('SAF export preserves UTF-8 text across bridge chunk boundaries', async () => {
  const mock = setup();
  const text = '한글 프리셋 😀\n'.repeat(2000);
  await mock.context.AndroidHid.saveText('presets.json',text,'application/json');
  const request = mock.messages.find(x => x.method === 'save');
  assert.equal(Buffer.from(request.args.data,'base64').toString('utf8'),text);
  assert.equal(request.args.name,'presets.json');
});
