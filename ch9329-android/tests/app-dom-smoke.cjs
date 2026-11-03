/* Controller/Android IPC end-to-end checks with a DOM and simulated CH9329.
   This is not an Android WebView or real USB hardware test. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {webcrypto} = require('node:crypto');
const {JSDOM} = require(process.env.JSDOM_MODULE || 'jsdom');

(async () => {
  const assets = path.resolve(__dirname,'../app/src/main/assets/web');
  let w, pendingRead = null, session = 0, opened = false, failOpen = false, batchRequests = 0, rejectIdentity = false, rejectRead = false;
  const queue = [], writes = [], saves = [], errors = [], results = [], batches = new Map();
  const config = new Uint8Array(50); config[0] = 0; config[5] = 0x25; config[6] = 0x80;
  config[11] = 0x1a; config[12] = 0x86; config[13] = 0xe1; config[14] = 0x29;
  const strings = ['Original Maker','Original Product','Original-SN'];
  const reply = (id,value,error) => setTimeout(() => w.AndroidHid.receive({id,value,error}),0);
  const flush = () => { if (pendingRead && queue.length) { const id = pendingRead; pendingRead = null; reply(id,{data:Buffer.from(queue.shift()).toString('base64')}); } };
  const dom = new JSDOM(fs.readFileSync(path.join(assets,'index.html'),'utf8'),{
    url:'https://appassets.androidplatform.net/assets/web/index.html',runScripts:'outside-only',pretendToBeVisual:true
  });
  w = dom.window;
  Object.assign(w,{TextEncoder,TextDecoder,ReadableStream,WritableStream,CompressionStream,DecompressionStream,Blob,File,Response,AbortController});
  Object.defineProperty(w,'crypto',{value:webcrypto});
  Object.defineProperty(w,'isSecureContext',{value:true});
  w.addEventListener('error',event => errors.push(event.message));
  w.HidNative = {postMessage(raw) {
    const {id,method,args} = JSON.parse(raw);
    switch(method) {
      case 'select': reply(id,{device:'mock:CH340',vendorId:0x1a86,productId:0x7523}); break;
      case 'open': if (failOpen) reply(id,null,'USB 권한이 없습니다.'); else { opened = true; session++; reply(id,{session}); } break;
      case 'read': if (!opened || args.session !== session) reply(id,{done:true}); else { assert.equal(pendingRead,null); pendingRead = id; flush(); } break;
      case 'write': {
        assert.equal(args.session,session); const bytes = Uint8Array.from(Buffer.from(args.data,'base64')); writes.push(bytes);
        const mode = config[0] & 0x7f;
        const bad = bytes[3] === 2 && mode === 3 || [4,5].includes(bytes[3]) && [1,3].includes(mode);
        let data = bytes[3] === 1 ? [0x31,1,0,0,0,0,0,0] : bytes[3] === 8 ? config : [bad ? 0xe6 : 0];
        let command = bytes[3] | 0x80;
        if (bytes[3] === 0x0a) {
          const type = bytes[5]; data = [type,strings[type].length,...Buffer.from(strings[type])];
          if (rejectRead) { command = 0xca; data = [0xe3]; }
        }
        if (bytes[3] === 0x0b) {
          if (rejectIdentity && bytes[5] === 2) { command = 0xcb; data = [0xe6]; }
          else strings[bytes[5]] = Buffer.from(bytes.slice(7,-1)).toString();
        }
        if (bytes[3] === 9) config.set(bytes.slice(5,-1));
        const response = w.CH9329.packet(command,data,bytes[2]);
        queue.push(response.slice(0,3),response.slice(3)); flush(); reply(id,true); break;
      }
      case 'keyboardBatch': {
        batchRequests++;
        assert.equal(args.session,session);
        const data = Buffer.from(args.data,'base64'), batch = {cancelled:false}; batches.set(args.token,batch);
        (async () => {
          let completed = 0;
          for (let n = 0; n < data.length && !batch.cancelled; n += 9) {
            writes.push(w.CH9329.packet(2,[data[n],0,...data.subarray(n+1,n+7)],args.address)); completed++;
            await new Promise(resolve => setTimeout(resolve,(data[n+7]<<8|data[n+8]) || 1));
          }
          batches.delete(args.token); reply(id,{completed,cancelled:batch.cancelled});
        })(); break;
      }
      case 'cancelBatch':
        if (args.session === session && batches.has(args.token)) batches.get(args.token).cancelled = true;
        reply(id,true); break;
      case 'close': if (args.session === session) { opened = false; queue.length = 0; if (pendingRead) { reply(pendingRead,{done:true}); pendingRead = null; } } reply(id,true); break;
      case 'save': saves.push(args); reply(id,true); break;
      default: throw new Error(method);
    }
  }};
  for (const file of ['protocol.js','ch340-usb.js','transfer.js','diff.js','decoder-source.js','android-bridge.js','app.js']) w.eval(fs.readFileSync(path.join(assets,file),'utf8'));
  const $ = id => w.document.getElementById(id);
  const wait = async predicate => {
    const end = Date.now() + 10000;
    while (!predicate()) { if (Date.now() > end) throw new Error('UI wait timeout: ' + $('jobDetail').textContent); await new Promise(resolve => setTimeout(resolve,5)); }
  };
  const change = (id,value) => { $(id).value = value; $(id).dispatchEvent(new w.Event('change')); };
  const toggle = (id,value) => { $(id).checked = value; $(id).dispatchEvent(new w.Event('change')); };
  assert.equal($('connect').disabled,false); assert.equal($('transport').options.length,2); assert.ok($('transport').textContent.includes('안드로이드'));
  failOpen = true; $('connect').click(); await wait(() => !$('connect').disabled);
  assert.ok($('connectionError').textContent.includes('USB 장치를 열지')); assert.equal(writes.length,0);
  failOpen = false; $('connect').click(); await wait(() => !$('sendText').disabled);
  assert.equal($('connectionBadge').textContent,'연결됨'); assert.equal($('connectionError').hidden,true); results.push('native open error and reconnect handshake');
  writes.length = 0; $('text').value = 'A%\r\nx'; $('sendText').click(); await wait(() => !$('sendText').disabled);
  assert.equal(writes.filter(b => b[3] === 2 && b[7] !== 0).length,4); assert.equal($('progressPercent').textContent,'100%'); results.push('ASCII typing, CRLF, key releases and progress');
  assert.ok(batchRequests > 0,'fast controller uses native batches');
  const beforeCompatible = batchRequests;
  change('typingMode','compatible'); $('keyDelay').value = '2'; writes.length = 0;
  $('text').value = 'aA%a'; $('sendText').click(); await wait(() => !$('sendText').disabled);
  assert.equal(batchRequests,beforeCompatible); assert.equal(writes.filter(b=>b[3]===2).length,9);
  change('typingMode','fast'); results.push('compatible mode keeps per-key releases and delay without batching');
  change('textMode','korean'); writes.length = 0; $('text').value = 'Hi 간아!'; $('sendText').click(); await wait(() => !$('sendText').disabled);
  assert.equal(writes.filter(b => b[3] === 2 && b[5] === 64).length,4); assert.ok($('jobDetail').textContent.includes('영문(A)')); results.push('Hangul and English mixed reports');
  writes.length = 0; $('text').value = '한글'.repeat(20); $('sendText').click(); await wait(() => writes.some(b => b[3] === 2 && b[5] === 64));
  w.AndroidHid.background(); await wait(() => !$('sendText').disabled);
  assert.ok($('jobTitle').textContent.includes('중지')); assert.ok(writes.at(-1).slice(5,-1).every(x => x === 0)); results.push('native background cancels typing and releases keys');
  writes.length = 0; $('shortcut').value = 'CTRL+ALT+DEL'; $('sendShortcut').click(); await wait(() => !$('sendText').disabled);
  assert.ok(writes.some(b => b[3] === 2 && b[5] === 5 && b[7] === 76)); results.push('shortcut reports');
  writes.length = 0; w.document.querySelector('[data-move="-1,0"]').click(); await wait(() => !$('sendText').disabled);
  assert.ok(writes.some(b => b[3] === 5 && b[7] === 226)); results.push('mouse relative movement');
  change('presetKind','korean'); $('presetName').value = '<img src=x> 한글'; $('presetValue').value = '한글 A'; $('savePreset').click();
  assert.equal($('presets').querySelector('img'),null); $('exportPresets').click(); await wait(() => saves.length > 0);
  assert.ok(Buffer.from(saves.at(-1).data,'base64').toString('utf8').includes('한글 A')); results.push('presets and native UTF-8 export');
  $('downloadDecoder').click(); await wait(() => saves.length > 1);
  assert.equal(Buffer.from(saves.at(-1).data,'base64').toString('utf8'),fs.readFileSync(path.join(assets,'decoder.html'),'utf8')); results.push('native decoder save preserves exact source');
  Object.defineProperty($('fileInput'),'files',{configurable:true,value:[new File(['한글 텍스트 '.repeat(100)],'korean.txt',{type:'text/plain'})]});
  $('fileInput').dispatchEvent(new w.Event('change')); $('prepareFile').click(); await wait(() => !$('sendFile').disabled);
  assert.ok($('fileSummary').textContent.includes('WVK2'));
  writes.length = 0; $('sendFile').click(); await wait(() => !$('sendFile').disabled);
  assert.equal($('progressPercent').textContent,'100%'); results.push('compressed Korean file preparation and transmission');
  const last = new Map([...Array.from({length:95},(_,i)=>String.fromCharCode(32+i)),'\n'].map(c => {const r=w.CH9329.asciiReport(c);return [r.modifier+','+r.keys[0],c];}));
  const envelope = writes.filter(b => b[3] === 2 && b[7]).map(b => last.get(b[5]+','+b[7])).join('');
  assert.ok(envelope.startsWith('WVK2\n')); assert.ok(envelope.endsWith('END\n'));
  change('fileMode','diff');
  assert.equal($('baseFileField').hidden,false); assert.equal($('prepareFile').disabled,true);
  const oldText = '\uFEFF' + Array.from({length:180},(_,i) => 'const value' + i + ' = "한글 ' + i + '";\r\n').join('');
  const newText = oldText.replace('한글 2"','수정 😀 2"').replace('const value80','// 설명\r\nconst value80').replace('const value150 = "한글 150";\r\n','');
  const pick = (id,text) => {
    Object.defineProperty($(id),'files',{configurable:true,value:[new File([text],'source.ts')]});
    $(id).dispatchEvent(new w.Event('change'));
  };
  pick('baseFileInput',oldText); pick('fileInput',newText); $('prepareFile').click(); await wait(() => !$('sendFile').disabled);
  assert.ok($('fileSummary').textContent.includes('변경 구간 3개'));
  writes.length = 0; $('sendFile').click(); await wait(() => !$('sendFile').disabled);
  const deltaEnvelope = writes.filter(b => b[3] === 2 && b[7]).map(b => last.get(b[5]+','+b[7])).join('');
  assert.ok(deltaEnvelope.includes('CONTENT=patch-v1\n'));
  const decoderHtml = fs.readFileSync(path.join(assets,'decoder.html'),'utf8');
  const decoderDom = new JSDOM(decoderHtml,{runScripts:'outside-only'});
  const target = decoderDom.window;
  Object.assign(target,{TextDecoder,Blob,DecompressionStream,Uint8Array,Uint32Array,DataView});
  target.eval(decoderHtml.match(/<script>([\s\S]*?)<\/script>/i)[1] + '\n;window.getDecodedBytes=()=>decodedBytes;');
  target.document.getElementById('data').value = deltaEnvelope;
  Object.defineProperty(target.document.getElementById('baseFile'),'files',{configurable:true,value:[new File([oldText],'source.ts')]});
  await target.decode();
  assert.equal(target.document.getElementById('status').className,'ok');
  assert.deepEqual(Buffer.from(target.getDecodedBytes()),Buffer.from(newText));
  Object.defineProperty(target.document.getElementById('baseFile'),'files',{configurable:true,value:[new File(['wrong'],'source.ts')]});
  await target.decode(); assert.equal(target.document.getElementById('status').className,'err');
  assert.equal(target.document.getElementById('preview').hidden,true);
  decoderDom.window.close(); results.push('native delta transmission and decoder reconstruction preserve BOM/CRLF; wrong baseline rejected');
  pick('fileInput',oldText); $('prepareFile').click(); await wait(() => !$('prepareFile').disabled);
  assert.equal($('sendFile').disabled,true); assert.ok($('fileSummary').textContent.includes('변경분이 없습니다'));
  pick('fileInput','tiny'); $('prepareFile').click(); await wait(() => !$('sendFile').disabled);
  assert.ok($('fileSummary').textContent.includes('전체 파일로 전송'));
  results.push('delta baseline selection, unchanged files and full-transfer fallback');
  change('operatingMode','1'); $('modeConfirmed').checked = true; $('modeConfirmed').dispatchEvent(new w.Event('change')); $('saveMode').click();
  await wait(() => !$('connect').hidden && !$('connect').disabled);
  assert.equal(config[0],1); $('connect').click(); await wait(() => !$('sendText').disabled);
  assert.equal(w.document.querySelector('[data-move="-1,0"]').disabled,true); results.push('mode persistence and keyboard-only capabilities');
  $('backupConfig').click(); await wait(() => saves.length > 2);
  assert.equal(JSON.parse(Buffer.from(saves.at(-1).data,'base64').toString()).config[0],1); results.push('native settings backup');
  assert.equal($('saveUsbIdentity').disabled,true);
  assert.equal($('usbManufacturer').disabled,true);
  $('readUsbIdentity').click(); await wait(() => !$('saveUsbIdentity').disabled);
  assert.equal($('usbManufacturer').value,'Original Maker');
  assert.equal($('usbProduct').value,'Original Product');
  assert.equal($('usbSerialNumber').value,'Original-SN');
  assert.equal($('usbManufacturerEnabled').checked,false);
  assert.equal($('usbProductEnabled').checked,false); assert.equal($('usbProduct').disabled,true);
  assert.equal($('usbManufacturer').disabled,true);
  toggle('usbManufacturerEnabled',true); toggle('usbProductEnabled',true); toggle('usbSerialEnabled',true);
  assert.equal($('usbManufacturer').disabled,false);
  assert.equal($('usbProduct').disabled,false); $('usbProduct').value = 'HID Desk Keyboard';
  writes.length = 0; $('usbManufacturer').value = 'My Keyboard'; $('usbSerialNumber').value = '한글';
  $('saveUsbIdentity').click(); await wait(() => !$('saveUsbIdentity').disabled);
  assert.ok($('usbIdentityResult').textContent.includes('1–23자'));
  assert.equal(writes.some(b=>[9,0x0b].includes(b[3])),false);
  results.push('USB identity read, default toggles and validation before persistent writes');
  writes.length = 0; $('usbSerialNumber').value = 'KB-0001';
  const beforeIdentity = config.slice(); $('saveUsbIdentity').click();
  assert.equal($('readUsbIdentity').disabled,true); assert.equal($('sendText').disabled,true); assert.equal($('stop').disabled,true);
  await wait(() => !$('connect').hidden && !$('connect').disabled);
  assert.deepEqual(strings,['My Keyboard','HID Desk Keyboard','KB-0001']);
  assert.deepEqual(writes.filter(b=>[9,0x0b].includes(b[3])).map(b=>b[3]),[0x0b,0x0b,0x0b,9]);
  assert.deepEqual(writes.filter(b=>b[3]===0x0b).map(b=>b[5]),[0,1,2]);
  const expectedIdentity = beforeIdentity.slice(); expectedIdentity[36] = 0x87;
  assert.deepEqual(config,expectedIdentity);
  assert.ok($('usbIdentityResult').textContent.includes('양쪽 USB'));
  assert.equal($('saveUsbIdentity').disabled,true);
  $('connect').click(); await wait(() => !$('sendText').disabled);
  assert.equal($('usbManufacturer').value,'');
  $('readUsbIdentity').click(); await wait(() => !$('saveUsbIdentity').disabled);
  assert.equal($('usbManufacturer').value,'My Keyboard'); assert.equal($('usbSerialNumber').value,'KB-0001');
  assert.equal($('usbProduct').value,'HID Desk Keyboard'); assert.equal($('usbProductEnabled').checked,true);
  assert.equal($('usbManufacturerEnabled').checked,true); assert.equal($('usbSerialEnabled').checked,true);
  const savedCount = saves.length; $('backupConfig').click(); await wait(() => saves.length > savedCount);
  assert.deepEqual(JSON.parse(Buffer.from(saves.at(-1).data,'base64').toString()).usbIdentity,{
    manufacturer:{value:'My Keyboard',enabled:true},product:{value:'HID Desk Keyboard',enabled:true},serialNumber:{value:'KB-0001',enabled:true}
  });
  results.push('USB identity ACK order, preserved configuration, reconnect and native identity backup');
  toggle('usbManufacturerEnabled',false); toggle('usbProductEnabled',false); toggle('usbSerialEnabled',false); writes.length = 0;
  $('saveUsbIdentity').click(); await wait(() => !$('connect').hidden && !$('connect').disabled);
  assert.equal(config[36],0); assert.equal(writes.some(b=>b[3]===0x0b),false);
  $('connect').click(); await wait(() => !$('sendText').disabled);
  $('readUsbIdentity').click(); await wait(() => !$('saveUsbIdentity').disabled);
  assert.equal($('usbManufacturerEnabled').checked,false);
  assert.equal($('usbProductEnabled').checked,false);
  results.push('USB identity default restoration disables only selected custom strings');
  toggle('usbProductEnabled',true); $('usbProduct').value = 'My USB Keyboard'; writes.length = 0;
  const beforeProduct = config.slice(); $('saveUsbIdentity').click();
  await wait(() => !$('connect').hidden && !$('connect').disabled);
  assert.deepEqual(writes.filter(b=>[9,0x0b].includes(b[3])).map(b=>b[3]),[0x0b,9]);
  assert.equal(writes.find(b=>b[3]===0x0b)[5],1);
  const expectedProduct = beforeProduct.slice(); expectedProduct[36] = 0x82;
  assert.deepEqual(config,expectedProduct); assert.deepEqual(strings,['My Keyboard','My USB Keyboard','KB-0001']);
  $('connect').click(); await wait(() => !$('sendText').disabled);
  $('readUsbIdentity').click(); await wait(() => !$('saveUsbIdentity').disabled);
  assert.equal($('usbProduct').value,'My USB Keyboard'); assert.equal($('usbProductEnabled').checked,true);
  assert.equal($('usbManufacturerEnabled').checked,false); assert.equal($('usbSerialEnabled').checked,false);
  toggle('usbProductEnabled',false); $('saveUsbIdentity').click();
  await wait(() => !$('connect').hidden && !$('connect').disabled); assert.equal(config[36],0);
  $('connect').click(); await wait(() => !$('sendText').disabled);
  $('readUsbIdentity').click(); await wait(() => !$('saveUsbIdentity').disabled);
  assert.equal($('usbProductEnabled').checked,false); assert.equal($('usbProduct').disabled,true);
  results.push('product-only save uses descriptor type 1, survives reconnect and independently returns to defaults');
  toggle('usbManufacturerEnabled',true); toggle('usbSerialEnabled',true);
  $('usbManufacturer').value = 'Partial Maker'; $('usbSerialNumber').value = 'Partial-SN';
  writes.length = 0; rejectIdentity = true; $('saveUsbIdentity').click();
  await wait(() => !$('connect').hidden && !$('connect').disabled);
  assert.ok($('usbIdentityResult').textContent.includes('일부 값'));
  assert.equal(writes.some(b=>b[3]===9),false); assert.equal(strings[0],'Partial Maker'); assert.equal(strings[2],'KB-0001');
  rejectIdentity = false; $('connect').click(); await wait(() => !$('sendText').disabled);
  $('readUsbIdentity').click(); await wait(() => !$('saveUsbIdentity').disabled);
  assert.equal($('usbManufacturer').value,'Partial Maker'); assert.equal($('usbManufacturerEnabled').checked,false);
  results.push('partial USB identity write closes the connection, avoids retries and reloads actual stored values');
  rejectRead = true; $('readUsbIdentity').click(); await wait(() => !$('readUsbIdentity').disabled);
  assert.equal($('saveUsbIdentity').disabled,true); assert.ok($('usbIdentityResult').textContent.includes('읽지 못했습니다'));
  assert.equal($('sendText').disabled,false); rejectRead = false;
  results.push('unsupported identity query leaves normal keyboard use available and prevents stale saves');
  w.AndroidHid.disconnected('USB 분리'); await wait(() => !$('connect').hidden && !$('connect').disabled);
  assert.equal($('sendText').disabled,true); results.push('native detach disables input');
  assert.deepEqual(errors,[]);
  fs.mkdirSync(path.resolve(__dirname,'../build'),{recursive:true});
  fs.writeFileSync(path.resolve(__dirname,'../build/dom-validation.json'),JSON.stringify({passed:results,errors,environment:'jsdom with simulated native IPC; no Android device or rendered layout'},null,2));
  console.log(JSON.stringify({passed:results.length,results},null,2)); dom.window.close();
})().catch(error => {console.error(error);process.exit(1);});
