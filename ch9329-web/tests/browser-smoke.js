/* Run this function in an isolated Chrome page opened at ../index.html. Uses no hardware. */
(async function browserSmoke() {
  const byId = id => document.getElementById(id);
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const results = [];
  const wait = async predicate => {
    const end = performance.now() + 5000;
    while (!predicate()) { if (performance.now() > end) throw new Error('UI wait timeout: ' + byId('jobDetail').textContent); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  let input, writes = [], caps = false, bad = false, rejectSave = false, failOpen = false, cancelSelection = false;
  const config = new Uint8Array(50); config[0] = 0x80; config[1] = 0x80; config[5] = 0x25; config[6] = 0x80;
  const reply = (bytes, send) => {
    writes.push([...bytes]);
    if (bad) return;
    const mode = config[0] & 0x7f;
    const unsupported = (bytes[3] === 2 && mode === 3) || ([4,5].includes(bytes[3]) && [1,3].includes(mode));
    const data = bytes[3] === 1 ? [0x31,1,caps ? 2 : 0,0,0,0,0,0] : bytes[3] === 8 ? config : [unsupported || (bytes[3] === 9 && rejectSave) ? 0xe6 : 0];
    if (bytes[3] === 9 && !rejectSave) config.set(bytes.slice(5,-1));
    const response = CH9329.packet(bytes[3] | 0x80, data);
    setTimeout(() => send(response), 3);
  };
  const makePort = () => ({
    async open() { if (failOpen) throw new DOMException("Failed to execute 'open' on 'SerialPort': Failed to open serial port.", 'NetworkError'); }, async close() {},
    readable:new ReadableStream({ start(controller) { input = controller; } }),
    writable:new WritableStream({ write(bytes) { reply(bytes, response => input.enqueue(response)); } })
  });
  Object.defineProperty(navigator, 'serial', { configurable:true, value:{ async requestPort() {
    if (cancelSelection) throw new DOMException('No port selected', 'NotFoundError');
    return makePort();
  } } });
  assert(window.isSecureContext && !!navigator.serial, 'file URL serial unavailable');
  cancelSelection = true; byId('connect').click(); await wait(() => !byId('connect').disabled);
  assert(byId('connectionError').hidden, 'port chooser cancellation is not a failure'); cancelSelection = false;
  failOpen = true; byId('connect').click(); await wait(() => !byId('connect').disabled);
  assert(!byId('connectionError').hidden && byId('connectionError').textContent.includes('시리얼 포트를 열지 못'), 'port open guidance persists');
  assert(!byId('connectionError').textContent.includes('9600') && writes.length === 0, 'open failure does not blame baud or send commands');
  failOpen = false;
  byId('connect').click(); await wait(() => !byId('sendText').disabled);
  assert(byId('connectionError').hidden, 'retry clears previous connection error'); results.push('port cancellation + open failure + retry');
  assert(byId('connectionBadge').textContent === '연결됨', 'connection state'); results.push('connect handshake');
  byId('startDelay').value = '0'; byId('keyDelay').value = '0';
  writes = []; byId('text').value = 'A%\r\nx'; byId('sendText').click();
  await wait(() => !byId('sendText').disabled);
  const reports = writes.filter(b => b[3] === 2).map(b => b.slice(5,-1));
  assert(JSON.stringify(reports[0]) === JSON.stringify([2,0,4,0,0,0,0,0]), 'uppercase wire report');
  assert(reports.filter(b => b.some(Boolean)).length === 4, 'normalized CRLF count');
  assert(byId('progressPercent').textContent === '100%', 'typing progress'); results.push('typing + releases');
  writes = []; byId('text').value = 'abcd'; byId('sendText').click(); await wait(() => !byId('sendText').disabled);
  assert(writes.filter(b => b[3] === 2).length === 5, 'fast mode report savings');
  byId('typingMode').value = 'compatible'; byId('typingMode').dispatchEvent(new Event('change')); byId('keyDelay').value = '0';
  writes = []; byId('sendText').click(); await wait(() => !byId('sendText').disabled);
  assert(writes.filter(b => b[3] === 2).length === 9, 'compatibility mode fallback');
  byId('typingMode').value = 'fast'; byId('typingMode').dispatchEvent(new Event('change')); results.push('fast + compatible input');
  writes = []; byId('text').value = '한글'; byId('sendText').click();
  assert(writes.length === 0 && byId('toast').textContent.includes('디코더'), 'unicode direct rejection'); results.push('unicode validation');
  caps = true; byId('text').value = 'abc'; byId('sendText').click(); await wait(() => !byId('sendText').disabled);
  assert(!writes.some(b => b[3] === 2), 'caps lock should stop before typing'); caps = false; results.push('Caps Lock guard');
  writes = []; byId('text').value = 'a'.repeat(500); byId('sendText').click();
  await wait(() => writes.filter(b => b[3] === 2).length > 5); byId('stop').click(); await wait(() => !byId('sendText').disabled);
  assert(byId('jobTitle').textContent.includes('중지'), 'cancel status');
  assert(writes.filter(b => b[3] === 2).length < 1000, 'cancel ended typing');
  assert(writes.at(-1).slice(5,-1).every(b => b === 0), 'cancel released key'); results.push('cancel without replay');
  document.querySelector('[data-tab="mouse"]').click(); writes = [];
  document.querySelector('[data-move="-1,0"]').click(); await wait(() => !byId('sendText').disabled);
  assert(writes.some(b => b[3] === 5 && b[7] === 226), 'left mouse delta');
  document.querySelector('[data-click="1"]').click(); await wait(() => !byId('sendText').disabled);
  assert(writes.at(-1).slice(5,-1).every((b,i) => i === 0 ? b === 1 : b === 0), 'mouse release'); results.push('mouse move + click');
  document.querySelector('[data-tab="keyboard"]').click();
  byId('presetName').value = '<img src=x>'; byId('presetValue').value = 'hello'; byId('savePreset').click();
  assert(!byId('presets').querySelector('img'), 'preset must use text content'); assert(byId('presets').textContent.includes('<img src=x>'), 'preset render'); results.push('preset local save / text escaping');
  document.querySelector('[data-tab="files"]').click();
  const dt = new DataTransfer(); dt.items.add(new File(['hello '.repeat(100)], 'smoke.txt', {type:'text/plain'}));
  byId('fileInput').files = dt.files; byId('fileInput').dispatchEvent(new Event('change')); byId('prepareFile').click();
  await wait(() => !byId('sendFile').disabled); assert(byId('fileSummary').textContent.includes('WVK2'), 'file compression preview'); results.push('file prepare offline');
  document.querySelector('[data-tab="settings"]').click();
  const chooseMode = mode => { byId('operatingMode').value = String(mode); byId('operatingMode').dispatchEvent(new Event('change')); };
  const confirmMode = () => { byId('modeConfirmed').checked = true; byId('modeConfirmed').dispatchEvent(new Event('change')); };
  assert(byId('operatingMode').options.length === 4 && byId('operatingMode').value === '0', 'four modes and current hardware mode');
  assert(byId('saveMode').disabled, 'mode requires product support check');
  chooseMode(1); confirmMode(); rejectSave = true;
  byId('saveMode').click(); await wait(() => !byId('readConfig').disabled);
  assert(byId('jobTitle').textContent.includes('완료하지 못'), 'save failure shown');
  assert(byId('connect').hidden && config[0] === 0x80, 'failed save keeps connection and config'); rejectSave = false;
  for (const mode of [1,3,0,2]) {
    writes = []; chooseMode(mode);
    assert(!byId('modeConfirmed').checked && byId('saveMode').disabled, 'selection resets confirmation');
    assert(writes.length === 0, 'selection does not write to device');
    assert(byId('modeCompatibility').hidden === (mode !== 2), 'mode 2 compatibility guidance');
    confirmMode();
    const before = [...config.slice(2)];
    byId('saveMode').click(); assert(byId('operatingMode').disabled, 'cannot change mode during save');
    await wait(() => !byId('connect').disabled && !byId('connect').hidden);
    const saved = writes.find(b => b[3] === 9);
    assert(saved && saved[5] === mode && saved[6] === 0, 'selected mode save packet');
    assert(JSON.stringify(saved.slice(7,-1)) === JSON.stringify(before), 'preserve address, speed and USB identity');
    assert(byId('modeResult').textContent.includes(`모드 ${mode}`) && byId('modeResult').textContent.includes('양쪽 USB'), 'mode-specific power cycle instructions');
    assert(!byId('modeConfirmed').checked, 'save clears confirmation');
    writes = []; byId('connect').click(); await wait(() => !byId('saveBaud').disabled);
    assert(byId('operatingMode').value === String(mode) && byId('configInfo').textContent.includes('소프트웨어 설정'), 'reconnect reflects saved mode');
    assert(byId('sendText').disabled === (mode === 3) && byId('sendFile').disabled === (mode === 3), 'keyboard/file availability');
    assert(document.querySelector('[data-move]').disabled === [1,3].includes(mode), 'mouse availability');
    assert(byId('inputModeNote').hidden === ![1,3].includes(mode), 'input mode notice');
    const releases = writes.filter(b => [2,5].includes(b[3])).map(b => b[3]);
    assert(JSON.stringify(releases) === JSON.stringify(mode === 3 ? [] : mode === 1 ? [2] : [2,5]), 'only supported recovery commands');
    // Previewing another mode must not change the active input capabilities.
    chooseMode(mode === 3 ? 0 : 3);
    assert(byId('sendText').disabled === (mode === 3), 'unsaved selection does not change inputs');
    confirmMode(); byId('readConfig').click(); await wait(() => !byId('readConfig').disabled);
    assert(byId('operatingMode').value === String(mode) && !byId('modeConfirmed').checked, 'read resets selection and confirmation');
  }
  results.push('all four modes + failed save + preservation + reconnect controls');
  writes = []; byId('deviceBaud').value = '57600'; byId('saveBaud').click();
  await wait(() => !byId('connect').disabled && !byId('connect').hidden);
  const speed = writes.find(b => b[3] === 9);
  assert(speed && speed[5] === 2 && speed[8] === 0 && speed[9] === 0 && speed[10] === 225 && speed[11] === 0, 'baud persistence frame');
  assert(byId('baud').value === '57600' && byId('baudResult').textContent.includes('양쪽 USB'), 'baud reconnect guidance'); results.push('baud save + matching reconnect speed');
  bad = true; byId('baud').value = '9600'; byId('connect').click();
  await wait(() => !byId('connect').disabled && !byId('connect').hidden); bad = false;
  assert(!byId('connectionError').hidden && byId('connectionError').textContent.includes('시리얼 포트는 열렸지만'), 'response failure differs from open failure');
  assert(localStorage.getItem('wvk.ch9329.baud') === '57600', 'failed connect keeps remembered speed');
  byId('baud').value = '38400'; byId('connect').click(); await wait(() => !byId('saveBaud').disabled);
  assert(localStorage.getItem('wvk.ch9329.baud') === '38400', 'successful connect remembers speed'); results.push('remember last working speed');
  // Android Chrome path: the same UI over the CH340 WebUSB driver.
  if (byId('transport').querySelector('[value=usb]').disabled) results.push('WebUSB skipped: no navigator.usb in this browser');
  else {
    byId('disconnect').click(); await wait(() => !byId('connect').hidden && !byId('connect').disabled);
    const controls = [], queue = []; let waiter = null;
    const flush = () => { if (waiter && queue.length) { const w = waiter; waiter = null; w.resolve({ status:'ok', data:new DataView(queue.shift().buffer) }); } };
    const abort = () => { waiter?.reject(new DOMException('closed', 'AbortError')); waiter = null; };
    const device = {
      vendorId:0x1a86, productId:0x7523, opened:false, configuration:null,
      async open() { this.opened = true; }, async close() { this.opened = false; abort(); },
      async selectConfiguration() { this.configuration = { interfaces:[{ interfaceNumber:0, alternates:[], alternate:{ endpoints:[
        { endpointNumber:2, direction:'in', type:'bulk', packetSize:32 }, { endpointNumber:2, direction:'out', type:'bulk', packetSize:32 }] } }] }; },
      async claimInterface() {}, async releaseInterface() { abort(); },
      async controlTransferIn(setup) { controls.push([setup.request, setup.value, setup.index]); return { status:'ok', data:new DataView(new Uint8Array([0x31,0]).buffer) }; },
      async controlTransferOut(setup) { controls.push([setup.request, setup.value, setup.index]); return { status:'ok', bytesWritten:0 }; },
      transferIn() { return new Promise((resolve, reject) => { waiter = { resolve, reject }; flush(); }); },
      async transferOut(endpoint, bytes) {
        reply(Uint8Array.from(bytes), response => { queue.push(response.slice(0,4), response.slice(4)); flush(); });
        return { status:'ok', bytesWritten:bytes.byteLength };
      }
    };
    Object.defineProperty(navigator, 'usb', { configurable:true, value:{ addEventListener() {}, removeEventListener() {}, async requestDevice(options) {
      assert(options.filters.some(f => f.vendorId === 0x1a86 && f.productId === 0x7523), 'CH340 chooser filter'); return device;
    } } });
    byId('transport').value = 'usb'; byId('transport').dispatchEvent(new Event('change'));
    byId('connect').click(); await wait(() => !byId('sendText').disabled);
    assert(byId('connectionDetail').textContent.includes('USB 직접') && byId('transport').disabled, 'usb transport shown and locked');
    assert(controls.some(([r, v, i]) => r === 0x9a && v === 0x1312 && i === (CH340Usb.baudDivisor(38400) | 0x80)), 'usb baud init');
    writes = []; byId('text').value = 'ok'; byId('sendText').click(); await wait(() => !byId('sendText').disabled);
    assert(writes.filter(b => b[3] === 2).length === 3 && byId('jobTitle').textContent === '완료했습니다', 'usb typing');
    byId('disconnect').click(); await wait(() => !byId('connect').hidden && !byId('connect').disabled);
    assert(!device.opened, 'usb device closed on disconnect');
    byId('transport').value = 'auto'; byId('transport').dispatchEvent(new Event('change')); results.push('WebUSB CH340 connect + typing');
  }
  assert(performance.getEntriesByType('resource').every(r => !/^https?:/.test(r.name)), 'unexpected network traffic');
  return { results, secure:window.isSecureContext, overflow:document.documentElement.scrollWidth > innerWidth, hardware:'not connected; mock only' };
})
