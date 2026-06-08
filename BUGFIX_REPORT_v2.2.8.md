# 🔧 BUGFIX REPORT v2.2.8 — 데이터 수집 파이프라인 종합 강화

**배포일**: 2026-04-22
**프로덕션 URL**: https://morning-stock-briefing.pages.dev
**배포 커밋**: (이 파일과 함께 푸시 예정)
**이전 버전**: v2.2.7 (수신자 주소록 CRUD)

---

## 🎯 배경

v2.2.7 에서 수신자 주소록의 편집/삭제 기능을 완성하고, 직전 작업으로
**`BRIEFING_READ_TOKEN` 동기화 (P0)** 를 통해 관리 UI에 등록된 3명 전원
(gmail 1 + naver 2) 에게 이메일이 정상 발송되는 것까지 확인했다 (run ID
24755798762, accepted 3/3).

이번 v2.2.8 은 진단 보고서 `DIAGNOSIS_REPORT_2026-04-22.md` 에서 남겨둔
**P1·P2·P3 후속 조치**를 한 번에 처리한다. 모두 "브리핑 발송은 되지만
수집 품질이 떨어져 있는" 상태를 해소하는 변경이다.

---

## 📦 포함된 수정 사항

### P1. GitHub Actions 워크플로 파일 업데이트 🟢

**파일**: `.github/workflows/daily_briefing.yml`

지난 v2.2.4~v2.2.5 에서 코드·Secrets 는 업데이트됐지만, GitHub App 권한
이슈(`workflows` 스코프 없음)로 **YAML 파일 자체는 구버전**에 머물러 있었다.
따라서 `OPENAI_*` 환경변수가 전달되지 않아 **Gemini 503 fallback 이 기능하지
못했다**.

이번엔 CLI 푸시로 YAML 파일도 정상 업데이트한다:

```yaml
jobs:
  run-briefing:
    # v2.2.8: Node 20 deprecation 경고 억제
    env:
      FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"
    steps:
      - name: Run briefing pipeline
        env:
          # AI 요약 - Gemini (기본)
          GEMINI_API_KEY:       ${{ secrets.GEMINI_API_KEY }}
          # v2.2.8 NEW: AI 요약 OpenAI fallback (Gemini 503/과부하 시 자동 전환)
          OPENAI_API_KEY:       ${{ secrets.OPENAI_API_KEY }}
          OPENAI_BASE_URL:      ${{ secrets.OPENAI_BASE_URL }}
          OPENAI_MODEL:         ${{ secrets.OPENAI_MODEL }}
          # (이하 기존)
```

**효과**
- Gemini 서버가 503/429/"UNAVAILABLE" 응답을 돌려주면, `ai_summarizer.py` 의
  `_summarize_with_openai_compat()` 이 자동 호출되어 **브리핑 발송이 끊기지
  않음** (이 로직은 이미 v2.2.3 부터 구현돼 있었음).
- `OPENAI_*` Secret 들이 비어 있어도 기존과 동일하게 Gemini 만 사용하므로
  **안전한 변경**이다.

**사용자 조치 (선택)**
- OpenAI 호환 fallback 을 실제로 쓰려면 `OPENAI_API_KEY`, `OPENAI_BASE_URL`,
  `OPENAI_MODEL` 을 GitHub Secrets 에 추가. 등록하지 않아도 기존처럼 정상 동작.

---

### P2. YouTube (디일렉) 수집기 두 건의 버그 수정 🟢

**파일**: `briefing/collectors/youtube_news.py`

이전 GitHub Actions 로그에는 다음 에러가 반복됐다:

```
❌ [디일렉 (THEELEC)] 수집 실패: 404 Client Error: Not Found for url:
   https://www.youtube.com/feeds/videos.xml?channel_id=UC2GRwEADsEKEX5k-Xg9YphA
```

조사해 보니 **두 가지 버그가 동시에 있었다**.

#### 버그 1 — 빈 문자열 fallback 실패

```python
# ❌ 이전
DEFAULT_THELEC_CHANNEL_ID = os.getenv(
    "THELEC_YOUTUBE_CHANNEL_ID", "UC2GRwEADsEKEX5k-Xg9YphA"
)
```

`os.getenv(key, default)` 는 **key 가 미설정인 경우에만** default 를 반환한다.
GitHub Secrets 에 `THELEC_YOUTUBE_CHANNEL_ID` 가 존재하지만 값이 빈
문자열이면 `""` 이 그대로 반환되어, RSS URL 이 `channel_id=` 로 끝나버린다.
또한 모듈 import 시점에 한 번만 평가되므로 런타임 수정도 불가능.

#### 버그 2 — 하드코딩된 채널 ID 가 실제로는 존재하지 않음

`UC2GRwEADsEKEX5k-Xg9YphA` 는 유효한 디일렉 채널이 아니었다.
`https://www.youtube.com/@thelec` 페이지의 HTML 에서 browseId 를 추출하여
실제 값이 **`UCW45xiXsUy3MJSiZ0zal0aw`** 임을 확인했다.

#### 수정

```python
_HARDCODED_THELEC_CHANNEL_ID = "UCW45xiXsUy3MJSiZ0zal0aw"  # @thelec (THELEC)

def _resolve_channel_id(explicit: Optional[str] = None) -> str:
    """
    채널 ID 우선순위:
      1) explicit 인자 (유효한 경우)
      2) 환경변수 THELEC_YOUTUBE_CHANNEL_ID (공백·빈 값이 아닌 경우)
      3) 하드코딩된 디일렉 공식 채널 ID
    """
    if explicit and explicit.strip():
        return explicit.strip()
    env_val = (os.getenv("THELEC_YOUTUBE_CHANNEL_ID") or "").strip()
    if env_val:
        return env_val
    return _HARDCODED_THELEC_CHANNEL_ID
```

`get_youtube_news()` 의 초반부도 런타임에 이 헬퍼를 호출하도록 변경하고,
진단을 위해 `INFO` 로그를 하나 추가:

```python
channel_id = _resolve_channel_id(channel_id)
api_key = (os.getenv("YOUTUBE_API_KEY") or "").strip() or None
logger.info("디일렉 YouTube 수집 채널 ID: %s (API=%s)", channel_id, "ON" if api_key else "OFF")
```

#### 검증 (로컬 유닛 테스트 6/6 통과)

| 케이스 | 입력 | 결과 |
|---|---|---|
| env 미설정 | — | `UCW45xiXsUy3MJSiZ0zal0aw` ✅ |
| env 빈 문자열 | `""` | `UCW45xiXsUy3MJSiZ0zal0aw` ✅ |
| env 공백 | `"   "` | `UCW45xiXsUy3MJSiZ0zal0aw` ✅ |
| env 유효값 | `"UC_CUSTOM"` | `UC_CUSTOM` ✅ |
| explicit 인자 | arg=`"UC_X"` | `UC_X` (env 무시) ✅ |
| explicit 빈 문자열 | arg=`""` | env 로 fallback ✅ |

**효과**
- GitHub Secret 을 비워둬도 404 가 아니라 실제 디일렉 채널에 접근.
- 채널 ID 교체가 필요할 때 Secret 만 바꾸면 즉시 반영됨.

---

### P3. 한국경제 RSS 파서 강화 🟢

**파일**: `briefing/collectors/korean_news.py`

실시간 조사 결과:

```
한국경제(증권) → HTTP 403 (Cloudflare WAF "Attention Required" HTML 반환)
한국경제(IT)   → HTTP 403 (동일)
매일경제       → HTTP 200 (정상)
머니투데이     → Google News RSS 우회 (정상)
```

기존 코드는 `response.raise_for_status()` 가 먼저 예외를 던져 fallback 으로
전환되기는 했지만, 에러 메시지가 `<unknown>:69:50: undefined entity` 같이
**원인을 알 수 없는 형태**였다. 또한 Cloudflare 가 앞으로 200 + HTML
challenge page (`Just a moment...`) 로 전환할 가능성도 있어 대비가 필요했다.

#### 강화 포인트

1. **HTTP 상태별 명확한 에러 메시지**
   - 403 → `"HTTP 403 (WAF/봇 차단)"`
   - 404 → `"HTTP 404 (피드 없음)"`
   - 5xx → `ConnectionError` (재시도 1회)
2. **일시 오류 재시도**: `requests.Timeout` / `ConnectionError` / 5xx 는
   기본 1 회 재시도 후 실패 처리
3. **Cloudflare WAF 페이지 감지**: 200 으로 응답하더라도 본문에
   `cf-error`, `Attention Required`, `Just a moment...` 등 시그니처가
   있으면 즉시 fallback 전환
4. **비-XML 응답 조기 감지**: `Content-Type` + 본문 앞 512바이트를
   검사해 RSS/Atom 이 아니면 fallback
5. **타임아웃 10초 → 15초**: 한국 서버가 가끔 느림
6. **빈 피드 감지**: `feedparser.parse` 성공해도 entries=0 이면 fallback

#### 기대 로그 (이전 vs 현재)

| 항목 | 이전 | 현재 |
|---|---|---|
| 한국경제 403 | `RSS 파싱 실패: <unknown>:69:50: undefined entity` | `HTTP 403 (WAF/봇 차단) — 한국경제(증권) 공식 RSS 접근 거부` |
| 404 | `404 Client Error` | `HTTP 404 (피드 없음) — XXX URL 확인 필요` |
| WAF challenge page | 정체불명 파싱 에러 | `WAF block detected (Just a moment...)` |
| 잘못된 Content-Type | raw XML parse 에러 | `비(非) XML 응답 (4549 bytes, Content-Type=text/html)` |

#### 로컬 검증 결과

```
Test 1 (한국경제 WAF):  ✅ "HTTP 403 (WAF/봇 차단)" 명확 메시지
Test 2 (매일경제 정상):  ✅ 3건 수집
Test 3 (404 URL):        ✅ "HTTP 404 (피드 없음)" 명확 메시지
Test 4 (전체 수집):      ✅ 12건 (6/6 피드 정상 — 한국경제 2건 fallback 포함)
```

---

## 🚀 배포 상태

| 항목 | 값 |
|---|---|
| 버전 | **v2.2.8** |
| Production | https://morning-stock-briefing.pages.dev |
| Preview | https://9c6d414f.morning-stock-briefing.pages.dev |
| /api/health | `{"version":"v2.2.8"}` ✅ |
| Service Worker | `msaic-v2.2.8` |
| Admin Dashboard | `Daily Briefing Admin v2.2.8` |

### GitHub Actions 영향 범위

| Secret | 필수 | 상태 |
|---|---|---|
| `GEMINI_API_KEY` | ✅ | 기존 |
| `OPENAI_API_KEY` | ⚪ 선택 | **v2.2.8 NEW** |
| `OPENAI_BASE_URL` | ⚪ 선택 | **v2.2.8 NEW** |
| `OPENAI_MODEL` | ⚪ 선택 | **v2.2.8 NEW** |
| `EMAIL_*` | ✅ | 기존 |
| `YOUTUBE_API_KEY` | ⚪ 선택 (없으면 RSS) | 기존 |
| `THELEC_YOUTUBE_CHANNEL_ID` | ❌ 더 이상 필요 없음 | **하드코딩 fallback 강화** |
| `BRIEFING_ADMIN_API` / `BRIEFING_READ_TOKEN` | ✅ | 기존 (v2.2.7 P0 에서 이미 동기화 완료) |

**모든 변경은 하위 호환**: 신규 Secret 추가는 선택이고, 기존 Secret
무시/누락 시에도 기존 동작이 유지된다.

---

## 📊 예상 개선 효과

| 지표 | 이전 (v2.2.7) | 현재 (v2.2.8) |
|---|---|---|
| Gemini 503 발생 시 | 브리핑 발송 **실패** | OpenAI 로 자동 fallback → 발송 성공 |
| 디일렉 YouTube 수집 | 0건/일 (404) | 예상 **3~5건/일** |
| 한국경제 수집 로그 가독성 | 정체불명 XML 에러 | 원인 한눈에 (WAF 403 등) |
| 한국경제 수집 건수 | fallback 후 수집은 되고 있었음 | 동일 (현재 fallback 경로는 문제 없음) |
| 일시적 5xx 오류 | 즉시 실패 | 1회 재시도 후 판단 |

---

## 🔮 다음 단계 (v2.2.9 이후)

1. **P4. `recipients-safe` 엔드포인트** 추가 — 토큰 없이도 옵션으로 마스킹된
   수신자 수를 확인할 수 있는 엔드포인트.
2. **관리 UI 에 "파이프라인 진단 탭"** — 최근 GitHub Actions 로그 요약,
   수집 성공률, Gemini/OpenAI 호출 비율 표시.
3. **수신자 카테고리 태그** (예: 증권/IT 구분 발송).
4. **RFC 8058 List-Unsubscribe** — 이메일 헤더에 1-click 구독 해제 링크.

---

## 📂 수정 파일 목록

```
.github/workflows/daily_briefing.yml   (+18 -6)   # P1
briefing/collectors/youtube_news.py     (+34 -5)  # P2
briefing/collectors/korean_news.py      (+110 -20) # P3
public/static/admin.js                  (3 occ: v2.2.7 → v2.2.8)
public/static/sw.js                     (2 occ: v2.2.7 → v2.2.8, 캐시 키 포함)
src/index.tsx                           (3 occ: v2.2.7 → v2.2.8)
BUGFIX_REPORT_v2.2.8.md                 (이 파일, NEW)
```

---

## ✅ 체크리스트

- [x] P1: 워크플로 파일에 `OPENAI_*` + `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` 추가
- [x] P2: YouTube channel_id 빈 문자열 fallback + 실제 채널 ID 로 교체
- [x] P3: 한국경제 RSS 파서 HTTP 상태/WAF/재시도 로직 강화
- [x] 로컬 유닛 테스트 통과 (YouTube 6/6, 한국경제 4/4)
- [x] 버전 문자열 v2.2.7 → v2.2.8 일괄 업데이트
- [x] `npm run build` 성공 (dist/_worker.js 93.46 kB)
- [x] Cloudflare Pages 배포 및 `/api/health` 가 v2.2.8 반환 확인
- [ ] GitHub main 브랜치에 커밋 푸시 (다음 단계)
- [ ] DRY_RUN 파이프라인에서 디일렉 YouTube 수집 건수 ≥ 1 확인 (사용자 액션)
- [ ] 실제 발송 1회 실행 후 "도착" 확인 (사용자 액션)

---

## 🙋 사용자 질문 · 조치 요약

**이번 배포에서 사용자가 꼭 해야 할 일 — 없음.**
P1~P3 모두 코드 변경이며, 기존 Secret 으로 그대로 동작합니다.

**선택적으로 하면 좋은 것**:
- GitHub Secrets 에 `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`
  추가 시 Gemini 장애 발생 시에도 브리핑이 끊기지 않습니다.
- `THELEC_YOUTUBE_CHANNEL_ID` Secret 은 이제 삭제하거나 비워둬도 OK.
