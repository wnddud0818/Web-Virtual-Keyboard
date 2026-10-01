/* Standalone browser controller. Modified from Web Virtual Keyboard, 2026-09-28. EUPL-1.2. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const { SerialClient, shortcut, normalizeText, textReports, textReportCount } = CH9329;
  const storeKey = 'wvk.ch9329.presets.v1', baudKey = 'wvk.ch9329.baud', transportKey = 'wvk.ch9329.transport';
  const operatingModes = [
    { name:'키보드 + 마우스 + 사용자 정의 HID', keyboard:true, mouse:true, description:'키보드·마우스·사용자 정의 HID가 함께 인식되는 복합 장치입니다. 공장 기본 모드이며 멀티미디어 키도 포함합니다.' },
    { name:'키보드만', keyboard:true, mouse:false, description:'일반 USB HID 키보드만 인식합니다. 마우스·멀티미디어 키·사용자 정의 HID 기능은 제외됩니다.' },
    { name:'키보드 + 마우스', keyboard:true, mouse:true, description:'키보드와 마우스가 함께 인식되는 복합 장치입니다. 멀티미디어 키를 포함하고 사용자 정의 HID 기능은 제외됩니다.' },
    { name:'사용자 정의 HID만', keyboard:false, mouse:false, description:'데이터 통신용 사용자 정의 HID만 인식합니다. 이 웹 화면의 키보드·마우스·파일 타이핑은 사용할 수 없으며, 설정 읽기와 모드 변경은 계속 사용할 수 있습니다.' }
  ];
  let busy = false, aborter = null, info = null, config = null, prepared = null, selectedFile = null;
  let fileRevision = 0, toastTimer, presets = [], modePending = false, canStop = true;
  // Android Chrome exposes navigator.serial for Bluetooth only, so wired CH340 goes through WebUSB.
  const android = /Android/i.test(navigator.userAgent);
  const apis = { serial:!!navigator.serial, usb:!!navigator.usb && !!window.CH340Usb };
  const transportNames = { serial:'시리얼 포트 (Web Serial)', usb:'USB 직접 (WebUSB)' };
  const supported = window.isSecureContext && (apis.serial || apis.usb);
  let linked = null;
  function autoTransport() { return android && apis.usb ? 'usb' : apis.serial ? 'serial' : apis.usb ? 'usb' : null; }
  function transport() { const chosen = $('transport').value; return chosen === 'auto' ? autoTransport() : apis[chosen] ? chosen : null; }
  const client = new SerialClient({ onFault(error) {
    info = null; config = null;
    aborter?.abort(error); sync();
    $('connectionDetail').textContent = '통신이 중단되었습니다. 케이블 연결 방향과 속도를 확인한 뒤 다시 연결하세요.';
    notify(error.message, true);
  } });
  function notify(message, error = false) {
    clearTimeout(toastTimer); $('toast').textContent = message; $('toast').className = 'toast' + (error ? ' error' : '');
    $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 12000 : 6000);
  }
  function sync() {
    const available = client.connected && !busy && !modePending;
    const mode = config ? config[0] & 0x7f : null, capabilities = operatingModes[mode];
    document.querySelectorAll('[data-device]').forEach(button => {
      const input = button.closest('[data-input]')?.dataset.input;
      button.disabled = !available || (input && !capabilities?.[input]);
    });
    $('connect').hidden = client.connected;
    $('connect').disabled = busy || !supported || !transport();
    $('disconnect').hidden = !client.connected;
    $('disconnect').disabled = busy;
    $('baud').disabled = busy || client.connected;
    $('address').disabled = busy || client.connected;
    $('transport').disabled = busy || client.connected;
    $('stop').disabled = !busy || !aborter || !canStop;
    $('saveMode').disabled = !available || !config || !$('modeConfirmed').checked;
    $('operatingMode').disabled = busy || modePending;
    $('modeConfirmed').disabled = busy || modePending;
    $('saveBaud').disabled = !available || !config;
    $('deviceBaud').disabled = busy;
    $('backupConfig').disabled = !config || busy;
    $('sendFile').disabled = !available || !prepared || !capabilities?.keyboard;
    $('prepareFile').disabled = busy || !selectedFile;
    $('keyDelay').disabled = busy || $('typingMode').value === 'fast'; $('startDelay').disabled = busy;
    $('typingMode').disabled = busy;
    $('sessionOrb').classList.toggle('busy', busy);
    const badge = $('connectionBadge');
    badge.textContent = client.connected ? (info?.usb ? '연결됨' : '대상 PC 확인') : '연결 안 됨';
    badge.className = 'badge' + (client.connected ? (info?.usb ? ' online' : ' warning') : '');
    $('connectionTitle').textContent = client.connected ? 'CH9329와 연결되었습니다' : '케이블을 연결해 주세요';
    $('connectionDetail').textContent = client.connected
      ? (info?.usb ? '대상 PC 연결 확인' : 'CH9329 쪽 USB를 대상 PC에 연결하세요') + ` · ${client.baudRate.toLocaleString()} bps` + (linked === 'usb' ? ' · USB 직접' : '')
      : 'CH340 → 이 기기 · CH9329 → 입력받을 컴퓨터';
    $('inputModeNote').hidden = !client.connected || ![1,3].includes(mode);
    $('inputModeNote').textContent = mode === 1
      ? '현재 장치는 키보드 전용 모드입니다. 마우스 조작은 사용할 수 없습니다.'
      : '현재 장치는 사용자 정의 HID 모드입니다. 키보드·마우스·파일 타이핑을 사용하려면 장치 설정에서 동작 모드를 변경하세요.';
  }
  function progress(done, total) {
    const percent = total ? Math.floor(done * 100 / total) : 0;
    $('progress').value = percent; $('progressPercent').textContent = percent + '%';
    $('progressCount').textContent = done.toLocaleString() + ' / ' + total.toLocaleString();
  }
  function check(signal) { if (signal.aborted) throw signal.reason; }
  async function pause(ms, signal) {
    const end = performance.now() + ms;
    while (performance.now() < end) { check(signal); await new Promise(resolve => setTimeout(resolve, Math.min(70, end - performance.now()))); }
    check(signal);
  }
  function stopped() { return new DOMException('전송을 중지했습니다.', 'AbortError'); }
  async function exclusive(title, work, { usb = true, caps = false, delay = false, cancellable = true } = {}) {
    if (busy || !client.connected || modePending) return;
    busy = true; canStop = cancellable; aborter = new AbortController(); const signal = aborter.signal;
    $('jobTitle').textContent = title; $('jobDetail').textContent = '장치 상태를 확인하고 있습니다.'; progress(0, 0); sync();
    try {
      if (usb) {
        info = await client.info(); check(signal); sync();
        if (!info.usb) throw new Error('CH9329 쪽 USB가 대상 PC에서 인식되지 않았습니다.');
        if (caps && info.capsLock) throw new Error('대상 PC의 Caps Lock을 끈 뒤 다시 전송해 주세요.');
      }
      if (delay) {
        for (let n = Number($('startDelay').value); n > 0; n--) {
          $('jobDetail').textContent = `${n}초 후 시작합니다. 대상 PC의 입력창을 선택하세요.`;
          await pause(1000, signal);
        }
      }
      check(signal);
      const result = await work(signal);
      check(signal);
      $('jobTitle').textContent = '완료했습니다'; $('jobDetail').textContent = typeof result === 'string' ? result : '장치에서 명령 처리 응답을 받았습니다.';
    } catch (error) {
      $('jobTitle').textContent = error.name === 'AbortError' ? '전송을 중지했습니다' : '작업을 완료하지 못했습니다';
      $('jobDetail').textContent = error.message + (usb ? ' 일부 입력은 남아 있을 수 있습니다. 다시 전송하려면 대상 내용을 먼저 비워 주세요.' : '');
      notify(error.message, error.name !== 'AbortError');
    } finally { busy = false; aborter = null; sync(); }
  }
  async function transmit(value, signal) {
    const text = normalizeText(value);
    if (!text.length) throw new Error('보낼 내용을 입력해 주세요.');
    const fast = $('typingMode').value === 'fast';
    const delay = fast ? 0 : Math.max(0, Math.min(100, Number($('keyDelay').value) || 0));
    let done = 0, lastPaint = 0; const started = performance.now();
    progress(0, text.length);
    try {
      for (const report of textReports(text, fast)) {
        check(signal);
        await client.keyboard(report.modifier, report.keys);
        done += report.advance;
        if (done === text.length || performance.now() - lastPaint > 80) {
          progress(done, text.length); lastPaint = performance.now();
          const remaining = done ? ((lastPaint - started) / done) * (text.length - done) : 0;
          const rate = done / Math.max(0.001, (lastPaint - started) / 1000);
          $('jobDetail').textContent = `초당 ${rate.toFixed(1)}자 · 남은 시간 약 ${duration(remaining / 1000)}`;
        }
        if (delay && report.advance) await pause(delay, signal);
      }
    } finally {
      if (client.connected) await client.keyboard();
    }
    return `${done.toLocaleString()}자 전송 응답을 받았습니다. 대상 PC에서 결과를 확인하세요.`;
  }
  $('typingMode').addEventListener('change', () => {
    $('keyDelay').value = $('typingMode').value === 'fast' ? '0' : '5'; sync(); renderFileSummary();
  });
  // Avoid leaving a key held while browser timers/serial callbacks are suspended.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && busy && canStop && $('typingMode').value === 'fast') aborter?.abort(stopped());
  });
  function rememberBaud(baud) { try { localStorage.setItem(baudKey, String(baud)); } catch {} }
  async function connect() {
    if (busy) return;
    let stage = 'select';
    const kind = transport(), target = kind === 'usb' ? 'USB 장치' : '시리얼 포트';
    $('connectionError').hidden = true;
    busy = true; sync();
    try {
      // The chooser call stays directly in the button gesture, including reconnects.
      const port = kind === 'usb' ? await CH340Usb.request() : await navigator.serial.requestPort();
      await client.close(); linked = kind;
      stage = 'open';
      await client.open(port, Number($('baud').value), Number($('address').value));
      stage = 'response';
      info = await client.info(); config = await client.config(); modePending = false;
      // The chip answered at this speed; preselect it on the next launch.
      rememberBaud(client.baudRate);
      if (info.usb) {
        // Recover any key/button left held by a previous interrupted session.
        try { await client.releaseAll(config[0] & 0x7f); }
        catch (error) { if (!client.connected) throw error; notify('연결됐지만 키/마우스 해제 명령 일부가 거부됐습니다. 장치 모드를 확인하세요.', true); }
      }
      renderConfig(); $('jobTitle').textContent = '장치와 연결되었습니다';
      $('jobDetail').textContent = (config[0] & 0x7f) === 3 ? '사용자 정의 HID 모드입니다. 장치 설정에서 모드를 변경할 수 있습니다.'
        : info.usb ? '대상 PC의 입력창을 선택해 주세요.' : 'CH9329 쪽 USB를 대상 PC에 연결해 주세요.';
    } catch (error) {
      if (!(stage === 'select' && error.name === 'NotFoundError')) {
        const guidance = stage === 'open'
          ? kind === 'usb'
            ? 'USB 장치를 열지 못했습니다. 아직 CH9329의 동작 모드나 응답을 확인하기 전입니다. 브라우저의 USB 사용 권한 요청을 허용했는지, CH340 쪽 USB가 이 기기에 연결됐는지 확인하세요. 같은 장치를 사용하는 다른 탭·앱을 닫고 양쪽 USB를 모두 분리했다가 다시 연결하세요. 데스크톱에서 운영체제의 CH340 드라이버가 장치를 사용 중이면 장치 설정의 연결 방식을 “시리얼 포트”로 바꾸세요.'
            : '시리얼 포트를 열지 못했습니다. 아직 CH9329의 동작 모드나 응답을 확인하기 전입니다. CH340 포트(USB Serial / usbserial)를 선택했는지 확인하세요. 같은 포트를 사용하는 다른 탭·시리얼 프로그램을 닫고, 양쪽 USB를 모두 분리했다가 다시 연결하세요. 계속 실패하면 CH340 드라이버와 USB 연결을 확인하세요.'
          : stage === 'response'
            ? target + '는 열렸지만 장치 연결 확인을 완료하지 못했습니다. 양쪽 USB 연결과 장치에 저장된 통신 속도·주소를 확인하세요. 속도를 변경한 적이 없다면 기본값은 9600 bps, 주소는 0입니다. 동작 모드와 별개로 시리얼 통신 모드는 0(프로토콜)이어야 합니다.'
            : kind === 'usb' ? '장치를 선택하지 못했습니다. 브라우저의 USB 장치 접근 권한을 확인하세요.' : '포트를 선택하지 못했습니다. 브라우저의 시리얼 장치 접근 권한을 확인하세요.';
        $('connectionError').textContent = guidance + '\n상세: ' + error.message;
        $('connectionError').hidden = false;
        notify(stage === 'open' ? target + ' 열기 실패. 아래 연결 안내를 확인하세요.' : '연결 실패. 아래 연결 안내를 확인하세요.', true);
      }
      await client.close(); info = null; config = null;
      renderConfig();
    } finally { busy = false; sync(); }
  }
  $('connect').addEventListener('click', connect);
  $('disconnect').addEventListener('click', async () => {
    if (busy) return; busy = true; sync();
    try { if (info?.usb && config) await client.releaseAll(config[0] & 0x7f); } catch (error) { notify('입력 해제를 확인하지 못했습니다: ' + error.message, true); }
    await client.close(); info = null; config = null; busy = false; renderConfig(); sync();
  });
  $('stop').addEventListener('click', () => {
    aborter?.abort(stopped()); $('jobDetail').textContent = '진행 중인 명령을 마치고 키를 해제하고 있습니다…';
  });
  window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
  document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach(item => { item.classList.toggle('active', item === button); if (item === button) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); });
    document.querySelectorAll('.panel').forEach(panel => { panel.hidden = panel.id !== 'panel-' + button.dataset.tab; });
    $('pageTitle').textContent = { keyboard:'키보드', mouse:'마우스', files:'파일 전송', settings:'장치 설정' }[button.dataset.tab];
  }));
  $('text').addEventListener('input', () => { $('charCount').textContent = $('text').value.length.toLocaleString() + '자'; });
  $('sendText').addEventListener('click', () => {
    let text;
    try { text = normalizeText($('text').value); if (!text) throw new Error('보낼 내용을 입력해 주세요.'); }
    catch (error) { notify(error.message, true); return; }
    if ($('appendEnter').checked) text += '\n';
    exclusive('텍스트 전송', signal => transmit(text, signal), { caps:true, delay:true });
  });
  function sendUnicode(value) {
    if (!value) { notify('보낼 내용을 입력해 주세요.', true); return; }
    const bytes = new TextEncoder().encode(value);
    exclusive('한글·텍스트 전송', async signal => {
      $('jobDetail').textContent = '텍스트를 압축하고 검증값을 만들고 있습니다.';
      const plan = await WVK.prepare(bytes, 'message.txt'); check(signal);
      await transmit(plan.text, signal);
      return '전송 완료. 대상 디코더에서 “검증하고 열기”를 눌러 주세요.';
    }, { caps:true, delay:true });
  }
  $('sendUnicode').addEventListener('click', () => sendUnicode($('text').value));
  function sendShortcut(value) {
    let report; try { report = shortcut(value); } catch (error) { notify(error.message, true); return; }
    exclusive(value + ' 전송', async () => { await client.tap(report.modifier, report.keys); });
  }
  for (const key of ['ESC','TAB','ENTER','BKSP','DEL','HOME','END','UP','DOWN','LEFT','RIGHT','CTRL+A','CTRL+C','CTRL+V','CTRL+S',...Array.from({ length:12 }, (_, i) => 'F' + (i + 1))]) {
    const button = document.createElement('button'); button.textContent = key; button.dataset.device = ''; button.addEventListener('click', () => sendShortcut(key)); $('quickKeys').append(button);
  }
  $('sendShortcut').addEventListener('click', () => sendShortcut($('shortcut').value));
  $('ime').addEventListener('click', () => sendShortcut('RALT'));
  $('mouseStep').addEventListener('input', () => { $('stepLabel').textContent = $('mouseStep').value; });
  document.querySelectorAll('[data-move]').forEach(button => button.addEventListener('click', () => {
    const [x, y] = button.dataset.move.split(',').map(Number), step = Number($('mouseStep').value);
    exclusive('마우스 이동', () => client.relative(x * step, y * step));
  }));
  async function clickMouse(button, signal) {
    try { await client.relative(0, 0, 0, button); await pause(40, signal); }
    finally { if (client.connected) await client.relative(); }
  }
  document.querySelectorAll('[data-click]').forEach(button => button.addEventListener('click', () => exclusive('마우스 클릭', signal => clickMouse(Number(button.dataset.click), signal))));
  $('doubleClick').addEventListener('click', () => exclusive('마우스 더블 클릭', async signal => { await clickMouse(1, signal); await pause(60, signal); await clickMouse(1, signal); }));
  document.querySelectorAll('[data-wheel]').forEach(button => button.addEventListener('click', () => exclusive('마우스 스크롤', () => client.relative(0, 0, Number(button.dataset.wheel)))));
  $('absoluteMove').addEventListener('click', () => {
    const x = Number($('mouseX').value), y = Number($('mouseY').value);
    if (![x, y].every(n => Number.isFinite(n) && n >= 0 && n <= 100)) { notify('좌표는 0–100%로 입력해 주세요.', true); return; }
    exclusive('지정 위치로 이동', () => client.absolute(Math.round(x * 4095 / 100), Math.round(y * 4095 / 100)));
  });
  function bytesLabel(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KiB' : (n / 1048576).toFixed(1) + ' MiB'; }
  function duration(seconds) {
    if (seconds < 60) return Math.max(1, Math.ceil(seconds)) + '초';
    if (seconds < 3600) return Math.ceil(seconds / 60) + '분';
    return (seconds / 3600).toFixed(1) + '시간';
  }
  function estimate(text) {
    const fast = $('typingMode').value === 'fast';
    // A 14-byte key report + 7-byte ACK, 8N1. USB/browser latency is extra.
    const wire = textReportCount(text, fast) * 210 / Number($('baud').value);
    const wait = fast ? 0 : text.length * (Number($('keyDelay').value) || 0) / 1000;
    return duration(wire + wait);
  }
  function renderFileSummary() {
    if (!prepared) return;
    const plan = prepared;
    $('fileSummary').textContent = `${plan.name} · ${bytesLabel(plan.original)}\n${plan.mode} · ${plan.text.length.toLocaleString()}자 · 통신·입력 간격 기준 최소 약 ${estimate(plan.text)} (실제는 더 걸릴 수 있음)${plan.saved ? '\n압축으로 ' + plan.saved.toLocaleString() + '자 절약' : ''}\n대상: ${plan.mode === '원문 텍스트' ? '빈 일반 텍스트 편집기' : 'decoder.html의 데이터 입력창'}`;
  }
  $('baud').addEventListener('change', renderFileSummary);
  $('keyDelay').addEventListener('change', renderFileSummary);
  function selectFile(file) {
    fileRevision++; selectedFile = file || null; prepared = null;
    $('fileSummary').textContent = file ? `${file.name} · ${bytesLabel(file.size)} · “전송 준비”를 눌러 주세요.` : '파일을 선택해 주세요.'; sync();
  }
  $('fileInput').addEventListener('change', () => selectFile($('fileInput').files[0]));
  $('fileMode').addEventListener('change', () => selectFile(selectedFile));
  $('dropzone').addEventListener('dragover', event => { event.preventDefault(); $('dropzone').classList.add('dragover'); });
  $('dropzone').addEventListener('dragleave', () => $('dropzone').classList.remove('dragover'));
  $('dropzone').addEventListener('drop', event => { event.preventDefault(); $('dropzone').classList.remove('dragover'); selectFile(event.dataTransfer.files[0]); });
  $('prepareFile').addEventListener('click', async () => {
    if (busy || !selectedFile) return;
    const revision = fileRevision, file = selectedFile, mode = $('fileMode').value;
    busy = true; prepared = null; sync();
    $('fileSummary').textContent = '파일을 읽고 전송량을 계산하고 있습니다…';
    try {
      if (file.size > 16 * 1024 * 1024) throw new Error('최대 16 MiB까지 준비할 수 있습니다.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      let plan;
      if (mode === 'raw') {
        if (bytes.some(b => b !== 9 && b !== 10 && b !== 13 && (b < 32 || b > 126))) throw new Error('원문 모드는 ASCII 텍스트만 지원합니다. 파일 복원 모드를 선택하세요.');
        plan = { text:normalizeText(new TextDecoder().decode(bytes)), mode:'원문 텍스트', saved:0 };
        if (!plan.text) throw new Error('빈 파일은 파일 복원 모드로 보내 주세요.');
      } else plan = await WVK.prepare(bytes, file.name);
      if (revision !== fileRevision) return;
      prepared = { ...plan, name:file.name, original:file.size }; renderFileSummary();
    } catch (error) { if (revision === fileRevision) $('fileSummary').textContent = error.message; notify(error.message, true); }
    finally { busy = false; sync(); }
  });
  $('sendFile').addEventListener('click', () => {
    const plan = prepared; if (!plan) return;
    exclusive(plan.name + ' 전송', async signal => { await transmit(plan.text, signal); return plan.mode === '원문 텍스트' ? '전송 완료. 대상 편집기에서 내용을 확인하세요.' : '전송 완료. 대상 디코더에서 검증하고 파일을 저장하세요.'; }, { caps:true, delay:true });
  });
  function download(name, value, type = 'application/json') {
    const url = URL.createObjectURL(new Blob([value], { type }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function decoderSource() { return atob(window.WVK_DECODER_BASE64); }
  $('downloadDecoder').addEventListener('click', () => download('decoder.html', decoderSource(), 'text/html;charset=utf-8'));
  $('typeDecoder').addEventListener('click', () => exclusive('빠른 디코더 타이핑', async signal => {
    await transmit(atob(window.WVK_INSTALLER_BASE64), signal); return '대상 편집기에서 decoder.html로 저장하고 Chrome / Edge로 열어 주세요. 디코더가 자동으로 펼쳐집니다.';
  }, { caps:true, delay:true }));
  $('typeFullDecoder').addEventListener('click', () => exclusive('디코더 전체 소스 타이핑', async signal => {
    await transmit(decoderSource(), signal); return '대상 편집기에서 decoder.html로 저장하고 브라우저로 열어 주세요.';
  }, { caps:true, delay:true }));
  const installerLength = atob(window.WVK_INSTALLER_BASE64).length;
  $('decoderSize').textContent = `빠른 설치: ${installerLength.toLocaleString()}자 · 전체 소스보다 ${Math.round(100 * (1 - installerLength / decoderSource().length))}% 적게 타이핑합니다.`;
  function validatePresets(value) {
    if (!Array.isArray(value) || value.length > 200) throw new Error('프리셋은 최대 200개까지 가져올 수 있습니다.');
    return value.map(p => {
      if (!p || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 60 || typeof p.value !== 'string' || !p.value || p.value.length > 100000 || !['text','unicode','shortcut'].includes(p.kind)) throw new Error('프리셋 파일 형식이 올바르지 않습니다.');
      if (p.kind === 'text') normalizeText(p.value);
      if (p.kind === 'shortcut') shortcut(p.value);
      return { name:p.name, value:p.value, kind:p.kind };
    });
  }
  function persist() {
    try { localStorage.setItem(storeKey, JSON.stringify(presets)); }
    catch { $('storageHint').textContent = '브라우저 저장소를 사용할 수 없습니다. 창을 닫기 전 프리셋을 내보내 주세요.'; }
    renderPresets();
  }
  function renderPresets() {
    $('presets').replaceChildren();
    if (!presets.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '자주 쓰는 문구와 단축키를 여기에 모아 보세요.'; $('presets').append(empty); }
    presets.forEach((preset, index) => {
      const item = document.createElement('div'); item.className = 'preset-item';
      const text = document.createElement('div'), title = document.createElement('strong'), sub = document.createElement('small');
      title.textContent = preset.name; sub.textContent = preset.kind === 'shortcut' ? preset.value : preset.value.slice(0, 60); text.append(title, sub);
      const send = document.createElement('button'); send.textContent = '전송 ↗'; send.dataset.device = '';
      send.addEventListener('click', () => {
        if (preset.kind === 'shortcut') sendShortcut(preset.value);
        else if (preset.kind === 'unicode') sendUnicode(preset.value);
        else exclusive(preset.name + ' 전송', signal => transmit(preset.value, signal), { caps:true, delay:true });
      });
      const remove = document.createElement('button'); remove.textContent = '×'; remove.className = 'delete'; remove.setAttribute('aria-label', preset.name + ' 삭제');
      remove.addEventListener('click', () => { presets.splice(index, 1); persist(); });
      item.append(text, send, remove); $('presets').append(item);
    }); sync();
  }
  $('savePreset').addEventListener('click', () => {
    try { presets = validatePresets([...presets, { name:$('presetName').value.trim(), kind:$('presetKind').value, value:$('presetValue').value }]); persist(); $('presetName').value = ''; $('presetValue').value = ''; notify('프리셋을 저장했습니다.'); }
    catch (error) { notify(error.message, true); }
  });
  $('exportPresets').addEventListener('click', () => download('hid-desk-presets.json', JSON.stringify(presets, null, 2)));
  $('importPresets').addEventListener('change', async () => {
    const file = $('importPresets').files[0]; if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('프리셋 파일은 최대 2 MiB입니다.');
      const additions = validatePresets(JSON.parse(await file.text())); presets = validatePresets([...presets, ...additions]); persist(); notify(additions.length + '개 프리셋을 추가했습니다.');
    } catch (error) { notify(error.message, true); }
    $('importPresets').value = '';
  });
  function hex(value) { return '0x' + value.toString(16).toUpperCase().padStart(2, '0'); }
  function renderModeChoice() {
    const mode = Number($('operatingMode').value), selected = operatingModes[mode];
    $('modeDescription').textContent = selected.description;
    $('modeCompatibility').hidden = mode !== 2;
    $('modeConfirmationText').textContent = `제품 설명서에서 “모드 ${mode} · ${selected.name}” 기능을 확인했습니다.`;
    $('saveMode').textContent = `모드 ${mode} 저장`;
  }
  function renderConfig() {
    $('configInfo').replaceChildren();
    const fields = config && info ? [
      ['칩 버전 (원시값)', hex(info.version)], ['대상 USB 연결', info.usb ? '인식됨' : '미연결 / 인식 안 됨'],
      ['Caps Lock', info.capsLock ? '켜짐 — 텍스트 전송 전 끄기' : '꺼짐'],
      ['현재 동작 모드', `${config[0] & 0x7f} · ${operatingModes[config[0] & 0x7f]?.name || '알 수 없는 모드'} · ${config[0] & 0x80 ? '하드웨어 핀 기준' : '소프트웨어 설정'}`],
      ['통신 모드', `${config[1] & 0x7f} · ${config[1] & 0x80 ? '하드웨어 핀 기준' : '소프트웨어 설정'}`],
      ['주소', config[2]], ['저장된 속도', new DataView(config.buffer, config.byteOffset, config.byteLength).getUint32(3, false) + ' bps']
    ] : [['장치', '연결 후 설정을 읽어 주세요.']];
    for (const [label, value] of fields) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; $('configInfo').append(dt, dd); }
    if (config && operatingModes[config[0] & 0x7f]) $('operatingMode').value = String(config[0] & 0x7f);
    $('modeConfirmed').checked = false;
    renderModeChoice();
  }
  $('readConfig').addEventListener('click', () => exclusive('장치 설정 읽기', async () => { info = await client.info(); config = await client.config(); renderConfig(); return '현재 장치 설정을 읽었습니다. USB 인터페이스 구성은 대상 PC에서 확인하세요.'; }, { usb:false }));
  $('modeConfirmed').addEventListener('change', sync);
  $('operatingMode').addEventListener('change', () => {
    $('modeConfirmed').checked = false; renderModeChoice(); sync();
  });
  $('saveBaud').addEventListener('click', () => {
    const baud = Number($('deviceBaud').value);
    exclusive('장치 통신 속도 저장', async signal => {
      const current = await client.config(); check(signal);
      await client.saveBaudRate(current, baud);
      modePending = true; config = null;
      $('baud').value = String(baud);
      rememberBaud(baud);
      const message = `${baud.toLocaleString()} bps 저장 완료. 양쪽 USB를 모두 분리한 후 다시 연결하세요. 위쪽 통신 속도도 ${baud.toLocaleString()}으로 맞춰 두었습니다.`;
      $('baudResult').textContent = message;
      await client.close(); info = null; renderConfig(); renderFileSummary();
      return message;
    }, { usb:false, cancellable:false });
  });
  $('backupConfig').addEventListener('click', () => { if (config) download('ch9329-config-backup.json', JSON.stringify({ version:info?.version, address:client.address, baud:client.baudRate, config:Array.from(config), savedAt:new Date().toISOString() }, null, 2)); });
  $('saveMode').addEventListener('click', () => {
    if (!$('modeConfirmed').checked) return;
    const mode = Number($('operatingMode').value);
    exclusive('부팅 모드 저장', async signal => {
      const current = await client.config(); check(signal);
      await client.saveOperatingMode(current, mode);
      modePending = true; config = null;
      $('modeConfirmed').checked = false;
      const message = `모드 ${mode} · ${operatingModes[mode].name} 저장 응답을 받았습니다. 양쪽 USB를 모두 뽑아 전원을 끊은 뒤 다시 연결하세요. 테스트 PC에서 선택한 장치 기능으로 인식되는지 확인해 주세요.`;
      $('modeResult').textContent = message;
      await client.close(); info = null; renderConfig();
      return message;
    }, { usb:false, cancellable:false });
  });
  try { const saved = localStorage.getItem(storeKey); if (saved) presets = validatePresets(JSON.parse(saved)); }
  catch { $('storageHint').textContent = '저장된 프리셋을 읽지 못했습니다. 내보낸 JSON을 가져오거나 새로 저장해 주세요.'; }
  try { const baud = localStorage.getItem(baudKey); if (['9600','19200','38400','57600','115200'].includes(baud)) $('baud').value = baud; } catch {}
  for (const option of $('transport').options) {
    if (option.value === 'auto') option.textContent = '자동' + (autoTransport() ? ' · ' + transportNames[autoTransport()] : '');
    else option.disabled = !apis[option.value];
  }
  try { const saved = localStorage.getItem(transportKey); if (apis[saved]) $('transport').value = saved; } catch {}
  $('transport').addEventListener('change', () => { try { localStorage.setItem(transportKey, $('transport').value); } catch {} sync(); });
  if (!supported) {
    $('supportNote').hidden = false;
    $('supportNote').textContent = '이 브라우저에서는 케이블 연결을 사용할 수 없습니다. 데스크톱은 폴더의 index.html을 Chrome / Edge에서 직접 열고, 안드로이드는 Chrome에서 HTTPS 주소로 여세요. 관리되는 브라우저는 장치 접근이 제한될 수 있습니다.';
  }
  renderPresets(); renderConfig(); sync();
})();
