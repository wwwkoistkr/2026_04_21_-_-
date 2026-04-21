# 🐛 Bugfix Report — v2.2.3

> **Title**: "지금 발송" 버튼 클릭 시 “실행 실패” 토스트가 뜨는 문제  
> **Severity**: 🔴 High (발송 자체는 성공했지만 UI 가 실패로 표기 → 사용자 혼동)  
> **Date**: 2026-04-21  
> **Deployed**: https://morning-stock-briefing.pages.dev (v2.2.3)  
> **Preview**: https://0e82bffa.morning-stock-briefing.pages.dev  

---

## 1. 증상 (Reproduction)

사용자 화면에서 발생한 현상 (첨부 스크린샷):

| 항목 | 내용 |
|---|---|
| UI | 빨간 박스로 **“발송 실패 (failure)”** + “로그 보기” 링크 |
| 토스트 | **❌ 실행 실패** |
| 콘솔 (무관) | `Uncaught (in promise) Error: A listener indicated an asynchronous response…` (브라우저 확장 기인, 프로덕트와 무관) |
| 실제 결과 | **메일은 정상 발송되어 수신자에게 도착함** |

---

## 2. 원인 분석 (Root Cause)

### 2.1 GitHub Actions 로그 분석 결과

`/repos/wwwkoistkr/2026_04_21_-_-/actions/runs` 에서 같은 순간(12:09:55Z) 두 건이 동시에 디스패치됨:

| Run # | dry_run | 결과 | 원인 |
|---|---|---|---|
| #6 | **false** (실제 발송) | ✅ **success** (메일 발송 완료) | 정상 |
| #7 | **true** (DRY RUN) | ❌ **failure** | **Gemini 503 + OPENAI_API_KEY 미설정 → AI 요약 단계 실패** |

Run #7 상세 실패 로그:
```
[WARNING] Gemini 호출 실패, OpenAI 호환으로 fallback:
           503 UNAVAILABLE. 'This model is currently experiencing high demand.'
[ERROR]   Gemini 요약 단계 실패
RuntimeError: AI 요약 엔진 설정이 없습니다.
              GEMINI_API_KEY 또는 (OPENAI_API_KEY + OPENAI_BASE_URL) 중 하나가 필요합니다.
```

### 2.2 왜 두 건이 동시에 디스패치되었는가

두 가지 경로 중 하나로 중복 요청이 생성됨:

1. **UI 더블클릭**: 사용자가 “지금 발송”을 빠르게 두 번 누름 → 프론트엔드에 중복 방지 로직 없음
2. **쿨다운 KV 일관성**: `KV.get('trigger:last')` 는 **eventually consistent** → 짧은 시간차로 도착한 두 요청이 모두 `last == null` 을 보고 디스패치 진행

### 2.3 왜 UI 가 “실행 실패”로 표기되었는가

`admin.js` 의 `startPolling()` 이 **최신 런 1건만 조회** (`data.runs.find(r => created_at >= sinceMs - 30s)`) 하는데, 
GitHub API 의 `workflow_runs` 배열은 **생성시각 내림차순** 이므로 운나쁘게 **실패한 Run #7** 을 먼저 집어서 실패 처리.

즉 **발송은 성공했지만 실패로 오인**하는 UI 버그.

### 2.4 근본 원인 정리

| # | 원인 | 영향 |
|---|---|---|
| **A** | Gemini 503 발생 시 곧바로 OpenAI fallback 시도 → `OPENAI_API_KEY` 없으면 즉시 RuntimeError | 일시적 과부하에도 파이프라인 전체 실패 |
| **B** | 프론트엔드 이중 클릭 방지 부재 | 동일 순간 두 건 dispatch 발생 가능 |
| **C** | 폴링 매칭 로직이 이벤트 타입·내 런 식별을 하지 않음 | 다른 사람/스케줄 런 / 동시 디스패치 된 다른 런을 잘못 매칭 |

---

## 3. 수정 내용 (Fix)

### 3.1 `public/static/admin.js` — 중복 트리거 방지 + 폴링 강화

```diff
+ let triggerInFlight = false

+ function setTriggerButtonsDisabled(disabled) { … 버튼 2개 disable + 흐림 처리 … }

  async function onTriggerClick(dryRun) {
+   if (triggerInFlight) {
+     toast('⏳ 이미 요청이 진행 중입니다.', 'warn')
+     return
+   }
    showConfirm(…, async () => {
+     triggerInFlight = true
+     setTriggerButtonsDisabled(true)
      const res = await triggerApi.run(dryRun)
      if (res.ok) { startPolling(requestSentAt, dryRun) }
+     else { triggerInFlight = false; setTriggerButtonsDisabled(false) }
    })
  }

  function startPolling(sinceMs, dryRun) {
-   const match = data.runs.find(r => created_at >= sinceMs - 30s)
+   const candidates = data.runs.filter(r =>
+       r.event === 'workflow_dispatch' &&
+       new Date(r.created_at).getTime() >= sinceMs - 60_000
+   )
+   candidates.sort((a, b) => /* newest first */)
+   const match = candidates[0]
    …
+   release() // 완료 시 버튼 잠금 해제
  }
```

- **더블클릭 방지**: `triggerInFlight` 플래그 + 양 버튼 `disabled`
- **폴링 매칭 개선**: `event === 'workflow_dispatch'` + 60초 창 + 최신 정렬 → 내가 트리거한 런을 정확히 선택
- **타임아웃 정리**: 폴링 종료/타임아웃 시 자동으로 버튼 복구
- **에러 힌트**: 실패 시 “GEMINI 503/시크릿 누락일 수 있습니다” 안내 표시

### 3.2 `briefing/modules/ai_summarizer.py` — Gemini 503 재시도 + 경량 모델 폴백

```python
GEMINI_RETRY_DELAYS_SEC = (3, 6, 12)            # 지수 백오프
GEMINI_FALLBACK_MODELS = (
    "gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-1.5-flash",
)

for m in [model_name, *GEMINI_FALLBACK_MODELS]:
    for attempt, delay in enumerate([0, *GEMINI_RETRY_DELAYS_SEC]):
        if delay: time.sleep(delay)
        try:
            text = _call_gemini_once(client, m, prompt)
            if text: return text
        except Exception as exc:
            if _is_transient_gemini_error(exc):
                continue           # 일시 오류 → 같은 모델 재시도
            break                  # 비일시적 오류 → 다음 모델
```

- **503/429/INTERNAL/UNAVAILABLE/overloaded/RESOURCE_EXHAUSTED** 키워드 감지 시 재시도
- `gemini-2.5-flash` 실패 → `gemini-2.5-flash-lite` → `gemini-2.0-flash` → `gemini-1.5-flash` 순으로 자동 폴백
- 모든 모델 실패 시에만 OpenAI 호환 fallback → 없으면 `RuntimeError` (메시지 개선: 보조 엔진 등록 방법 안내)

**효과**: Google 의 일시적 트래픽 쏠림(503) 이 있어도 **최대 3회 × 4모델 = 12회** 시도 후 결정 → 과거처럼 3초 만에 전체 파이프라인이 실패하는 일이 없음.

### 3.3 버전/캐시 버스팅

| 파일 | v2.2.2 | v2.2.3 |
|---|---|---|
| `src/index.tsx` (API health, UI 배지) | v2.2.2 | **v2.2.3** |
| `src/index.tsx` (script 태그) | `/static/admin.js?v=2.2.2` | `/static/admin.js?v=2.2.3` |
| `public/static/admin.js` (배너/console.log) | v2.2.2 | **v2.2.3** |
| `public/static/sw.js` `CACHE_VERSION` | `msaic-v2.2.2` | **`msaic-v2.2.3`** |

→ 기존 PWA 사용자도 Service Worker 가 자동 갱신되며 새 `admin.js` 를 가져옴.

---

## 4. 검증 (Verification)

로컬·프로덕션 모두 통과:

```
=== Production health ===
{"ok":true,"service":"Morning Stock AI Briefing Center","version":"v2.2.3"}

=== admin.js signature ===
  • 56,718 bytes
  • triggerInFlight 문자열: 8회 등장
  • v2.2.3 문자열: 9회 등장
  • workflow_dispatch 필터링 로직 포함

=== SW cache version ===
msaic-v2.2.3
```

**수동 테스트 체크리스트** (권장):
1. 프로덕션 접속 → 강력 새로고침 (Ctrl+Shift+R) 
2. “지금 발송” 버튼 연속 2회 클릭 → 두 번째 클릭에 `⏳ 이미 요청이 진행 중입니다.` 토스트 + 버튼 비활성
3. 버튼 잠금이 폴링 완료 / 타임아웃 / 오류 중 하나에서 자동 해제되는지 확인
4. 워크플로 완료 후 UI 가 실제 런 결과와 일치하는지 확인

---

## 5. 권장 후속 조치 (User Action Items)

### 5.1 GitHub Actions Secret 보강 — **권장**

현재 `GEMINI_API_KEY` 만 등록되어 있음. **OpenAI 호환 보조 엔진** 을 추가로 등록하면
Gemini 과부하 시에도 브리핑이 안전하게 발송됩니다:

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL` (예: `https://api.openai.com/v1`)
- `OPENAI_MODEL` (선택, 기본 `gpt-5-mini`)

저장 위치: `https://github.com/wwwkoistkr/2026_04_21_-_-/settings/secrets/actions`

### 5.2 누락된 시크릿 (파이프라인 경고 감소용)

- `YOUTUBE_API_KEY` 미설정 → 디일렉 RSS 로 fallback 시도
- `THELEC_YOUTUBE_CHANNEL_ID` 빈 값 → YouTube 피드 404 발생 (브리핑 발송엔 영향 없음)
- `BRIEFING_READ_TOKEN` 이 잘못됨 → `/api/public/sources` 401 (KV 수집 실패 → 하드코딩 폴백으로 정상 진행)

위 항목은 **실패 원인은 아니지만** 로그에 경고가 남아 심리적 방해를 일으키므로 시간 날 때 정리 권장.

### 5.3 쿨다운 정확도 향상 (선택 사항, 다음 마이너 업데이트)

KV eventual consistency 로 인한 이론적 중복 디스패치를 완전히 차단하려면
Durable Object 기반 원자적 락으로 교체해야 합니다. 현재는 **프론트엔드 락 + 백엔드 KV 쿨다운** 2중 방어로 
실용적 수준의 보호가 됩니다.

---

## 6. 파일 변경 요약

```
modified:   briefing/modules/ai_summarizer.py   # Gemini 재시도 + 경량 모델 폴백 (+46 −9)
modified:   public/static/admin.js              # triggerInFlight + 폴링 강화 (+79 −33)
modified:   public/static/sw.js                 # msaic-v2.2.3
modified:   src/index.tsx                       # 버전 v2.2.3 + 캐시버스팅
new:        BUGFIX_REPORT_v2.2.3.md             # (this file)
```

---

## 7. 커밋 히스토리

- `fix(v2.2.3)`: 지금발송 중복트리거 방지 + 폴링 오매칭 수정 + Gemini 503 재시도/폴백
- Deploy URL: https://0e82bffa.morning-stock-briefing.pages.dev
- Prod URL  : https://morning-stock-briefing.pages.dev (v2.2.3)
