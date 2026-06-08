# 📚 OpenAI API 키 발급 → GitHub Secret 등록 완전 가이드 (초보자용)

> **작성일**: 2026-04-23
> **대상**: Morning Stock AI v2.6.2 프로젝트
> **소요 시간**: 총 15~20분
> **예상 비용**: $5 (약 1년 사용 가능)

---

## 🗺️ 전체 흐름

```
[PART 1] OpenAI 가입 & API 키 발급 (10분)
[PART 2] GitHub에 키 등록 (5분)
[PART 3] 확인 & 테스트 (5분)
```

---

# 🟢 PART 1 — OpenAI API 키 발급

## ① OpenAI 회원가입
- URL: https://platform.openai.com/signup
- 이메일 또는 Google 계정 사용 가능
- 전화번호 SMS 인증 필요

## ② API Keys 페이지 이동
- URL: https://platform.openai.com/api-keys
- 왼쪽 메뉴 "API Keys" 클릭

## ③ 새 키 생성
- "+ Create new secret key" 버튼 클릭
- Name: `morning-stock-ai`
- Permissions: All
- "Create secret key" 클릭

## ④ 키 복사 (⚠️ 딱 한 번만 표시!)
- "Copy" 버튼 클릭 → 즉시 메모장에 저장
- 형식: `sk-proj-abcdefg...xyz` (약 150자)
- 놓치면 삭제 후 새로 만들기 (무료)

## ⑤ 크레딧 충전 ($5 추천)
- URL: https://platform.openai.com/settings/organization/billing/overview
- "Add to credit balance" 클릭
- $5 선택 (약 1년 사용 가능)
- Auto-recharge는 OFF (초보자 필수!)

---

# 🟠 PART 2 — GitHub Secret 등록

## ⑥ 리포지토리 접속
- URL: https://github.com/wwwkoistkr/2026_04_21_-_-

## ⑦ Settings 탭 클릭
- 리포지토리 상단 메뉴 가장 오른쪽 "⚙ Settings"

## ⑧ Secrets and variables → Actions
- 왼쪽 사이드바 → Secrets and variables → Actions
- 빠른 경로: https://github.com/wwwkoistkr/2026_04_21_-_-/settings/secrets/actions

## ⑨ 3개 Secret 등록

### Secret 1: OPENAI_API_KEY
| 필드 | 값 |
|------|-----|
| Name | `OPENAI_API_KEY` |
| Secret | `sk-proj-...` (④에서 복사한 전체 키) |

### Secret 2: OPENAI_BASE_URL
| 필드 | 값 |
|------|-----|
| Name | `OPENAI_BASE_URL` |
| Secret | `https://api.openai.com/v1` |

### Secret 3: OPENAI_MODEL
| 필드 | 값 |
|------|-----|
| Name | `OPENAI_MODEL` |
| Secret | `gpt-4o-mini` |

---

# 🔵 PART 3 — 테스트

## ⑩ 완료 후 AI Developer에게 알림
"OpenAI 등록 완료했어" 메시지 → 자동 검증 시작

## ⑪ 예상 결과
- Gemini 429 실패 시 자동으로 OpenAI로 전환
- 정상적인 AI 요약 10건 (미국 4 + 한국 6)
- 이메일에 완벽한 브리핑 도착

---

# 🖼️ 단계별 스크린샷 이미지 URL

| 단계 | 이미지 URL |
|------|-----------|
| ① 회원가입 | https://www.genspark.ai/api/files/s/qkGsn4cR |
| ② API Keys 페이지 | https://www.genspark.ai/api/files/s/G0KjHhsC |
| ③ 키 생성 모달 | https://www.genspark.ai/api/files/s/UD1dswvn |
| ④ 키 복사 화면 | https://www.genspark.ai/api/files/s/vmQ8pYDl |
| ⑤ 크레딧 충전 | https://www.genspark.ai/api/files/s/4yxQ8sHF |
| ⑦ Settings 탭 | https://www.genspark.ai/api/files/s/mVi7gfpz |
| ⑧ Secrets 메뉴 | https://www.genspark.ai/api/files/s/aFDTpR5M |
| ⑨ New secret 버튼 | https://www.genspark.ai/api/files/s/LR0QdyuG |
| ⑩ Secret 입력 폼 | https://www.genspark.ai/api/files/s/YMp640uH |

---

# 🆘 자주 발생하는 문제

| 문제 | 해결 |
|------|------|
| 이메일 인증 메일 안 옴 | 스팸 폴더 확인 |
| 전화번호 인증 실패 | 다른 번호 or 1주일 후 재시도 |
| 카드 결제 실패 | 카드사에 해외결제 허용 요청 |
| API 키 복사 놓침 | 삭제 후 새로 만들기 (무료) |
| GitHub Settings 안 보임 | 로그아웃 후 재로그인 |

---

# 🔒 보안 주의사항

## 절대 하지 말 것
- ❌ API 키를 다른 사람에게 공유
- ❌ 카카오톡/이메일로 전송
- ❌ GitHub 코드에 직접 붙여넣기
- ❌ 네이버 블로그·트위터 등 공개 게시

## 권장 관리 방법
- ✅ 메모장 파일로 로컬 저장 (`openai_key_2026-04-23.txt`)
- ✅ GitHub Secrets에만 등록
- ✅ Cloudflare Secrets에만 등록 (필요시)
- ✅ 3개월마다 키 교체 (Best Practice)

---

## 📞 지원

진행 중 막히는 부분이 있으면 단계 번호와 함께 AI Developer에게 알려주세요:
- "③ 단계에서 Create 버튼이 회색이야"
- "⑤ 단계 카드 결제가 안 돼"
- "완료! 이제 테스트 해줘"
