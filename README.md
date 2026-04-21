# 📊 주식 및 반도체 일일 브리핑 자동화 시스템

> 매일 아침 8시(KST), 국내외 경제·반도체 뉴스를 **자동 수집 → Gemini AI가 핵심 10개만 엄선·한국어 요약 → 내 Gmail로 HTML 메일 발송**하는 서버리스 파이프라인.

- **구동 환경**: GitHub Actions (서버리스, 무료 cron)
- **언어**: Python 3.10+
- **AI 엔진**: Google Gemini 2.5 Flash
- **메일**: Gmail SMTP

---

## ✅ 현재 구현된 기능

| 단계 | 모듈 | 설명 |
|------|------|------|
| 1. 수집 | `briefing/collectors/korean_news.py` | 한국경제·매일경제·머니투데이 증권/IT RSS. 공식 RSS 차단 시 **Google News RSS 우회(Fallback)** |
| 1. 수집 | `briefing/collectors/us_news.py` | Seeking Alpha / ETF.com / Morningstar / Reuters / Bloomberg — 모두 **Google News `site:` 검색**으로 우회 수집 |
| 1. 수집 | `briefing/collectors/youtube_news.py` | 디일렉 유튜브 채널. **YouTube Data API v3** → 실패 시 **채널 RSS Fallback** |
| 1. 수집 | `briefing/collectors/aggregator.py` | `collect_all_data()` — 모든 수집기를 try/except 로 개별 감싸 **한 곳이 죽어도 시스템 중단 없음 (지침서 §3.2)** |
| 2. 포맷팅 | `briefing/modules/formatter.py` | 표준 dict(list) → Gemini 가 읽기 쉬운 텍스트 (지침서 §3.3) |
| 3. 요약 | `briefing/modules/ai_summarizer.py` | Gemini 2.5 Flash 로 **핵심 10개 엄선 + 해외 뉴스 한국어 번역** |
| 4. 발송 | `briefing/modules/email_sender.py` | Markdown → 반응형 HTML 메일 → Gmail SMTP(SSL) 발송 |
| 5. 자동화 | `.github/workflows/daily_briefing.yml` | 매일 KST 오전 8시 자동 실행 + 수동 DRY_RUN 버튼 |

**직전 로컬 테스트 결과**: 총 **53건 수집** (한국 30 + 미국 18 + 유튜브 5), 한국경제 RSS 403 차단은 **Google News 우회로 자동 복구**, 유튜브는 **RSS Fallback 성공**.

---

## 🔑 필수 환경 변수 (GitHub Secrets 에 등록)

| 이름 | 용도 | 필수 |
|------|------|:---:|
| `GEMINI_API_KEY` | Google AI Studio 에서 발급 (Gemini 2.5 Flash) | ✅ |
| `EMAIL_SENDER` | 보내는 Gmail 주소 (`you@gmail.com`) | ✅ |
| `EMAIL_APP_PASSWORD` | Gmail 앱 비밀번호(16자). 계정 보안 → 2단계 인증 활성화 후 발급 | ✅ |
| `EMAIL_RECIPIENTS` | 받는 사람. 콤마로 여러 명 (`a@x.com,b@y.com`). 생략 시 본인 | ⬜ |
| `YOUTUBE_API_KEY` | YouTube Data API v3. 없으면 RSS Fallback 자동 사용 | ⬜ |
| `THELEC_YOUTUBE_CHANNEL_ID` | 디일렉 채널 ID 덮어쓰기 (기본값 `UC2GRwEADsEKEX5k-Xg9YphA`) | ⬜ |

---

## 🚀 빠른 시작 (로컬 테스트)

```bash
# 1. 의존성 설치
pip install -r requirements.txt

# 2. 개별 수집기 모듈 테스트
python -m briefing.collectors.korean_news    # 한국 뉴스
python -m briefing.collectors.us_news        # 미국 뉴스
python -m briefing.collectors.youtube_news   # 디일렉 유튜브
python -m briefing.collectors.aggregator     # 전체 통합 수집

# 3. 메일 발송 없이 전체 파이프라인 점검 (DRY_RUN)
DRY_RUN=true python main.py
# → HTML 프리뷰가 /tmp/briefing_latest.html 에 저장됨

# 4. 실제 발송 (환경 변수 필요)
export GEMINI_API_KEY=...
export EMAIL_SENDER=you@gmail.com
export EMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx
export EMAIL_RECIPIENTS=me@gmail.com
python main.py
```

---

## 🧠 진입점(Entry Points) 요약

- **`python main.py`** — 수집 → 포맷 → AI 요약 → 메일 발송 (전체 파이프라인)
- **`python -m briefing.collectors.aggregator`** — 수집 계층만 테스트
- **`python -m briefing.modules.email_sender --send`** — 메일 모듈만 단독 테스트
- **GitHub Actions → `Daily Stock & Semiconductor Briefing` workflow** — 매일 23:00 UTC (08:00 KST) 자동 실행, `workflow_dispatch` 로 수동 실행 가능 (dry_run 옵션 지원)

---

## 📐 데이터 표준(지침서 §3.3)

모든 수집 함수는 아래 스키마의 `list[dict]` 를 반환합니다.

```python
{
    "source":  "한국경제(증권)",          # 출처 라벨
    "title":   "SK하이닉스, HBM 신기록",  # 기사 제목
    "link":    "https://...",             # 원문 URL
    "summary": "기사 본문 요약 (선택)",    # 비어 있을 수 있음
}
```

---

## 🛡️ 에러 방어 설계 (지침서 §3.2)

1. 각 RSS/크롤링/API 호출은 **독립된 try-except** 로 감쌈 → 한 곳이 죽어도 다른 소스로 계속 진행
2. 한국경제처럼 공식 RSS 가 403 으로 차단되면 **Google News RSS 우회(Fallback)** 자동 전환
3. 유튜브 API 키 누락 시 **채널 RSS 피드**로 자동 Fallback
4. `main.py` 는 단계별로 예외를 catch 해서 **부분 실패에도 적절한 exit code** 를 반환

---

## 🧱 아키텍처 다이어그램

```
 ┌────────────┐  ┌─────────┐  ┌──────────┐
 │ 한국 3사 RSS │  │ 미국 매체 │  │ 유튜브   │
 └─────┬──────┘  └────┬────┘  └────┬─────┘
       │  (Google News fallback)   │
       ▼                ▼          ▼
 ┌─────────────────────────────────────┐
 │      collect_all_data()             │  지침서 §3.2 예외 방어
 │  → list[ {source,title,link,summary} ]│  지침서 §3.3 표준 양식
 └────────────────┬────────────────────┘
                  │
                  ▼
        format_data_for_ai()           (지침서 §3.3)
                  │
                  ▼
         Gemini 2.5 Flash
    "핵심 10개, 해외는 한국어 번역"
                  │
                  ▼
        build_html_email() + smtplib
                  │
                  ▼
            📧  Gmail 받은편지함
```

---

## 🕒 스케줄

GitHub Actions cron 표현식:

```yaml
schedule:
  - cron: '0 23 * * *'   # UTC 23:00 = KST 08:00
```

---

## 🚧 아직 구현되지 않은 기능 (TODO)

- [ ] **한경 컨센서스 일일 리포트 크롤링** (BeautifulSoup 기반, 설계서 §1)
- [ ] **네이버 증권 ETF 수익률 상위/하위 JSON API 수집** (설계서 §1)
- [ ] **종목 코드별 맞춤 요약** (예: 사용자가 보유한 SK하이닉스/삼성전자 우선 표시)
- [ ] **Slack / 텔레그램 Webhook 복수 채널 발송**
- [ ] **Deep-dive 주간/월간 리포트 자동 생성**
- [ ] **요약 결과를 GitHub Pages 에 아카이브로 배포**

---

## 📝 개발 단계 이력

| 단계 | 완료 | 내용 |
|:---:|:---:|---|
| 1 | ✅ | 프로젝트 골격 + `collect_korean_news` (한국 3사) |
| 2 | ✅ | `get_us_news` (미국 매체), `get_youtube_news` (디일렉), `collect_all_data` 통합 |
| 3 | ✅ | `format_data_for_ai`, Gemini 요약, Gmail SMTP, `main.py`, GitHub Actions 워크플로 |

---

## 📚 기술 스택

- `requests`, `feedparser`, `beautifulsoup4` — 수집
- `google-generativeai` — Gemini 2.5 Flash
- `google-api-python-client` — YouTube Data API v3 (선택)
- `smtplib`, `email` — Gmail SMTP (Python 표준 라이브러리)
- **GitHub Actions** — 서버리스 cron

---

## 🧪 로컬 실행 결과 스크린샷 (텍스트)

```
✅ 한국경제(증권) (Google News 우회): 5건 수집 완료
✅ 한국경제(IT)   (Google News 우회): 5건 수집 완료
✅ 매일경제(증권): 5건 수집 완료
✅ 매일경제(IT):   5건 수집 완료
✅ 머니투데이(증권): 5건 수집 완료
✅ 머니투데이(IT):   5건 수집 완료
✅ Seeking Alpha / ETF.com / Morningstar / Reuters / Bloomberg (각 3건)
✅ 디일렉(유튜브) (RSS): 5건 수집 완료
✨ 중복 제거 후 최종: 53건
📝 AI 입력 텍스트 길이: 22,840 chars
```

---

## 📄 라이선스 & 크레딧

- 원천 뉴스의 저작권은 각 매체에 있습니다. 본 시스템은 개인 이용 목적의 요약 브리핑만 수행합니다.
- 설계서 및 프롬프트 가이드 © 사용자 제공 문서.

_Last updated: 2026-04-21_
