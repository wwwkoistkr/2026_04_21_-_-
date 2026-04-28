# 분석 보고서: GitHub API 422 — Disabled Workflow 에러

**날짜**: 2026-04-28  
**버전**: v2.9.6.4  
**심각도**: 🔴 높음 (핵심 기능 "지금 발송" 완전 차단)

---

## 1. 에러 현상

### 스크린샷 에러 메시지
```
GitHub API 422: Cannot trigger a 'workflow_dispatch' on a disabled workflow
```

### 발생 위치
- **UI 섹션**: "🚀 지금 즉시 브리핑 발송" 카드
- **버튼**: "지금 발송" 또는 "DRY RUN (미리보기)" 클릭 시
- **API 엔드포인트**: `POST /api/admin/trigger-now`

---

## 2. 근본 원인 (Root Cause)

### GitHub 측 문제
GitHub 저장소 `wwwkoistkr/2026_04_21_-_-`에서 **`daily_briefing.yml` 워크플로우가 비활성화(disabled)** 상태입니다.

GitHub는 다음 경우에 워크플로우를 자동 비활성화합니다:
1. **60일간 워크플로우 활동이 없을 때** (자동 비활성화)
2. **사용자가 수동으로 비활성화했을 때** (Actions 탭 → 워크플로우 → Disable)
3. **저장소를 포크한 후** 기본적으로 비활성화됨

비활성화된 워크플로우에 `workflow_dispatch` API를 호출하면 GitHub는 **HTTP 422** 응답을 반환합니다.

### 앱 코드 측 문제
현재 코드(`src/index.tsx` 2493~2511행)에서 **422 에러에 대한 전용 처리가 없습니다**:

```typescript
// 현재 에러 처리 코드 (src/index.tsx:2503-2511)
return c.json({
  ok: false,
  error: `GitHub API ${resp.status}: ${detail}`,
  hint: resp.status === 401
    ? 'PAT 토큰이 잘못되었거나 만료됨...'
    : resp.status === 404
    ? `워크플로 파일(${workflow})을 찾을 수 없음...`
    : undefined,   // ← 422는 hint가 없음!
}, 502)
```

| HTTP 상태 | 현재 처리 | 문제 |
|---|---|---|
| 401 | ✅ hint 제공 | — |
| 404 | ✅ hint 제공 | — |
| **422** | ❌ hint 없음 | 사용자가 원인·해결방법을 알 수 없음 |

---

## 3. 영향 범위

### 직접 차단되는 기능
| 기능 | 엔드포인트 | 영향 |
|---|---|---|
| 🚀 지금 발송 | `POST /api/admin/trigger-now` (dryRun=false) | ❌ 완전 차단 |
| 🧪 DRY RUN | `POST /api/admin/trigger-now` (dryRun=true) | ❌ 완전 차단 |
| 🔄 스테이지별 재실행 | `POST /api/admin/trigger-now` (stage=collect/summarize/send) | ❌ 해당 yml도 disabled면 차단 |

### 영향받는 워크플로우 파일 목록
```
daily_briefing.yml        ← stage='all' (기본)
daily_01_collect.yml      ← stage='collect'
daily_02_summarize.yml    ← stage='summarize'
daily_03_send.yml         ← stage='send'
```

### 영향 없는 기능
- 대시보드 조회, 소스/수신자 관리, 사용자 점수 등 다른 관리 기능은 정상

---

## 4. 수정 방안

### 방안 A: 자동 활성화 후 재시도 (⭐ 권장)

**전략**: 422 "disabled workflow" 에러 감지 시, GitHub API로 워크플로우를 자동 활성화한 뒤 dispatch를 재시도합니다.

**GitHub Enable Workflow API**:
```
PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable
```
- `workflow_id`에 파일명 사용 가능 (예: `daily_briefing.yml`)
- 성공 시 HTTP 204 반환
- 필요 권한: PAT에 `repo` + `workflow` 스코프 (기존 GITHUB_TRIGGER_TOKEN과 동일)

**수정 대상**: `src/index.tsx` — `POST /api/admin/trigger-now` 핸들러 (2455~2511행)

**구현 로직**:
```
1. dispatch 요청 → 422 수신
2. 응답 메시지에 "disabled" 포함 여부 확인
3. Enable API 호출 (PUT .../enable)
4. 1~2초 대기
5. dispatch 재시도 (1회만)
6. 재시도 성공 시 정상 응답, 실패 시 에러 + 가이드 메시지
```

**장점**: 사용자 개입 없이 자동 복구, UX 최상  
**단점**: 약간의 응답 지연 (~2초), PAT에 Actions write 권한 필요 (기존과 동일)

---

### 방안 B: 422 전용 에러 메시지 + 수동 가이드

**전략**: 422 에러 시 명확한 한글 안내 메시지와 GitHub 링크를 제공합니다.

**수정 대상 1**: `src/index.tsx` — 백엔드 에러 분기 (2503~2511행)
```
422 감지 → hint에 다음 안내 추가:
"워크플로우가 비활성화 상태입니다. GitHub → Actions → daily_briefing.yml → Enable workflow 클릭"
+ 직접 링크: https://github.com/{repo}/actions/workflows/{workflow}
```

**수정 대상 2**: `public/static/admin.js` — 프론트엔드 에러 표시 (1760~1766행)
```
422 disabled 에러 시 특별 UI 표시:
- 빨간 경고 대신 주황 안내 배너
- "활성화하러 가기" 버튼 (GitHub 직접 링크)
```

**장점**: 구현 단순  
**단점**: 사용자가 직접 GitHub에 가서 활성화해야 함

---

### 방안 C: A + B 결합 (최적 권장안)

1. **1차**: 자동 Enable + 재시도 (방안 A)
2. **자동 복구 실패 시**: 상세 가이드 메시지 표시 (방안 B)
3. **422 외 에러에도**: 누락된 에러 코드(403, 409 등) 힌트 보강

---

## 5. 수정 파일 목록 (예상)

| 파일 | 수정 내용 | 난이도 |
|---|---|---|
| `src/index.tsx` (2455~2515행) | 422 감지 → Enable API → 재시도 로직 | 중간 |
| `src/index.tsx` (2503~2511행) | 422/403 등 추가 hint 메시지 | 쉬움 |
| `public/static/admin.js` (1760~1774행) | 프론트엔드 422 전용 UI (선택) | 쉬움 |

**예상 수정 코드량**: ~40~60행 추가/수정

---

## 6. 즉시 해결 방법 (수동)

코드 수정 전 즉시 해결하려면:

1. **GitHub 저장소 접속**: https://github.com/wwwkoistkr/2026_04_21_-_-/actions
2. **좌측 사이드바**에서 `daily_briefing.yml` (또는 해당 워크플로우) 클릭
3. **상단 배너** "This workflow was disabled..." 확인
4. **"Enable workflow"** 버튼 클릭
5. 앱에서 다시 "지금 발송" 시도

> ⚠️ 단, 60일 이상 활동이 없으면 다시 자동 비활성화될 수 있으므로 코드 수정(방안 A/C)이 근본 해결책입니다.

---

## 7. 권장 구현 순서

1. 방안 C (자동 활성화 + 실패 시 가이드) 적용
2. 단위 테스트: 422 응답 시뮬레이션 → Enable → 재시도 성공 확인
3. 스테이지 모드 (`daily_01_*.yml` ~ `daily_03_*.yml`)에도 동일 로직 적용
4. 프로덕션 배포 후 검증
