# 🌅 Morning Stock AI — Briefing Center

> **매일 아침 8시(KST)**, 주식·반도체 뉴스를 AI가 엄선·한국어 요약해 내 Gmail로 배달하는 **개인 브리핑 자동화 시스템**.
> 추가로, 새로운 뉴스지/애널리스트 RSS/YouTube 채널을 **웹 관리 콘솔**에서 자유롭게 등록할 수 있습니다.

---

## 🎯 빠른 시작: **👉 [SETUP_GUIDE.md](./SETUP_GUIDE.md) 를 먼저 읽으세요!**

> 내일 아침 08:00 부터 `koist.kr@gmail.com` 으로 브리핑을 받기 위한
> **단계별 체크리스트**(약 10분)가 정리되어 있습니다.

---

## ✨ 주요 구성요소

이 프로젝트는 **두 개의 앱**이 함께 움직입니다:

| # | 구성요소 | 스택 | 역할 |
|:--:|---|---|---|
| ① | **Python 브리핑 파이프라인** | Python 3.11 + GitHub Actions | 매일 아침 8시 자동 실행 → 수집 · Gemini 요약 · Gmail 발송 |
| ② | **관리자 웹 콘솔** | Hono · Cloudflare Pages · KV | 새 뉴스지/애널리스트 소스를 추가/삭제 · 로그인 보호 |

```
   ┌──────────────────────────────────────────────┐
   │  ② 관리자 웹 콘솔 (Cloudflare Pages + KV)       │
   │     https://morning-stock-briefing.pages.dev │
   │       · 로그인(비밀번호)                        │
   │       · RSS/YouTube/애널리스트 URL 추가        │
   │       · URL 자동 판별 + 즉석 테스트             │
   └───────────────────┬──────────────────────────┘
                       │  GET /api/public/sources (Bearer)
                       ▼
   ┌──────────────────────────────────────────────┐
   │  ① Python 파이프라인 (GitHub Actions)           │
   │     - 한국 3사 + 미국 5개 매체 + 디일렉YT        │
   │     - 사용자 등록 소스 추가 수집                │
   │     - Gemini 2.5 Flash 10개 엄선 + 한국어 번역  │
   │     - Gmail SMTP 발송 → koist.kr@gmail.com    │
   └──────────────────────────────────────────────┘
```

---

## ✅ 현재 구현된 기능

### ① Python 파이프라인

| 단계 | 모듈 | 설명 |
|:---:|---|---|
| 수집 | `briefing/collectors/korean_news.py` | 한국경제·매일경제·머니투데이 (증권/IT) — 공식 RSS 차단 시 **Google News RSS 우회(Fallback)** |
| 수집 | `briefing/collectors/us_news.py` | Seeking Alpha · ETF.com · Morningstar · Reuters · Bloomberg (Google News `site:` 우회) |
| 수집 | `briefing/collectors/youtube_news.py` | 디일렉(THEELEC) 유튜브 — YouTube Data API v3 → RSS Fallback |
| 수집 | `briefing/collectors/custom_sources.py` | **관리 콘솔에 등록한 사용자 소스**를 HTTP 로 로드해 타입별 분기 수집 |
| 수집 | `briefing/collectors/aggregator.py` | 위 4개 모듈을 `collect_all_data()` 하나로 통합 (예외 방어) |
| 포맷 | `briefing/modules/formatter.py` | 수집 dict → Gemini 프롬프트 텍스트 |
| 요약 | `briefing/modules/ai_summarizer.py` | **Gemini 2.5 Flash** — 핵심 10개 + 해외 뉴스 한국어 번역 |
| 발송 | `briefing/modules/email_sender.py` | Markdown → 브랜드 HTML → Gmail SMTP |
| 자동화 | `.github/workflows/daily_briefing.yml` | 매일 **KST 08:00** 실행 + 수동 dry_run |

### ② Hono 웹 관리 콘솔

| 기능 | 엔드포인트 | 설명 |
|---|---|---|
| 로그인 화면 | `GET /login` | 비밀번호 단일 인증 |
| 로그인 처리 | `POST /login` | `ADMIN_PASSWORD` 비교 후 HTTPOnly 세션 쿠키 |
| 로그아웃 | `POST /logout` | 세션 쿠키 파기 |
| 대시보드 | `GET /` | 소스 목록 + 추가 폼 (로그인 필요) |
| 소스 조회 | `GET /api/admin/sources` | 관리자용 (세션 필요) |
| 소스 추가 | `POST /api/admin/sources` | URL 자동 판별 (RSS/YouTube/GoogleNews/Web) |
| 소스 활성·라벨 수정 | `PATCH /api/admin/sources/:id` | 토글 |
| 소스 삭제 | `DELETE /api/admin/sources/:id` | |
| 즉석 테스트 | `POST /api/admin/test-source` | URL 을 실제 fetch → 제목 샘플 미리보기 |
| **수집기 연동** | `GET /api/public/sources` | **Python 수집기가 호출** — Bearer 토큰 보호 |
| 헬스체크 | `GET /api/health` | 상태 확인 |

**관리 콘솔 기능 하이라이트**
- 🔐 로그인 1회 후 12시간 세션 유지
- 🧠 URL 붙여넣기만 해도 **RSS/YouTube/GoogleNews/웹 자동 판별**
- 🧪 **추가 전 즉석 테스트** 버튼 — 실제 최근 제목 5건 미리보기
- 🎛️ 활성/비활성 토글, 삭제 한 번에
- 💾 Cloudflare KV 에 저장 → GitHub 푸시 불필요, 즉시 반영

---

## 🔑 필수 환경 변수 / Secrets

### Python 파이프라인 (GitHub Secrets)

| 이름 | 용도 | 필수 |
|---|---|:---:|
| `GEMINI_API_KEY` | Google AI Studio 발급 | ✅ |
| `EMAIL_SENDER` | 보내는 Gmail 주소 | ✅ |
| `EMAIL_APP_PASSWORD` | Gmail 앱 비밀번호 16자 | ✅ |
| `EMAIL_RECIPIENTS` | 받는 이메일 (기본값: `koist.kr@gmail.com`) | ⬜ |
| `YOUTUBE_API_KEY` | YouTube Data API v3 | ⬜ |
| `THELEC_YOUTUBE_CHANNEL_ID` | 디일렉 채널 ID 덮어쓰기 | ⬜ |
| `BRIEFING_ADMIN_API` | Hono 관리 콘솔 URL (예: `https://morning-stock-briefing.pages.dev`) | ⬜ |
| `BRIEFING_READ_TOKEN` | Hono 의 `BRIEFING_READ_TOKEN` 과 동일 값 | ⬜ |

### Hono 관리 콘솔 (Cloudflare Pages Secrets)

| 이름 | 용도 |
|---|---|
| `ADMIN_PASSWORD` | 관리자 로그인 비밀번호 |
| `BRIEFING_READ_TOKEN` | Python 이 `/api/public/sources` 호출 시 쓰는 Bearer 토큰 |

---

## 🚀 로컬 실행 가이드

### 1) Python 파이프라인 (로컬 DRY RUN)

```bash
cd /home/user/webapp
pip install -r requirements.txt

# 수집 계층만 테스트
python -m briefing.collectors.aggregator

# 메일 발송 없이 전체 테스트
DRY_RUN=true python main.py
```

### 2) Hono 관리 콘솔 (샌드박스 개발)

```bash
cd /home/user/webapp
npm install          # 이미 설치되어 있음
npm run build        # dist/_worker.js 생성
fuser -k 3000/tcp 2>/dev/null || true
pm2 start ecosystem.config.cjs
curl http://localhost:3000/api/health
# → http://localhost:3000/login 브라우저 접속
#    기본 비밀번호: admin1234
```

### 3) 두 앱 연동 테스트

```bash
# 관리 콘솔이 돌고 있는 상태에서:
BRIEFING_ADMIN_API=http://localhost:3000 \
BRIEFING_READ_TOKEN=dev-briefing-token \
DRY_RUN=true python main.py
# → 한국/미국/유튜브 + 관리 콘솔 등록 소스까지 모두 수집
```

---

## 📦 프로젝트 구조

```
webapp/
├── main.py                             # Python 파이프라인 진입점
├── briefing/
│   ├── collectors/
│   │   ├── korean_news.py              # 한국 3사
│   │   ├── us_news.py                  # 미국 매체
│   │   ├── youtube_news.py             # 디일렉 유튜브
│   │   ├── custom_sources.py           # ★ 관리 콘솔 연동
│   │   └── aggregator.py               # 통합
│   └── modules/
│       ├── formatter.py                # AI 입력 포맷
│       ├── ai_summarizer.py            # Gemini 2.5 Flash
│       └── email_sender.py             # Gmail SMTP
├── src/
│   ├── index.tsx                       # Hono 앱 (관리 콘솔 + API)
│   └── renderer.tsx                    # JSX 레이아웃
├── public/static/
│   ├── admin.js                        # 대시보드 프런트 스크립트
│   └── style.css                       # 커스텀 CSS
├── .github/workflows/daily_briefing.yml # 매일 08:00 KST
├── ecosystem.config.cjs                # PM2 (로컬 Hono 실행)
├── wrangler.jsonc                      # Cloudflare Pages 설정 + KV 바인딩
├── vite.config.ts                      # Hono Cloudflare Pages 빌드
├── package.json
├── requirements.txt
├── .env.example
└── README.md
```

---

## 🚢 프로덕션 배포 (요약)

### Hono 콘솔 → Cloudflare Pages

```bash
# 1. KV namespace 생성 (1회)
npx wrangler kv namespace create SOURCES_KV
# 출력된 id 를 wrangler.jsonc 에 반영

# 2. Secrets 설정
npx wrangler pages secret put ADMIN_PASSWORD       --project-name morning-stock-briefing
npx wrangler pages secret put BRIEFING_READ_TOKEN  --project-name morning-stock-briefing

# 3. 빌드 & 배포
npm run build
npx wrangler pages deploy dist --project-name morning-stock-briefing
```

### Python 파이프라인 → GitHub Actions

1. GitHub 저장소에 코드 푸시
2. `Settings → Secrets and variables → Actions` 에서 위 표의 Secrets 등록
3. 내일 아침 **KST 08:00** 부터 자동 발송 시작 (또는 `Run workflow` 버튼으로 수동 실행)

---

## 🧪 검증된 수집 결과 (샘플)

```
✅ 한국 뉴스 누적: 30건 (한경/매경/머투 × 증권·IT)
✅ 미국 뉴스 누적: 18건 (Seeking Alpha, ETF.com, Morningstar, Reuters, Bloomberg)
✅ 유튜브 누적: 5건 (디일렉)
✅ 사용자 등록 소스 누적: 3건 (예: 매경 IT)
✨ 중복 제거 후: 48~53건 / AI 입력 ~22,000 chars
```

---

## 🛡️ 에러 방어 설계

- 각 수집기는 **독립 try-except** → 한 곳 장애가 전체 파이프라인을 멈추지 않음
- 한국경제 RSS 403 차단 → **Google News 우회 자동 Fallback**
- 유튜브 UA 특이사항(브라우저 UA 거부) → **feedparser UA** 로 정상 수집
- 관리 콘솔이 꺼져 있어도(401/404 등) Python 은 경고 후 계속 진행

---

## 📋 사용 방법 (최종 사용자 시나리오)

1. 브라우저로 `https://morning-stock-briefing.pages.dev/login` 접속
2. 관리자 비밀번호 입력
3. 새 소스 추가:
   - **이름**: `박병창 애널리스트`
   - **URL**: `https://analyst.example.com/rss` 혹은 유튜브 채널 URL
4. 🧪 **테스트** 버튼으로 실제 수집 가능 여부 확인
5. ✅ **추가** 버튼 → 즉시 저장 (다음 날 아침 브리핑부터 반영)
6. 매일 08:00 KST, `koist.kr@gmail.com` 으로 브리핑 도착 ✉️

---

## 🚧 아직 구현되지 않은 기능 (Roadmap)

- [ ] `web` 타입 소스 본문 추출 (Readability/trafilatura)
- [ ] 한경 컨센서스 일일 리포트 크롤러
- [ ] 네이버 증권 ETF 수익률 상위/하위 JSON
- [ ] Slack/Telegram 복수 채널 발송
- [ ] 브리핑 히스토리 아카이브 (Cloudflare R2)
- [ ] 즐겨찾는 종목 코드 기반 맞춤 요약

---

## 📚 기술 스택

**Python 파이프라인**: `requests`, `feedparser`, `beautifulsoup4`, `google-generativeai`, `google-api-python-client`, `smtplib`, `email`

**웹 관리 콘솔**: `Hono`, `Cloudflare Pages`, `Cloudflare KV`, `Tailwind CSS (CDN)`, `Font Awesome (CDN)`, `Vite`, `Wrangler`

**자동화**: `GitHub Actions` · `PM2` (로컬)

---

## 📄 라이선스

개인 이용 목적의 요약 브리핑 시스템입니다. 각 매체의 저작권은 원저작자에게 있습니다.

_Last updated: 2026-04-21_
