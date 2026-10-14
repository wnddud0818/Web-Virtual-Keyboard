#!/usr/bin/env python3
"""Package the current web controller, retaining a snapshot for standalone builds."""
from pathlib import Path
import shutil
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[1]
source = root / 'upstream'
workspace_web = root.parent / 'ch9329-web'
web_files = ('index.html', 'app.js', 'protocol.js', 'ch340-usb.js', 'transfer.js', 'diff.js',
             'decoder-source.js', 'decoder.html', 'decoder-installer.html', 'styles.css', 'LICENSE', 'README.md')
if workspace_web.is_dir():
    for name in web_files:
        shutil.copy2(workspace_web / name, source / name)
    for name in ('scripts', 'tests'):
        for file in (workspace_web / name).rglob('*'):
            if file.is_file() and '__pycache__' not in file.parts and file.name != '.DS_Store':
                target = source / name / file.relative_to(workspace_web / name)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(file, target)
shutil.copy2(source / 'decoder.html', root / 'Web-Virtual-Keyboard-platformio/web/decoder.html')
version = ET.parse(root / 'app/src/main/AndroidManifest.xml').getroot().get('{http://schemas.android.com/apk/res/android}versionName')
dest = root / 'app/src/main/assets/web'
dest.mkdir(parents=True, exist_ok=True)
for name in ('protocol.js', 'ch340-usb.js', 'transfer.js', 'diff.js', 'decoder-source.js', 'decoder.html', 'decoder-installer.html', 'styles.css', 'LICENSE'):
    shutil.copy2(source / name, dest / name)

def replace(text, before, after):
    if before not in text:
        raise RuntimeError(f'Upstream changed: {before[:100]}')
    return text.replace(before, after)

html = (source / 'index.html').read_text()
html = replace(html, '<script src="app.js" defer></script>', '<script src="android-bridge.js" defer></script>\n<script src="app.js" defer></script>')
html = replace(html, '별도 서버 없이 실행됩니다.', '인터넷 없이 실행됩니다.')
html = replace(html, '<a href="README.md" target="_blank">사용 안내 ↗</a>', '<span>갤럭시 OTG · Android 앱 1.0</span>')
html = html.replace('Android 앱 1.0', f'Android 앱 {version}')
html = replace(html, '이 컴퓨터에서 보내고, 연결된 컴퓨터에서 입력하세요.', '갤럭시에서 보내고, 연결된 컴퓨터에서 입력하세요.')
html = replace(html, '<section id="panel-settings" class="panel" hidden>', '<section id="panel-settings" class="panel" hidden>\n          <p class="notice">USB 권한과 장치 목록은 화면 위의 “USB 확인 / 권한”에서 확인하세요. 아래 장치 설정은 케이블 연결과 CH9329 응답 확인 후 변경할 수 있습니다.</p>')
html = replace(html, '<option value="serial">시리얼 포트 (Web Serial)</option>', '')
html = replace(html, 'USB 직접 (WebUSB)', 'USB 직접 (안드로이드)')
html = replace(html, '안드로이드(갤럭시 등) Chrome은 드라이버 없이 USB 직접 방식으로 연결합니다.', '이 앱은 안드로이드 USB 기능으로 CH340을 직접 연결합니다.')
html = html.replace('이 앱은 안드로이드 USB 기능으로 CH340을 직접 연결합니다.', '이 앱은 USB 시리얼 장치를 직접 연결합니다. CH340/CH341과 CH343/CH9102의 CDC, CP210x, FTDI 등 지원 칩을 자동으로 찾습니다.')
html = replace(html, '제어 기기에는 CH340 쪽을, 대상 PC에는 CH9329 쪽만 연결합니다. 데스크톱은 CH340 시리얼 포트가 필요하며, 포트가 보이지 않으면 USB 연결 방향과 CH340 드라이버를 확인하세요.',
               'CH340 쪽을 갤럭시에, CH9329 쪽을 대상 PC에 연결합니다. 장치가 보이지 않으면 OTG 젠더와 USB 연결 방향을 확인하세요.')
html = replace(html, '브라우저', '앱')
html = replace(html, '보내는 PC', '보내는 갤럭시')
(dest / 'index.html').write_text(html)

app = (source / 'app.js').read_text()
app = replace(app, 'const apis = { serial:!!navigator.serial, usb:!!navigator.usb && !!window.CH340Usb };',
              'const native = !!window.AndroidHid?.available;\n  const apis = { serial:!native && !!navigator.serial, usb:(native || !!navigator.usb) && !!window.CH340Usb };')
app = replace(app, "usb:'USB 직접 (WebUSB)'", "usb:'USB 직접 (안드로이드)'")
app = replace(app, 'const supported = window.isSecureContext && (apis.serial || apis.usb);', 'const supported = (native || window.isSecureContext) && (apis.serial || apis.usb);')
acknowledge = '''        if (report.ime) ime = report.ime;
        done += report.advance; sent.done = done;
        if (done === text.length || performance.now() - lastPaint > 80) {
          progress(done, text.length); lastPaint = performance.now();
          const remaining = done ? ((lastPaint - started) / done) * (text.length - done) : 0;
          const rate = done / Math.max(0.001, (lastPaint - started) / 1000);
          $('jobDetail').textContent = `초당 ${rate.toFixed(1)}자 · 남은 시간 약 ${duration(remaining / 1000)}`;
        }'''
loop = '''      for (const report of mixed ? koreanTextReports(text, fast) : textReports(text, fast)) {
        check(signal);
        await client.keyboard(report.modifier, report.keys);
''' + acknowledge + '''
        if (delay && report.advance) await pause(delay, signal);
        if (report.wait) await pause(report.wait, signal);
      }'''
native_loop = '''      const acknowledged = (report, paint = true) => {
''' + acknowledge.replace('if (done === text.length || performance.now() - lastPaint > 80)', 'if (paint && (done === text.length || performance.now() - lastPaint > 80))') + '''
      };
      const reports = mixed ? koreanTextReports(text, fast) : textReports(text, fast);
      if (native && fast) {
        await AndroidHid.transmitReports(client, reports, signal, acknowledged);
      } else {
        for (const report of reports) {
          check(signal);
          await client.keyboard(report.modifier, report.keys);
          acknowledged(report);
          if (delay && report.advance) await pause(delay, signal);
          if (report.wait) await pause(report.wait, signal);
        }
      }'''
app = replace(app, loop, native_loop)
app = replace(app, "  function rememberBaud(baud)", "  window.addEventListener('hid-background', () => {\n    if (busy && canStop) aborter?.abort(stopped());\n  });\n  function rememberBaud(baud)")
app = replace(app, "    const url = URL.createObjectURL(new Blob([value], { type }));", "    if (native) {\n      AndroidHid.saveText(name, value, type).then(() => notify('파일을 저장했습니다.')).catch(error => notify(error.message, true));\n      return;\n    }\n    const url = URL.createObjectURL(new Blob([value], { type }));")
app = replace(app, '브라우저의 USB 사용 권한 요청을 허용했는지', '앱의 USB 사용 권한 요청을 허용했는지')
app = replace(app, '데스크톱에서 운영체제의 CH340 드라이버가 장치를 사용 중이면 장치 설정의 연결 방식을 “시리얼 포트”로 바꾸세요.', '')
app = replace(app, '브라우저의 USB 장치 접근 권한을 확인하세요.', '앱의 USB 사용 권한을 확인하세요.')
app = app.replace('같은 장치를 사용하는 다른 탭·앱을 닫고', '같은 장치를 사용하는 다른 앱을 닫고')
app = replace(app, '브라우저', '앱')
app = app.replace('앱로 열어 주세요.', '브라우저로 열어 주세요.')
app = replace(app, '이 앱에서는 케이블 연결을 사용할 수 없습니다. 데스크톱은 폴더의 index.html을 Chrome / Edge에서 직접 열고, 안드로이드는 Chrome에서 HTTPS 주소로 여세요. 관리되는 앱는 장치 접근이 제한될 수 있습니다.',
              '앱의 USB 기능을 시작하지 못했습니다. Android System WebView를 최신 버전으로 업데이트한 뒤 앱을 다시 실행하세요.')
# Upstream's exact grammar varies; ensure the app never tells Android users to host a website.
app = app.replace("$('supportNote').textContent = '이 앱에서는 케이블 연결을 사용할 수 없습니다. 데스크톱은 폴더의 index.html을 Chrome / Edge에서 직접 열고, 안드로이드는 Chrome에서 HTTPS 주소로 여세요. 관리되는 앱는 장치 접근이 제한될 수 있습니다.';", "$('supportNote').textContent = 'Android System WebView를 최신 버전으로 업데이트한 뒤 앱을 다시 실행하세요.';")
(dest / 'app.js').write_text(app)
print('Prepared offline Android assets')
