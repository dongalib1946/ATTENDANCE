# 근로학생 출퇴근 QR 기록 앱

GitHub Pages 정적 HTML과 Google Sheets Apps Script로 동작하는 출퇴근 기록 앱입니다.

이전 Netlify Functions 방식도 호환됩니다. `config.js`의 `appsScriptUrl`이 비어 있으면 브라우저는 기존 `/.netlify/functions/attendance` 경로를 사용하고, Apps Script URL을 넣으면 GitHub Pages에서 직접 Apps Script를 호출합니다.

## 구조

```text
학생/모니터 브라우저
  -> GitHub Pages 정적 파일
  -> Google Apps Script
  -> Google Sheet
```

브라우저에는 Apps Script URL만 노출됩니다. QR 비밀키와 관리자 PIN은 Apps Script 스크립트 속성에만 저장합니다.

## 파일

- `index.html`: 학생이 QR을 스캔했을 때 열리는 출퇴근 입력 화면
- `display.html`: 모니터에 띄워둘 QR 화면
- `admin.html`: 관리자 PIN 인증 후 QR 교체 주기 설정
- `config.js`: GitHub Pages에서 호출할 Apps Script 웹 앱 URL 설정
- `netlify/functions/attendance.js`: QR 발급, QR 토큰 검증, Apps Script 프록시
- `apps-script/Code.gs`: Google Sheet 명부/시간표 조회, 출퇴근 기록, QR 주기 설정 저장

## Apps Script 설정

1. Google Sheet에서 `확장 프로그램 > Apps Script`를 엽니다.
2. `apps-script/Code.gs` 내용을 붙여 넣습니다.
3. `프로젝트 설정 > 스크립트 속성`에 아래 값을 추가합니다.

```text
ATTENDANCE_QR_SECRET=QR 서명용 긴 임의 문자열
ATTENDANCE_DISPLAY_PIN=관리자 페이지 접속 PIN
ATTENDANCE_TIMEZONE=Asia/Seoul
ATTENDANCE_QR_REFRESH_TIMES=08:30,10:30,12:30,14:30,16:30
ATTENDANCE_QR_GRACE_MINUTES=3
ATTENDANCE_SITE_URL=https://내-github-id.github.io/내-repository
```

`ATTENDANCE_ADMIN_PIN`을 새로 만들 필요는 없습니다. 기존 `ATTENDANCE_DISPLAY_PIN`을 관리자 PIN으로 계속 읽습니다.

4. `setupSpreadsheet` 함수를 한 번 실행합니다.
   - `출퇴근기록`, `학생명부`, `시간표` 시트가 없으면 자동으로 만들어집니다.
5. `배포 > 새 배포 > 웹 앱`을 선택합니다.
6. 실행 권한은 `나`, 액세스 권한은 `모든 사용자`로 설정하고 배포합니다.
7. 발급된 웹 앱 URL을 `config.js`의 `appsScriptUrl`에 넣습니다.

Netlify 방식을 함께 유지하려면 Apps Script 스크립트 속성에 기존 `ATTENDANCE_PROXY_SECRET`도 그대로 두고, 같은 값을 Netlify 환경변수에 넣으세요.

## GitHub Pages 배포

1. GitHub에 새 repository를 만들고 이 폴더의 파일을 올립니다.
2. `config.js`를 열어 Apps Script 웹 앱 URL을 넣습니다.

```js
window.ATTENDANCE_CONFIG = {
  appsScriptUrl: "https://script.google.com/macros/s/.../exec"
};
```

3. repository의 `Settings > Pages`에서 배포 소스를 선택합니다.
   - 간단한 방식: `Deploy from a branch`
   - Branch: `main`
   - Folder: `/root`
4. 배포된 주소를 Apps Script 스크립트 속성 `ATTENDANCE_SITE_URL`에 저장합니다.
5. Apps Script를 새 배포로 갱신합니다.

GitHub Pages 주소가 `https://내-github-id.github.io/attendance`라면 모니터에는 `https://내-github-id.github.io/attendance/display.html`을 띄웁니다.

기존 `ATTENDANCE_SITE_URL`이 Netlify 주소여도 GitHub Pages 화면에서는 현재 접속 중인 GitHub Pages 주소를 우선 사용합니다. 그래도 관리와 확인이 헷갈리지 않도록 완전 이전 후에는 `ATTENDANCE_SITE_URL`을 GitHub Pages 주소로 바꾸는 것을 권장합니다.

## Netlify 호환 환경변수

Netlify Functions 방식을 계속 사용할 때만 필요합니다.

필수:

```text
GOOGLE_APPS_SCRIPT_URL=https://script.google.com/macros/s/.../exec
ATTENDANCE_PROXY_SECRET=Apps Script 스크립트 속성과 같은 값
ATTENDANCE_QR_SECRET=QR 서명용 긴 임의 문자열
ATTENDANCE_DISPLAY_PIN=관리자 페이지 접속 PIN
```

선택:

```text
ATTENDANCE_SITE_URL=https://내-netlify주소.netlify.app
ATTENDANCE_TIMEZONE=Asia/Seoul
ATTENDANCE_QR_REFRESH_TIMES=08:30,10:30,12:30,14:30,16:30
ATTENDANCE_QR_GRACE_MINUTES=3
ATTENDANCE_APPS_SCRIPT_TIMEOUT_MS=8000
```

`ATTENDANCE_ADMIN_PIN`도 지원하지만 필수는 아닙니다. 기존 `ATTENDANCE_DISPLAY_PIN`을 그대로 사용할 수 있습니다.

`ATTENDANCE_APPS_SCRIPT_TIMEOUT_MS`는 Netlify Function이 Apps Script 응답을 기다리는 최대 시간입니다. 기본값은 8000ms이며, 네트워크가 자주 느린 환경이면 10000~12000 정도로 늘릴 수 있습니다.

## 연결 안정성

- 브라우저 요청은 timeout 후 자동 재시도하며, 실패 시 로딩을 멈추고 안내 메시지를 표시합니다.
- GitHub Pages 모드에서는 QR 발급, QR 검증, 명부, 기록 저장을 Apps Script가 직접 처리합니다.
- Netlify 호환 모드에서는 명부를 Netlify에서 5분간 캐시하고, Apps Script가 잠시 불안정하면 최근 명부를 임시로 사용합니다.
- Apps Script도 학생명부를 5분간 캐시합니다. 명부를 즉시 갱신해야 하면 Apps Script 편집기에서 `clearRosterCache` 함수를 한 번 실행하세요.

## QR 교체 주기

`https://내-github-pages주소/admin.html`에서 관리자 PIN으로 인증한 뒤 선택합니다.

- 30분마다
- 1시간마다
- 3시간마다
- 6시간마다

기존 `ATTENDANCE_QR_REFRESH_TIMES`가 설정되어 있으면 위 interval보다 고정 시각 목록이 우선됩니다. 예를 들어 `08:30,10:30,12:30,14:30,16:30`이면 해당 시각마다 QR이 바뀝니다.

## 디스플레이 시간표

모니터용 `display.html`은 QR 코드와 함께 오늘 요일의 상호대차 담당 학생을 표시합니다. 시간표는 Google Sheet의 `시간표` 시트에서 읽으며, 월요일부터 금요일까지 각 요일별 1타임, 2타임, 3타임 담당자를 관리합니다.

`시간표` 시트 형식:

```text
요일 | 1타임 | 2타임 | 3타임 | 비고 | 사용여부
월   | 홍길동 | 김학생 | 이근로 |      | Y
화   |        |        |        |      | Y
수   |        |        |        |      | Y
목   |        |        |        |      | Y
금   |        |        |        |      | Y
```

- `1타임`, `2타임`, `3타임` 칸에 해당 요일의 상호대차 담당 학생명을 입력합니다.
- 디스플레이에는 오늘 요일의 3타임 담당자만 표시됩니다.
- `사용여부`가 `N`이면 해당 요일은 비활성 안내로 표시됩니다.
- Apps Script는 시간표를 60초간 캐시합니다. 즉시 반영해야 하면 Apps Script 편집기에서 `clearScheduleCache` 함수를 한 번 실행하세요.

## 사용

- 모니터에는 `https://내-github-pages주소/display.html`을 띄웁니다.
- 디스플레이 화면 오른쪽 위의 작은 `관리자` 버튼으로 관리자 페이지에 들어갈 수 있습니다.
- 학생은 QR을 스캔한 뒤 `4층` 또는 `5층`, 이름, 출근/퇴근을 선택합니다.
