# 분석 보고서: GitHub API 422 — disabled workflow 에러

**작성일**: 2026-04-28  
**버전**: v2.9.6.4  
**보고자**: AI Analysis  

---

## 1. 에러 현상

### 1-1. 주요 에러 (스크린샷 #1, #2)
```
GitHub API 422: Cannot trigger a 'workflow_dispatch' on a disabled workflow
```

- **위치**: "지금 즉시 브리핑 발송" 섹션 (빨간 배너)
- **발생 시점**: "지금 발송" 또는 "DRY RUN (미리보기)" 버튼 클릭 시
- **HTTP 상태 코드**: GitHub API가 `422 Unprocessable Entity` 응답

### 1-2. 부차적 에러 (DevTools 콘솔, 스크린샷 #2)
- `Failed to load resource: the server responded with a status of 404` (리소스 로드 실패)
- Tailwind CDN 관련 경고
- DOM 중복 ID 경고

---

## 2. 근본 원인 분석

### 🔴 핵심 원인: GitHub 리포지토리의 워크플로우가 **비활성화(disabled)** 상태

GitHub Actions는 다음 조건에서 워크플로우를 자동 비활성화합니다:

| 자동 비활성화 조건 | 해당 여부 |
|---|---|
| 리포에 **60일 이상 커밋이 없을 때** | ⚠️ 가능성 있음 |
| 사용자가 수동으로 Settings → Actions에서 비활성화 | ⚠️ 가능성 있음 |
| 워크플로우 파일 구문 오류 | 가능성 낮음 (기존에 작동했으므로) |
| 리포 Fork 시 보안상 기본 비활성화 | 가능성 낮음 |

### 에러 발생 흐름

```
사용자 → [지금 발송] 버튼 클릭
  → POST /api/admin/trigger-now
    → 쿨다운/제한 체크 통과
    → GitHub API 호출:
        POST https://api.github.com/repos/wwwkoistkr/2026_04_21_-_-/actions/workflows/daily_briefing.yml/dispatches
    → GitHub 응답: 422 "Cannot trigger a 'workflow_dispatch' on a disabled workflow"
    → 앱이 에러 메시지를 사용자에게 표시
```

---

## 3. 코드 분석

### 3-1. API 호출 코드 (`src/index.tsx` 라인 2456~2470)

```typescript
const dispatchUrl = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`

const resp = await fetch(dispatchUrl, {
  method: 'POST',
  headers: {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  },
  body: JSON.stringify({
    ref: 'main',
    inputs: dispatchInputs,
  }),
})
```

- 코드 자체는 **정상**. GitHub API 스펙에 맞게 올바르게 호출하고 있음.

### 3-2. 에러 처리 코드 (`src/index.tsx` 라인 2495~2512)

```typescript
return c.json({
  ok: false,
  error: `GitHub API ${resp.status}: ${detail}`,
  hint: resp.status === 401
    ? 'PAT 토큰이 잘못되었거나 만료됨...'
    : resp.status === 404
    ? `워크플로 파일(${workflow}) 또는 저장소(${repo}) 를 찾을 수 없음.`
    : undefined,   // ← 422에 대한 힌트가 없음!
}, 502)
```

**문제점**: `422` 에러에 대한 전용 힌트가 없음. 사용자가 에러를 보고 **무엇을 해야 하는지** 알 수 없음.

### 3-3. 대상 워크플로우 파일

| 변수 | 값 |
|---|---|
| `DEFAULT_GITHUB_REPO` | `wwwkoistkr/2026_04_21_-_-` |
| `DEFAULT_WORKFLOW_FILE` | `daily_briefing.yml` |
| 스테이지별 워크플로우 | `daily_01_collect.yml`, `daily_02_summarize.yml`, `daily_03_send.yml` |

---

## 4. 해결 방안

### 방안 A: 즉시 해결 (GitHub 웹에서 수동 조치) ⭐ 권장

1. **GitHub 리포 방문**: https://github.com/wwwkoistkr/2026_04_21_-_-/actions
2. 좌측 사이드바에서 `daily_briefing.yml` (또는 해당 워크플로우) 클릭
3. **"Enable workflow"** 버튼 클릭하여 워크플로우 재활성화
4. 스테이지별 워크플로우도 동일하게 확인:
   - `daily_01_collect.yml`
   - `daily_02_summarize.yml`
   - `daily_03_send.yml`

> 이 조치만으로 즉시 정상 작동합니다. 코드 수정이 필요 없습니다.

### 방안 B: 코드 개선 (재발 방지 + UX 개선)

#### B-1. 422 에러에 대한 힌트 메시지 추가

**파일**: `src/index.tsx` (라인 ~2505)

현재:
```typescript
hint: resp.status === 401
  ? 'PAT 토큰이 잘못되었거나 만료됨...'
  : resp.status === 404
  ? '워크플로 파일... 를 찾을 수 없음.'
  : undefined,
```

개선 방향:
```typescript
hint: resp.status === 401
  ? 'PAT 토큰이 잘못되었거나 만료됨...'
  : resp.status === 404
  ? '워크플로 파일... 를 찾을 수 없음.'
  : resp.status === 422
  ? `워크플로(${workflow})가 비활성화 상태입니다. GitHub → Actions 탭에서 "Enable workflow" 버튼을 눌러 활성화하세요.`
  : undefined,
```

#### B-2. 자동 워크플로우 활성화 시도 (선택적)

GitHub API로 워크플로우를 프로그래밍 방식으로 활성화할 수 있습니다:

```typescript
// 422 에러 시 자동 활성화 시도
if (resp.status === 422 && detail.includes('disabled')) {
  const enableUrl = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/enable`
  const enableResp = await fetch(enableUrl, {
    method: 'PUT',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (enableResp.status === 204) {
    // 활성화 성공 → 원래 dispatch 재시도
    // ...
  }
}
```

> ⚠️ 이 방안은 PAT에 `actions:write` 권한이 필요합니다.

#### B-3. 트리거 전 워크플로우 상태 사전 확인 (선택적)

```
GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}
```
응답의 `state` 필드가 `"disabled_inactivity"` 또는 `"disabled_manually"`이면 사전에 사용자에게 안내.

---

## 5. DevTools 콘솔 부차적 이슈

| 이슈 | 심각도 | 설명 |
|---|---|---|
| `404 Failed to load resource` | 🟡 낮음 | 특정 정적 리소스 로드 실패. favicon 또는 manifest 관련 가능성 |
| Tailwind CDN 경고 | ⚪ 무시 가능 | CDN 방식 사용 시 항상 발생하는 정보성 경고 |
| DOM 중복 ID | 🟡 낮음 | HTML에 동일 ID가 2개 이상 존재. 기능에 영향 적음 |

---

## 6. 권장 조치 우선순위

| 순위 | 조치 | 난이도 | 효과 |
|---|---|---|---|
| 🥇 1 | GitHub Actions에서 워크플로우 수동 활성화 (방안 A) | ⭐ 즉시 | 에러 즉시 해결 |
| 🥈 2 | 422 에러 힌트 메시지 추가 (방안 B-1) | 코드 수정 소 | 재발 시 사용자가 자가 해결 가능 |
| 🥉 3 | 자동 활성화 로직 추가 (방안 B-2) | 코드 수정 중 | 사용자 개입 없이 자동 복구 |
| 4 | 트리거 전 상태 사전 확인 (방안 B-3) | 코드 수정 중 | 더 나은 UX |

---

## 7. 요약

> **이 에러는 코드 버그가 아닙니다.**  
> GitHub Actions의 `daily_briefing.yml` 워크플로우가 **비활성화** 상태이기 때문에 발생합니다.  
> GitHub 리포의 Actions 탭에서 **"Enable workflow"**를 클릭하면 즉시 해결됩니다.  
> 다만, 코드에서 422 에러에 대한 안내 메시지가 없어 사용자가 원인을 파악하기 어려우므로,  
> 힌트 메시지 추가 및 자동 활성화 로직을 보완하면 재발 시에도 원활한 사용이 가능합니다.
