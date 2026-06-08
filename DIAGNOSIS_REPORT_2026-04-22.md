# 🔍 Morning Stock AI — 수신자 동기화 & 자료 수집 장애 원인 분석 보고서

> **작성일:** 2026-04-22 (Wed)
> **분석 대상:** 프로덕션 v2.2.7 (https://morning-stock-briefing.pages.dev)
> **분석 근거:** 실제 GitHub Actions 실행 로그 `#24752650647` (2026-04-21 23:55 KST) + 프로덕션 API 직접 호출 결과 + 소스 코드 감사
> **결론 요약:** **모두 "조용한 실패(Silent Fallback)" 한 가지 뿌리에서 파생됩니다.** `BRIEFING_READ_TOKEN`이 양쪽(Cloudflare ↔ GitHub Secrets)에서 일치하지 않아 파이프라인이 **관리UI와 완전히 격리된 상태로 동작**하고 있습니다.

---

## 🧭 Executive Summary (한 장 요약)

| 질문 | 답 | 증거 |
|---|---|---|
| 앱에서 추가한 수신자가 실제 메일 수신자 목록에 들어가나요? | ❌ **들어가지 않습니다** | GH Actions 로그 L29: `관리 콘솔 수신자 조회 401/403 — ...관리 UI에 추가한 수신자들이 이번 발송에서 '반영되지 않았습니다'. EMAIL_RECIPIENTS 환경변수만 사용됩니다.` |
| 오늘(04-21 23:55) 실제 몇 명에게 발송됐나요? | **2명** (GitHub Secret에 박혀 있는 2명) | GH Actions 로그 L30: `최종 발송 대상: 2명 → ww***r@gmail.com, hj***0@naver.com` |
| 앱 관리UI에는 몇 명 등록돼 있나요? | **3명** (사용자 리포트 기준) | 앞선 세션에서 3명 확인 — Gmail 1 + 네이버 2 |
| 관리UI의 "사용자가 등록한 뉴스 소스"가 반영되나요? | ❌ **전혀 반영되지 않습니다** | GH Actions 로그 L27: `KV 소스 목록 조회 실패 (건너뜀): 401 Client Error: Unauthorized for url: .../api/public/sources` → KV 수집 0건 → **하드코딩 3사 폴백으로만 발송 중** |
| 자료 수집이 "안 되는 것처럼 보이는" 진짜 이유는? | 아래 3중 실패가 겹침 | ① 관리UI 소스 `401` ② 공식 한국경제 RSS가 XML 깨짐으로 Google News 우회 의존 ③ 디일렉 유튜브 채널 ID 비어 있음 |
| 워크플로가 v2.2.4 이후로 최신 기능을 못 쓴다는데 사실인가요? | ✅ **사실입니다** | `.github/workflows/daily_briefing.yml` 이 `OPENAI_*`, `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` 등 3개 env를 **아직 포함하지 않고 있음** (v2.2.4 업데이트가 web UI에서 수동 적용 안 됨) |

---

## 1️⃣ 시스템 아키텍처 개요 (동기화가 어디에서 끊기는가)

```
┌─────────────────────────────────┐
│  관리 UI (https://*.pages.dev)  │   ← 관리자가 "수신자 추가/삭제/편집" 하는 곳
│  - Cloudflare KV: SOURCES_KV    │
│    ├─ recipients:list  [3명]    │
│    └─ sources:list     [N개]    │
└──────────────┬──────────────────┘
               │ GET /api/public/recipients  (Bearer: BRIEFING_READ_TOKEN)
               │ GET /api/public/sources     (Bearer: BRIEFING_READ_TOKEN)
               ▼
┌─────────────────────────────────┐
│  GitHub Actions (매일 07:00 KST)│
│  env:                            │
│   EMAIL_RECIPIENTS = "2명"      │   ← GitHub Secret (수동 관리)
│   BRIEFING_READ_TOKEN = "X"     │   ← GitHub Secret (CF와 일치해야 함)
│   BRIEFING_ADMIN_API  = "Y"     │
│                                  │
│  ▼ 의도된 흐름                  │
│  1. CF 호출 → 수신자 3명 받음   │
│  2. EMAIL_RECIPIENTS(2)와 합침 │
│  3. 중복 제거 후 최종 3명 발송 │
└─────────────────────────────────┘
```

**📛 실제 일어나는 일:**

```
GitHub Actions BRIEFING_READ_TOKEN  ≠  Cloudflare Pages BRIEFING_READ_TOKEN
              │
              ▼
      CF 에서 401 Unauthorized 반환
              │
              ▼
   Python이 "환경변수 수신자만 사용" 폴백
              │
              ▼
       실제 발송 = EMAIL_RECIPIENTS (2명) only
   관리UI에서 추가한 3번째 수신자는 영원히 미수신
```

---

## 2️⃣ 근본 원인 분석 (3가지 겹친 장애)

### 🔴 ROOT CAUSE #1: `BRIEFING_READ_TOKEN` 토큰 불일치 (치명적)

**증거 (GH Actions 로그 L27, L29):**
```
2026-04-21 23:55:43 [WARNING] KV 소스 목록 조회 실패 (건너뜀):
    401 Client Error: Unauthorized for url: ***/api/public/sources
2026-04-21 23:56:22 [WARNING] 관리 콘솔 수신자 조회 401/403 —
    BRIEFING_READ_TOKEN 이 올바르지 않거나 BRIEFING_PUBLIC_TOKEN
    (백엔드 검증값) 과 일치하지 않습니다.
    → 관리 UI에 추가한 수신자들이 이번 발송에서 '반영되지 않았습니다'.
      EMAIL_RECIPIENTS 환경변수만 사용됩니다.
```

**증거 (직접 프로덕션 호출):**
```bash
$ curl -s https://morning-stock-briefing.pages.dev/api/public/recipients
{"error":"unauthorized"}   # HTTP 401

$ curl -s https://morning-stock-briefing.pages.dev/api/public/sources
{"error":"unauthorized"}   # HTTP 401
```

**코드 위치:** `src/index.tsx:1576-1582`
```typescript
function checkBearer(c: any): boolean {
  const expected = c.env.BRIEFING_READ_TOKEN   // ← CF 에 저장된 값
  if (!expected) return true                    // 미설정 → 인증 스킵
  const auth = c.req.header('Authorization') ?? ''
  const token = auth.replace(/^Bearer\s+/i, '')
  return token === expected                     // ← 문자열 완전 일치 검사
}
```

**왜 이런 상태가 되었나?**
- Cloudflare 의 `BRIEFING_READ_TOKEN` 과 GitHub Secret `BRIEFING_READ_TOKEN` 중 어느 한 쪽이 업데이트되면서 다른 쪽이 동기화되지 않음
- 두 값이 한 글자라도 다르면 즉시 401

**영향 범위 (연쇄):**
1. ❌ 관리UI "뉴스 소스" (Google News site: 검색, 사용자 추가 RSS 등) 전부 **무시**됨
2. ❌ 관리UI "수신자" (추가한 네이버 유저) 전부 **무시**됨
3. ❌ `_report_recipient_events()` POST도 401 → 관리UI 카드에 "마지막 발송일" "누적 발송 N회" **영원히 비어 있음** (v2.2.7 신규 이력 기능이 완전 무력화)
4. ⚠️ 결국 Python은 v1 시절 **하드코딩 3사 + 환경변수 이메일**만 사용하게 되어 사실상 v2.0 이전 상태로 회귀

---

### 🔴 ROOT CAUSE #2: 한국경제 공식 RSS XML 깨짐 (완화된 상태)

**증거 (GH Actions 로그 L11-L14):**
```
2026-04-21 23:55:44 [WARNING] [한국경제(증권)] 공식 RSS 수집 실패
    → fallback 시도: RSS 파싱 실패(한국경제(증권)):
      <unknown>:39:151: not well-formed (invalid token)
2026-04-21 23:55:45 [INFO] [한국경제(증권)] fallback으로 5건 수집

2026-04-21 23:55:46 [WARNING] [한국경제(IT)] 공식 RSS 수집 실패
    → fallback 시도: RSS 파싱 실패(한국경제(IT)):
      <unknown>:39:151: not well-formed (invalid token)
2026-04-21 23:55:47 [INFO] [한국경제(IT)] fallback으로 5건 수집
```

**무엇이 문제인가?**
- `https://rss.hankyung.com/feed/finance.xml` 의 39번째 줄 151번째 문자에서 XML 파싱 에러 발생
- 한경이 RSS 본문에 잘못된 문자(제어문자, 닫히지 않는 태그 등)를 내보내고 있음 → 파서가 거부

**왜 수집은 "성공"처럼 보이나?**
- `korean_news.py` 에 이중 안전망이 있음: 공식 RSS 실패 시 Google News RSS (`site:hankyung.com 증권`) 로 자동 폴백
- 결과적으로 **한국경제는 5건씩 수집**되지만, 출처는 **Google News 를 경유한 2차 인용** → 링크가 `news.google.com/rss/articles/...` 로 나감 (원문 링크 한 단계 더 리다이렉트)

**실제 부작용:**
- ✅ 수집 자체는 성공 (폴백 덕분)
- ⚠️ 사용자가 받는 메일의 "원문 링크" 를 클릭하면 한경 사이트가 아닌 Google News 경유 페이지로 이동 → 사용자 경험 저하
- ⚠️ AI 요약 입력 텍스트의 `summary` 필드가 Google News 의 짧은 snippet 으로 대체됨 → 요약 품질 저하

---

### 🔴 ROOT CAUSE #3: 디일렉 유튜브 채널 ID가 빈 문자열 (완전 실패)

**증거 (GH Actions 로그 L21):**
```
2026-04-21 23:56:00 [WARNING] YouTube RSS 도 실패:
    404 Client Error: Not Found for url:
    https://www.youtube.com/feeds/videos.xml?channel_id=
                                             ↑ 여기가 비어 있음
```

**env 변수 확인 (워크플로 L19-L20):**
```yaml
THELEC_YOUTUBE_CHANNEL_ID:   # ← 값이 비어 있음 (GitHub Secret 미설정)
YOUTUBE_API_KEY:             # ← 값이 비어 있음 (GitHub Secret 미설정)
```

**코드 위치:** `briefing/collectors/youtube_news.py:31-33`
```python
DEFAULT_THELEC_CHANNEL_ID = os.getenv(
    "THELEC_YOUTUBE_CHANNEL_ID", "UC2GRwEADsEKEX5k-Xg9YphA"
)
```

**🐛 미묘한 버그:**
`os.getenv(KEY, DEFAULT)`는 **환경변수가 존재하면 값이 빈 문자열이어도 DEFAULT가 사용되지 않음**.
- GitHub Actions 워크플로에 `THELEC_YOUTUBE_CHANNEL_ID: ${{ secrets.THELEC_YOUTUBE_CHANNEL_ID }}` 가 정의되어 있음
- 해당 Secret이 등록되어 있지 않으면 **빈 문자열**로 주입
- Python 입장에서는 "환경변수가 설정되어 있음"(empty string) → 기본 채널 ID 대체 안 됨
- RSS URL이 `...channel_id=` (뒤 비어있음) 로 완성 → 404

**영향:**
- ❌ 디일렉 유튜브 0건 수집 (매일)
- ℹ️ 나머지 수집은 정상이라 치명적이지는 않지만, **반도체 전문 유튜브 브리핑** 기능이 완전히 죽어있는 상태

---

## 3️⃣ 부가 발견 사항

### 🟡 Finding #4: 워크플로 파일이 v2.2.4 이전 상태 (기능 누락)
```yaml
# 현재 워크플로에 없는 것들:
#   FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"  ← Node20 deprecation 경고
#   OPENAI_API_KEY:  ${{ secrets.OPENAI_API_KEY }}   ← ai_summarizer 폴백
#   OPENAI_BASE_URL: ${{ secrets.OPENAI_BASE_URL }}
#   OPENAI_MODEL:    ${{ secrets.OPENAI_MODEL }}
```
- 원인: **GitHub App이 workflows 권한을 갖고 있지 않아** (`refusing to allow a GitHub App to create or update workflow`) 스크립트 자동 푸시가 계속 거부됨. v2.2.4부터 수동으로 웹 UI에서 갱신해 달라고 안내했으나 아직 미적용.
- 영향: Gemini 할당량 초과 또는 503 오류 시 OpenAI 폴백 불가 → 전체 파이프라인 실패 위험

### 🟡 Finding #5: `/api/public/recipients-safe` 엔드포인트 404
- v2.2.5 보고서에는 "토큰 없이도 마스킹된 이메일을 볼 수 있는 안전 엔드포인트 구현"으로 명시되었으나, 실제 코드베이스 `src/index.tsx` 에 해당 라우트가 **존재하지 않음**
```bash
$ curl -I https://morning-stock-briefing.pages.dev/api/public/recipients-safe
HTTP/2 404
```
- 그래서 사용자가 관리UI에서 "직접 보기" 버튼을 눌러도 실제로는 작동하지 않음 (진단 목적 기능이 없어진 상태)

### 🟢 Finding #6: 실제로 "성공" 중인 것들
| 항목 | 상태 |
|---|---|
| 한국경제 (Google News 경유) | ✅ 10건 |
| 매일경제 공식 RSS | ✅ 10건 |
| 머니투데이 (Google News) | ✅ 10건 |
| Seeking Alpha / ETF.com / Morningstar / Reuters / Bloomberg | ✅ 총 18건 |
| Gemini 2.5 Flash 요약 | ✅ 21,379 chars 입력 → 454 chars 출력 (21초) |
| Gmail SMTP 발송 | ✅ 2/2 accepted (Gmail + Naver 1명) |
| **총 수집 건수** | **48건 (중복 제거 후)** |

→ **"자료 수집이 전혀 안 된다"는 체감과 달리, 기본 48건은 잘 수집되고 있음**. 다만 **"관리 UI에 추가한 사용자 커스텀 소스"가 전혀 반영되지 않고 있다**는 것이 진짜 문제.

---

## 4️⃣ 타임라인으로 본 사건 재현 (04-21 23:55 KST 실행)

```
23:55:42  🚀 파이프라인 시작
23:55:42  env 확인: EMAIL_RECIPIENTS=*** BRIEFING_READ_TOKEN=***
23:55:42  📡 KV 소스 수집 시도 → ADMIN_API/api/public/sources 호출
23:55:43  ❌ 401 Unauthorized — 토큰 불일치 → KV 수집 포기 (0건)
23:55:44  ⚠️ 하드코딩 폴백 모드로 전환
23:55:44  📰 한국경제(증권) 공식 RSS: XML 깨짐 → Google News 우회 → 5건
23:55:46  📰 한국경제(IT)   공식 RSS: XML 깨짐 → Google News 우회 → 5건
23:55:52  📰 매일경제(증권) 공식 RSS 성공 → 5건
23:55:53  📰 매일경제(IT)   공식 RSS 성공 → 5건
23:55:53  📰 머니투데이(증권) Google News → 5건
23:55:54  📰 머니투데이(IT)   Google News → 5건
23:55:55  🌎 미국 매체 6개 총 18건
23:56:00  📺 디일렉 유튜브: channel_id="" → 404 → 0건
23:56:00  🤖 Gemini 2.5 Flash 호출 (입력 21,379 chars)
23:56:22  🤖 Gemini 응답 (454 chars, 22초 소요)
23:56:22  📧 관리콘솔 수신자 조회 → 401 → 포기
23:56:22  📧 EMAIL_RECIPIENTS 환경변수만 사용: 2명
23:56:22  📡 SMTP 연결 → Gmail 1명 ✅, 네이버 1명 ✅
23:56:24  📊 발송 이벤트 POST → 401 → 실패 (관리UI 이력 미기록)
23:56:24  ✅ 파이프라인 완료 (하지만 실제론 절반만 성공한 셈)
```

---

## 5️⃣ 🛠 해결 방안 (우선순위 순)

### ⭐ Priority 0 — 지금 당장 (5분) — 토큰 일치시키기

**가장 빠른 복구 경로:**

#### 옵션 A) Cloudflare 토큰을 GitHub에 복사 (권장)
```bash
# 1) 관리자 로그인 후 CF 토큰 확인
#    https://morning-stock-briefing.pages.dev/ 에서 [🩺 토큰·수신자 진단] 클릭
#    → "tokenHashPrefix: xxxxxxxx" 표시되면 CF 에 저장됨

# 2) CF 대시보드에서 현재 값 조회
#    Cloudflare Pages → morning-stock-briefing → Settings → Environment variables
#    → Production 의 BRIEFING_READ_TOKEN 값을 복사

# 3) GitHub Secret 에 붙여넣기
#    https://github.com/wwwkoistkr/2026_04_21_-_-/settings/secrets/actions
#    → BRIEFING_READ_TOKEN (pencil) → 복사한 값 → Update secret
```

#### 옵션 B) 새 토큰 생성 후 양쪽 동시 업데이트
```bash
# 강력한 랜덤 토큰 생성
openssl rand -hex 32
# → 예: 7f3e8a1b5c9d2e4f...

# 1) GitHub Secret: BRIEFING_READ_TOKEN ← 위 값
# 2) CF Pages Secret:
cd /home/user/webapp
npx wrangler pages secret put BRIEFING_READ_TOKEN --project-name morning-stock-briefing
# (붙여넣고 Enter)
```

**검증 방법 (토큰 X 값이라 가정):**
```bash
curl -H "Authorization: Bearer X" \
  https://morning-stock-briefing.pages.dev/api/public/recipients
# 성공 시: {"recipients":["wwwkoistkr@gmail.com","hj...","ellen7615..."],"generatedAt":"..."}
```

---

### ⭐ Priority 1 — 오늘 중 (10분) — 워크플로 수동 업데이트

GitHub 웹 UI에서:
1. https://github.com/wwwkoistkr/2026_04_21_-_-/blob/main/.github/workflows/daily_briefing.yml
2. 연필 아이콘 (Edit) 클릭
3. `GEMINI_API_KEY:` 다음 줄에 아래 3줄 추가:
```yaml
          OPENAI_API_KEY:       ${{ secrets.OPENAI_API_KEY }}
          OPENAI_BASE_URL:      ${{ secrets.OPENAI_BASE_URL }}
          OPENAI_MODEL:         ${{ secrets.OPENAI_MODEL }}
```
4. `timeout-minutes: 15` 다음 줄에 env 블록 추가:
```yaml
    env:
      FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"
```
5. Commit directly to main

---

### ⭐ Priority 2 — 이번 주 (15분) — 유튜브 채널 ID 버그 수정

**코드 수정** (`briefing/collectors/youtube_news.py`):
```python
# 변경 전:
DEFAULT_THELEC_CHANNEL_ID = os.getenv(
    "THELEC_YOUTUBE_CHANNEL_ID", "UC2GRwEADsEKEX5k-Xg9YphA"
)

# 변경 후 (빈 문자열도 기본값으로 대체):
_env_channel = os.getenv("THELEC_YOUTUBE_CHANNEL_ID", "").strip()
DEFAULT_THELEC_CHANNEL_ID = _env_channel or "UC2GRwEADsEKEX5k-Xg9YphA"
```

이후 GitHub Secret에서 `THELEC_YOUTUBE_CHANNEL_ID` 자체를 삭제하거나, 실제 디일렉 채널 ID를 설정.

---

### ⭐ Priority 3 — 이번 달 (30분) — 토큰 불일치 재발 방지 (구조 개선)

**아이디어 1: HMAC 서명으로 전환**
- 현재: 문자열 단순 비교 → 양쪽 저장 필요 → 동기화 리스크
- 개선: GitHub Actions 가 `timestamp + HMAC(timestamp, shared_secret)` 를 헤더로 보내고, CF 가 shared_secret 로 검증. 비밀은 **한쪽만 저장**하고 다른 쪽은 **서명만 검증** → 동기화 끊김 현상 원천 차단

**아이디어 2: 자가 진단 엔드포인트 개선**
- 현재 `/api/admin/diag-recipient-sync` 는 "CF 쪽 해시"만 보여줌
- 개선: GitHub 가 파이프라인 시작 시 토큰 해시 4자리를 CF에 보고 → CF 가 자기 해시와 비교 → 관리UI에 🔴/🟢 실시간 표시

**아이디어 3: `/api/public/recipients-safe` 실제 구현**
- v2.2.5 보고서에 있다고 했으나 실제 코드엔 없음 (404)
- 토큰 불필요, 마스킹된 이메일 + 건수만 리턴 → 언제든 검증 가능한 "공개 상태 페이지" 역할

---

### ⭐ Priority 4 — 선택 (20분) — 한국경제 RSS 파서 견고화

**옵션 1: 파서 교체**
```python
# 현재: feedparser (XML 엄격) → 한경 깨진 XML 거부
# 개선: lxml 의 recover=True 옵션 또는 BeautifulSoup(xml) 사용
from bs4 import BeautifulSoup
soup = BeautifulSoup(response.content, 'xml')
for item in soup.find_all('item'):
    ...
```

**옵션 2: 한국경제 공식 RSS 포기**
- 이미 Google News 폴백이 잘 동작 → `url` 필드를 아예 Google News URL로 바꿔 1-step 수집으로 단순화
- 단, "기사 원문 링크" 품질 저하는 감수

---

## 6️⃣ 🎯 예상 복구 효과 (P0~P2 적용 시)

| 지표 | 현재 (04-21 발송) | 복구 후 예상 |
|---|---|---|
| 실제 수신자 수 | 2명 | **3명** (관리UI 반영) |
| 뉴스 소스 수 | 하드코딩 13개 | **13개 + 관리UI에 등록한 모든 커스텀 소스** |
| 한국경제 원문 품질 | Google News 경유 (2-step) | 동일 (P4 적용 시 개선) |
| 유튜브 수집 | 0건 | **5건** (P2 적용 시) |
| 관리UI 수신자 카드 "마지막 발송" | ❌ 공란 | **✅ 매일 갱신** |
| Gemini 503 장애 시 | ❌ 파이프라인 실패 | **✅ OpenAI 폴백** (P1 적용 시) |

---

## 7️⃣ 📋 체크리스트 (실행하실 순서)

- [ ] **(P0, 5분)** CF 또는 GitHub 한쪽의 `BRIEFING_READ_TOKEN` 을 복사해 다른 쪽에 동일하게 설정
- [ ] **(P0 검증)** `curl -H "Authorization: Bearer <TOKEN>" https://.../api/public/recipients` 가 200 리턴 확인
- [ ] **(P0 검증)** 관리UI 에서 [🚀 지금 발송] → Actions 로그에서 `최종 발송 대상: 3명` 확인
- [ ] **(P1, 10분)** 워크플로 파일 웹UI 편집 → OPENAI_*, FORCE_JAVASCRIPT_* 추가
- [ ] **(P2, 15분)** youtube_news.py 패치 후 v2.2.8 배포
- [ ] **(P3, 30분)** 장기적 재발 방지 구조 개선 (HMAC 서명 등)
- [ ] **(P4, 20분)** 한국경제 파서 견고화 (선택)

---

## 8️⃣ 🔑 핵심 교훈

1. **"조용한 실패"는 가장 비싼 버그다.** 401을 받고도 파이프라인이 "정상 완료"로 종료되어 이틀 넘게 인지되지 않았음. → 치명적 인증 실패 시 exit code 1 또는 Slack webhook 경보 추가 필요.
2. **토큰 동기화는 인프라 책임, 애플리케이션 책임이 아니다.** 단순 문자열 비교 구조 자체가 구조적 결함. HMAC 같은 "동기화 없는 검증"으로 가야 함.
3. **`os.getenv(K, D)` 는 빈 문자열을 기본값으로 대체하지 않는다.** 파이썬 표준 관용구 `os.getenv(K, "").strip() or D` 를 팀 컨벤션으로.
4. **"작동하는 것처럼 보이는" 것과 "의도대로 작동하는" 것의 차이.** 메일은 가고 있었으나, 관리UI에서 추가한 사람에게는 영원히 안 가고 있었음.

---

## 🔗 참고 자료
- GitHub Actions Run: https://github.com/wwwkoistkr/2026_04_21_-_-/actions/runs/24752650647
- Cloudflare Pages: https://morning-stock-briefing.pages.dev
- 관련 보고서: `BUGFIX_REPORT_v2.2.5.md` (토큰 진단 API 도입), `BUGFIX_REPORT_v2.2.7.md` (CRUD 확장)
- 주요 파일:
  - `src/index.tsx:1576-1600` (public API, checkBearer)
  - `briefing/modules/email_sender.py:28-74` (fetch_recipients_from_admin)
  - `briefing/collectors/custom_sources.py:79-101` (fetch_custom_sources)
  - `briefing/collectors/youtube_news.py:31-33` (channel_id 버그)
  - `.github/workflows/daily_briefing.yml` (v2.2.4 이전 상태)
