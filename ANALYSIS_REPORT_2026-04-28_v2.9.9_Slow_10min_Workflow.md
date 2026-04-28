# 🔬 분석보고서 — v2.9.9 "지금 발송" 워크플로 10분 지연 / 자가복구 능력 점검

> **작성일**: 2026-04-28
> **대상 버전**: v2.9.9.1 (HEAD `711456c`)
> **트리거 사례**: 첨부 스크린샷 #58 — "Morning Stock AI — Daily Briefing (Legacy Single-Stage)" 7:31:38 KST 시작, 9~10분째 in_progress
> **분석 범위**: 자동 스케줄 운영(매일 06:30 KST)의 자가복구(Self‑Recovery) 신뢰성 — "혼자 문제를 만나도 혼자 회복하면서 끝까지 완주해야 함"

---

## 📷 스크린샷에서 읽어낸 사실

| 실행번호 | 시각 (KST) | 상태 | 추정 소요 |
|---|---|---|---|
| **#58** | 4/28 19:31:38 | 🔵 in_progress | 분석 시점에 약 **9~10분 경과** |
| #57 | 4/28 19:09:33 | ✅ completed | 직전 #56 으로부터 +8분 50초 (5분 쿨다운 직후 재시도?) |
| #56 | 4/28 19:00:43 | ✅ completed | 직전 #55 로부터 +20분 8초 |
| #55 | 4/28 18:40:35 | ✅ completed | — |
| #54 | 4/26 16:45:52 | ✅ completed | 1일 26시간 전 |

**관찰 1.** 표기 워크플로는 `Morning Stock AI — Daily Briefing (Legacy Single-Stage)` = `daily_briefing.yml` (단일 단계). 첨부 UI 패널의 "예상 4~7분"은 **레거시 단일 스테이지 기준**이지 정상 운영 경로(3-stage 파이프라인)의 시간이 아님 → **운영 경로 불일치**.

**관찰 2.** #58 이 9~10분째 머물러 있다는 것은 **timeout 한계(15분) 안쪽이지만 v2.9.9 의 "예상 4~7분" 약속을 1.5배 초과** — UI 가 오히려 사용자의 신뢰를 깎는 방향.

**관찰 3.** #57 도 #56 직후 9분만에 다시 시작 → 사용자가 "5분 쿨다운" 만료 후 곧바로 재발송한 패턴. 결과는 success 였지만 **동일 날짜 동일 수신자 이메일이 짧은 간격으로 2번 가능성** (락은 v2.9.2 에 도입됐지만 `daily_briefing.yml`(`run_pipeline()`) 경로는 락을 걸지 않음 → ⚠️ 이중 발송 위험).

---

## 🎯 핵심 문제 5가지 (자가복구 관점)

### ❶ Legacy 단일 스테이지 경로의 SUMMARY_CALL_DELAY_SEC = 6초 (v2.9.9 와 모순)

**증거 — `.github/workflows/daily_briefing.yml` line 55**:
```yaml
SUMMARY_CALL_DELAY_SEC: ${{ secrets.SUMMARY_CALL_DELAY_SEC || '6' }}
```

**증거 — `briefing/modules/ai_summarizer.py` line 173**:
```python
SUMMARY_CALL_DELAY_SEC = float(os.getenv("SUMMARY_CALL_DELAY_SEC", "3"))  # ← 코드 기본값 3초
```

**증거 — `daily_02_summarize.yml` line 51**:
```yaml
SUMMARY_CALL_DELAY_SEC: ${{ secrets.SUMMARY_CALL_DELAY_SEC || '6' }}
```

🔴 **결론**:
- `summarize_with_gemini` 가 호출하는 모듈 **기본값은 3초** (v2.9.9 변경)
- 하지만 GitHub Actions 워크플로 **3개 모두 환경변수로 6초 강제 주입**
- "지금 발송" 으로 트리거된 #58 은 실제로 **15건 × 6초 = 90초** 의 라이트 케이스가 아니라
- **15건 × (6초 + Gemini 응답 ~6~12초) ≈ 3~4.5분** + 이전/이후 단계 → 합치면 4~6분
- 첫 호출이 429 적응형 백오프에 걸리면 (`+2초씩, max 8초`) **8초 × 15건 = 2분** 추가
- 따라서 **9~10분 진입은 정상 범위 내 worst case**, 하지만 사용자 UI 표기와 불일치

> **사용자 UI 가 "AI 요약 ~3분 (병목)" 이라고 적은 근거인 3초 딜레이는 워크플로 환경변수에 주입되지 않아 무력화됨.**

### ❷ "Legacy Single-Stage" 가 아직 살아있고 UI 에서 그것이 호출됨

**증거 — `src/index.tsx` line 88, 2399**:
```typescript
const DEFAULT_WORKFLOW_FILE = 'daily_briefing.yml'  // (line 88 부근)
// ...
all: c.env.GITHUB_WORKFLOW_FILE || DEFAULT_WORKFLOW_FILE,  // (line 2399)
```

- "지금 발송" 버튼 → `stage='all'` → `daily_briefing.yml` 호출
- `daily_briefing.yml` 은 `python main.py all` → `run_pipeline()` (단일 프로세스)
- `run_pipeline()` 은 v2.9.2 에서 도입한 **KV 락(중복발송 방지) / 4회 재시도(Stage3) / 관리자 알림 메일** 등 자가복구 인프라를 **사용하지 않음**

**자가복구 인프라 비교** (모두 `main.py` 안):
| 안전망 기능 | `run_pipeline()` (Legacy) | `run_stage_send()` (3-stage) |
|---|---|---|
| KV 락 (이중 발송 방지) | ❌ 없음 | ✅ `_acquire_send_lock()` |
| 요약 결과 4회 재시도 + 점진 백오프 | ❌ 없음 | ✅ `_fetch_today_summary_with_retry()` |
| Stage 2 결과 부재 시 로컬 백업 폴백 | ❌ 없음 (단일 프로세스라 메모리에 있음) | ✅ |
| 발송 실패 시 관리자 Gmail 알림 | ❌ 없음 | ✅ `_send_failure_alert_email()` |
| 재시도 통계 KV 기록 | ❌ 없음 | ✅ `_record_retry_stats()` |

🔴 **결론**: **수동 트리거 경로(=사용자가 매일 만지는 경로)가 자동 운영 경로보다 더 취약** — 문제 발견율은 수동 경로에서 더 높음에도 불구.

### ❸ 폴링 타임아웃과 워크플로 timeout 의 어긋남

**증거 — `public/static/admin.js` line 1807**:
```javascript
const MAX_MIN = 8  // v2.9.7: 5→8분 확장
```

**증거 — `daily_briefing.yml` line 22**:
```yaml
timeout-minutes: 15
```

🔴 **결론**: 워크플로는 **최대 15분** 까지 살 수 있는데, UI 폴링은 **8분** 에 포기.
- 9~10분째에 #58 처럼 진행 중이면 → UI 는 "폴링 시간 초과" 경고 + 자기 잠금 해제 → **사용자는 실패로 오인**
- 그러나 GitHub Actions 는 그 후 success 로 종료할 수도 있음 → 이메일은 도착하지만 사용자는 이미 "강제 해제" 누르고 다시 "지금 발송" → **이중 발송**

**자동 운영 관점**:
- 06:30 cron 이 정상이면 어떻게 되는가? Legacy 단일 스테이지는 schedule 에서 제거됐고(line 11 코멘트), 실제 자동 실행은 3-stage (`05:50 → 06:00 → 06:45 KST`) → 단일 스테이지는 사용자 수동 경로 전용. 자동 운영은 별 영향 없음.

### ❹ 자동 활성화(v2.9.7) 후 폴링이 sinceMs 일치 실패 가능성

**증거 — `src/index.tsx` line 2521~2532** (v2.9.7 자동 enable + 1초 후 재 dispatch):
```typescript
await new Promise(r => setTimeout(r, 1000))
const retryResp = await fetch(dispatchUrl, { ... })
```

**증거 — `admin.js` line 1748**:
```javascript
const requestSentAt = Date.now()
let res
try {
  res = await triggerApi.run(dryRun)
}
// ...
startPolling(requestSentAt, dryRun)  // sinceMs = 사용자가 버튼 누른 시각
```

**증거 — `admin.js` line 1894~1898** (sinceMs 매칭):
```javascript
const candidates = data.runs.filter((r) => {
  const createdMs = new Date(r.created_at).getTime()
  return createdMs >= sinceMs - 60000   // ← -60초 여유
})
```

🟡 **결론**: 자동 활성화 분기가 enable + 1초 + 재 dispatch 까지 **2~3초 지연** → `created_at` 은 client 가 기록한 `requestSentAt` 보다 늦지만, `-60000ms` 여유로 매칭은 가능. **현재로서는 OK**, 그러나 GitHub 가 dispatch 받고 실제 run 을 만드는 데 추가로 5~15초 걸리는 경우 — 첫 폴링(10초) 이 빈손으로 돌아오는 일은 종종 발생할 것.

### ❺ Cron 스케줄 정상성 점검

| 워크플로 | UTC cron | KST 환산 | 정상? |
|---|---|---|---|
| daily_01_collect.yml | `50 20 * * *` | **05:50** | ✅ |
| daily_02_summarize.yml | `0 21 * * *` | **06:00** | ❌ 코멘트 (`06:10`) 와 **불일치** |
| daily_03_send.yml | `45 21 * * *` | **06:45** | ❌ 코멘트 (`06:25`) 와 **불일치** |
| daily_briefing.yml | (없음) | (legacy) | ✅ — 수동 전용 |

🟡 **확인**: cron 자체는 v2.9.4 에서 `06:00 / 06:00 / 06:45` 로 조정되어 작동은 한다 (커밋 `8603e79`, `a9de563`, `e115848`).
- **Stage 1 (collect)** 05:50 → 약 5~6분 소요
- **Stage 2 (summarize)** 06:00 → 약 6~8분 소요 (병목)
- **Stage 3 (send)** 06:45 → Stage 2 완료 후 **약 30분 여유** (락+4회 재시도가 잘 작동하는 구조)

🔴 **하지만**: `daily_02_summarize.yml` 의 코멘트(주석) 에는 여전히 `06:10` 이라 적혀 있고, `daily_03_send.yml` 의 코멘트엔 `06:25` 라 적혀 있음 → **주석과 실제가 불일치 → 미래의 사람이 잘못 수정할 위험.**

---

## 🛡️ 자가복구 능력(Resilience) 평가표

> "이 앱은 매일 06:30 KST 자동 실행 → 혼자 문제 만나도 혼자 회복해서 발송까지 가야 한다." 라는 사용자 요구에 대한 점검.

### A. 자동 스케줄 경로 (3-stage, 매일 새벽)

| 시나리오 | 현재 대응 | 점수 |
|---|---|---|
| Stage 1 수집 0건 | `_safe_notify_error("collected", ...)` 후 종료. **다음날까지 무대응** | 🟡 4/10 |
| Stage 1 KV 업로드 실패 | 로컬 백업 남아도 다음 단계가 못 읽음 (Stage 2 가 KV 만 봄, 로컬 백업 폴백 있음 ✅) | 🟢 7/10 |
| Stage 2 Gemini 무료 쿼터 초과 | `_call_with_retry` → 4모델 폴백 → OpenAI 폴백 → 적응형 백오프 | 🟢 9/10 |
| Stage 2 모두 실패 | `_safe_notify_error("summary", ...)` 후 종료. Stage 3 가 KV 빈손 → 4회 재시도 → 관리자 알림 | 🟢 8/10 |
| Stage 3 Stage2 직전 실패 | 4회 재시도 (60→90→120초) + 락 + 알림 메일 | 🟢 9/10 |
| Stage 3 SMTP 발송 실패 | `_send_failure_alert_email` 시도 (역시 SMTP 라 같이 죽을 가능성) | 🟡 5/10 |
| 워크플로 자체 disabled (60일 미커밋) | **자동 운영에서는 복구 불가** — UI 의 "지금 발송" 만 v2.9.7 자동 enable 보유 | 🔴 2/10 |
| GitHub Actions 쿼터 소진 | 무대응 — 다음 달까지 발송 안 됨 | 🔴 1/10 |
| 시크릿 만료 (PAT 토큰, OPENAI_API_KEY 등) | 무대응 — 알림 없음 | 🔴 2/10 |

**자동 경로 평균: 5.2/10 — Stage 2/3 는 견고하지만 인프라 레이어(disabled, quota, secret) 무방비.**

### B. 수동 트리거 경로 (Legacy single-stage = `daily_briefing.yml`)

| 시나리오 | 현재 대응 | 점수 |
|---|---|---|
| 모든 단계 실패 시 | `run_pipeline()` 은 `return 1` 만 함, 부분 결과 없음 | 🔴 3/10 |
| 락 / 이중 발송 | **락 없음** — 5분 쿨다운만 의존 | 🔴 2/10 |
| Stage 2 결과 4회 재시도 | **없음** (단일 프로세스라 메모리에 있어서 그런 코드 자체 없음) | n/a |
| 워크플로 disabled 시 | UI(v2.9.7) 가 자동 enable 후 재 dispatch ✅ | 🟢 9/10 |
| 9~10분 가다 timeout 15분 | 결국 종료, 이메일 발송 시점이 지나면 안 감 | 🟡 5/10 |

**수동 경로 평균: 4.5/10 — UI 레벨 자가복구는 좋지만 파이프라인 자체는 약함.**

---

## 💊 처방 — 우선순위별 개선안

### 🟢 즉시 적용 가능 (Quick Win, 30분 이내)

#### **P-1.** `daily_briefing.yml` / `daily_02_summarize.yml` 의 `SUMMARY_CALL_DELAY_SEC` 기본값을 `6` → `3` 으로 변경

```diff
- SUMMARY_CALL_DELAY_SEC: ${{ secrets.SUMMARY_CALL_DELAY_SEC || '6' }}
+ SUMMARY_CALL_DELAY_SEC: ${{ secrets.SUMMARY_CALL_DELAY_SEC || '3' }}
```

**효과**:
- 15건 × 3초 = 45초 (현재 90초) → **약 45초 단축**
- 적응형 백오프(429 시 +2초)는 그대로 살아있어 안전성은 유지
- v2.9.9 의 코드 기본값(3초)과 워크플로 환경변수 기본값을 **일치**시킴 → 향후 혼동 방지

#### **P-2.** 폴링 MAX_MIN 8 → 12 분으로 확장 (워크플로 timeout 15분 - 큐 대기 3분 = 안전 마진 12분)

```diff
- const MAX_MIN = 8  // v2.9.7: 5→8분 확장
+ const MAX_MIN = 12 // v2.9.10: 8→12분 (timeout 15분 - 큐 대기 3분 안전 마진)
```

**효과**: 이번 #58 처럼 9~10분 걸리는 케이스도 사용자가 "실패" 로 오인하지 않음.

#### **P-3.** 주석 cron 시각 실제와 일치시키기

```diff
# daily_02_summarize.yml
-    # 06:10 KST (= 21:10 UTC) — collect(06:00) 완료 후 10분 여유
+    # 06:00 KST (= 21:00 UTC) — collect(05:50) 완료 후 10분 여유

# daily_03_send.yml
-    # 06:25 KST (= 21:25 UTC) — summarize(06:10) 완료 후 15분 여유
+    # 06:45 KST (= 21:45 UTC) — summarize(06:00) 완료 후 45분 여유 (15분 timeout 3개 직렬)
```

#### **P-4.** UI 의 "예상 4~7분" 라벨 → **"예상 5~9분"** 으로 솔직하게 변경 (Legacy 경로 기준)

`src/index.tsx` line 484, `admin.js` line 1723/1729, polling progress 의 `totalEstSec = 360` 도 `480` (8분) 으로 조정.

### 🟡 중기 개선 (1~2시간)

#### **P-5.** "지금 발송" 의 기본 stage 를 `all` (Legacy) → `send` (Stage 3-only) 또는 새로운 `all_v2` (3-stage 직렬) 로 마이그레이션

**현재**: 사용자가 버튼 누르면 30 KB 입력 → AI 호출 → 메일 발송 = 모든 위험을 한 워크플로에 집중.
**대안 A**: "지금 발송" = 오늘 KV 에 이미 있는 요약을 다시 보내기만 (= `stage=send`). 30초 만에 끝남.
**대안 B**: 새 `daily_pipeline_v2.yml` 이 3-stage 를 `needs:` 로 직렬 실행 → 자가복구 인프라 100% 활용.

→ 사용자 의도를 들어봐야 할 부분 (수동 발송 시에도 "최신 뉴스 수집부터 재시작" 인지 / "오늘 분 재발송" 인지).

#### **P-6.** `run_pipeline()` (Legacy) 에도 KV 락 + Stage 3-style 재시도 + 관리자 알림 도입

`run_pipeline()` 끝부분에 `_acquire_send_lock(date)` 한 줄만 추가해도 이중발송 위험 0 으로 차단.

#### **P-7.** 폴링이 timeout 분기로 빠져도 **버튼 잠금은 유지** (5분 더)

현재: timeout → `release()` → 버튼 재활성화 → 사용자가 또 누름 → 이중발송.
개선: timeout 분기에서 `triggerInFlight = false` 호출 직전에 "5분 잠금 + 자동 재폴링" 옵션 제공.

### 🔴 인프라 레이어 (전면 보강)

#### **P-8.** 시크릿 / 쿼터 / disabled 자가 점검 cron (매일 05:30 KST, 메인 파이프라인 30분 전)

새 워크플로 `health_check.yml` 추가:
```yaml
on:
  schedule:
    - cron: '30 20 * * *'   # 05:30 KST
jobs:
  health:
    steps:
      - name: Check Gemini quota left
      - name: Check OpenAI quota left
      - name: Check Cloudflare KV reachable
      - name: Check workflow enabled state (self-introspect)
      - name: If any failure → send alert email to EMAIL_SENDER
```

→ 06:00 발송 시점에 이미 문제를 알고 있는 상태 = 진짜 자가복구.

#### **P-9.** 메인 파이프라인이 GitHub Actions 외부에 **이중화 백업 트리거** 보유

Cloudflare Cron Triggers (Workers) 에서 06:50 KST 에 "오늘 발송 됐는지" 점검 → 안 됐으면 `daily_03_send.yml` 자동 재 dispatch (이미 v2.9.7 자동 enable 인프라 활용).

```typescript
// wrangler.jsonc
{
  "triggers": { "crons": ["50 21 * * *"] }  // 06:50 KST
}
// src/index.tsx
export default {
  scheduled(event, env) {
    // 1. 오늘 latest-run 조회 → 발송 완료 여부 판단
    // 2. 미완료면 PAT 로 daily_03_send.yml 자동 재 dispatch
    // 3. 결과를 KV (recovery:YYYYMMDD) 에 기록
  }
}
```

#### **P-10.** Stage 3 의 `_send_failure_alert_email` 이 Gmail SMTP 와 운명 공동체 → **별도 채널 추가** (예: Cloudflare Worker 가 직접 RESEND/SENDGRID API 호출)

지금은 메일 보내는 SMTP 가 죽으면 알림도 못 감 = 단일 점.

---

## 📊 정리 — 자가복구 신뢰도 등급표 (현재 vs 개선 후)

```
                  현재(v2.9.9.1)        P1~P7 적용 후      P8~P10 까지
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
자동 06:30 발송 안정성    ▓▓▓▓▓░░░░░ 52%  ▓▓▓▓▓▓▓░░░ 68%   ▓▓▓▓▓▓▓▓▓▓ 95%
수동 트리거 안정성        ▓▓▓▓▓░░░░░ 45%  ▓▓▓▓▓▓▓▓░░ 78%   ▓▓▓▓▓▓▓▓▓▓ 95%
이중발송 방지             ▓▓░░░░░░░░ 20%  ▓▓▓▓▓▓▓▓░░ 80%   ▓▓▓▓▓▓▓▓▓▓ 100%
사용자 UI 정확성          ▓▓▓▓▓░░░░░ 50%  ▓▓▓▓▓▓▓▓▓░ 90%   ▓▓▓▓▓▓▓▓▓▓ 95%
인프라 레이어 자기인식    ▓░░░░░░░░░ 10%  ▓░░░░░░░░░ 10%   ▓▓▓▓▓▓▓▓▓░ 90%
```

---

## 🚀 권장 다음 단계 (네가 결정할 부분)

1. **(가장 추천)** P-1 ~ P-4 를 묶어서 **v2.9.10** 으로 즉시 패치 → 30분 이내 끝남, 이번 #58 의 사용자 혼동 즉시 해소.
2. **(중기)** P-5 의 "지금 발송 = stage=send" 전환 vs "3-stage 직렬 실행" 중 사용자 의도 확인.
3. **(장기)** P-8/P-9 (외부 health check + Cloudflare Cron 이중화) 를 v2.10.0 의 메인 테마로.

> 어떤 처방부터 적용할지 알려주면, 그 패치를 바로 코딩 + 테스트 + 커밋까지 마치겠다.

— 분석 끝
