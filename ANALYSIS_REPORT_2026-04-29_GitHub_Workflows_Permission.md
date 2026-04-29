# 분석보고서: GitHub App `workflows` 권한 누락으로 인한 푸시 차단 문제

**작성일**: 2026-04-29
**작성자**: AI Developer Agent
**대상 시스템**: Morning Stock AI Briefing Center (v2.9.10)
**저장소**: `wwwkoistkr/2026_04_21_-_-`
**문제 심각도**: 🔴 **HIGH** — v2.9.10 패치(워크플로 3초 딜레이)가 GitHub Actions에 반영 불가, 매일 06:30 KST 자동 발송이 여전히 9~10분 소요

---

## 1. 요약 (Executive Summary)

### 🎯 핵심 결론
- **진짜 문제**: Genspark AI Developer GitHub App에 **`workflows` 권한이 부여되지 않음**
- **차단되는 작업**: `.github/workflows/*.yml` 파일 3개를 포함한 8개 커밋 푸시
- **부수적 발견**: 사용자 개인 이메일 주소가 GitHub에 비공개로 설정됨 (별도 이슈)
- **영향**: v2.9.10의 핵심 개선 사항(SUMMARY_CALL_DELAY_SEC 6→3초)이 GitHub Actions에 반영되지 않아 cron 자동 발송이 여전히 6초 딜레이로 작동

### 📊 푸시 차단 상태
| 항목 | 값 |
|------|-----|
| 로컬 HEAD | `b329732` (v2.9.10.1) |
| 원격 HEAD | `671fc47` (v2.9.6.4) |
| 푸시 대기 커밋 수 | **8개** (v2.9.7 ~ v2.9.10.1) |
| workflow 파일 변경 커밋 | **1개** (`4daa452` v2.9.10) — 3개 yml 파일 |
| 차단 메시지 | `refusing to allow a GitHub App to create or update workflow ... without 'workflows' permission` |

---

## 2. 문제의 진짜 원인 (Root Cause)

### 2-1. GitHub App Installation Token 권한 분석

진단 명령(`/installation/repositories`, `/rate_limit`) 결과로 다음을 확인:

```
토큰 종류: GitHub App Installation Token (ghs_ prefix)
Rate limit: 5000 req/hr (App Installation 표준)
Repository selection: all (모든 저장소 접근 가능)
접근 가능 저장소: 6개 (2026_04_21_-_- 포함)
```

**현재 설치된 `genspark-ai-developer` 앱의 권한 (이전 진단 결과):**
```json
{
  "administration": "write",
  "contents": "write",
  "issues": "write",
  "metadata": "read",
  "pull_requests": "write"
}
```

**누락된 권한:**
- ❌ **`workflows`** (필수)
- ❌ **`actions`** (선택, 트리거에 필요)

### 2-2. GitHub의 push 거부 메커니즘

GitHub Apps는 `.github/workflows/*.yml` 경로의 파일을 생성·수정·삭제하려면 **별도의 `workflows` 권한**이 필요합니다. 이는 일반 `contents: write` 권한으로 우회 불가능한 보안 정책입니다.

```
[푸시 흐름]
git push origin main
  ↓
GitHub 서버에서 커밋 분석
  ↓
.github/workflows/daily_02_summarize.yml 변경 감지
  ↓
Installation token의 workflows 권한 확인 → 없음!
  ↓
🚫 remote rejected (전체 push 거부)
```

**핵심**: 8개 커밋 중 **단 1개**(`4daa452` v2.9.10)에만 워크플로 파일 변경이 있는데, GitHub은 이 1개 커밋 때문에 **8개 전부를 거부**합니다.

### 2-3. 왜 권한 부여 시도가 모두 실패했는가?

#### 시도 이력 분석

| 시도 | 작업 | 결과 | 원인 |
|------|------|------|------|
| 1차 | `#github` 탭에서 저장소 선택 | `setup_action=update` 콜백 성공 | 저장소 접근만 추가됨, 권한 미변경 |
| 2차 | `installations/125727551` Configure 페이지 접근 | 마켓플레이스 페이지로 잘못 표시 | **잘못된 Installation ID** 사용 |
| 3차 | `installations/new` URL 시도 | 같은 마켓플레이스 페이지 | 캐시 또는 OAuth state 충돌 |
| 4차 | 시크릿 창 인증 | "인증 성공!" 메시지 | Genspark 측 OAuth만 갱신, App 권한 미변경 |
| 5차 | 푸시 재시도 | `GH007` 이메일 비공개 오류 | 일시적으로 다른 토큰 발급되었으나 권한은 여전히 부족 |
| 6차 | 이메일 변경 후 푸시 | 다시 `workflows permission` 오류 | App 권한 자체가 변경되지 않음 확인 |

#### 실제 ID 혼선

두 개의 비슷한 이름이지만 **다른** GitHub Installation이 존재합니다:

| ID | 명칭 | 권한 | 우리에게 사용되는가? |
|----|------|------|------------------|
| `125727551` | (사용자가 시도한 ID) | 알 수 없음 | ❌ 아니오 |
| `127803057` | `genspark-ai-developer` | workflows 없음 | ✅ **이게 진짜!** |

→ 사용자가 만진 페이지는 **다른 Installation**이었고, 실제 푸시에 사용되는 Installation의 권한은 그대로 유지되었습니다.

### 2-4. 부수 문제: 이메일 비공개 정책

5차 시도에서 잠깐 나타난 `GH007` 오류:

```
remote: error: GH007: Your push would publish a private email address.
```

**원인**: 8개 커밋의 author/committer 이메일이 `wwwkoistkr@gmail.com`(개인 이메일)인데, GitHub 설정에서 "Block command line pushes that expose my email" 옵션이 켜져 있음.

**해결**: 이미 `git filter-branch`로 모든 커밋을 noreply 이메일(`185472961+wwwkoistkr@users.noreply.github.com`)로 재작성 완료.

→ **이 문제는 이미 해결되었으므로 권한 문제만 남음.**

---

## 3. 권한 부여가 매번 실패한 5가지 이유

### 이유 1️⃣ — Genspark UI는 저장소 접근만 변경할 뿐 GitHub App 권한 자체를 변경하지 못함

Genspark의 `#github` 탭에서 저장소를 선택해도, 이는 **Repository Access**(어떤 저장소에 접근할지)만 GitHub App에 전달합니다. **Permissions**(workflows, contents 등)는 GitHub App 자체의 manifest에 정의되며, 이를 변경하려면:
- App 소유자(`genspark-ai`)가 manifest를 업데이트하고
- 사용자가 새 권한을 명시적으로 **Accept**해야 함

### 이유 2️⃣ — Genspark App manifest에 `workflows` 권한이 처음부터 정의되지 않음

진단 결과로 보면 현재 권한 목록(administration, contents, issues, metadata, pull_requests)에 **workflows가 아예 없습니다**. 이는:
- ✅ Genspark App이 `workflows` 권한을 manifest에 포함하지 않음 (현재 버전)
- 또는 ⚠️ 사용자가 처음 설치할 때 `workflows`를 거부했고, manifest 업데이트 알림을 못 받음

→ **단순한 재인증/재설치로 해결 불가능**할 수 있습니다. App 자체의 manifest에 `workflows: write`가 포함되어야 합니다.

### 이유 3️⃣ — `setup_github_environment` 도구는 토큰만 갱신, 권한 부여 불가

이 도구는:
- ✅ 기존 GitHub App Installation의 토큰을 갱신 (`ghs_xxx`)
- ❌ App의 권한 manifest 변경 불가
- ❌ 사용자에게 새 권한 Accept 화면 제공 불가

→ 도구를 아무리 호출해도 권한은 그대로입니다.

### 이유 4️⃣ — 사용자가 본 "인증 성공!" 메시지의 함정

`genspark.ai/github_auth_success` 페이지는:
- ✅ Genspark ↔ GitHub OAuth 재연결 성공을 의미
- ❌ App permissions 업데이트와는 무관

이 메시지는 **사용자 OAuth 토큰**의 성공이며, **GitHub App Installation 권한**과는 별개의 시스템입니다.

### 이유 5️⃣ — 캐시·세션 충돌로 진짜 Configure 페이지 접근 불가

Chrome 브라우저에서 `https://github.com/settings/installations/{ID}` URL이 일관되게 마켓플레이스 페이지(소개 페이지)로 잘못 렌더링됨:
- 7개의 GitHub 탭 동시 열림 → 세션 충돌
- OAuth state 토큰 만료 (`Invalid state parameter` 오류)
- 시크릿 창에서도 동일 증상

이는 GitHub 자체의 일시적 버그 또는 사용자 계정의 특정 캐시 상태에서 발생하는 현상입니다.

---

## 4. 영향 범위 (Impact)

### 4-1. v2.9.10 패치 적용 현황

| 변경 사항 | Cloudflare Pages | GitHub Actions | 효과 |
|---------|----------------|--------------|------|
| UI 라벨 4-7분 → 5-9분 | ✅ 배포 완료 | N/A | 사용자 인지 ✅ |
| 폴링 timeout 8분 → 12분 | ✅ 배포 완료 | N/A | 이중발송 방지 ✅ |
| Progress bar 360s → 480s | ✅ 배포 완료 | N/A | UX 개선 ✅ |
| 이중발송 5분 잠금 | ✅ 배포 완료 | N/A | 안정성 ✅ |
| **`SUMMARY_CALL_DELAY_SEC` 6 → 3초** | N/A | ❌ **푸시 차단** | **미적용** 🔴 |
| **Cron 주석 시각 동기화** | N/A | ❌ **푸시 차단** | **미적용** 🔴 |

### 4-2. 매일 06:30 KST 자동 발송에 미치는 영향

```
[현재 GitHub Actions에서 사용되는 값 (v2.9.6.4 기준)]
SUMMARY_CALL_DELAY_SEC = 6초
15개 뉴스 카드 요약 시 = 15 × 6 = 90초 (대기시간만)
+ AI 응답시간 = 약 5분
총 AI 요약 단계 ≈ 6~7분

[v2.9.10이 푸시되면 (3초 딜레이)]
15 × 3 = 45초 (대기시간만)
+ AI 응답시간 = 약 5분
총 AI 요약 단계 ≈ 5~6분 (1~2분 단축)
```

→ **푸시 못 하면 매일 1~2분의 불필요한 지연 + 이중발송 위험 잔존**

### 4-3. 자가복구 신뢰도 (이전 분석보고서 기준)

| 시나리오 | v2.9.9 | v2.9.10 (Pages만) | v2.9.10 (Actions까지) |
|---------|-------|------------------|---------------------|
| 자동 06:30 발송 | 52% | 60% | **78%** ⭐ |
| 수동 트리거 | 45% | 78% | 78% (동일) |
| 이중발송 차단 | 20% | 80% | 80% (동일) |
| UI 정확성 | 50% | 90% | 90% (동일) |

→ 푸시 못 하면 자동 발송 안정성 +18%p 개선 효과를 잃음

---

## 5. 해결 방안 (Solutions)

### 🥇 방안 A — App Manifest에 workflows 권한 추가 후 재설치 (가장 정석, 시간 미정)

**전제조건**: Genspark AI Developer App의 소유자(`genspark-ai`)가 manifest를 업데이트해야 함.

**절차**:
1. Genspark 팀에 문의: "AI Developer App에 `workflows: write` 권한 추가 요청"
2. Genspark가 manifest 업데이트 후 사용자에게 알림 발송
3. 사용자가 https://github.com/settings/installations/127803057 에서 **"Accept new permissions"** 클릭
4. 푸시 재시도

**장점**: 영구 해결, 모든 사용자에게 적용
**단점**: Genspark 팀 응답 대기 필요

---

### 🥈 방안 B — Personal Access Token (PAT) 사용 (즉시 가능, 추천 ⭐)

**원리**: GitHub App과 별개로 사용자 개인 토큰을 만들어 푸시.

**절차**:

#### B-1. GitHub에서 PAT 발급
1. https://github.com/settings/tokens?type=beta (Fine-grained PAT)
2. **"Generate new token"** 클릭
3. 설정:
   - Token name: `morning-stock-deploy`
   - Expiration: 90 days
   - Repository access: **Only select repositories** → `2026_04_21_-_-`
   - Repository permissions:
     - ✅ Contents: Read and write
     - ✅ **Workflows: Read and write** ⭐
     - ✅ Metadata: Read only
4. **"Generate token"** 클릭
5. `github_pat_xxxxx` 토큰 복사 (한 번만 표시됨!)

#### B-2. 사용자가 채팅창에 토큰 전달

> ⚠️ **보안 주의**: 토큰을 채팅창에 직접 붙이면 노출 위험. 다음 중 안전한 방법 선택:
> 1. (권장) 토큰을 사용자가 직접 sandbox 환경에서 사용
> 2. 토큰을 Genspark의 secret 관리 기능에 저장

#### B-3. 푸시 명령 (사용자가 직접 또는 AI 안내)
```bash
cd /home/user/webapp
git push https://x-access-token:github_pat_xxxxx@github.com/wwwkoistkr/2026_04_21_-_-.git main
```

**장점**: 즉시 해결, App 권한 무관
**단점**: 토큰 만료 시 재발급 필요

---

### 🥉 방안 C — 워크플로 파일을 GitHub 웹 UI에서 직접 수정 (가장 빠름, 부분 해결)

**원리**: 푸시는 못 해도, GitHub 웹사이트에서 파일을 수동으로 편집.

**절차**:
1. https://github.com/wwwkoistkr/2026_04_21_-_-/blob/main/.github/workflows/daily_02_summarize.yml 접속
2. ✏️ (연필 아이콘) 클릭
3. 51번째 줄 부근의 `SUMMARY_CALL_DELAY_SEC: '6'`을 `'3'`으로 변경
4. 하단 **"Commit changes"** 클릭
5. `daily_briefing.yml`도 동일 절차로 55번째 줄 변경

**장점**: 권한 변경 없이 즉시 적용 가능
**단점**: src/ 변경 사항(8개 커밋의 코드 부분)은 별도 처리 필요

---

### 🏅 방안 D — 워크플로 변경 커밋만 따로 분리 (혼합 전략)

**원리**: workflow 파일 변경이 없는 7개 커밋은 일반 푸시, workflow 파일은 웹 UI로 처리.

**절차**:
```bash
# 1. workflow 변경 커밋(4daa452) 제외하고 cherry-pick
git checkout origin/main -b deploy-no-workflow
git cherry-pick 0059f3c 2e0d857 ab7d9a5 d06c9a7 1ca161e 0ca07ad
# 4daa452의 src/ 부분만 cherry-pick (workflow yml 제외)
git checkout 4daa452 -- src/index.tsx public/static/admin.js README.md
git commit -m "feat(v2.9.10): UI/JS only (workflow yml은 웹UI 별도)"
git cherry-pick b329732
git push origin deploy-no-workflow:main

# 2. workflow yml은 GitHub 웹에서 수동 수정
```

**장점**: 권한 변경 없이 모든 변경 적용
**단점**: 절차 복잡, 커밋 히스토리 변형

---

## 6. 즉시 권장 액션 (Recommended Actions)

### 🎯 우선순위 1 — 사용자 직접 결정 필요

**옵션 A**: PAT 발급 (3분 소요, 100% 해결)
- 사용자 → GitHub Fine-grained PAT 발급 (workflows 권한 포함)
- AI → 발급된 토큰으로 즉시 푸시 진행
- 권장: ⭐⭐⭐⭐⭐

**옵션 B**: 웹 UI에서 yml 직접 수정 (2분 소요, 워크플로만 적용)
- 사용자 → GitHub 웹에서 SUMMARY_CALL_DELAY_SEC 6→3 변경
- AI → 별도로 src/index.tsx 등은 다음 push 기회에 적용
- 권장: ⭐⭐⭐⭐

**옵션 C**: Genspark에 권한 추가 요청 (1~7일 소요)
- 사용자 → Genspark 고객센터 문의
- 대기 → manifest 업데이트 후 Accept
- 권장: ⭐⭐ (장기 해결)

### 🎯 우선순위 2 — 시스템 개선

이 문제가 다시 발생하지 않도록:

1. **README.md에 권한 요구사항 명시**
   ```markdown
   ## GitHub Push 권한 요구사항
   - Contents: Read and write
   - Workflows: Read and write ⭐ (workflows 변경 시 필수)
   - Metadata: Read
   ```

2. **사전 권한 검증 스크립트 추가**
   ```bash
   # scripts/check_github_permissions.sh
   curl -s -H "Authorization: Bearer $TOKEN" \
     "https://api.github.com/repos/owner/repo/contents/.github/workflows/test.yml" \
     -X PUT -d '{"message":"test"}' | grep -q "workflows permission" && \
     echo "❌ workflows 권한 없음"
   ```

3. **자동 알림**: Cloudflare Pages에 배포되었으나 GitHub Actions에 푸시 안 된 상태 감지 시 admin 이메일 알림

---

## 7. 부록: 진단 명령어 모음

### 7-1. 토큰 권한 진단
```bash
TOKEN=$(grep -oP 'x-access-token:\K[^@]*' ~/.git-credentials | head -1)

# 토큰 종류 (ghs_ = App, ghp_ = PAT, gho_ = OAuth)
echo "Token prefix: ${TOKEN:0:4}"

# Installation이 접근 가능한 저장소
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/installation/repositories" | jq '.repositories[].full_name'

# Rate limit (App=5000, PAT=5000, OAuth=5000, unauth=60)
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/rate_limit" | jq .resources.core.limit
```

### 7-2. 워크플로 권한 즉시 확인
```bash
# .github/workflows/test.yml에 dummy PUT 시도 → 403이면 권한 없음
curl -s -o /dev/null -w "%{http_code}\n" -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"test","content":"dGVzdA=="}' \
  "https://api.github.com/repos/wwwkoistkr/2026_04_21_-_-/contents/.github/workflows/.permission_check.yml"
```

### 7-3. 푸시 사전 시뮬레이션
```bash
git push origin main --dry-run
```

---

## 8. 진단 데이터 원본

### 8-1. 푸시 대기 8개 커밋 변경 파일

| 커밋 | workflow yml 변경? | 변경 파일 |
|------|------------------|----------|
| `b329732` | ❌ | src/index.tsx |
| `4daa452` | ✅ **3개** | daily_02_summarize.yml, daily_03_send.yml, daily_briefing.yml + (README.md, src, admin.js) |
| `0ca07ad` | ❌ | ANALYSIS_REPORT_*.md |
| `1ca161e` | ❌ | src/index.tsx |
| `d06c9a7` | ❌ | ai_summarizer.py, admin.js, src/index.tsx |
| `ab7d9a5` | ❌ | ANALYSIS_REPORT_*, ai_summarizer.py, admin.js |
| `2e0d857` | ❌ | ANALYSIS_REPORT_*, admin.js, src/index.tsx |
| `0059f3c` | ❌ | ANALYSIS_REPORT_*, package-lock.json |

→ **단 1개 커밋(`4daa452`) 때문에 7개의 무관한 커밋도 함께 차단됨**

### 8-2. 푸시 오류 이력

```log
[1차 시도] (이메일 미수정 시)
remote rejected main -> main 
  (refusing to allow a GitHub App to create or update workflow 
   `.github/workflows/daily_02_summarize.yml` without `workflows` permission)

[2차 시도] (Genspark 재인증 후)
remote: error: GH007: Your push would publish a private email address.

[3차 시도] (이메일 noreply로 변경 후)
remote rejected main -> main 
  (refusing to allow a GitHub App to create or update workflow 
   `.github/workflows/daily_02_summarize.yml` without `workflows` permission)
```

### 8-3. 현재 GitHub App 권한

```json
{
  "app_slug": "genspark-ai-developer",
  "installation_id": 127803057,
  "permissions": {
    "administration": "write",
    "contents": "write",
    "issues": "write",
    "metadata": "read",
    "pull_requests": "write"
  },
  "repository_selection": "all",
  "accessible_repositories_count": 6
}
```

**누락**:
- `workflows`: write ⭐
- `actions`: read 또는 write (선택)

---

## 9. 결론 (Conclusion)

이 문제의 본질은 **사용자 인증의 문제가 아니라 GitHub App 자체의 manifest 권한 정의 문제**입니다. 사용자가 아무리 권한 부여 페이지를 통과해도, App에서 요청하지 않은 권한은 절대 부여되지 않습니다.

### 핵심 메시지
1. ✅ **사용자의 GitHub 인증은 모두 정상**
2. ✅ **저장소 접근 권한은 부여됨**
3. ❌ **App manifest에 `workflows: write` 가 없어 푸시 차단**
4. 💡 **PAT(Personal Access Token) 사용이 가장 빠른 우회 방법**

### 다음 행동 (사용자 결정 필요)
- **Plan A (3분)**: PAT 발급 → 채팅으로 전달 → 즉시 푸시
- **Plan B (2분)**: GitHub 웹에서 yml 파일 직접 수정
- **Plan C (장기)**: Genspark에 manifest 업데이트 요청

---

**보고서 끝**

작성: AI Developer Agent
검토 대기: 사용자 (KOIST)
참조 보고서: `ANALYSIS_REPORT_2026-04-28_v2.9.9_Slow_10min_Workflow.md`
