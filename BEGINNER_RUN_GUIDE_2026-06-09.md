# 초보자용 실행 안내서

작성일: 2026-06-09

## 1. 실행 앱은 무엇인가?

이 프로젝트의 실제 운영 앱은 Cloudflare에 배포된 웹 관리자 화면이다.

```text
https://morning-stock-briefing.pages.dev/login
```

이 URL이 실제 앱이다. 브라우저에서 열고 `ADMIN_PASSWORD`로 로그인하면 된다.

## 2. 자동 실행은 누가 하는가?

매일 자동 실행은 GitHub Actions가 담당한다.

| 단계 | GitHub workflow | 실행 내용 |
| --- | --- | --- |
| 수집 | `daily_01_collect.yml` | `python main.py collect` |
| 요약 | `daily_02_summarize.yml` | `python main.py summarize` |
| 발송 | `daily_03_send.yml` | `python main.py send` |

따라서 컴퓨터에서 매일 프로그램을 켜 둘 필요는 없다.

## 3. 내가 클릭해야 하는 파일

초보자용 실행 메뉴를 추가했다.

```text
START_STOCK_ALERT.bat
```

이 파일을 더블클릭하면 메뉴가 열린다.

메뉴에서 할 수 있는 일:

1. 관리자 웹앱 열기
2. 수집 실행 요청
3. 요약 실행 요청
4. 발송 테스트 요청
5. 실제 발송 요청
6. 전체 실행 요청
7. Cloudflare에 웹앱 배포

## 4. 주의할 점

`/api/admin/trigger-now`는 PowerShell 명령어가 아니다.
웹 API 주소이므로 터미널에 그대로 입력하면 오류가 난다.

터미널에서 실행하려면 아래 중 하나를 사용한다.

```powershell
.\START_STOCK_ALERT.bat
```

또는:

```powershell
.\tools\trigger-now.ps1 -Stage collect
```

## 5. Cloudflare 배포까지 가능한가?

가능하다. 다만 Cloudflare 계정 로그인과 권한이 필요하다.
`START_STOCK_ALERT.bat` 메뉴에서 `7. Cloudflare에 웹앱 배포`를 선택하면:

```powershell
npm run build
npx wrangler pages deploy dist --project-name morning-stock-briefing
```

를 실행한다.

Cloudflare 로그인이 안 되어 있거나 권한이 없으면 배포 단계에서 로그인/권한 오류가 날 수 있다.

## 6. 가장 쉬운 사용 순서

1. `START_STOCK_ALERT.bat` 더블클릭
2. `1`번으로 관리자 웹앱 열기
3. 평소에는 자동 실행 상태만 확인
4. 수동으로 테스트하려면 `2`, `3`, `4` 순서로 실행
5. 실제 메일 발송은 충분히 확인한 뒤 `5`번 실행
