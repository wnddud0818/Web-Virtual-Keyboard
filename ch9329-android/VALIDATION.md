# HID Desk Android 1.0.1 검증

## 통과한 검사

| 검사 | 결과 |
|---|---|
| Android SDK 35 / JDK 17 컴파일 | 통과 |
| D8, 최소 Android API 26 | 통과 |
| APK Signature Scheme v2 / v3 | 통과 |
| zipalign 정렬 검사 | 통과 |
| APK 패키지·앱 이름·실행 Activity 확인 | `com.wnddud.hiddesk`, HID Desk, MainActivity |
| APK 인터넷 권한 | 없음 |
| 기존 CH9329·WebUSB·파일 전송 테스트 | 31개 통과 |
| 추가한 Android JS 연결 테스트 | 5개 통과 |
| Java CH340 통신 속도·긴급 해제 패킷 | 통과 |
| USB 드라이버 감지 회귀 검사 | CH340 별칭·CH343/CH9102 CDC·CP210x·FTDI·HID·미지원 장치 통과 |
| 앱 화면과 native IPC를 연결한 DOM 테스트 | 12개 시나리오 통과 |

DOM 테스트는 연결 실패 후 재연결, ASCII/CRLF 전송, 한글·영어 혼합 키 리포트, 앱 배경 전환 시 중지·해제, 단축키, 마우스 이동, 프리셋과 UTF-8 내보내기, 디코더 정확한 저장, 압축 한글 파일 전송, 키보드 전용 모드, 설정 백업, 케이블 분리 처리를 확인했습니다.

## 실기기 확인이 필요한 항목

이 환경에는 갤럭시나 USB 케이블이 연결되어 있지 않습니다. **APK를 실제 안드로이드에 설치·실행하거나 실제 USB 장치와 통신하는 검증은 하지 못했습니다.** 가상 장치는 Android USB Host·시스템 권한창·SAF 파일창·WebView 수명주기를 대신 검증하지 않습니다. DOM 테스트는 화면 레이아웃을 렌더링하는 시각 검사가 아닙니다.

설치 후 확인 순서:

1. 인터넷 없이 앱 화면이 열리는지 확인합니다.
2. OTG로 CH340을 연결하고 **USB 확인 / 권한**에서 장치 목록과 칩을 확인한 뒤 권한 요청을 허용합니다. 거부·분리·재연결도 확인합니다.
3. 대상 PC의 빈 입력창에서 `Hello 123!`를 전송합니다.
4. Windows 한국어 IME / 두벌식 / 101키 종류 1 / 영문(A) 상태에서 `안녕하세요 hello`를 전송합니다.
5. 마우스 기능이 있는 모드에서 클릭·이동을 확인합니다.
6. 짧은 한글 텍스트 파일을 대상 `decoder.html`로 보내고 CRC/SHA 검증 결과를 확인합니다.
7. 프리셋 내보내기·가져오기, 디코더 저장, 설정 백업을 확인합니다.
8. 긴 전송을 중지하고, 앱을 나갔다가 돌아와 키 해제·재연결을 확인합니다. IME 상태는 대상 PC에서 직접 확인합니다.

## 재실행

```sh
npm install
npm test
npm run test:ui
```

Java 계산 검사는 JDK로 `Ch340Math.java`와 `tests/Ch340MathTest.java`를 함께 컴파일한 뒤 `Ch340MathTest`를 실행합니다. APK 빌드·서명·정렬 검사는 `scripts/build_apk.py`가 수행합니다.

USB 권한창 자체와 native USB 상태 창은 실제 Android에서 확인해야 합니다. 검사에 쓰인 USB 장치는 메타데이터 모델이며 실제 USB 열기·송수신 검증이 아닙니다. 1.0.1은 1.0.0과 서명 인증서가 같은지 APK 검사로 확인합니다.
