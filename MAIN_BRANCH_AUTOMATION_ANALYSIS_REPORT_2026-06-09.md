# main 브랜치 자동 실행 구조 및 최신성 패치 반영 분석 보고서

작성일: 2026-06-09 KST
대상 브랜치: `origin/main`
작업 방식: 기본 브랜치 변경 없이 `origin/main` 최신 코드 위에 필요한 기능만 이식

## 1. 결론

이 앱은 사용자가 말한 것처럼 GitHub에서 자동 실행되도록 설계된 앱이 맞다.
다만 서버에 상시 떠 있는 데몬 프로세스가 아니라, GitHub Actions 스케줄러가 정해진 시간에
`python main.py collect`, `python main.py summarize`, `python main.py send`를 각각 실행하는 구조다.

GitHub Actions의 `schedule` 이벤트는 기본 브랜치의 워크플로만 자동 실행하므로,
기본 브랜치를 바꾸는 대신 `origin/main` 위에 필요한 패치만 반영하는 방식이 가장 안전하다.

## 2. 현재 main 자동 실행 구조

`origin/main`에는 다음 워크플로가 존재한다.

| 파일 | 역할 | 실행 명령 | 스케줄 |
| --- | --- | --- | --- |
| `.github/workflows/daily_01_collect.yml` | 뉴스 수집 | `python main.py collect` | 20:50 UTC = 05:50 KST |
| `.github/workflows/daily_02_summarize.yml` | AI 요약 | `python main.py summarize` | 21:00 UTC = 06:00 KST |
| `.github/workflows/daily_03_send.yml` | 메일 발송 | `python main.py send` | 21:45 UTC = 06:45 KST |
| `.github/workflows/daily_briefing.yml` | 레거시 단일 실행 | `python main.py all` | 수동 실행 전용 |

`daily_briefing.yml`은 schedule이 제거되어 있고 `workflow_dispatch`만 남아 있으므로,
평상시 자동 발송은 3단계 워크플로가 담당한다.

## 3. main에 반영한 핵심 수정

archive 브랜치 전체를 main에 덮어쓰지 않고, 아래 기능만 선별 반영했다.

1. 최신성 필터 모듈 추가
   - `briefing/collectors/freshness.py`
   - 기본 72시간 기준으로 `today`, `recent`, `stale`, `undated` 상태를 계산한다.
   - 제목/요약에 현재 연도보다 오래된 연도 신호가 있으면 후보에서 제외할 수 있다.

2. collect 단계 최신성 필터 강화
   - RSS/Google News entry의 `published`, `updated`, `published_parsed` 등을 파싱한다.
   - 오래된 기사와 과거 연도 신호가 강한 기사를 수집 단계에서 제외한다.
   - Google News 검색에 기본 `when:2d`를 붙여 최근 기사 위주로 수집한다.

3. summarize 단계 재검증
   - 수집 단계에서 통과한 기사라도 요약 직전에 최신성 필터를 한 번 더 적용한다.
   - 랭킹 프롬프트에 `topic`, `freshness`, `published_at`, `age_hours`를 포함한다.
   - AI가 2024년/2025년 과거 사건을 최신 이슈처럼 요약하지 않도록 명시했다.

4. 미국 소스 확장
   - v2.9의 반도체/원자력 구조는 유지했다.
   - 추가로 Physical AI, 로보틱스, 공식 원전 기관, ETF 관련 소스를 보강했다.
   - 예: NVIDIA Newsroom, The Robot Report, IEEE Spectrum Robotics, U.S. EIA, U.S. NRC, World Nuclear News, ARK Invest, WisdomTree.

5. 관리자 UI/소스 메타데이터
   - source schema에 `topic`을 추가했다.
   - 소스 카드에 topic 배지를 표시한다.
   - 기본 소스/프리셋에 Physical AI, Nuclear/SMR, AI Power 관련 검색어를 추가했다.

## 4. 필요한 GitHub Secrets

자동 실행이 정상 동작하려면 GitHub 저장소의 Actions secrets에 아래 값이 있어야 한다.

| Secret | 사용 단계 | 용도 |
| --- | --- | --- |
| `BRIEFING_ADMIN_API` | collect/summarize/send | Cloudflare Pages 관리자 API URL |
| `BRIEFING_READ_TOKEN` | collect/summarize/send | API 읽기 인증 |
| `BRIEFING_REPORT_TOKEN` | collect/summarize/send | 수집/요약/발송 결과 저장 인증 |
| `GEMINI_API_KEY` | summarize | Gemini 요약 |
| `OPENAI_API_KEY` | summarize | Gemini 실패 시 OpenAI 호환 fallback |
| `OPENAI_BASE_URL` | summarize | OpenAI 호환 API 사용 시 |
| `OPENAI_MODEL` | summarize | OpenAI 호환 모델명 |
| `EMAIL_SENDER` | send | Gmail 발신자 |
| `EMAIL_APP_PASSWORD` | send | Gmail 앱 비밀번호 |
| `EMAIL_RECIPIENTS` | send | 수신자 fallback |

선택 값:

| Secret | 기본값 | 설명 |
| --- | --- | --- |
| `ARTICLE_SCRAPE_ENABLED` | `true` | 기사 본문 스크래핑 사용 여부 |
| `SUMMARY_MODE` | `sequential` | 요약 호출 방식 |
| `SUMMARY_CALL_DELAY_SEC` | `3` | 요약 호출 간격 |
| `ARTICLE_MAX_AGE_HOURS` | `72` | 최신 기사 허용 시간 |
| `ARTICLE_ALLOW_UNDATED` | `true` | 날짜 없는 기사 허용 여부 |
| `GOOGLE_NEWS_RECENT_WINDOW` | `2d` | Google News 최근 검색 창 |

## 5. 남은 주의점

1. GitHub Actions 자동 실행은 기본 브랜치에서만 보장된다.
   - 이번 작업은 `origin/main` 기반으로 반영하므로 이 조건을 만족한다.

2. 날짜 없는 기사 처리
   - 기본값은 `ARTICLE_ALLOW_UNDATED=true`다.
   - 과거 데이터가 계속 섞이면 GitHub Secret 또는 환경변수에서 `ARTICLE_ALLOW_UNDATED=false`로 강화하는 것이 좋다.

3. 소스 수 증가에 따른 수집량
   - 미국 확장 소스가 늘어났으므로 수집 후보가 증가한다.
   - v2.9의 15건 요약/쿼터 구조는 유지되어 최종 출력은 통제된다.

4. Cloudflare API와 KV 토큰
   - collect/summarize/send는 중간 결과를 Cloudflare KV에 쓰고 읽는다.
   - 토큰이 틀리면 GitHub Actions는 실행되더라도 단계 간 데이터 전달이 실패한다.

## 6. 검증 계획

반영 후 아래 검증을 수행한다.

- Python AST 문법 검사
- `npm run build`
- `git diff --check`
- GitHub Actions 워크플로 파일 존재 확인
- 충돌 마커 제거 확인

## 7. 운영 권장 순서

1. main에 커밋/푸시한다.
2. GitHub Actions 탭에서 `daily_01_collect.yml`을 수동 실행해 수집 결과가 KV에 저장되는지 확인한다.
3. `daily_02_summarize.yml`을 수동 실행해 요약이 생성되는지 확인한다.
4. `daily_03_send.yml`은 먼저 `dry_run=true`로 실행해 HTML preview를 확인한다.
5. 문제가 없으면 다음날 자동 스케줄을 관찰한다.

## 8. 터미널에서 수동 트리거하는 방법

`/api/admin/trigger-now`는 PowerShell 명령어가 아니라 웹 API 경로다.
따라서 터미널에서 직접 `/api/admin/trigger-now`를 입력하면 `CommandNotFoundException`이 발생한다.

터미널에서 수동 실행하려면 다음 helper 스크립트를 사용한다.

```powershell
cd "E:\2026_06_08_(주식알리미)\webapp"
.\tools\trigger-now.ps1 -Stage collect
.\tools\trigger-now.ps1 -Stage summarize
.\tools\trigger-now.ps1 -Stage send -DryRun
```

브라우저 관리자 화면과 동일하게 `ADMIN_PASSWORD`로 로그인한 뒤
`POST /api/admin/trigger-now`를 호출한다.
