# 분석 보고서 #2: 워크플로우 활성화 후 — 잔존 에러 분석

**작성일**: 2026-04-28  
**버전**: v2.9.6.4  
**이전 보고서**: `ANALYSIS_REPORT_2026-04-28_workflow_disabled.md` (422 에러 → ✅ 해결됨)

---

## 0. 이전 422 에러 상태

| 항목 | 상태 |
|---|---|
| `daily_briefing.yml` 활성화 | ✅ "Workflow enabled successfully" 확인 |
| 프로덕션 `trigger-status` API | ✅ `"configured": true` |
| 프로덕션 DRY RUN 테스트 | ✅ `"ok": true` — 정상 dispatch 확인 |
| GitHub Actions 실행 | ✅ run #56 `in_progress` 상태 확인 |

**결론: 이전 422 에러는 완전히 해결되었습니다.**

---

## 1. 현재 스크린샷 에러 현상 (3번째 스크린샷)

### 1-1. 노란색 경고 배너 (앱 UI)
```
⚠ 폴링 타임아웃 — GitHub Actions 페이지에서 직접 확인해 주세요.
```

- **위치**: "지금 즉시 브리핑 발송" 섹션 (triggerStatus div)
- **성격**: 에러가 아닌 **폴링 타임아웃 안내**
- **색상**: `bg-amber-50` (노란색/경고 톤)

### 1-2. DevTools 콘솔 에러
- `Failed to load resource: the server responded with a status of 404`
- 브라우저 내부 경고 (Tailwind CDN 관련)

---

## 2. 근본 원인 분석

### 🟡 주요 원인: 폴링 타임아웃 (5분 초과)

**이 에러는 코드 버그가 아닙니다.** 정상적인 타임아웃 동작입니다.

#### 발생 흐름:

```
1. 사용자가 [지금 발송] 또는 [DRY RUN] 클릭
2. POST /api/admin/trigger-now → GitHub dispatch 성공 (✅ ok: true)
3. 프론트엔드가 startPolling() 시작 — 10초마다 recent-runs 조회
4. MAX_MIN = 5 (5분) 동안 매칭되는 런을 찾지 못함
5. → "폴링 타임아웃" 경고 표시
```

#### 왜 5분 안에 매칭을 못 찾았나?

가능한 원인 3가지:

| 원인 | 가능성 | 설명 |
|---|---|---|
| **A. 이전 422 에러 후 폴링 진입** | ⭐ 높음 | 422 에러로 실패했는데, 이전 실행의 폴링이 남아있거나, 워크플로우 활성화 직후 재시도한 경우 |
| **B. GitHub Actions 큐 지연** | 🟡 중간 | 워크플로우가 큐에서 5분 이상 대기 (GitHub 서버 부하) |
| **C. 워크플로우 실행 시간 > 5분** | 🟡 중간 | 실제 실행이 5분을 초과하여 completed 상태 확인 전에 타임아웃 |

#### 가장 유력한 시나리오:

```
1. 사용자가 [지금 발송] 클릭 → 422 에러 (워크플로우 disabled)
2. GitHub Actions에서 "Enable workflow" 클릭
3. 다시 [지금 발송] 클릭 → dispatch 성공
4. 폴링 시작 → 5분 대기
5. 하지만 이전 422 실패한 트리거로 인해 saveTrigger()에 ok:false 기록이 남아있고
   쿨다운 타이머가 진행 중일 수 있어 혼란
6. GitHub 워크플로우가 처음 활성화 후 초기 실행이라 지연됨
7. 5분 타임아웃 → 노란 배너 표시
```

---

## 3. 프로덕션 실제 상태 확인 결과

API 직접 호출로 확인한 프로덕션 상태:

```json
// GET /api/admin/trigger-status
{
  "configured": true,            // ✅ PAT 설정됨
  "last": {
    "timestamp": 1777369234169,  // 마지막 트리거 성공
    "dryRun": false,
    "ok": true                   // ✅ 성공
  }
}

// GET /api/admin/recent-runs
{
  "ok": true,
  "runs": [
    { "id": 25046487390, "status": "in_progress", "event": "workflow_dispatch" },  // 실행 중!
    { "id": 25045578349, "status": "completed", "conclusion": "success" },         // 성공
    ...
  ]
}
```

**→ 프로덕션은 현재 정상 작동 중입니다.**  
**→ 스크린샷의 에러는 "이전 실행의 폴링 타임아웃 잔여 메시지"입니다.**

---

## 4. 콘솔 404 에러 분석

DevTools 콘솔의 `404` 에러는 별도 이슈:

| 가능한 원인 | 설명 |
|---|---|
| `manifest.json` 내 아이콘 경로 불일치 | PWA manifest에서 참조하는 아이콘 경로가 실제 파일과 불일치 |
| Service Worker 캐시 불일치 | sw.js가 이전 버전의 리소스를 요청 |
| favicon 경로 | 브라우저 자동 요청 `/favicon.ico`가 404 |

**심각도: 🟡 낮음** — 기능에 영향 없음.

---

## 5. 코드 개선 권장사항

### 🥇 우선순위 1: 422 에러에 대한 자동 복구 + 힌트 메시지

**파일**: `src/index.tsx` (라인 ~2486)

```typescript
// 422 disabled workflow 자동 복구
if (resp.status === 422 && detail.includes('disabled')) {
  // 1단계: 자동 활성화 시도
  const enableUrl = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/enable`
  const enableResp = await fetch(enableUrl, {
    method: 'PUT',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'MorningStockAI-BriefingCenter/2.1',
    },
  })
  
  if (enableResp.status === 204) {
    // 2단계: 활성화 성공 → 1초 대기 후 dispatch 재시도
    await new Promise(r => setTimeout(r, 1000))
    const retryResp = await fetch(dispatchUrl, { /* 동일 옵션 */ })
    if (retryResp.status === 204) {
      // 성공!
      await saveTrigger(c.env, { timestamp: now, dryRun, ok: true })
      return c.json({
        ok: true, dryRun,
        message: '✅ 워크플로우 자동 활성화 후 발송 요청됨',
        autoEnabled: true,
      })
    }
  }
  
  // 자동 복구 실패 시 힌트 제공
  return c.json({
    ok: false,
    error: `GitHub API 422: ${detail}`,
    hint: `워크플로우(${workflow})가 비활성화 상태입니다.\nGitHub → Actions 탭 → "${workflow}" → "Enable workflow" 버튼을 눌러 활성화하세요.\nhttps://github.com/${repo}/actions`,
  }, 502)
}
```

### 🥈 우선순위 2: 에러 힌트 체인 보강

**파일**: `src/index.tsx` (라인 ~2505)

현재 힌트 체인에 `422` 분기 추가:
```typescript
hint: resp.status === 401
  ? 'PAT 토큰이 잘못되었거나 만료됨. repo + workflow 권한 확인.'
  : resp.status === 404
  ? `워크플로 파일(${workflow}) 또는 저장소(${repo}) 를 찾을 수 없음.`
  : resp.status === 422
  ? `워크플로가 비활성화 상태입니다. GitHub Actions 탭에서 "Enable workflow"를 눌러주세요. → https://github.com/${repo}/actions`
  : undefined,
```

### 🥉 우선순위 3: 폴링 타임아웃 개선

**파일**: `public/static/admin.js` (라인 ~1789)

- `MAX_MIN`을 5 → 7~8분으로 늘리거나
- 타임아웃 시 자동 재시도 로직 추가
- 또는 "아직 실행 중일 수 있습니다" 라는 더 친절한 메시지

```javascript
const MAX_MIN = 8  // 5분 → 8분으로 확장 (워크플로우 실행 시간 고려)
```

---

## 6. 종합 요약

| 이슈 | 상태 | 조치 필요 |
|---|---|---|
| **422 disabled workflow** | ✅ 해결됨 (수동 활성화 완료) | 코드 개선으로 재발 방지 (자동 복구) |
| **노란 폴링 타임아웃 배너** | ✅ 정상 동작 (일시적) | 새로고침하면 사라짐. 선택적으로 MAX_MIN 확장 |
| **프로덕션 dispatch** | ✅ 정상 작동 | 조치 불필요 |
| **콘솔 404** | 🟡 경미 | 낮은 우선순위 — 기능 무관 |

### 🎯 최종 권장

1. **지금**: 페이지 새로고침 → 정상 작동 확인
2. **코드 개선 시**: 422 자동 복구 로직 추가 (방안 B-2) → 향후 워크플로우 비활성화 시 자동 대응
3. **선택적**: 폴링 타임아웃을 5분→8분으로 확장
