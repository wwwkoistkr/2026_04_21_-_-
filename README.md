# 🌅 Morning Stock AI — Briefing Center **v2.5.0** 🎯📨✨

> **매일 아침 7시(KST)**, 주식·반도체 뉴스를 AI가 엄선·한국어 요약해 내 Gmail로 배달하는 **개인 브리핑 자동화 시스템**.
> 추가로, 새로운 뉴스지/애널리스트 RSS를 **웹 관리 콘솔**에서 자유롭게 등록할 수 있습니다.

## 🆕 v2.5.0 업데이트 (2026-04-23) — 2단계 AI 파이프라인 + 카드형 이메일

### 🔴 해결한 문제
- **증상**: 2026-04-23 아침 메일에 뉴스가 **1건만** 표시 (매우 초라함)
- **근본 원인**: Gemini 2.5-flash 가 27KB 입력에 대해 **282자만 응답** 했는데도 v2.4.0은 품질 검증 없이 그대로 발송
- **과거 접근**: 한 번의 호출로 "10개 모두 요약" → 토큰 한도/모델 과부하에 취약

### ✨ 새로운 2단계 아키텍처 (Option B)
1. **Step 1 — 랭킹**: 수집된 59건 뉴스 중 핵심 **정확히 10개** 선별 (JSON 출력, mini call)
2. **Step 2 — 병렬 상세 요약**: 10건을 **동시에** 각각 개별 호출 (ThreadPoolExecutor)
   - 각 호출 최대 1024토큰 → 절대 끊기지 않음
   - 개별 품질 검증 (최소 250자) + 실패 시 원본 폴백
3. **Step 3 — 총평 조립**: 카테고리 집계 + 시장 총평 생성

### 🎨 카드형 HTML 이메일
- 뉴스 1건 = 카드 1장 (둥근 모서리, 그림자, 색상 배지)
- 카테고리 색상: 🔴반도체 🟣AI 🟢미국증시 🔵한국증시 🟠거시 ⚫기타
- **요약 박스** (파랑) + **투자 시사점 박스** (노랑) 시각적 구분
- Footer: 실제 수집 소스 동적 추출, 디일렉(YouTube) 잔재 제거
- KST 날짜 보정 (GitHub Actions UTC → KST +9h)

### 📊 품질 지표 상향
- MIN_OUTPUT_CHARS: 1,800 → **3,500**
- MIN_NEWS_ITEMS: 7 → **10 (엄격)**
- 개별 항목 최소 **250자** 강제
- 모델 폴백: flash → flash-lite → 2.0-flash → 1.5-flash → OpenAI 호환 → 규칙기반

---

## 이전 v2.4.0 업데이트 (2026-04-22) — 수집 대시보드

- 📊 실시간 수집 진행 상황 + 소스별 상태 뱃지
- Python 수집기 → Cloudflare KV 리포터 훅
- DRY-RUN 10초 간격 폴링

## v2.2 업데이트 (2026-04-21) — 에러 수정 + 8K 고해상도 + PC↔모바일 실시간 동기화
- 🛡️ **에러 내성 강화**: 전역 에러 핸들러 (`window.onerror`, `unhandledrejection`) + null-safe 가드 + `safeFetch` 래퍼로 모든 API 오류가 사용자에게 토스트로 표시됨
- 🖼️ **8K 고해상도 아이콘 세트**: 16/32/48/64/72/96/128/144/152/167/180/192/256/384/512/1024/**2048**px + maskable 세트 → Retina/4K/8K 디스플레이에서도 선명
- 🔄 **PC ↔ 모바일 실시간 동기화** (새 기능!)
  - 같은 브라우저 탭 간: **BroadcastChannel** 즉시 반영
  - 서로 다른 기기 간: **`/api/admin/sync-version`** 15초 폴링 → 데이터 변경 시 자동 갱신
  - KV 기반 버전 카운터 (sources/recipients 변경시 +1)
  - 편집 모달 열려있을 땐 자동갱신 지연 (작업 보호)
- 📐 **해상도별 반응형 레이아웃**:
  - 1920px+: 소스 카드 2단 그리드
  - 2560px (QHD): 3단 그리드 + 폰트 크기 확대
  - 3840px (4K/8K): 4단 그리드 + 터치 영역 확대
  - Retina 대응: 0.5px 테두리, geometricPrecision 렌더링
- 🌗 **자동 테마 색상**: light/dark 모드에 따라 theme-color 전환
- 🖨️ **프린트 최적화**: PDF/인쇄 시 버튼/모달 자동 숨김

## v2.1 기능 (유지)
- 📱 **PWA 지원**: iOS/Android 홈 화면 설치 (🌅 아이콘, 오프라인 캐시)
- 🚀 **"지금 발송" 버튼**: GitHub Actions workflow_dispatch 즉시 실행
- 🧪 **DRY RUN 모드**: 메일 미발송 + artifact 미리보기
- ⏳ **10분 쿨다운** + 상태 폴링

## v2.0 기능 (유지)
- 🎯 **검색어 기반 정밀 수집**: 각 소스마다 최대 5개 검색어 지정 (`site:hankyung.com "반도체"` 형태)
- 📋 **프리셋 4종**: 🇰🇷 한국 증권 / 🇰🇷 한국 IT / 🌎 US Semi / 🌎 US ETF
- 🗂️ **카테고리 탭 UI**: 🇰🇷 한국 / 🌎 미국 / 📺 유튜브 / ➕ 사용자
- 🔌 **KV 중심 수집**: 모든 소스를 관리 콘솔에서 편집 (하드코딩 폴백은 안전망)
- 📈 **수집량 2.5배**: 48건 → **111건** (123건 수집 후 중복 제거)

→ 관리 UI (https://morning-stock-briefing.pages.dev) → ① 수신자 추가 → ② 소스 편집 → **🚀 지금 발송**

## 🚀 Live Deployment
- **관리 콘솔**: https://morning-stock-briefing.pages.dev
- **로그인**: 비밀번호 `admin1234`
- **기본 수신자**: `wwwkoistkr@gmail.com` (자동 등록됨)
- **스케줄**: 매일 **07:00 KST** 자동 발송 (GitHub Actions cron)

---

## 🎯 빠른 시작: **👉 [SETUP_GUIDE.md](./SETUP_GUIDE.md) 를 먼저 읽으세요!**

> 내일 아침 07:00 부터 `wwwkoistkr@gmail.com` 으로 브리핑을 받기 위한
> **단계별 체크리스트**(약 10분)가 정리되어 있습니다.

---

## ✨ 주요 구성요소

이 프로젝트는 **두 개의 앱**이 함께 움직입니다:

| # | 구성요소 | 스택 | 역할 |
|:--:|---|---|---|
| ① | **Python 브리핑 파이프라인** | Python 3.11 + GitHub Actions | 매일 아침 7시 자동 실행 → 수집 · Gemini 요약 · Gmail 발송 |
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
   │     - Gmail SMTP 발송 → wwwkoistkr@gmail.com    │
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
| 자동화 | `.github/workflows/daily_briefing.yml` | 매일 **KST 07:00** 실행 + 수동 dry_run |

### ② Hono 웹 관리 콘솔

| 기능 | 엔드포인트 | 설명 |
|---|---|---|
| 로그인 화면 | `GET /login` | 비밀번호 단일 인증 (기본: `admin1234`) |
| 로그인 처리 | `POST /login` | `ADMIN_PASSWORD` 비교 후 HTTPOnly 세션 쿠키 |
| 로그아웃 | `POST /logout` | 세션 쿠키 파기 |
| 대시보드 | `GET /` | 수신자·소스 관리 (로그인 필요) |
| **수신자 조회** | `GET /api/admin/recipients` | 브리핑 받을 이메일 목록 |
| **수신자 추가** | `POST /api/admin/recipients` | 이메일 + 별명 등록 |
| **수신자 토글/수정** | `PATCH /api/admin/recipients/:id` | 활성/비활성 |
| **수신자 삭제** | `DELETE /api/admin/recipients/:id` | |
| 소스 조회 | `GET /api/admin/sources` | 관리자용 (세션 필요) |
| 소스 추가 | `POST /api/admin/sources` | URL 자동 판별 (RSS/YouTube/GoogleNews/Web) |
| 소스 활성·라벨 수정 | `PATCH /api/admin/sources/:id` | 토글 |
| 소스 삭제 | `DELETE /api/admin/sources/:id` | |
| 즉석 테스트 | `POST /api/admin/test-source` | URL 을 실제 fetch → 제목 샘플 미리보기 |
| **소스 연동** | `GET /api/public/sources` | **Python 수집기가 호출** — Bearer 토큰 보호 |
| **수신자 연동** | `GET /api/public/recipients` | **Python 발송기가 호출** — Bearer 토큰 보호 |
| 헬스체크 | `GET /api/health` | 상태 확인 |

**관리 콘솔 기능 하이라이트**
- 🔐 로그인 1회 후 12시간 세션 유지 (기본 비밀번호 `admin1234`)
- 📬 **이메일 수신자 관리** — 여러 명에게 동시 발송, 별명·활성 토글 지원
- 🧠 URL 붙여넣기만 해도 **RSS/YouTube/GoogleNews/웹 자동 판별**
- 🧪 **추가 전 즉석 테스트** 버튼 — 실제 최근 제목 5건 미리보기
- 🎛️ 활성/비활성 토글, 삭제 한 번에
- 💾 Cloudflare KV 에 저장 → GitHub 푸시 불필요, 즉시 반영
- 🌐 최초 접속 시 `wwwkoistkr@gmail.com` 이 기본 수신자로 자동 등록

---

## 🔑 필수 환경 변수 / Secrets

### Python 파이프라인 (GitHub Secrets)

| 이름 | 용도 | 필수 |
|---|---|:---:|
| `GEMINI_API_KEY` | Google AI Studio 발급 | ✅ |
| `EMAIL_SENDER` | 보내는 Gmail 주소 | ✅ |
| `EMAIL_APP_PASSWORD` | Gmail 앱 비밀번호 16자 | ✅ |
| `EMAIL_RECIPIENTS` | 받는 이메일 (기본값: `wwwkoistkr@gmail.com`) | ⬜ |
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
├── .github/workflows/daily_briefing.yml # 매일 07:00 KST
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
3. 내일 아침 **KST 07:00** 부터 자동 발송 시작 (또는 `Run workflow` 버튼으로 수동 실행)

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
6. 매일 07:00 KST, `wwwkoistkr@gmail.com` 으로 브리핑 도착 ✉️

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
