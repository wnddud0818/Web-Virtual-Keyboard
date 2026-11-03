# Android 설치 파일

- [HID-Desk-Android-1.0.5.apk](HID-Desk-Android-1.0.5.apk)
- Android 8.0 이상 / USB OTG / 최신 Android System WebView
- 패키지: `com.wnddud.hiddesk`, 버전 코드: `6`
- 파일 크기: `157,101`바이트
- SHA-256: `524b129031acb37d06c4e1f9e4729439f4a5587025ebe9d85f55fcdfba5100d4`
- 서명 인증서 SHA-256: `afe5b931e53e95ccdf677a3f4742bfdb62fd3a4072dd1c8388ee58901e5e21fe`

**장치 설정 → USB 식별 정보**에서 제조사명·제품명·시리얼 번호를 읽고 변경합니다. 각 항목은 사용자 지정 또는 기본값으로 선택할 수 있으며, 저장 후 양쪽 USB의 전원을 다시 연결합니다.

JS 테스트 58개, 앱 화면·가상 USB 연동 21개 시나리오, APK 빌드·v2/v3 서명·정렬 검사와 웹 자산 13개 일치를 확인했습니다. 실제 갤럭시·CH9329의 저장과 대상 PC 표시는 미검증입니다.

**이번 1.0.5는 같은 대화에서 배포한 1.0.4와 서명 인증서가 같아 업데이트 설치할 수 있습니다.** 다른 서명의 앱이나 1.0.3 이하 배포본은 [사용 안내](../README.md)를 확인하세요. [검증 결과](../VALIDATION.md)에 확인 범위를 기록합니다.

# 이전 1.0.4 배포 기록

- [HID-Desk-Android-1.0.4.apk](HID-Desk-Android-1.0.4.apk)
- Android 8.0 이상 / USB OTG / 최신 Android System WebView
- 패키지: `com.wnddud.hiddesk`, 버전 코드: `5`
- 파일 크기: `157,101`바이트
- SHA-256: `ffe10f3c662161ae8911476bee5facab0806b7f652c53650a96d28057221b4ff`
- 서명 인증서 SHA-256: `afe5b931e53e95ccdf677a3f4742bfdb62fd3a4072dd1c8388ee58901e5e21fe`

**장치 설정 → 제조사명 & 시리얼 번호**에서 CH9329의 USB 제조사명·시리얼 번호를 조회하고 저장할 수 있습니다. 사용자 지정 값을 켜거나 기본값으로 되돌릴 수 있으며 저장 후 양쪽 USB의 전원을 다시 연결합니다. 기존 빠른 입력·변경분 전송 기능을 포함합니다.

JS 테스트 56개, 앱 화면·가상 USB 연동 20개 시나리오, Java 네이티브 검사, APK 빌드·서명·정렬 검사를 통과했습니다. 실제 갤럭시와 CH9329 장치에서의 저장·USB 인식은 미검증입니다.

**새 개발 서명은 기존 1.0.3과 다릅니다. 기존 앱의 프리셋을 JSON으로 내보낸 뒤 기존 앱을 삭제하고 1.0.4를 설치하세요.** 자세한 절차와 검증 한도는 [사용 안내](../README.md)와 [검증 결과](../VALIDATION.md)를 확인하세요.

# 이전 1.0.3 배포 기록

- [HID-Desk-Android-1.0.3.apk](HID-Desk-Android-1.0.3.apk)
- Android 8.0 이상 / USB OTG / 최신 Android System WebView
- 패키지: `com.wnddud.hiddesk`, 버전 코드: `4`
- 파일 크기: `153,005`바이트
- SHA-256: `a730e29b8fef7a4e8c9bccc83bbe024884bdf1522bc2359e67498f13b62d3ea3`
- 서명 인증서 SHA-256: `264ab7c0a5b6cfcb371ea433a256b1322eab012f2662a1cf6caf188b715ee7f6`

빠른 입력을 네이티브에서 최대 32개 명령씩 처리하고 각 응답을 확인합니다. 매 읽기·쓰기의 USB 상태 조회를 제거했으며 기존 UTF-8 변경분 전송을 포함합니다. 빌드·서명·자동 검증을 통과했고 실제 갤럭시의 USB 입력 속도는 미측정입니다.

**1.0.3의 개발 서명은 기존 1.0.1·1.0.2와 다릅니다. 기존 앱에서 프리셋을 JSON으로 내보낸 뒤 기존 앱을 삭제하고 설치하세요.** [사용 안내](../README.md)와 [검증 결과](../VALIDATION.md)를 확인하세요.

## 이전 1.0.2 배포 기록

- [HID-Desk-Android-1.0.2.apk](HID-Desk-Android-1.0.2.apk)
- Android 8.0 이상 / USB OTG / 최신 Android System WebView
- 패키지: `com.wnddud.hiddesk`, 버전 코드: `3`
- 파일 크기: `148,909`바이트
- SHA-256: `32e6340238211a8139fcc8403fd5937a52c0b7c87e9ebbbaec409caec65d73b7`
- 서명 인증서 SHA-256: `b3ebf20d54db1513c8fd0eea128afd9891ac0b39e1dec6474f5b77a697d7d3b7`

현재 웹 버전의 UTF-8 변경분 전송과 새 디코더를 포함합니다. 빌드·서명·자동 검증을 통과했으며 실제 갤럭시 USB 통신은 미검증입니다.

**이번 1.0.2는 기존 배포 APK와 다른 로컬 개발 키로 서명했습니다. 기존 1.0.1 위에 업데이트 설치할 수 없습니다. 기존 앱의 프리셋을 JSON으로 내보내고 기존 앱을 삭제한 뒤 설치하세요.** 사용법은 [프로젝트 README](../README.md)를 확인하세요.

이전 배포 [1.0.1 APK](HID-Desk-Android-1.0.1.apk)는 그대로 보관합니다. 이전 파일의 SHA-256은 `184473c618c4fdf9a3895a1edf2e190f6a10b6e17560618bdd3398c8aefcd8bf`, 서명 인증서 SHA-256은 `54c5f534dcc12a1c860aeb9239a0382194f5125c4cfbebf6fcb9a8cc6fe2fb7e`입니다.
