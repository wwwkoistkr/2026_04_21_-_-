# 🎯 Morning Stock AI Briefing Center — 운영 설정 가이드

> **목표**: 매일 아침 **07:00 KST** 에 `wwwkoistkr@gmail.com` 으로 주식·반도체 브리핑 메일이 **자동 도착** 하도록 설정합니다.

이 가이드는 **사용자가 직접 해야 하는 작업만** 정리한 체크리스트입니다.
모든 항목은 약 **10~15분** 안에 끝낼 수 있습니다.

---

## 📋 전체 진행표

| # | 단계 | 소요 | 필요한 것 | 상태 |
|:--:|---|:--:|---|:--:|
| 1 | Gmail **앱 비밀번호** 발급 | 3분 | 스마트폰 (2단계 인증용) | ⬜ |
| 2 | Google AI Studio **Gemini API 키** 발급 | 2분 | Google 계정 | ⬜ |
| 3 | GitHub 저장소 준비 | 1분 | GitHub 계정 | ⬜ |
| 4 | GitHub **Secrets 4개 등록** | 3분 | 위 1, 2 값 | ⬜ |
| 5 | GitHub Actions 수동 테스트 | 2분 | 위 단계 완료 | ⬜ |
| 6 | (선택) Cloudflare Pages **관리 콘솔 배포** | 5분 | Cloudflare 계정 | ⬜ |

> ⚠️ **1~5번은 필수**. 6번은 새 뉴스지/애널리스트를 웹에서 추가하고 싶을 때만 진행하셔도 됩니다.

---

## 1️⃣ Gmail 앱 비밀번호 발급 (3분)

> 일반 Gmail 비밀번호가 아닌 **16자리 앱 비밀번호**가 필요합니다. 보안상 SMTP 전용 전용 비밀번호입니다.

### 순서

1. **2단계 인증 활성화** (이미 되어 있으면 패스)
   - 접속: <https://myaccount.google.com/security>
   - `2단계 인증` → `사용` 으로 설정

2. **앱 비밀번호 생성**
   - 접속: <https://myaccount.google.com/apppasswords>
   - 앱 이름에 `Morning Stock Briefing` 입력 → **만들기**
   - 화면에 나타나는 **16자리 문자열** 복사 (예: `abcd efgh ijkl mnop`)
   - ⚠️ 이 비밀번호는 **한 번만 표시** 되므로 메모장에 보관하세요.
   - ✅ 사용 시 **띄어쓰기는 제거** 해서 한 줄로 입력 (`abcdefghijklmnop`).

---

## 2️⃣ Gemini API 키 발급 (2분)

1. 접속: <https://aistudio.google.com/apikey>
2. **Get API key** → **Create API key** 클릭
3. `AIza...` 로 시작하는 API 키가 생성되면 복사 → 메모장에 보관

> 💰 무료 쿼터로도 하루 1회 실행에는 충분합니다 (Gemini 2.5 Flash: 일 1500회 무료).

---

## 3️⃣ GitHub 저장소 준비 (1분)

### 옵션 A. 기존 GitHub 계정에 새 저장소 만들기

1. 접속: <https://github.com/new>
2. Repository name: `morning-stock-briefing`
3. Private 선택 (권장)
4. **Create repository** 클릭

### 옵션 B. 이미 저장소가 있으시면

- 해당 저장소 URL 만 메모해두시면 됩니다.

> 저에게 저장소 URL 을 알려주시면 현재 코드를 바로 푸시해드립니다.
> (이때 `setup_github_environment` 툴로 안전하게 인증됩니다.)

---

## 4️⃣ GitHub Secrets 4개 등록 (3분) — **가장 중요!**

저장소 페이지에서: **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

| # | Secret 이름 | 값 |
|:-:|---|---|
| 1 | `GEMINI_API_KEY` | 위 2단계에서 발급받은 `AIza...` |
| 2 | `EMAIL_SENDER` | `wwwkoistkr@gmail.com` |
| 3 | `EMAIL_APP_PASSWORD` | 위 1단계의 **16자리** (공백 제거) |
| 4 | `EMAIL_RECIPIENTS` | `wwwkoistkr@gmail.com` |

> ✅ 위 4개만 등록하면 **매일 아침 07:00 KST** 브리핑이 자동 발송됩니다.

### (선택) 추가 Secrets

| 이름 | 언제 필요? |
|---|---|
| `YOUTUBE_API_KEY` | 디일렉 유튜브 수집을 RSS 대신 공식 API 로 하고 싶을 때 |
| `BRIEFING_ADMIN_API` | 6단계(Cloudflare 관리 콘솔 배포) 후 필요 |
| `BRIEFING_READ_TOKEN` | 6단계(Cloudflare 관리 콘솔 배포) 후 필요 |

---

## 5️⃣ GitHub Actions 수동 테스트 (2분)

1. 저장소 → **Actions** 탭
2. 왼쪽 목록에서 `Daily Stock & Semiconductor Briefing` 선택
3. 오른쪽 **Run workflow** → **Run workflow** 버튼 클릭
4. ~2분 후 실행 완료 → **초록색 체크** 확인
5. `wwwkoistkr@gmail.com` 메일함에서 **📊 일일 주식·반도체 브리핑** 이 도착했는지 확인 ✉️

> 🎉 **여기까지 되면 완료!** 내일 아침 07:00 부터 자동으로 도착합니다.

---

## 6️⃣ (선택) Cloudflare Pages 관리 콘솔 배포 (5분)

> 새 뉴스지/애널리스트/유튜브 채널을 **웹에서 추가·삭제** 하려면 이 단계가 필요합니다.

### 필요한 것

- Cloudflare 계정 (무료) — <https://dash.cloudflare.com/sign-up>
- Cloudflare API Token — `Deploy 탭` 에서 발급

### 배포 순서

```bash
# 1) Cloudflare API 키 설정 (제가 도와드립니다)
#    → setup_cloudflare_api_key 툴로 자동 설정

# 2) KV namespace 생성 (1회)
npx wrangler kv namespace create SOURCES_KV
# 출력된 id 를 wrangler.jsonc 의 kv_namespaces.id 에 입력

# 3) Pages 프로젝트 생성
npx wrangler pages project create morning-stock-briefing \
  --production-branch main --compatibility-date 2026-04-13

# 4) Secrets 등록
npx wrangler pages secret put ADMIN_PASSWORD       --project-name morning-stock-briefing
npx wrangler pages secret put BRIEFING_READ_TOKEN  --project-name morning-stock-briefing

# 5) 빌드 & 배포
npm run build
npx wrangler pages deploy dist --project-name morning-stock-briefing
```

### 배포 후

1. 배포 URL (예: `https://morning-stock-briefing.pages.dev`) 접속
2. `ADMIN_PASSWORD` 로 로그인
3. 새 소스 추가: URL 만 붙여넣으면 **자동 판별** (RSS/YouTube/GoogleNews/Web)
4. **🧪 테스트** 버튼으로 즉석 검증 → **✅ 추가**
5. GitHub Secrets 에 아래 2개 추가:
   - `BRIEFING_ADMIN_API` = `https://morning-stock-briefing.pages.dev`
   - `BRIEFING_READ_TOKEN` = 위 4단계에서 넣은 값과 동일
6. 다음 날 아침부터 **사용자 등록 소스도 함께 브리핑**에 포함됩니다 ✨

---

## ❓ 자주 묻는 질문

**Q. 매일 몇 시에 메일이 오나요?**
A. **매일 아침 07:00 KST** (한국시간). GitHub Actions 가 자동으로 실행합니다.

**Q. 메일이 안 왔어요.**
A. Actions 탭에서 로그를 확인하세요. 빨간색 실패 표시가 있으면:
- `EMAIL_APP_PASSWORD` 에 **띄어쓰기가 들어갔는지** 확인
- `GEMINI_API_KEY` 가 만료되지 않았는지 확인
- Gmail "보안이 낮은 앱" 관련 설정이 아닌 **앱 비밀번호** 를 썼는지 확인

**Q. 무료인가요?**
A. GitHub Actions (월 2000분 무료) + Gemini 2.5 Flash (일 1500회 무료) + Gmail SMTP (무료) + Cloudflare Pages (월 50만 요청 무료).
→ **완전 무료** 로 운영 가능합니다.

**Q. 시간을 바꾸고 싶어요.**
A. `.github/workflows/daily_briefing.yml` 의 `cron: `0 22 * * *'` 부분 (UTC 23:00 = KST 08:00).
예) KST 07:00 을 원하면 `cron: '0 22 * * *'` 로 변경.

**Q. 받는 사람을 여러 명으로 하고 싶어요.**
A. `EMAIL_RECIPIENTS` 에 콤마로 구분해서 넣으세요:
```
wwwkoistkr@gmail.com,another@example.com,third@company.com
```

**Q. 새 애널리스트 블로그를 추가하고 싶어요.**
A. 6단계(Cloudflare 관리 콘솔) 를 배포하시면 웹에서 1초 만에 추가 가능합니다.
콘솔 배포 없이 코드로 추가하시려면 `briefing/collectors/korean_news.py` 의 `KOREAN_RSS_FEEDS` 리스트에 한 줄 추가하세요.

---

## 🆘 도움이 필요하면

저에게 다음 중 하나로 말씀해주시면 바로 처리해드립니다:

- **"GitHub 저장소를 만들어줘"** → 자동으로 준비
- **"코드를 GitHub 에 푸시해줘"** → `setup_github_environment` 실행 후 푸시
- **"Cloudflare Pages 에 배포해줘"** → `setup_cloudflare_api_key` 실행 후 배포
- **"테스트 메일을 지금 보내줘"** → 로컬에서 Gemini + Gmail 실제 호출

_Last updated: 2026-04-21_
