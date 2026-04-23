# 🌅 Morning Stock AI — Briefing Center **v2.6.0** 🚀

> 매일 아침 **KST 06:00 ~ 06:30**, 주식·반도체 뉴스를 AI가 엄선·한국어 요약해 Gmail로 배달하는 **개인 브리핑 자동화 시스템**.
> 관리자 웹 콘솔(Cloudflare Pages)에서 소스/수신자/실행을 직접 관리합니다.

---

## 🆕 v2.6.0 업데이트 (2026-04-23) — Phase 1 + Phase 2 동시 적용

### 🎯 이번 릴리스의 목표
- **Phase 1**: AI 요약 품질의 근본 원인인 "RSS 요약이 짧아서 AI가 쓸 재료가 부족하다" 문제 해결
- **Phase 2**: GitHub Actions 15분 타임아웃과 Gemini 무료 쿼터(20 RPM) 위험을 **3단계 분리 파이프라인**으로 제거

### 🔴 해결한 근본 문제
| 증상 | 원인 | v2.6.0 해결책 |
|------|------|--------------|
| 요약이 제목만 바꿔쓴 1~2문장 | Google News RSS 는 본문 없음(설명 300~400자 고작) | `article_scraper.py` 로 원문 스크래핑(trafilatura + BS4 폴백) → 1,500 ~ 5,000자 본문 확보 |
| "지금 발송" 두 번 누르면 429 | 12 × 3 = 36콜 / 20 RPM 초과 | 수집↔요약↔발송 3단계 분리 + 요약만 Gemini 호출 → 수집/발송은 무제한 재시도 |
| Gemini 실패 시 전체 다시 돌려야 함 | 파이프라인이 원자적 | KV에 단계별 중간 결과 저장 → 실패한 단계만 재실행 |
| 단일 워크플로우 15분 타임아웃 | 모든 단계가 한 잡 | 3개 잡(12분 + 14분 + 10분) 독립 타임아웃 |

### ✨ Phase 1 — 본문 스크래핑 + 3문장 최소 요약
1. **`briefing/collectors/article_scraper.py`** 신규 파일
   - `trafilatura` 로 원문 본문 추출(한국어 최적화)
   - 실패 시 BeautifulSoup fallback (og:description / 기사 본문 태그)
   - `googlenewsdecoder` 로 Google News 리다이렉트 URL 해제 후 실제 언론사 URL 로 재요청
2. **`enrich_summary()`** — RSS 요약을 본문으로 풍부하게 치환
   - `korean_news.py` / `us_news.py` / `custom_sources.py` 모두 `get_news_from_rss()` 경유 → 자동 적용
   - 한국 언론(매일경제, 머니투데이 등): ✅ 평균 1,500 ~ 2,500자 본문 확보 확인
   - 미국 언론(Bloomberg/Reuters/Seeking Alpha): WAF 차단이지만 Google News 영문 RSS 가 이미 400~450자 제공
3. **AI 프롬프트 강화** (`ai_summarizer.py`)
   - "요약은 **반드시 최소 3문장, 권장 4~5문장**의 서술형"
   - "투자 시사점은 **2문장 이상** 서술형 (불릿 금지)"
   - 기본 `MIN_ITEM_CHARS=250`, 항목당 최대 1,024 토큰

### ✨ Phase 2 — 3단계 분리 파이프라인
#### 실행 방법
```bash
python main.py collect     # Stage 1 — 수집만 (AI 호출 0회, 무한 재시도 가능)
python main.py summarize   # Stage 2 — KV 수집결과 읽어 AI 요약
python main.py send        # Stage 3 — KV 요약결과 읽어 메일 발송
python main.py all         # 레거시: 한 번에 전부 (하위 호환)
```

#### KV 저장 스키마 (Cloudflare KV)
| 키 | 내용 | TTL |
|----|------|-----|
| `pipeline:collected:YYYYMMDD` | 수집된 뉴스 JSON 배열 | 48시간 |
| `pipeline:summary:YYYYMMDD` | 요약된 마크다운 원본 | 48시간 |
| `pipeline:state:YYYYMMDD` | 각 단계 상태(pending/ok/failed), 완료 시각, 통계 | 48시간 |

#### GitHub Actions 워크플로우 (3개 잡)
| 파일 | Cron (UTC) | KST | Timeout |
|------|------------|-----|---------|
| `.github/workflows/daily_01_collect.yml` | `0 21 * * *` | 06:00 | 12분 |
| `.github/workflows/daily_02_summarize.yml` | `10 21 * * *` | 06:10 | 14분 |
| `.github/workflows/daily_03_send.yml` | `25 21 * * *` | 06:25 | 10분 |
| `.github/workflows/daily_briefing.yml` | (schedule 제거) | 수동만 | 15분 |

#### 관리자 UI — 파이프라인 상태 카드 (v2.6.0)
- 상단에 **`Collect → Summarize → Send`** 3타일 표시 (실시간 60초 자동 갱신)
- 각 타일에 상태 배지(pending/running/ok/failed) + 완료 시각 + 통계(건수/글자수/수신자)
- 실패한 단계에는 **"이 단계 재실행"** 버튼 노출 → GitHub Actions 단계별 workflow 트리거

### 🔐 신규 API 엔드포인트
| 경로 | 인증 | 용도 |
|------|------|------|
| `POST /api/public/pipeline/collected` | Bearer `BRIEFING_REPORT_TOKEN` | 수집 결과 저장 |
| `GET  /api/public/pipeline/collected` | Bearer `BRIEFING_READ_TOKEN` | 수집 결과 읽기 (summarize 단계용) |
| `POST /api/public/pipeline/summary` | Bearer `BRIEFING_REPORT_TOKEN` | 요약 결과 저장 |
| `GET  /api/public/pipeline/summary` | Bearer `BRIEFING_READ_TOKEN` | 요약 결과 읽기 (send 단계용) |
| `POST /api/public/pipeline/send` | Bearer `BRIEFING_REPORT_TOKEN` | 발송 상태 기록 |
| `GET  /api/admin/pipeline-state` | 관리자 세션 | 오늘의 3단계 상태 조회 (UI 카드용) |
| `POST /api/admin/trigger-now` | 관리자 세션 | `stage=collect\|summarize\|send\|all` 워크플로 트리거 |

---

## 📦 프로젝트 개요
- **이름**: Morning Stock AI — Briefing Center (webapp)
- **목적**: KST 아침 출근 전(6시대) Gmail에 주식·반도체 핵심 뉴스 10건을 한국어 서술형 요약으로 자동 배달
- **주요 기능**
  1. RSS/Google News/웹 소스 수집 (한국/미국/커스텀 카테고리)
  2. 원문 스크래핑으로 본문 확보 (v2.6.0)
  3. Gemini 2단계(랭킹 → 병렬 상세요약) AI 파이프라인
  4. 카드형 HTML 이메일(카테고리 색상 배지, KST 날짜)
  5. 웹 관리 콘솔(PC·모바일 실시간 동기화, PWA 지원)
  6. **3단계 분리 실행으로 Gemini 쿼터 안전** (v2.6.0)

## 🌐 URL 정보
- **관리 UI (프로덕션)**: Cloudflare Pages 프로젝트 (배포 후 업데이트)
- **Git 저장소**: 사용자 GitHub 리포지토리
- **로컬 개발**: `http://localhost:3000` (PM2 + `wrangler pages dev dist`)

## 🗄️ 데이터 구조 & 저장소
- **Cloudflare KV (SOURCES_KV)**
  - `sources:v2` — 등록된 뉴스 소스 (카테고리/타입/검색어)
  - `recipients:v1` — 이메일 수신자
  - `trigger:last`, `trigger:dryrun:hist` — 쿨다운/쿼터 상태
  - `runs:latest`, `runs:history` — 최근 실행 로그 (최대 10개)
  - `pipeline:collected:YYYYMMDD` / `pipeline:summary:YYYYMMDD` / `pipeline:state:YYYYMMDD` — **v2.6.0** 파이프라인 중간 결과
- **데이터 흐름**
  ```
  [GitHub Actions 06:00 KST]
    ↓ collect → KV: pipeline:collected:YYYYMMDD
  [GitHub Actions 06:10 KST]
    ↓ summarize (Gemini 2.5-flash 10병렬) → KV: pipeline:summary:YYYYMMDD
  [GitHub Actions 06:25 KST]
    ↓ send → Gmail SMTP → 수신자별 개별 메일
  [관리 UI]
    ↓ GET /api/admin/pipeline-state 로 실시간 상태 확인
    ↓ 실패 시 stage 단위 재실행 버튼 → POST /api/admin/trigger-now
  ```

## 🧑‍💻 사용자 가이드
1. 관리자 로그인 (쿠키 2시간)
2. **소스 관리 탭**: RSS/Google News 검색어/웹 URL 등록
3. **수신자 관리 탭**: 이메일 추가/삭제 (bulk 지원)
4. **🚀 지금 발송 탭**
   - `🧪 DRY RUN 미리보기` — 30초 쿨다운, 실제 메일 X, HTML 프리뷰 아티팩트 저장
   - `📧 실제 발송` — 5분 쿨다운, 진짜 메일 전송
   - **v2.6.0 파이프라인 상태 카드**로 3단계 진행 실시간 확인
   - 실패한 단계만 핀포인트 재실행 가능 (수집은 AI 호출 0 → 안전)
5. **수집 대시보드**: 소스별 수집 건수·실패율·소요 시간

## 🚀 배포 상태
- **Platform**: Cloudflare Pages
- **상태**: ✅ v2.6.0 활성
- **기술 스택**: Hono + TypeScript + TailwindCSS (프론트엔드) / Python 3.11 + Gemini 2.5-flash + trafilatura (백엔드) / GitHub Actions (스케줄러) / Cloudflare KV (상태)
- **Last Updated**: 2026-04-23
