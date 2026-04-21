# 🔴 긴급 버그 수정 보고서 — Morning Stock AI v2.2.2

**작성일**: 2026-04-21
**심각도**: 🔴 Critical (UI 전체 모달 기능 사용 불가)
**영향 범위**: PC 브라우저 (화면 너비 ≥ 640px) — 전체 사용자 중 대부분

---

## 1. 증상 (What the user saw)

### 사용자 스크린샷 증거
- 소스 목록에서 **편집 버튼 클릭** → "소스 편집" 모달이 열림
- 그러나 **모달 본문(label, URL, 검색어 입력란 등)이 완전히 비어있음**
- "취소" / "저장" 버튼만 보이는 껍데기 모달
- DevTools 콘솔에는 `[MorningStock] Admin v2.2.1 초기화 중…` 등 정상 로그가 출력됨
- 얼핏 `Cannot read properties of undefined (reading 'map')` 류의 JS 런타임 에러로 보였음

### 재현 조건
1. PC 브라우저 (Chrome, Edge, Firefox, Safari — 화면 폭 ≥ 640px)
2. 로그인 후 대시보드 진입
3. 아무 소스나 편집 버튼 클릭
4. ❌ **모달이 빈 상태로 표시됨**

모바일(< 640px)에서는 정상 작동 → PC에서만 재현.

---

## 2. 잘못 짚었던 진단 (False leads)

아래는 버그를 찾는 과정에서 초기에 의심했던 원인들. **모두 아니었음**:

| 의심 항목 | 확인 결과 |
|-----------|-----------|
| `source.queries`가 undefined | ❌ API 응답 확인, 모든 소스에 정상 배열 존재 |
| `presetCatalog`가 아직 로드 안됨 | ❌ `loadPresets()` 정상 완료, safePresets 가드도 있음 |
| `escapeHtml(undefined)` 크래시 | ❌ `String(s ?? '')` 로 이미 방어됨 |
| Service Worker 캐시 stale | 🟡 부분적 (v2.2.1에서 이미 해결, 그런데도 v2.2.1 빌드에서 여전히 재현) |
| `document.getElementById('modalBody')`가 null | ❌ HTML에 엘리먼트 존재, DOM 파싱 정상 |
| try-catch 누락 | ❌ 이미 try-catch로 감쌌음 |
| `closeModal` 재선언 문제 | ❌ 이전에 수정됨 |

**결정적 단서**: 사용자 스크린샷에서 모달 타이틀이 `"소스 편집"` (HTML 초기값) 그대로였음.
→ `openEditModal` 내부에서 `modalTitle.textContent = ...` 가 실행되기 전에 이미 모달이 열려있었음을 의미.
→ **"편집 버튼 클릭이 원인이 아니라, 페이지 로드 시점부터 모달이 숨겨지지 않았던 것"** 이라는 가설에 도달.

---

## 3. 🎯 진짜 원인 (Root Cause) — CSS Specificity 충돌

### 문제의 HTML (src/index.tsx)
```tsx
<div id="editModal"
  class="hidden fixed inset-0 bg-black/50 z-50
         sm:flex sm:items-center sm:justify-center sm:p-4">
```

### Tailwind가 생성하는 CSS

```css
/* 베이스 레이어 */
.hidden {
  display: none;
}

/* sm: 프리픽스 (min-width: 640px 이상에서 적용) */
@media (min-width: 640px) {
  .sm\:flex {
    display: flex;
  }
}
```

### CSS 캐스케이드 규칙 분석

두 규칙의 **specificity 는 동일** `(0, 1, 0)` (클래스 1개씩).
동점일 때 CSS는 **스타일시트 내 선언 순서가 뒤인 것을 적용** (Tailwind는 `.hidden` → `.sm:flex` 순으로 컴파일).

**그러나 진짜 결정타**는 **미디어쿼리의 매칭**:

| 화면 폭 | `.hidden` | `.sm:flex` | 최종 `display` |
|---------|-----------|-----------|--------------|
| < 640px (모바일) | `none` ✓ | 매칭 안됨 | **`none`** ✅ 정상 |
| ≥ 640px (PC) | `none` | `flex` ✓ | **`flex`** ❌ 버그 |

→ **PC에서는 `editModal`이 처음 로드 시점부터 `display: flex`가 되어 화면에 보이고 있었음.**
→ 모달 "div"는 보이지만 내부 `#modalBody`는 비어있는 상태 (JS가 아직 채우지 않음).
→ 사용자는 "편집 버튼 누르니 빈 모달이 떴다"고 인식했지만,
**실제로는 처음부터 계속 보이고 있었고, 편집 버튼이 다시 누를 때마다 `modalTitle`만 업데이트**되고 있었음.

### 왜 지금껏 눈에 안 띄었나?

- `modalBody`가 비어있을 때 `<div id="editModal">`은 내부 요소가 없어 **배경 블러 레이어만 보임**
- 뒤에 있는 대시보드 UI가 `z-50` 뒤로 밀리면서 반투명 검은 배경에 덮여 있었음
- `openEditModal`이 `modalTitle`을 업데이트하면 그제서야 "소스 편집" 타이틀이 바뀌어 사용자가 비로소 모달을 "열렸다"고 인식

**즉, 처음 페이지 진입 직후부터 이미 모달이 상시 표시 중이었던 숨은 버그였음.**

### 왜 `modal.classList.add('hidden')` 이 효과 없었나?

```javascript
function closeModal() {
  modal.classList.add('hidden')  // 이 줄을 실행해도...
}
```

`.hidden` 클래스를 DOM에 추가해도, 같은 요소에 `.sm:flex`가 여전히 있고,
**PC 해상도에서는 `sm:flex`가 미디어쿼리 매칭으로 `display: flex`를 강제**하므로
사용자 눈에는 모달이 **계속 보임**.

---

## 4. 수정 방안 (Fix)

### 4.1 CSS 전용 룰 추가 (`public/static/style.css`)

```css
/* specificity 를 강하게 올린 전용 상태 클래스 */
.modal-hidden,
.modal-hidden[class] {
  display: none !important;
}

.modal-visible,
.modal-visible[class] {
  display: flex !important;
  align-items: center;
  justify-content: center;
}

.toast-hidden { display: none !important; }
.toast-visible { display: block !important; }
```

**핵심 기법**:
1. `!important` — Tailwind 미디어쿼리 규칙 압도
2. `[class]` 속성 셀렉터 — specificity 를 `(0, 2, 0)` 으로 올려 혹시 있을 다른 충돌 방지
3. 모바일 모달 풀스크린 규칙도 포함 (모바일 UX 유지)

### 4.2 HTML 클래스 교체 (`src/index.tsx`)

```diff
- <div id="editModal" class="hidden fixed ... sm:flex sm:items-center sm:justify-center sm:p-4">
+ <div id="editModal" class="modal-hidden fixed inset-0 bg-black/50 z-50 p-4">
```

`confirmModal`, `toast` 도 동일하게 교체.

### 4.3 JS 헬퍼 도입 (`public/static/admin.js`)

```javascript
function showModal(el) {
  if (!el) return
  el.classList.remove('modal-hidden', 'hidden')
  el.classList.add('modal-visible')
}
function hideModal(el) {
  if (!el) return
  el.classList.remove('modal-visible')
  el.classList.add('modal-hidden')
}
```

모든 모달 표시/숨김 로직을 이 헬퍼로 통일.
추가 가드:
- `renderModalBody` 중 에러 발생 시 `hideModal(modal)` 호출 → 빈 모달 노출 차단
- `modal` / `modalBody` 가 `null` 이면 토스트로 알림 후 중단

### 4.4 토스트 함수 수정
```diff
- el.classList.remove('hidden')
- toast._t = setTimeout(() => el.classList.add('hidden'), 3000)
+ el.className = 'toast-visible ' + (palette[type] || palette.info)
+ toast._t = setTimeout(() => {
+   el.className = 'toast-hidden ' + /* ... */
+ }, 3000)
```

### 4.5 `showConfirm` 안전장치
`confirmModal` 이 DOM 에서 사라진 경우 `window.confirm` 으로 fallback.

---

## 5. 검증 (Verification)

### 배포 URL
- 프로덕션: https://morning-stock-briefing.pages.dev (v2.2.2)
- Preview: https://5aaf1539.morning-stock-briefing.pages.dev
- GitHub: commit `c8a984e`

### 서빙 자산 검증
```bash
$ curl https://morning-stock-briefing.pages.dev/api/health
{"ok":true,"service":"Morning Stock AI Briefing Center","version":"v2.2.2"}

$ curl https://morning-stock-briefing.pages.dev/static/admin.js | grep -c "modal-hidden\|modal-visible"
6  # ✓ 6 occurrences

$ curl https://morning-stock-briefing.pages.dev/static/style.css | grep -c "modal-hidden\|modal-visible"
6  # ✓ 6 rules

$ curl https://morning-stock-briefing.pages.dev/ | grep 'id="editModal"'
id="editModal" class="modal-hidden fixed inset-0 bg-black/50 z-50 p-4"
# ✓ hidden / sm:flex 제거 확인
```

### Service Worker 자동 갱신
- SW 버전 `msaic-v2.2.0` → `msaic-v2.2.2`
- 기존 캐시 자동 삭제
- controllerchange 이벤트로 활성 탭 자동 새로고침
- admin.js 에 `?v=2.2.2` 쿼리스트링으로 HTML 파서 레벨 캐시 무효화

### 실전 테스트 시나리오 (사용자가 직접 확인 가능)
1. https://morning-stock-briefing.pages.dev 접속
2. 로그인 (admin1234)
3. **F12 → Application → Service Workers → "Update"** 로 수동 갱신 (또는 그냥 30초 대기 후 새로고침)
4. 아무 소스의 ✏️ 편집 버튼 클릭
5. ✅ 모달이 **완전히 채워진 상태**로 열림 (label, URL, 검색어 행, 저장 버튼 활성)
6. ✅ 취소 누르면 모달이 **완전히 사라짐** (PC에서도)

---

## 6. 배운 것 (Lessons Learned)

### 6.1 Tailwind `hidden` + 반응형 프리픽스 조합의 함정

**절대 이렇게 쓰지 말 것**:
```html
<div class="hidden sm:flex">  <!-- 💀 PC에서 항상 보임 -->
```

**올바른 사용법**:
```html
<!-- PC만 보이게: -->
<div class="hidden sm:block">  <!-- sm:block 은 sm:flex와 다른 맥락에서 OK -->

<!-- 모바일만 보이게: -->
<div class="sm:hidden">

<!-- JS로 토글되는 요소: -->
<div class="modal-hidden" data-state="closed">  <!-- 전용 CSS 상태 클래스 사용 -->
```

**JS 로 토글되는 모달·드롭다운·토스트는 Tailwind 반응형 클래스와 `hidden`을 섞지 말 것.**

### 6.2 UI 버그를 런타임 JS 에러로 오인하는 함정

- "모달이 비어있다" → 반사적으로 `Cannot read ... of undefined` 를 의심
- 실제로는 **JS는 정상 실행됐고, CSS가 모달을 숨기지 못한 것** 뿐이었음
- DOM / JS / CSS 세 계층을 분리해서 조사하는 훈련이 필요

### 6.3 디버깅 전략

다음 순서로 접근했으면 더 빨리 찾았을 것:
1. ✅ JS 콘솔 에러 확인
2. ✅ 네트워크 응답 확인 (API 데이터)
3. ⭐ **DevTools Elements 탭에서 `editModal` 의 computed style 을 봤다면 `display: flex` 를 즉시 확인**
4. ⭐ **하지만 원격 진단 (스크린샷 기반) 에서는 Step 3 가 불가** → 코드 리뷰로 CSS specificity 충돌을 찾는 것이 정답

### 6.4 회귀 방지

- `.hidden` + `sm:flex` 같은 조합 사용 시 **lint rule** 로 차단 (추후 stylelint/eslint 커스텀 룰 도입 검토)
- 모든 동적 표시/숨김 UI 는 전용 상태 클래스로만 제어
- E2E 테스트: 모달 열기/닫기 → `getBoundingClientRect().width === 0 && height === 0` 검사

---

## 7. 버전 히스토리

| 버전 | 날짜 | 변경 |
|------|------|------|
| v2.0 | 2026-04-21 | 키워드 기반 수집 확장 |
| v2.1 | 2026-04-21 | PWA + 지금 발송 버튼 + 모바일 반응형 |
| v2.2 | 2026-04-21 | 에러 수정 시도 + 8K 해상도 + PC↔모바일 동기화 |
| v2.2.1 | 2026-04-21 | SW 캐시 강제 업데이트 + 자동 리로드 |
| **v2.2.2** | **2026-04-21** | 🔴 **CSS specificity 충돌 해결 (핵심 수정)** |

---

## 8. 파일 변경 요약

| 파일 | 변경 내용 |
|------|-----------|
| `public/static/style.css` | `.modal-hidden/visible`, `.toast-hidden/visible` 룰 추가 |
| `src/index.tsx` | 3개 모달 HTML 클래스 교체, 버전 v2.2.2 |
| `public/static/admin.js` | showModal/hideModal 헬퍼, toast 함수, 6개소 적용 |
| `public/static/sw.js` | 캐시 버전 `msaic-v2.2.2` |

---

**작성자**: AI Developer Agent (Claude)
**검토자**: 사용자 (실제 동작 확인 필요)
**관련 커밋**: `c8a984e` — `fix(v2.2.2): CRITICAL - Tailwind hidden vs sm:flex specificity 충돌 수정`
