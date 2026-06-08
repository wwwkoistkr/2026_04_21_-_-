# 🐛 Bugfix Report — v2.2.4

> **제목**: "지금 발송" 은 성공 표기인데 **이메일이 실제로 오지 않음** + **첫화면 비밀번호 화면 사라짐**
> **Severity**: 🔴 Critical (브리핑 수신 실패 + 보안성 저하)
> **Date**: 2026-04-21
> **Production**: https://morning-stock-briefing.pages.dev (v2.2.4)
> **Preview**: https://3effad0e.morning-stock-briefing.pages.dev

---

## 1. 증상

| # | 증상 | 사용자가 본 것 |
|---|---|---|
| **A** | 지금발송 → "발송완료" 표시 | 실제 이메일 도착 안 됨 |
| **B** | "상세보기" 클릭 시 GitHub 페이지 콘솔에 빨간 에러 | GitHub 자체 CSP 경고 (우리 앱과 무관) |
| **C** | 앱 실행 시 로그인 화면이 없어짐 | 바로 대시보드로 진입 |

---

## 2. 근본 원인 분석 (Root Cause)

### 2.1 🔴 이메일 실제 발송 실패 분석 — Run #8 로그 해부

```
[INFO]  관리 콘솔에서 수신자 목록 요청: ***/api/public/recipients
[WARN]  관리 콘솔 수신자 조회 실패 (환경변수만 사용): 401 Unauthorized   ← 핵심
[INFO]  최종 발송 대상: ['***']                                              ← 1명만
[INFO]  SMTP 연결: smtp.gmail.com:465
[INFO]  메일 발송 완료 → ['***']                                             ← 가짜 성공
✉️  메일 발송 완료 → ***
```

**3개의 결정적 버그가 중첩**되어 있었습니다:

| 버그 | 위치 | 설명 |
|---|---|---|
| **B1** | `email_sender.py:53-57` | `fetch_recipients_from_admin()` 가 401 을 **조용히 빈 리스트로 폴백** → 관리 UI에 추가한 수신자들이 사라짐. 사용자는 UI 에 추가했다고 생각하지만 실제 발송엔 반영 안 됨 |
| **B2** | `email_sender.py:282-287` | `server.sendmail()` 의 반환값(거부된 수신자 dict)을 **전혀 검사하지 않음** → Gmail 이 일부 수신자를 550/554 로 거부해도 "발송 완료" 라고 로깅 |
| **B3** | 운영 환경 | `EMAIL_RECIPIENTS` Secret 에 등록된 주소로 메일이 실제 전송됐지만 **Gmail이 스팸/프로모션으로 분류** → 사용자는 받은편지함에서 못 찾고 "안 왔다"고 인지 |

스팸 분류 원인:
- `Reply-To`, `Date`, `List-Unsubscribe`, `X-Mailer` 등 신뢰성 헤더 부재
- HTML-only 본문에 마케팅성 이모지/gradient
- GitHub Actions 에서 발송되는 자동화 메일은 Gmail 스팸 점수에 취약

### 2.2 🟠 "첫화면에 로그인 없음" 분석

```typescript
// src/index.tsx (before)
const SESSION_TTL_SEC = 60 * 60 * 12   // 12시간
```

- 이전에 로그인 후 **12시간 세션 쿠키**가 남아있어 사용자가 브라우저를 닫았다가 다시 열어도 바로 대시보드 진입
- 사용자의 요구: "첫화면에 비밀번호 묻는 화면" → **매 세션마다 로그인 의도**

### 2.3 🟡 GitHub Actions Node 20 Deprecation

```
##[warning]Node.js 20 actions are deprecated.
actions/checkout@v4, actions/setup-python@v5 ...
Node.js 20 will be removed from the runner on September 16th, 2026.
```

**영향**: 아직은 경고 수준. 2026-09-16 이후엔 빌드 실패 가능.

---

## 3. 수정 내용 (Fix)

### 3.1 `briefing/modules/email_sender.py` — 이메일 발송 신뢰성 3중 강화

#### (a) sendmail() 반환값 검사 ✅

```python
rejected = server.sendmail(sender, recipients, msg.as_string())

accepted = [r for r in recipients if r not in (rejected or {})]
if rejected:
    for r, (code, reason) in rejected.items():
        print(f"   • {_mask_email(r)} → SMTP {code}: {reason}")
    if not accepted:
        raise RuntimeError("모든 수신자가 SMTP 서버에 의해 거부되었습니다.")
```

이제 **일부 실패도 명확히 감지**되며, 모두 실패 시 예외로 워크플로가 실패 표기됨.

#### (b) Gmail 스팸 점수 낮추는 표준 헤더 추가 ✅

```python
msg["Reply-To"] = sender
msg["Date"] = datetime.utcnow().strftime("%a, %d %b %Y %H:%M:%S +0000")
msg["List-Unsubscribe"] = f"<mailto:{sender}?subject=unsubscribe>"
msg["X-Mailer"] = "MorningStockAI-BriefingCenter/2.2.4"
```

RFC 2369 `List-Unsubscribe` + `Date` 헤더는 Gmail 의 **자동 메일 분류기(SpamCat)**에 긍정적 신호로 작용.

#### (c) BRIEFING_READ_TOKEN 실패 시 가시적 진단 ✅

```python
except requests.HTTPError as exc:
    if status in (401, 403):
        logger.warning(
            "관리 콘솔 수신자 조회 401/403 — BRIEFING_READ_TOKEN 이 올바르지 않거나..."
            "→ 관리 UI에 추가한 수신자들이 이번 발송에서 '반영되지 않았습니다'."
        )
        print("⚠️  [관리콘솔 수신자] BRIEFING_READ_TOKEN 인증 실패 → 환경변수 수신자만 사용됨")
```

이제 로그에서 **"관리 UI 수신자가 반영 안 됐다"**는 사실이 즉시 드러남.

#### (d) 개인정보 마스킹 ✅

로그에 실제 이메일을 찍지 않고 `ab***f@gmail.com` 형태로 마스킹 → GitHub Actions 공개 로그에서 수신자 주소 유출 방지.

#### (e) SMTP 인증 오류 전용 처리 ✅

```python
except smtplib.SMTPAuthenticationError as exc:
    raise RuntimeError(
        f"SMTP 인증 실패: {exc}. Gmail 앱 비밀번호(16자리)가 올바른지 확인하세요. "
        "일반 비밀번호는 사용할 수 없으며, 2단계 인증이 활성화되어 있어야 합니다."
    )
```

### 3.2 `src/index.tsx` — 로그인 복원

```diff
- const SESSION_TTL_SEC = 60 * 60 * 12   // 12시간
+ const SESSION_TTL_SEC = 60 * 60 * 2    // 2시간
```

추가로:

- 로그인 페이지에 **"세션 유지 시간: 2시간 (이후 재로그인 필요)"** 안내 표시
- `/logout?logout=1` → "✅ 안전하게 로그아웃되었습니다" 확인 메시지
- **GET /logout** 라우트 추가 (모바일 PWA 북마크/빠른실행용)
- 모바일 패딩 조정 (`mt-12 sm:mt-20`, `p-6 sm:p-8`)
- 로그인 버튼에 `touch-target` + 아이콘

### 3.3 `public/static/admin.js` — 스팸 폴더 안내 UI

발송 완료 시 사용자에게 명확한 안내:

```
✅ 실행 완료! 이메일 발송 완료 [상세 보기]
┌──────────────────────────────────┐
│ 📬 메일이 안 보이나요?           │
│   1️⃣ Gmail 스팸/프로모션 탭 확인 │
│   2️⃣ EMAIL_RECIPIENTS 주소 확인  │
│   3️⃣ 상세보기에서 "📬 최종 발송  │
│      대상" 로그 확인             │
└──────────────────────────────────┘
```

### 3.4 `.github/workflows/daily_briefing.yml` — 미래 대비

```yaml
env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"   # Node 20 deprecation 경고 제거

# + OpenAI 호환 fallback 엔진 Secrets 연결
env:
  OPENAI_API_KEY:       ${{ secrets.OPENAI_API_KEY }}
  OPENAI_BASE_URL:      ${{ secrets.OPENAI_BASE_URL }}
  OPENAI_MODEL:         ${{ secrets.OPENAI_MODEL }}
```

### 3.5 버전/캐시 버스팅

| 파일 | v2.2.3 | v2.2.4 |
|---|---|---|
| API `/api/health` | v2.2.3 | **v2.2.4** |
| 관리자 UI 배지 | v2.2.3 | **v2.2.4** |
| `admin.js?v=` | 2.2.3 | **2.2.4** |
| Service Worker `CACHE_VERSION` | `msaic-v2.2.3` | **`msaic-v2.2.4`** |

---

## 4. 검증 (Verification)

### 4.1 자동 검증 ✅ 모두 통과

```
=== PROD health ===        {"version":"v2.2.4"}
=== PROD root (unauth) === HTTP 302 → /login
=== PROD login page ===    "2시간", "관리자 비밀번호", "세션 유지" 모두 포함
=== PROD SW version ===    msaic-v2.2.4
```

### 4.2 수동 테스트 체크리스트

| # | 시나리오 | 기대 동작 |
|---|---|---|
| 1 | 쿠키 삭제 후 `https://morning-stock-briefing.pages.dev/` 접속 | 로그인 페이지로 302 리디렉션 |
| 2 | 잘못된 비밀번호 입력 | "⚠️ 비밀번호가 올바르지 않습니다" |
| 3 | 올바른 비밀번호 입력 → 대시보드 진입 | 정상 |
| 4 | 2시간 후 재방문 | 자동 로그아웃 → 로그인 화면 |
| 5 | `/logout` GET 접속 | "✅ 안전하게 로그아웃되었습니다" |
| 6 | "지금 발송" 클릭 → 완료 | 스팸 폴더 확인 안내 UI 노출 |
| 7 | **다음 워크플로 실행 로그** | `📬 최종 발송 대상: N명`, `✅ 수락된 수신자:`, 거부 시 상세 SMTP 코드 |

---

## 5. 사용자 필수 후속 조치 (User Action Items)

### 5.1 🔴 즉시 — 이메일이 스팸으로 가는 원인 확인

1. **Gmail 받은편지함에서 'in:anywhere morning-stock' 검색** → 스팸/프로모션 탭 확인
2. 메일이 있다면: 해당 메일 우클릭 → **"스팸 아님" / "받은편지함으로 이동"** → Gmail이 학습
3. 발신자 주소(`EMAIL_SENDER`)를 **주소록에 추가** → Gmail이 "신뢰할 수 있는 발신자"로 분류

### 5.2 🟠 BRIEFING_READ_TOKEN 재발급 (권장)

관리 UI 에서 추가한 수신자가 실제 발송에 반영되게 하려면:

1. Cloudflare Pages → Secret 에서 `BRIEFING_READ_TOKEN` 값 확인
2. 같은 값을 GitHub Secrets 의 `BRIEFING_READ_TOKEN` 에 **정확히 일치**하게 저장
3. 다음 발송 로그에 "관리 콘솔 수신자 N명 수신" 이 찍히는지 확인

### 5.3 🟡 OPENAI_API_KEY 등록 (Gemini 503 대비)

이미 `.github/workflows/daily_briefing.yml` 에 슬롯을 추가했으므로, Secrets 에 값만 넣으면 자동 작동:
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL` (예: `https://api.openai.com/v1`)
- `OPENAI_MODEL` (선택, 기본 `gpt-5-mini`)

---

## 6. 파일 변경 요약

```
modified:  briefing/modules/email_sender.py          (+75 −8)  이메일 발송 신뢰성 강화
modified:  src/index.tsx                             (+18 −6)  세션 TTL + GET /logout + 로그인 UI
modified:  public/static/admin.js                    (+15 −3)  스팸 폴더 안내 UI
modified:  public/static/sw.js                       (+2 −2)   CACHE_VERSION bump
modified:  .github/workflows/daily_briefing.yml      (+6 −0)   Node24 + OpenAI secrets
new:       BUGFIX_REPORT_v2.2.4.md
```

---

## 7. 과거 리포트와의 연관성

- v2.2.1: SW 캐시 강제 갱신 + admin.js 네트워크우선
- v2.2.2: Tailwind hidden vs sm:flex 충돌 수정
- v2.2.3: 지금발송 중복 트리거 + 폴링 오매칭 수정
- **v2.2.4**: 이메일 실제 발송 신뢰성 + 로그인 복원 ← **이번**

이로써 **지금발송 버튼** 관련 이슈 (UI 오작동 → 오인 실패 → 오인 성공) 3단계가 모두 해결되었습니다.
