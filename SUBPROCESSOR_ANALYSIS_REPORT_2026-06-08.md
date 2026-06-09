# 서브프로세서 구조 분석 보고서

작성일: 2026-06-08
대상 소스: `morning-stock-briefing` 압축 해제본, v2.7.0 기준
분석 범위: GitHub Actions, Python 실행 단계, Cloudflare/Hono API, 수집/요약/발송 모듈

## 1. 요약

이 프로젝트의 "서브프로세서"는 운영 관점에서 두 계층으로 구성된다.

1. GitHub Actions 기반 실행 서브프로세서
   - `daily_01_collect.yml`
   - `daily_02_summarize.yml`
   - `daily_03_send.yml`

2. Python 내부 처리 서브프로세서
   - `main.py collect`
   - `main.py summarize`
   - `main.py send`
   - 보조 모듈: 수집기, 본문 스크래퍼, AI 요약기, 이메일 발송기, 실행 리포터

핵심 설계 의도는 기존 단일 실행 파이프라인을 세 단계로 나누어 GitHub Actions 15분 제한, Gemini 무료 쿼터/RPM 제한, 중복 발송 문제를 줄이는 것이다. 각 단계는 Cloudflare KV를 중간 저장소로 사용해 독립적으로 재시도할 수 있게 설계되어 있다.

## 2. 전체 아키텍처

```text
GitHub Actions
  06:00 KST daily_01_collect.yml
    -> python main.py collect
    -> 뉴스 수집
    -> Cloudflare KV: pipeline:collected:YYYYMMDD

  06:10 KST daily_02_summarize.yml
    -> python main.py summarize
    -> KV에서 수집 결과 조회
    -> Gemini/OpenAI로 요약
    -> Cloudflare KV: pipeline:summary:YYYYMMDD

  06:25 KST daily_03_send.yml
    -> python main.py send
    -> KV에서 요약 결과 조회
    -> Gmail SMTP 발송
    -> Cloudflare KV: pipeline:state:YYYYMMDD

Cloudflare Pages / Hono Admin API
  -> 소스/수신자 관리
  -> 파이프라인 중간 결과 저장/조회
  -> GitHub workflow_dispatch 수동 실행
```

## 3. 서브프로세서별 역할

### 3.1 Stage 1: Collect

관련 파일:

- `.github/workflows/daily_01_collect.yml`
- `main.py`
- `briefing/collectors/aggregator.py`
- `briefing/collectors/custom_sources.py`
- `briefing/collectors/korean_news.py`
- `briefing/collectors/us_news.py`
- `briefing/collectors/article_scraper.py`
- `briefing/collectors/run_reporter.py`

실행 명령:

```bash
python main.py collect
```

주요 동작:

- Cloudflare Admin API에서 활성 뉴스 소스를 가져온다.
- Google News RSS, RSS, web 소스에서 뉴스를 수집한다.
- 한국 뉴스, 미국 반도체/ETF 뉴스, 사용자 정의 소스를 합산한다.
- 중복 링크를 제거한다.
- 수집 결과를 로컬 백업과 Cloudflare KV에 저장한다.

중간 저장:

- 로컬 백업: `/tmp/briefing_backup/collected_YYYYMMDD.json`
- KV 저장: `pipeline:collected:YYYYMMDD`
- 상태 저장: `pipeline:state:YYYYMMDD`

특징:

- AI API를 호출하지 않기 때문에 실패 위험과 비용이 낮다.
- 소스 조회 실패 시 한국 뉴스 fallback 수집 경로가 있다.
- `RunReporter`가 수집 진행 상황을 관리 UI에 보고하도록 설계되어 있다.

리스크:

- 외부 RSS/Google News 응답에 의존한다.
- 본문 스크래핑은 사이트별 차단, WAF, HTML 구조 변경에 취약하다.
- 수집 단계가 KV 업로드에 실패하면 다음 단계가 진행하기 어렵다. 로컬 백업은 GitHub Actions 실행 환경 안에만 남기 때문에 다음 워크플로에서 직접 접근할 수 없다.

### 3.2 Stage 2: Summarize

관련 파일:

- `.github/workflows/daily_02_summarize.yml`
- `main.py`
- `briefing/modules/formatter.py`
- `briefing/modules/ai_summarizer.py`

실행 명령:

```bash
python main.py summarize
```

주요 동작:

- Cloudflare KV의 `pipeline:collected:YYYYMMDD`에서 수집 결과를 읽는다.
- `formatter.py`로 AI 입력 텍스트를 구성한다.
- `ai_summarizer.py`가 Gemini/OpenAI 기반 요약 파이프라인을 실행한다.
- 최종 Markdown 브리핑을 KV와 로컬 백업에 저장한다.

AI 내부 처리 단계:

1. `rank_top_news`
   - 전체 후보 뉴스에서 핵심 10건을 선정한다.
   - 미국 4건, 한국 6건 비율을 강제하려는 프롬프트가 포함되어 있다.

2. `summarize_all_items_parallel`
   - 실제 기본값은 `SUMMARY_MODE=sequential`이다.
   - 각 기사 요약 호출 사이 기본 6초 대기를 둔다.
   - `SUMMARY_MODE=parallel`일 때만 `ThreadPoolExecutor` 기반 병렬 실행을 사용한다.

3. `generate_overview`
   - 10건 요약 결과를 기반으로 총평을 만든다.

4. `assemble_final_briefing`
   - 미국/한국 섹션을 나누어 최종 Markdown을 조립한다.

중간 저장:

- 로컬 백업: `/tmp/briefing_backup/summary_YYYYMMDD.md`
- KV 저장: `pipeline:summary:YYYYMMDD`
- 상태 저장: `pipeline:state:YYYYMMDD`

강점:

- Gemini 장애 시 OpenAI fallback 경로가 있다.
- 각 기사 요약 실패 시 규칙 기반 fallback Markdown을 만들어 전체 파이프라인이 완전히 멈추지 않도록 설계되어 있다.
- 순차 실행 기본값과 6초 딜레이로 Gemini RPM 제한을 회피하려는 의도가 명확하다.

리스크:

- 랭킹, 개별 요약, 총평까지 AI 호출 수가 많아 전체 실행 시간이 길다.
- `SUMMARY_MODE=parallel`을 켜면 무료 Gemini RPM 제한에 다시 걸릴 수 있다.
- 프롬프트가 매우 길고 강제 조건이 많아 모델 출력 실패 또는 JSON 파싱 실패 가능성이 있다.
- v2.7.0 기준 출력 포맷은 짧아졌지만, 한국어/이모지/특수문자 처리가 메일 HTML 변환에서 깨질 여지가 있다.

### 3.3 Stage 3: Send

관련 파일:

- `.github/workflows/daily_03_send.yml`
- `main.py`
- `briefing/modules/email_sender.py`

실행 명령:

```bash
python main.py send
```

주요 동작:

- KV에서 `pipeline:summary:YYYYMMDD`를 읽는다.
- 수신자 목록을 환경 변수와 Admin API에서 병합한다.
- Markdown을 HTML 이메일로 변환한다.
- Gmail SMTP SSL로 수신자별 개별 발송한다.
- 발송 결과를 Admin API의 recipient event endpoint에 보고한다.

발송 방식:

- SMTP 서버: `smtp.gmail.com:465`
- 인증: `EMAIL_SENDER`, `EMAIL_APP_PASSWORD`
- 수신자: `EMAIL_RECIPIENTS` + `/api/public/recipients`
- 개별 To 헤더로 한 명씩 발송

강점:

- 수신자별 개별 발송으로 스팸/수신 거부 추적이 쉬워졌다.
- 모든 수신자가 거부된 경우에만 전체 실패로 처리한다.
- 일부 수신자가 거부되어도 다른 수신자 발송은 계속한다.
- DRY_RUN 모드에서 실제 발송 없이 HTML 미리보기를 생성할 수 있다.

리스크:

- Gmail 앱 비밀번호가 만료되거나 잘못되면 전체 발송이 실패한다.
- Admin API 수신자 조회 토큰이 불일치하면 환경 변수 수신자만 사용된다.
- HTML 변환기가 Markdown 구조에 강하게 의존하므로 AI 출력 포맷이 달라지면 카드 렌더링이 깨질 수 있다.

## 4. Cloudflare/Hono 관리 API 역할

관련 파일:

- `src/index.tsx`
- `public/static/admin.js`

주요 KV 키:

- `sources:v2`: 활성 뉴스 소스 목록
- `recipients:v1`: 수신자 목록
- `pipeline:collected:YYYYMMDD`: 수집 결과
- `pipeline:summary:YYYYMMDD`: 요약 Markdown
- `pipeline:state:YYYYMMDD`: 단계별 상태
- `runs:latest`, `runs:history`: 수집 실행 로그

주요 API:

- `GET /api/public/sources`
  - Python 수집기가 활성 소스 목록을 조회한다.

- `GET /api/public/recipients`
  - Python 이메일 모듈이 활성 수신자 이메일을 조회한다.

- `POST /api/public/pipeline/collected`
  - collect 단계가 수집 결과를 저장한다.

- `GET /api/public/pipeline/collected`
  - summarize 단계가 수집 결과를 읽는다.

- `POST /api/public/pipeline/summary`
  - summarize 단계가 AI 요약 결과를 저장한다.

- `GET /api/public/pipeline/summary`
  - send 단계가 요약 결과를 읽는다.

- `POST /api/public/pipeline/send`
  - send 단계가 발송 상태를 저장한다.

- `GET /api/admin/pipeline-state`
  - 관리자 화면이 단계별 상태를 조회한다.

- `POST /api/admin/trigger-now`
  - 관리자 화면에서 GitHub Actions workflow_dispatch를 호출한다.

인증 구조:

- 저장 API는 `BRIEFING_REPORT_TOKEN`으로 보호한다.
- 조회 API는 `BRIEFING_READ_TOKEN`으로 보호한다.
- 관리자 수동 실행은 Cloudflare 세션과 GitHub PAT 계열 환경 변수를 사용한다.

## 5. GitHub Actions 서브프로세서 분석

### daily_01_collect.yml

- 스케줄: 매일 21:00 UTC, 한국시간 06:00
- 타임아웃: 12분
- 실행: `python main.py collect`
- artifact: collect 백업 JSON

### daily_02_summarize.yml

- 스케줄: 매일 21:10 UTC, 한국시간 06:10
- 타임아웃: 14분
- 실행: `python main.py summarize`
- artifact: summary 백업 Markdown
- v2.7.0에서 `workflow_run` 트리거 제거 주석이 있음

### daily_03_send.yml

- 스케줄: 매일 21:25 UTC, 한국시간 06:25
- 타임아웃: 10분
- 실행: `python main.py send`
- 수동 실행 시 `dry_run` 입력 가능
- v2.7.0에서 `workflow_run` 트리거 제거 주석이 있음

분석:

- 세 단계의 시간 간격은 collect 10분, summarize 15분 여유를 준다.
- `workflow_run` 제거는 중복 실행/중복 발송 방지에 타당하다.
- 각 워크플로가 서로 직접 artifact를 공유하지 않고 Cloudflare KV를 매개로 연결된다.

## 6. 데이터 흐름

```text
Admin UI
  -> sources:v2 / recipients:v1 관리

Collect
  -> /api/public/sources 조회
  -> RSS/Google News/Web 수집
  -> article_scraper로 본문 보강
  -> /api/public/pipeline/collected 저장

Summarize
  -> /api/public/pipeline/collected 조회
  -> rank_top_news
  -> summarize_one_item
  -> generate_overview
  -> assemble_final_briefing
  -> /api/public/pipeline/summary 저장

Send
  -> /api/public/pipeline/summary 조회
  -> /api/public/recipients 조회
  -> build_html_email
  -> Gmail SMTP 발송
  -> /api/public/recipient-events 보고
  -> /api/public/pipeline/send 저장
```

## 7. 현재 구조의 장점

- 단계별 분리로 실패 지점을 좁히기 쉽다.
- collect 단계는 AI 호출이 없어 반복 재시도가 부담이 적다.
- summarize 단계는 AI 쿼터 이슈를 독립적으로 조정할 수 있다.
- send 단계는 AI 호출 없이 발송만 담당하므로 재발송 제어가 가능하다.
- Cloudflare KV가 단계 간 중간 저장소 역할을 하므로 GitHub Actions 실행 시간이 분리된다.
- 관리자 UI에서 상태 조회와 수동 재실행을 지원한다.

## 8. 주요 문제 및 위험

### 8.1 원격 main과 압축본 버전 차이

현재 GitHub 원격 `main`은 v2.9 계열까지 진행되어 있고, 압축본은 v2.7.0 기준이다. 이 압축본을 main에 그대로 덮으면 최신 개선 사항이 사라질 수 있다.

권장:

- 압축본 분석/복구는 `archive-v2.7.0-2026-04-24` 브랜치에서 유지한다.
- 실제 수정은 원격 최신 `main`을 기준으로 별도 작업 브랜치를 만드는 것이 안전하다.

### 8.2 KV 의존성

세 단계가 모두 Cloudflare KV를 기준으로 연결된다. KV 저장 실패가 발생하면 다음 단계가 실패한다.

권장:

- stage별 artifact 다운로드 fallback을 추가하거나, 실패 시 관리자 UI에서 백업 artifact를 재주입하는 경로를 만든다.
- `pipeline:state`에 error 필드를 더 일관되게 기록한다. collect 실패는 현재 구조상 error 기록이 약하다.

### 8.3 GitHub Actions 중복 실행 방지

v2.7.0에서 `workflow_run` 제거는 올바른 방향이다. 다만 수동 실행과 예약 실행이 겹칠 경우 여전히 중복 발송 가능성이 있다.

권장:

- `concurrency` 그룹을 workflow별 또는 날짜별로 추가한다.
- send 단계에서 `pipeline:state.sentAt`이 이미 있으면 기본적으로 발송을 차단하는 idempotency check를 추가한다.

예시:

```yaml
concurrency:
  group: morning-stock-send-${{ github.ref }}
  cancel-in-progress: false
```

### 8.4 AI 호출 비용과 안정성

요약기는 랭킹, 10건 개별 요약, 총평으로 구성되어 호출 수가 많다. fallback은 잘 되어 있으나 실행 시간이 길고 모델 장애에 취약하다.

권장:

- `SUMMARY_MODE=sequential` 기본값 유지
- 호출별 성공/실패/모델명을 `pipeline:state.stats`에 저장
- Gemini와 OpenAI fallback 사용량을 별도 집계
- JSON 랭킹 파싱 실패 시 deterministic fallback 기준을 명확히 한다.

### 8.5 이메일 HTML 변환 취약성

이메일 렌더러는 AI가 특정 Markdown 구조를 유지한다는 전제에 의존한다.

권장:

- AI 출력 결과를 구조화 JSON으로 먼저 받고, Markdown/HTML은 코드에서 생성한다.
- 최소한 `build_html_email` 전에 Markdown 구조 검증 함수를 둔다.
- DRY_RUN HTML preview를 저장하고 관리자 UI에서 열람 가능하게 한다.

### 8.6 인코딩/문자 깨짐

일부 터미널 출력과 README에서 한글이 깨져 보인다. 파일 자체는 대체로 UTF-8로 보이나, Windows PowerShell 출력 코드페이지 또는 압축 해제 과정에서 파일명이 깨진 흔적이 있다.

권장:

- 모든 소스/문서 파일을 UTF-8로 통일한다.
- `.gitattributes`에 텍스트 파일 인코딩/줄바꿈 정책을 명시한다.
- 압축 해제보다 Git clone 기반 복원을 우선한다.

## 9. 개선 우선순위

### P0: 중복 발송 방지

- send 단계에 idempotency check 추가
- 이미 `sentAt`이 있는 날짜는 `FORCE_SEND=true`가 아닐 경우 발송 차단
- GitHub Actions에 concurrency 추가

### P1: 최신 main 기준 재정렬

- 압축본 브랜치와 원격 main 차이를 비교한다.
- v2.7.0의 유효한 개선점만 최신 main에 cherry-pick 또는 재구현한다.
- main을 압축본으로 강제 덮어쓰지 않는다.

### P1: 상태 기록 강화

- collect 실패도 `pipeline:state`에 실패 상태로 남긴다.
- 각 단계 시작/종료 시각, 입력 건수, 출력 글자 수, error를 표준 필드로 기록한다.

### P2: AI 출력 구조화

- 랭킹/개별 요약/총평을 JSON 스키마로 받고, 최종 Markdown/HTML은 코드에서 생성한다.
- 이 방식은 이메일 렌더링 안정성을 크게 높인다.

### P2: 운영 진단 UI 강화

- 관리자 UI에 오늘 날짜 기준 `collected`, `summary`, `send` 원문 확인 기능 추가
- API 토큰 불일치, 수신자 조회 실패, SMTP 실패를 카드형 진단으로 표시

## 10. 결론

이 소스의 서브프로세서 구조는 단순한 함수 분리가 아니라, GitHub Actions 실행 단위와 Python 내부 처리 단위를 함께 분리한 운영형 파이프라인이다. 설계 방향은 타당하다. 특히 collect, summarize, send를 분리하고 Cloudflare KV로 중간 결과를 저장하는 방식은 쿼터 제한과 재시도 문제를 해결하는 데 효과적이다.

다만 실제 운영 안정성을 높이려면 다음 세 가지가 가장 중요하다.

1. send 단계의 중복 발송 방지
2. 최신 원격 main과 압축본 v2.7.0의 버전 차이 정리
3. AI 출력과 이메일 HTML 변환의 구조화

따라서 웹 수정 작업을 시작한다면, 먼저 원격 최신 main을 기준으로 작업 브랜치를 만들고, 그 위에 "파이프라인 상태/재실행/중복 발송 방지" 기능을 개선하는 것이 가장 안전하다.
