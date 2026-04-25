"""
[v2.9.1] 미국 뉴스 누락 방지 + 이메일 폭 1024px + 노란 박스 연동 (2026-04-24 패치).

## v2.9.1 핵심 수정 (2026-04-24, 사용자 피드백 재반영)
----------------------------------------------------
사용자 피드백: "v2.9.0 배포 후 메일에 미국 뉴스 0건" "이메일 폭 더 넓게"
v2.9.0 → v2.9.1 핵심 변경 3가지:
  1) 🔴 _region_aware_fallback() 신규 — AI 랭킹 실패 시 미국 우선 폴백 (v2.9.0은 단순 slicing이어서 한국만 통과 가능성)
  2) 🔴 assemble_final_briefing() 미국 0건 시 경고 메시지 + logger.error 출력
  3) 🎨 email_sender.py: 이메일 폭 920→1024px, 노란 박스 폰트 27→24px(최적 밸런스), box-shadow 강화

## v2.9.0 핵심 수정 (2026-04-24, 사용자 피드백 전면 반영)
----------------------------------------------------
v2.8.0(7줄/10건) → v2.9.0(10줄/15건) 확장. 사용자 요청 6가지 반영:

## v2.9.0 핵심 수정 (2026-04-24, 사용자 피드백 전면 반영)
----------------------------------------------------
v2.8.0(7줄/10건) → v2.9.0(10줄/15건) 확장. 사용자 요청 6가지 반영:
  1) 카테고리 엄격 필터: 반도체 + 원자력 (그 외 전량 배제)
  2) 건수 10 → 15건
  3) 미국 우선: US 7건(rank 1~7) + KR 8건(rank 8~15)
  4) 요약 분량 7줄 → 10줄 (⚡검색어매칭, 🏭파급효과, 📅일정 추가)
  5) 메일 너비 680px → 920px (email_sender.py)
  6) 노란색 투자 시사점 박스 확대 (email_sender.py)

### v2.9.0 10줄 귀납법 구조
  💰 핵심 팩트 1 (금액·실적·규모)
  📊 핵심 팩트 2 (경쟁·공급·시점)
  📉 원인 1 (내부 요인·수요·공급)
  📈 원인 2 (외부 배경·정책·규제)
  🔍 맥락 (업계 전반 구조 변화)
  ⚡ 검색어 매칭 (왜 이 뉴스가 '반도체/원자력' 테마인지)  ← v2.9.0 신규
  🏭 파급 효과 (밸류체인·전후방 영향)                    ← v2.9.0 신규
  📅 일정·타임라인 (언제·어떤 변곡점)                    ← v2.9.0 신규
  🎯 수혜주 (종목명·코드·목표가·상승여력)
  📬 시사점 (투자자 행동 지침)

### 주요 상수 변경
  1) TARGET_NEWS_COUNT 10 → 15
  2) US_QUOTA 4 → 7, KR_QUOTA 6 → 8
  3) MIN_ITEM_CHARS 300 → 450
  4) ITEM_MAX_OUTPUT_TOKENS 1536 → 2048
  5) ALLOWED_CATEGORIES = ("반도체", "원자력") 엄격 필터

### 기대 효과
  - 1건 분량 400~600자 → 600~900자 (원인+파급효과+일정 추가)
  - 건수 10 → 15건 (+50%)
  - 반도체/원자력에 집중된 투자 정보
  - 발송 소요 시간 3~5분 → 5~8분 (GitHub Actions 14분 한도 내)
  - HTML 크기 ~60 KB → ~100 KB (Gmail 102 KB 한도 내)

## v2.8.0 (2026-04-24): 7줄 귀납법 포맷 (이전 버전, 유지)

## v2.7.0 (2026-04-24): 4줄 귀납법 포맷 (유지)

## v2.7.0 핵심 수정 (2026-04-24)
----------------------------------------------------
기존 v2.6.3 은 뉴스 1건당 500~700자 5~7문장의 서술형 요약을 생성했으나
수치 포함도가 낮고 모바일에서 스크롤이 길다는 피드백 반영.

### v2.7.0 포맷 변경
  1) `_build_item_prompt()` — 4줄 귀납법 프롬프트로 교체:
     💰(수치) / 📊(배경) / 🔍(구조) / 📈(결론) 4줄 강제.
  2) `_is_item_output_valid()` — 4개 이모지 라인 + 숫자 3개 이상 검증.
  3) `_fallback_item_markdown()` — 동일 4줄 포맷으로 통일.
  4) `MIN_ITEM_CHARS` 250 → 150 축소 (4줄은 짧으니까).

### 기대 효과
  - 1건 분량 500~700자 → 150~250자 (60% 축소)
  - 숫자 포함도 평균 0~2개 → 4~8개
  - 모바일 한 화면에 2~3건 노출
  - OpenAI 토큰 비용 약 60% 절감

## v2.6.3 (2026-04-23): Gemini/OpenAI 2단계 엔진 + OpenAI fallback 강화 (유지).

## v2.6.3 핵심 수정 (2026-04-23)
----------------------------------------------------
- 증상: Gemini 무료 티어 일일 20회 한도 소진 후 Step 2의 10개 아이템 호출이
  모두 429 RESOURCE_EXHAUSTED로 실패했으나, 각 아이템이 조용히 원본 폴백 마크다운으로
  대체되어 파이프라인이 "정상 종료"로 간주됨. 결과: OpenAI 키가 등록되어 있음에도
  불구하고 item 단계에서는 한 번도 호출되지 않아 AI 요약 없는 브리핑이 발송됨.

### v2.6.3 수정 내역
  1) `summarize_one_item()` - Gemini 6회 재시도 전부 실패 시 OpenAI 호환 API 호출 추가
  2) `rank_top_news()`      - Gemini 랭킹 실패 시 OpenAI 호환 API로 동일 프롬프트 재시도
  3) `generate_overview()`  - Gemini 총평 실패 시 OpenAI 호환 API로 재시도
  4) `_call_openai_chat()`  - 모든 단계 공통 OpenAI 호출 헬퍼 신규 추가
  5) `_is_openai_available()` - 환경 변수 OPENAI_API_KEY 존재 체크 헬퍼

## v2.5.0 → v2.6.2 전면 개편 (Option B)

## v2.5.0 전면 개편 (Option B)
----------------------------------------------------
기존 v2.4.1 은 "한 번에 10개 요약"을 Gemini에게 요구했으나
  - flash가 503 과부하 시 flash-lite로 강등 → lite가 3,123자로 축약
  - 실제 발송(2026-04-23 07:44 KST)은 **282자 응답**만 받아서 메일 1건만 표시
  → 근본적으로 "한 프롬프트에 27KB 입력, 10개 객체 출력"이 불안정

### v2.5.0 새로운 2단계 아키텍처
  1) **랭킹 단계** (mini call): 수집된 N건 뉴스 중 핵심 **10개 선별 + 순위**
     - 입력: 메타데이터(제목·출처·요약 100자)
     - 출력: JSON 배열 (각 항목: idx, rank, reason)
     - 모델: gemini-2.5-flash (빠르고 정확)
  2) **상세 요약 단계** (per-item): 선택된 10개를 **병렬로 각각 개별 요약**
     - 입력: 뉴스 1건 + 시스템 지침 (400~500자 상세 요약 강제)
     - 출력: 구조화 마크다운 (제목·출처·요약·시사점·원문)
     - 모델: gemini-2.5-flash (개별 호출이라 토큰 한도 여유)
  3) **조립 단계**: 10개 결과를 순서대로 이어 붙이고 '오늘의 총평' 추가

### 장점
  - 개별 호출이라 토큰 한도에 절대 안 걸림 (각 호출 최대 2K)
  - 1개가 실패해도 나머지 9개는 정상 → robust
  - 각 항목별 품질 검증 가능 → 짧으면 재시도
  - 모델 과부하 시 자동 폴백 + 병렬이라 전체 시간 단축

## 모델 폴백 순서 (v2.5.0)
  gemini-2.5-flash → gemini-2.5-flash-lite → gemini-2.0-flash → gemini-1.5-flash
  → OpenAI 호환 API (설정 시) → 최후 수단: 원본 데이터 기반 규칙 기반 요약
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# ─── 모델 설정 ─────────────────────────────────────────────
GEMINI_RETRY_DELAYS_SEC = (2, 4, 8)  # 지수 백오프
GEMINI_FALLBACK_MODELS = (
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
)
TRANSIENT_KEYWORDS = (
    "503", "UNAVAILABLE", "overloaded", "RESOURCE_EXHAUSTED",
    "429", "deadline", "INTERNAL", "timeout",
)

# ─── 품질 기준 (v2.9.0 — 10줄/15건 확장) ───────────────────
MIN_OUTPUT_CHARS = 5000         # v2.9.0: 3500→5000 (15건 대응)
MIN_NEWS_ITEMS = 15             # v2.9.0: 10→15 (사용자 요청)
MAX_OUTPUT_TOKENS = 8192        # Gemini 2.5 Flash의 max
TARGET_NEWS_COUNT = 15          # v2.9.0: 10→15 최종 출력 뉴스 개수

# 개별 뉴스 요약 기준
MIN_ITEM_CHARS = 450            # v2.9.0: 300→450 (10줄 귀납법, +검색어매칭·파급효과·일정)
ITEM_MAX_OUTPUT_TOKENS = 2048   # v2.9.0: 1536→2048 (10줄 확장 대응, 한국어 약 600~900자)

# v2.9.0: 허용 카테고리 엄격 제한 (반도체 + 원자력 2종만)
ALLOWED_CATEGORIES = ("반도체", "원자력")

# ─── v2.6.0: 순차 호출/페이싱 (Gemini 무료 티어 RPM 제한 대응) ────
# Gemini 무료 티어: gemini-2.5-flash = 10 RPM (분당 10회).
# 기존엔 ThreadPoolExecutor(max_workers=4) 로 동시에 4건을 호출했고,
# 10건 랭킹+총평까지 합치면 12회/1분 이내로 초과해 429 발생 빈번.
# SUMMARY_MODE=sequential 이면 각 호출 사이 SUMMARY_CALL_DELAY_SEC 초 대기.
#
# 환경 변수
#   SUMMARY_MODE               : "sequential" | "parallel" (기본 sequential)
#   SUMMARY_CALL_DELAY_SEC     : 순차 호출 간 대기(기본 6초 = 10 RPM 안전)
#   SUMMARY_MAX_WORKERS        : parallel 일 때 동시 실행 수 (기본 4)
SUMMARY_MODE = os.getenv("SUMMARY_MODE", "sequential").strip().lower()
SUMMARY_CALL_DELAY_SEC = float(os.getenv("SUMMARY_CALL_DELAY_SEC", "6"))
SUMMARY_MAX_WORKERS = int(os.getenv("SUMMARY_MAX_WORKERS", "4"))

# 개별 뉴스 요약에 원문 본문(스크래핑 결과)이 얼마나 잘려 들어갈지
# — 기존 500자 에서 1500자 로 확장해 AI 가 재료를 충분히 확보하도록.
ITEM_PROMPT_BODY_CHARS = int(os.getenv("ITEM_PROMPT_BODY_CHARS", "1500"))

# ─── 공통 유틸 ─────────────────────────────────────────────
def _is_transient_error(exc: Exception) -> bool:
    msg = str(exc)
    return any(k in msg for k in TRANSIENT_KEYWORDS)


def _now_kst() -> datetime:
    from datetime import timezone, timedelta
    try:
        return datetime.now(timezone(timedelta(hours=9)))
    except Exception:
        return datetime.now()


def _today_kr_str() -> str:
    d = _now_kst()
    weekday_kr = ["월", "화", "수", "목", "금", "토", "일"][d.weekday()]
    return d.strftime(f"%Y년 %m월 %d일 ({weekday_kr})")


def _today_iso_str() -> str:
    return _now_kst().strftime("%Y-%m-%d")


# ════════════════════════════════════════════════════════════
# 단계 1) 랭킹 — 수집된 N건 중 상위 10개 선별
# ════════════════════════════════════════════════════════════
def _build_ranking_prompt(news_list: List[Dict[str, str]]) -> str:
    """N건 뉴스 중 상위 10개를 선별하는 프롬프트 (JSON 출력)."""
    today = _today_kr_str()

    lines = [f"=== 후보 뉴스 목록 (총 {len(news_list)}건) ==="]
    for i, n in enumerate(news_list):
        src = n.get("source", "")
        title = (n.get("title") or "").strip()[:120]
        summary_snippet = (n.get("summary") or "").strip().replace("\n", " ")[:200]
        lines.append(f"[{i}] ({src}) {title}")
        if summary_snippet:
            lines.append(f"    요약: {summary_snippet}")

    news_block = "\n".join(lines)

    return f"""당신은 한국 개인투자자를 위한 '반도체·원자력 일일 브리핑'의 편집장입니다.
오늘은 **{today}** (KST) 입니다.

아래 후보 뉴스 {len(news_list)}건 중, **반도체 또는 원자력 테마**에 해당하는 뉴스만 선별하여
**핵심 뉴스 정확히 {TARGET_NEWS_COUNT}개**를 순위를 매겨 선정해 주세요.

## 🚨 v2.9.0 엄격 카테고리 필터 (반드시 준수)
**오직 아래 2개 카테고리만 선정**하세요. 그 외는 **전량 배제**합니다.

✅ **허용 카테고리 (2종만)**:
- **반도체**: 엔비디아, AMD, 인텔, 마이크론, TSMC, 삼성전자, SK하이닉스, HBM, 메모리, 파운드리, AI 칩, ASML, SOXX/SMH ETF
- **원자력**: SMR(소형모듈원자로), 우라늄, 원전, 두산에너빌리티, 한수원, 한전KPS, NuScale, Cameco, 원전 수출

❌ **배제 카테고리 (전부 제외)**:
- 바이오/제약, 화장품, 일반 자동차, 건설, 은행/금융, 소비재
- 일반 증시 지수 (코스피/S&P 단순 등락)
- 거시경제 (환율·금리) — 단, **반도체/원자력 기업에 직접 영향** 주는 내용이면 허용
- AI (단, **반도체 칩·HBM·GPU** 관련이면 반도체로 분류)
- 빅테크 일반 (단, **반도체 칩 설계·구매** 관련이면 반도체로 분류)

## 🚨 필수 지역 쿼터 (v2.9.0)
| 지역 | 필수 건수 | 설명 |
|---------|----------|------|
| 🇺🇸 **미국 매체** | **정확히 7건** | Seeking Alpha, Reuters, Bloomberg, ETF.com, Morningstar (영문 출처) |
| 🇰🇷 **한국 매체** | **정확히 8건** | 한국경제, 매일경제, 머니투데이, 조선비즈 등 한글 출처 |

**합계: 미국 7건 + 한국 8건 = 총 15건 (엄격히 준수)**

## 선정 우선순위

### 🇺🇸 미국 매체 7건 세부 구성
- 반도체: 4~5건 (엔비디아, AMD, 인텔, 마이크론, TSMC, HBM, ASML 관련)
- 원자력: 2~3건 (SMR, 우라늄, 원전, Cameco, NuScale, Vistra 관련)

### 🇰🇷 한국 매체 8건 세부 구성
- 반도체: 5~6건 (삼성전자, SK하이닉스, 한미반도체, HPSP, 원익IPS, 파운드리, HBM)
- 원자력: 2~3건 (두산에너빌리티, 한수원, 한전KPS, SMR, 원전 수출)

## 💡 출처 식별 가이드
- **🇺🇸 미국 매체**: Seeking Alpha, Seeking Alpha (ETF), Seeking Alpha (Nuclear), Reuters, Reuters (Nuclear), Bloomberg, Bloomberg (Nuclear), ETF.com, Morningstar, Morningstar (Nuclear)
- **🇰🇷 한국 매체**: 한국경제(증권/IT/반도체/원자력), 매일경제(증권/IT/원자력), 머니투데이(증권/IT), 조선비즈(반도체/원자력) 등

미국 매체 뉴스는 **제목이 영어**이더라도 한국 투자자에게 중요하므로 반드시 포함하세요.

## 🚫 부적합 뉴스 대응
- 반도체/원자력 관련 뉴스가 **수량에 미달**하면 **관련성이 가장 높은 순**으로 선정 (예: AI 칩 투자, 전력 인프라 등 간접 연관 허용).
- 그래도 미달 시 **건수가 부족해도** 관련 없는 뉴스는 **절대 포함하지 말 것**.

## 🚮 정보 부족 후보 자동 배제 (v2.9.3)
- 후보 요약이 **2~3줄 이하**로 매우 짧거나, 핵심 숫자/사실이 없는 항목은 **선정하지 마세요**.
- 제목만 있고 본문이 사실상 없는 항목(예: "...하다." 한 줄짜리)은 배제.
- 광고성·홍보성 보도자료(특정 제품 출시 선전, 행사 후기)도 배제.
- 결과적으로 15건이 안 채워져도 좋습니다 — **품질 미달 후보를 억지로 채우지 말 것**.

## 출력 형식 (반드시 순수 JSON 배열만, 설명 문장 없이)
```json
[
  {{"idx": 후보번호, "rank": 1, "category": "반도체", "region": "US", "reason": "선정 이유 한 줄"}},
  ...(총 {TARGET_NEWS_COUNT}개)
]
```

- `idx`: 위 후보 목록의 [번호]
- `rank`: 1~{TARGET_NEWS_COUNT} (중복 불가, 미국 7건 먼저[1~7], 한국 8건 이후[8~15])
- `category`: **"반도체"** 또는 **"원자력"** — 이 2개만 허용 (v2.9.0)
- `region`: **"US"** (미국 매체) 또는 **"KR"** (한국 매체) — 반드시 명시
- `reason`: 왜 오늘 중요한지 한 줄 (20자 내외)

{news_block}

위 {len(news_list)}건 중 정확히 {TARGET_NEWS_COUNT}개를 선정하되,
- 🇺🇸 미국 매체 **정확히 7건** + 🇰🇷 한국 매체 **정확히 8건**
- 카테고리는 **반도체 또는 원자력 2종만** 허용
- **rank 1~7은 미국, rank 8~15는 한국** 순서로 배치
JSON 배열로만 답변하세요.
"""


def _parse_ranking_json(text: str) -> List[Dict[str, Any]]:
    """모델 출력에서 JSON 배열을 추출. ```json 블록, 앞뒤 텍스트 대응."""
    if not text:
        return []

    # 1) ```json ... ``` 코드 블록 추출 시도
    m = re.search(r"```(?:json)?\s*(\[[\s\S]*?\])\s*```", text)
    if m:
        candidate = m.group(1)
    else:
        # 2) 최상위 [ ... ] 배열 추출
        m = re.search(r"(\[\s*\{[\s\S]*\}\s*\])", text)
        candidate = m.group(1) if m else text

    try:
        data = json.loads(candidate)
        if isinstance(data, list):
            return data
    except Exception as exc:
        logger.warning("랭킹 JSON 파싱 실패: %s", exc)

    return []


def _call_gemini_simple(
    client, model_name: str, prompt: str, max_tokens: int = MAX_OUTPUT_TOKENS,
    temperature: float = 0.3,
) -> str:
    """단일 Gemini 호출 (재시도 없음, 순수 호출)."""
    from google.genai import types as gt
    response = client.models.generate_content(
        model=model_name,
        contents=prompt,
        config=gt.GenerateContentConfig(
            temperature=temperature,
            top_p=0.9,
            max_output_tokens=max_tokens,
        ),
    )
    return (response.text or "").strip()


# ════════════════════════════════════════════════════════════
# v2.6.3: OpenAI 호환 단일 호출 헬퍼 (모든 단계 공용)
# ════════════════════════════════════════════════════════════
def _is_openai_available() -> bool:
    """OpenAI fallback 사용 가능 여부 체크."""
    return bool(os.getenv("OPENAI_API_KEY"))


def _call_openai_chat(
    prompt: str,
    max_tokens: int = 1024,
    temperature: float = 0.3,
    system_prompt = None,
    call_label: str = "",
) -> str:
    """
    v2.6.3: 단일 OpenAI Chat Completions 호출.
    Gemini 실패 시 각 단계(rank/item/overview)에서 이 함수로 재시도.

    환경 변수:
      OPENAI_API_KEY  : 필수
      OPENAI_BASE_URL : 선택 (기본: https://api.openai.com/v1)
      OPENAI_MODEL    : 선택 (기본: gpt-4o-mini)
    """
    from openai import OpenAI

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY 미설정")

    base_url = os.getenv("OPENAI_BASE_URL") or None
    model_name = os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip()

    client = OpenAI(api_key=api_key, base_url=base_url) if base_url else OpenAI(api_key=api_key)
    logger.info("OpenAI[%s] model=%s max_tokens=%d 호출 시작", call_label, model_name, max_tokens)

    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})

    resp = client.chat.completions.create(
        model=model_name,
        messages=messages,
        max_tokens=max_tokens,
        temperature=temperature,
    )
    text = (resp.choices[0].message.content or "").strip()
    if not text:
        raise RuntimeError(f"OpenAI[{call_label}] 빈 응답")
    logger.info("OpenAI[%s] ✅ 성공 (%d자)", call_label, len(text))
    return text


def _call_with_retry(
    client, prompt: str, max_tokens: int, temperature: float,
    call_label: str = "",
) -> Tuple[str, str]:
    """여러 모델 + 지수 백오프로 재시도. (응답, 사용 모델) 반환. 전부 실패 시 예외."""
    models_to_try = ("gemini-2.5-flash",) + GEMINI_FALLBACK_MODELS
    last_exc: Optional[Exception] = None

    for m in models_to_try:
        for attempt, delay in enumerate([0, *GEMINI_RETRY_DELAYS_SEC]):
            if delay:
                time.sleep(delay)
            try:
                logger.info(
                    "Gemini[%s] model=%s attempt=%d/%d max_tokens=%d",
                    call_label, m, attempt + 1,
                    len(GEMINI_RETRY_DELAYS_SEC) + 1, max_tokens,
                )
                text = _call_gemini_simple(client, m, prompt, max_tokens, temperature)
                if text:
                    return text, m
                last_exc = RuntimeError("empty response")
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                if _is_transient_error(exc):
                    logger.warning("Gemini[%s] %s 일시 오류 — 재시도: %s", call_label, m, exc)
                    continue
                logger.warning("Gemini[%s] %s 영구 오류, 다음 모델: %s", call_label, m, exc)
                break
        logger.warning("Gemini[%s] 모델 %s 전체 실패 → 다음 모델", call_label, m)

    raise RuntimeError(f"모든 Gemini 모델 실패 ({call_label}): {last_exc}")


def rank_top_news(
    news_list: List[Dict[str, str]],
    client,
) -> List[Dict[str, Any]]:
    """
    Step 1: 수집된 뉴스에서 상위 10개를 선별.

    Returns
    -------
    List[Dict]: [{idx, rank, category, reason, original}, ...]
        original = 원본 뉴스 dict (source/title/link/summary)
    """
    if len(news_list) <= TARGET_NEWS_COUNT:
        logger.info("수집 뉴스 %d건 ≤ 목표 %d건, 전체 채택",
                    len(news_list), TARGET_NEWS_COUNT)
        return [
            {
                "idx": i, "rank": i + 1, "category": "기타",
                "reason": "자동 포함", "original": n,
            }
            for i, n in enumerate(news_list)
        ]

    prompt = _build_ranking_prompt(news_list)
    logger.info("Step 1) 랭킹 호출: 후보=%d건, 프롬프트=%d자",
                len(news_list), len(prompt))

    # ─────────────────────────────────────────────────────────
    # v2.6.3: Gemini 랭킹 실패 시 OpenAI 호환 API 재시도
    # ─────────────────────────────────────────────────────────
    text = ""
    used_model = ""
    try:
        text, used_model = _call_with_retry(
            client, prompt, max_tokens=2048, temperature=0.2, call_label="rank",
        )
        logger.info("Step 1) 랭킹 응답 (모델=%s, 길이=%d)", used_model, len(text))
    except Exception as exc:  # noqa: BLE001
        logger.warning("Step 1) Gemini 랭킹 실패: %s", exc)
        if _is_openai_available():
            try:
                logger.info("Step 1) → OpenAI fallback 랭킹 시도")
                text = _call_openai_chat(
                    prompt, max_tokens=2048, temperature=0.2, call_label="rank",
                )
                used_model = "openai-fallback"
                logger.info("Step 1) ✅ OpenAI 랭킹 성공 (%d자)", len(text))
            except Exception as exc2:  # noqa: BLE001
                logger.warning("Step 1) OpenAI 랭킹도 실패: %s", exc2)
                text = ""
        if not text:
            logger.warning("Step 1) 랭킹 API 전면 실패 → 미국 우선 폴백 (v2.9.1)")
            return _region_aware_fallback(news_list)

    parsed = _parse_ranking_json(text)
    if not parsed:
        logger.warning("랭킹 JSON 파싱 실패 → 미국 우선 폴백 (v2.9.1)")
        return _region_aware_fallback(news_list)

    # rank 순으로 정렬 + idx 유효성 검증
    result: List[Dict[str, Any]] = []
    seen_idx = set()
    for item in parsed:
        try:
            idx = int(item.get("idx"))
            rank = int(item.get("rank", len(result) + 1))
        except (TypeError, ValueError):
            continue
        if idx < 0 or idx >= len(news_list) or idx in seen_idx:
            continue
        seen_idx.add(idx)
        result.append({
            "idx": idx,
            "rank": rank,
            "category": str(item.get("category", "기타")),
            "reason": str(item.get("reason", "")),
            "original": news_list[idx],
        })

    result.sort(key=lambda x: x["rank"])
    # 목표 개수 미달이면 미채택 뉴스로 보충
    if len(result) < TARGET_NEWS_COUNT:
        for i, n in enumerate(news_list):
            if len(result) >= TARGET_NEWS_COUNT:
                break
            if i not in seen_idx:
                result.append({
                    "idx": i, "rank": len(result) + 1,
                    "category": "기타", "reason": "자동 보충",
                    "original": n,
                })
    result = result[:TARGET_NEWS_COUNT]

    # ─────────────────────────────────────────────────────────────
    # v2.9.0: 🇺🇸 미국 7건 + 🇰🇷 한국 8건 엄격 쿼터 + 순서 재배치 (v2.6.2 대비 확장)
    # ─────────────────────────────────────────────────────────────
    # 독자는 매일 동일 구성의 브리핑을 기대하므로 수량을 고정한다.
    # 또한 "미국 섹션 먼저 → 한국 섹션 나중" 구조이므로
    # 미국 7건이 rank 1~7 로 오도록 재정렬한다.
    result = _enforce_region_quota(result, news_list, seen_idx,
                                    target_us=US_QUOTA, target_kr=KR_QUOTA)

    logger.info("Step 1) 최종 선정: %d건 (미국 %d + 한국 %d)", len(result),
                sum(1 for r in result if _is_us_source(r["original"].get("source", ""))),
                sum(1 for r in result if not _is_us_source(r["original"].get("source", ""))))
    return result


# ═══════════════════════════════════════════════════════════════
# v2.9.0: 미국/한국 매체 식별 + 엄격 쿼터(미국 7 + 한국 8) 강제 로직
# ═══════════════════════════════════════════════════════════════
US_SOURCE_KEYWORDS = (
    "Seeking Alpha", "Reuters", "Bloomberg",
    "ETF.com", "Morningstar",
)
US_QUOTA = 7  # v2.9.0: 4→7 🇺🇸 미국 매체 Top 15 중 정확한 건수 (미국 우선)
KR_QUOTA = 8  # v2.9.0: 6→8 🇰🇷 한국 매체 Top 15 중 정확한 건수


def _is_us_source(source: str) -> bool:
    """출처명이 미국 매체인지 확인. 대소문자 무시, 부분 일치."""
    if not source:
        return False
    s = source.strip()
    for kw in US_SOURCE_KEYWORDS:
        if kw.lower() in s.lower():
            return True
    return False


def _region_aware_fallback(news_list: List[Dict[str, str]]) -> List[Dict[str, Any]]:
    """
    v2.9.1: AI 랭킹 전면 실패 시 사용하는 미국 우선 폴백 로직.

    기존(v2.9.0): news_list[:15] 를 단순히 잘랐기 때문에 수집 결과 순서가
                 한국 뉴스 먼저이면 미국 뉴스 0건으로 발송되는 버그 발생.

    개선(v2.9.1): 수집 결과에서 미국 매체 7건 + 한국 매체 8건을 각각 앞에서부터
                 골라 정확한 15건(미국 먼저) 구성을 강제한다.
    """
    us_candidates = [(i, n) for i, n in enumerate(news_list)
                     if _is_us_source(n.get("source", ""))]
    kr_candidates = [(i, n) for i, n in enumerate(news_list)
                     if not _is_us_source(n.get("source", ""))]

    logger.info(
        "🔄 폴백 랭킹: 수집된 미국 %d건, 한국 %d건 → 목표 미국 %d, 한국 %d",
        len(us_candidates), len(kr_candidates), US_QUOTA, KR_QUOTA,
    )

    # 미국 우선 선정 → 한국으로 보충
    picked_us = us_candidates[:US_QUOTA]
    picked_kr = kr_candidates[:KR_QUOTA]

    # 미국이 부족하면 한국으로, 한국이 부족하면 미국으로 보충
    total = len(picked_us) + len(picked_kr)
    if total < TARGET_NEWS_COUNT:
        extra_us = us_candidates[len(picked_us):]
        extra_kr = kr_candidates[len(picked_kr):]
        for src in (extra_kr, extra_us):
            for cand in src:
                if total >= TARGET_NEWS_COUNT:
                    break
                # 이미 포함된 인덱스 회피
                if cand[0] not in {x[0] for x in (picked_us + picked_kr)}:
                    if _is_us_source(cand[1].get("source", "")):
                        picked_us.append(cand)
                    else:
                        picked_kr.append(cand)
                    total += 1

    # 순서: 미국 먼저 → 한국 이후
    result: List[Dict[str, Any]] = []
    rank = 1
    for (idx, n) in picked_us:
        result.append({
            "idx": idx, "rank": rank, "category": "미국증시",
            "reason": "🇺🇸 폴백 선정 (v2.9.1)", "original": n,
        })
        rank += 1
    for (idx, n) in picked_kr:
        result.append({
            "idx": idx, "rank": rank, "category": "한국증시",
            "reason": "🇰🇷 폴백 선정 (v2.9.1)", "original": n,
        })
        rank += 1

    logger.warning(
        "🔄 폴백 완료: 최종 %d건 (🇺🇸 %d + 🇰🇷 %d)",
        len(result), len(picked_us), len(picked_kr),
    )
    return result


def _enforce_region_quota(
    ranked: List[Dict[str, Any]],
    all_news: List[Dict[str, str]],
    seen_idx: set,
    target_us: int = US_QUOTA,
    target_kr: int = KR_QUOTA,
) -> List[Dict[str, Any]]:
    """
    v2.9.0: 엄격한 미국/한국 매체 쿼터 강제 + 순서 재배치 (7:8=15건).

    최종 목표 구성 (v2.9.0):
      - rank 1~target_us (7): 🇺🇸 미국 매체 뉴스
      - rank target_us+1 ~ target_us+target_kr (8~15): 🇰🇷 한국 매체 뉴스

    동작:
      1. AI 선정 결과를 미국/한국 두 버킷으로 분리.
      2. 각 버킷이 목표치에 못 미치면 원본 후보에서 보충.
      3. 각 버킷이 목표치를 초과하면 낮은 순위부터 제거.
      4. 미국 먼저(rank 1~7), 한국 나중(rank 8~15) 으로 재정렬.

    이 함수 완료 후 정확히 ``target_us + target_kr`` (=15) 건이 반환된다.
    """
    target_total = target_us + target_kr

    # 1) AI 선정 결과를 미국/한국 버킷으로 분리
    ai_us = [r for r in ranked if _is_us_source(r["original"].get("source", ""))]
    ai_kr = [r for r in ranked if not _is_us_source(r["original"].get("source", ""))]

    # 기존 선정 순위 유지하기 위해 rank 순으로 정렬
    ai_us.sort(key=lambda x: x["rank"])
    ai_kr.sort(key=lambda x: x["rank"])

    logger.info(
        "Step 1-A) AI 원선정: 미국 %d건, 한국 %d건 → 목표: 미국 %d건, 한국 %d건",
        len(ai_us), len(ai_kr), target_us, target_kr,
    )

    # 2) 각 버킷을 목표치로 맞추기 (부족하면 보충, 초과하면 절단)
    used_idx = set(r["idx"] for r in (ai_us + ai_kr))

    # 미국 보충
    if len(ai_us) < target_us:
        need = target_us - len(ai_us)
        available_us = [
            (i, n) for i, n in enumerate(all_news)
            if _is_us_source(n.get("source", "")) and i not in used_idx
        ]
        for k, (cand_idx, cand_news) in enumerate(available_us[:need]):
            ai_us.append({
                "idx": cand_idx,
                "rank": 999,  # 임시
                "category": "미국증시",
                "reason": "🇺🇸 미국 매체 쿼터 보장 (v2.6.2)",
                "original": cand_news,
            })
            used_idx.add(cand_idx)
        if len(ai_us) < target_us:
            logger.warning(
                "🇺🇸 미국 뉴스 보충 실패: 목표 %d, 확보 %d (원본 후보 부족)",
                target_us, len(ai_us),
            )

    # 한국 보충
    if len(ai_kr) < target_kr:
        need = target_kr - len(ai_kr)
        available_kr = [
            (i, n) for i, n in enumerate(all_news)
            if not _is_us_source(n.get("source", "")) and i not in used_idx
        ]
        for k, (cand_idx, cand_news) in enumerate(available_kr[:need]):
            ai_kr.append({
                "idx": cand_idx,
                "rank": 999,  # 임시
                "category": "한국증시",
                "reason": "🇰🇷 한국 매체 쿼터 보장 (v2.6.2)",
                "original": cand_news,
            })
            used_idx.add(cand_idx)
        if len(ai_kr) < target_kr:
            logger.warning(
                "🇰🇷 한국 뉴스 보충 실패: 목표 %d, 확보 %d (원본 후보 부족)",
                target_kr, len(ai_kr),
            )

    # 초과분 절단 (하위 rank 제거)
    ai_us = ai_us[:target_us]
    ai_kr = ai_kr[:target_kr]

    # 3) 🇺🇸 미국(rank 1~4) + 🇰🇷 한국(rank 5~10) 순서로 재배치
    final_result: List[Dict[str, Any]] = []
    for i, item in enumerate(ai_us, start=1):
        item["rank"] = i
        final_result.append(item)
    for i, item in enumerate(ai_kr, start=target_us + 1):
        item["rank"] = i
        final_result.append(item)

    logger.info(
        "✅ v2.9.0 쿼터 강제 적용 완료: 🇺🇸 %d건 (rank 1~%d) + 🇰🇷 %d건 (rank %d~%d) = 총 %d건",
        len(ai_us), target_us,
        len(ai_kr), target_us + 1, target_us + target_kr,
        len(final_result),
    )
    return final_result


# ════════════════════════════════════════════════════════════
# 단계 2) 개별 뉴스 상세 요약
# ════════════════════════════════════════════════════════════
def _build_item_prompt(item: Dict[str, Any]) -> str:
    """개별 뉴스 1건에 대한 상세 요약 프롬프트."""
    today = _today_kr_str()
    orig = item["original"]
    rank = item["rank"]
    category = item.get("category", "기타")

    # v2.9.3: 10줄 귀납법 + "현 상황 집중" 정책 (경영사·역사적 배경 금지)
    # 원문 본문은 최대 ITEM_PROMPT_BODY_CHARS 까지 전달해 구체 수치 추출 유도.
    body_chars = ITEM_PROMPT_BODY_CHARS
    return f"""당신은 한국 개인투자자를 위한 시니어 반도체·원자력 애널리스트입니다.
오늘은 **{today}** (KST) 입니다.

아래 뉴스 1건을 **숫자·금액 중심의 10줄 귀납법**으로 섬세하게 분석하세요.
읽는 데 40~60초 이내로 끝나야 하며, 각 줄은 **독립된 한 문장**입니다.

## 🚨 v2.9.3 핵심 지침 — "현 상황만 다뤄라"
**이전의 모든 지침은 이번 작성에는 우선하지 마세요.** 다음 새 정책을 최우선 적용합니다.

### ✅ 반드시 다룰 것 (현 상황 집중)
- **최근 7일 이내** 실적·계약·정책·가격·수요·공급 변화
- **이번 분기/이번 달** 가이던스, 출하량, 점유율
- **지금 이 시점**의 매수/매도 판단 근거
- 원문에 명시된 **구체 수치** (금액·%·건수·일정)

### ❌ 절대 다루지 말 것 (한참 지난 자료 / 경영 일반론 금지)
- **역사적 배경**: "역사적으로", "1990년대", "2000년대", "지난 수십 년", "오랜 세월"
- **경영 철학·비전**: "창업 이래", "기업 철학", "경영 비전", "회사의 DNA"
- **장기 회상**: "결국", "장기적으로", "끝내", "마침내" (원인 설명용 외엔 금지)
- **M&A 역사**: 과거 인수·합병 이력 회고 (단, 이번 주 발표된 신규 딜은 허용)
- **CEO 일대기**: 창업자·전 CEO 일생 회고
- 그 외 **3개월 이상 지난** 모든 배경 설명

이 금지어가 본문에 한 번이라도 들어가면 **재작성 대상**이 됩니다.

## 절대 준수 사항 (v2.9.3)
1. **출력 구조**: 제목 1줄 + 10개 이모지 라인(💰📊📉📈🔍⚡🏭📅🎯📬) + 원문 링크 1줄. **오직 이 형식만** 허용.
2. **숫자 밀도**: 10개 이모지 라인에 **숫자(금액·%·건수·연도·배수·종목코드 등)가 총 10개 이상** 포함되어야 함.
3. **귀납법 10단계**: 팩트 2줄 → 원인 2줄 → 맥락 1줄 → 검색어 매칭 1줄 → 파급 효과 1줄 → 일정 1줄 → 수혜주 1줄 → 시사점 1줄 순서로 **구체 사실에서 투자 결론**으로 전개.
4. **각 줄 길이**: 이모지 1줄당 **한국어 50~90자** (너무 짧으면 실패).
5. **⚡ 라인**: 이 뉴스가 왜 **"반도체" 또는 "원자력"** 테마에 해당하는지 근거를 명시.
6. **🏭 라인**: 밸류체인(소재→장비→설계→제조→고객사) 중 어느 단계가 파급 효과를 받는지 명시.
7. **📅 라인**: 실적 발표일, 양산 일정, 정책 시행일 등 **향후 6개월 내 변곡점** 명시.
8. **📬 라인**: 반드시 **"시사점"** 단어와 함께 **투자 행동 지침**(매수/매도/관망) + **목표가 또는 상승여력 %** 포함.
9. **🎯 라인**: 수혜주를 **종목명(종목코드) 목표가(+상승여력%)** 형태로 명시. 원문에 종목 정보 없으면 업계 대표주 제시.
10. **언어**: 원문이 영어여도 자연스러운 한국어로 번역. 모든 문장은 마침표/느낌표로 종결.
11. **추정 금지**: 원문에 없는 수치는 쓰지 말 것. 부족하면 "정보 부족" 또는 "원문 확인 필요" 로 명시.
12. **시제**: 모든 분석은 **현재형/근접 미래형**으로 작성. 과거형은 직전 분기 실적·이번 주 사건에만 한정.

## 10줄 귀납법 구조 (각 줄의 역할)
- 💰 **핵심 팩트 1**  = 가장 중요한 금액·실적·규모 수치
- 📊 **핵심 팩트 2**  = 경쟁·공급망·시점 관련 추가 수치
- 📉 **원인 1**       = 왜 이런 결과가 나왔나 (내부 요인·수요·공급)
- 📈 **원인 2**       = 추가 배경 (정책·규제·경쟁사 동향)
- 🔍 **맥락·구조**    = 업계 전반 구조 변화 (점유율·시장 규모)
- ⚡ **검색어 매칭**  = 이 뉴스가 반도체/원자력 테마에 해당하는 근거 (v2.9.0 신규)
- 🏭 **파급 효과**    = 밸류체인 전후방 영향 (소재·장비·설계·제조·고객) (v2.9.0 신규)
- 📅 **일정·타임라인** = 향후 변곡점 (실적 발표·양산 시작·정책 시행) (v2.9.0 신규)
- 🎯 **수혜주**       = 직접 수혜 종목명(코드) 목표가(+상승여력%)
- 📬 **시사점**       = 투자자 행동 지침 (귀납 결론, 매수·관망·리스크)

## 출력 형식 (이 구조만 허용, 빈 줄 포함)
### {rank}. {{한국어 핵심 제목 (25자 내외, 핵심 숫자 1개 포함 권장)}}

- **카테고리**: {category} · **출처**: {orig.get("source", "")}

💰 {{핵심 팩트 1 (금액·실적·규모, 예: 매출 20.4조 +39% YoY · 영업익 7.03조)}}
📊 {{핵심 팩트 2 (경쟁·공급·시점, 예: HBM3E 12단 Q1'26 양산 · 엔비디아 GB200 100% 동결)}}
📉 {{원인 1 — 왜 이런 결과가 나왔나 (예: 삼성 HBM3E 8단 인증 지연 → 공급 부족 6개월 연장)}}
📈 {{원인 2 — 추가 배경 (예: CHIPS Act $520억 보조금 + 美 관세 회피로 HBM 가격 28% 상승)}}
🔍 {{맥락·구조 (예: HBM 시장점유율 SK 53% · 삼성 38% · 마이크론 9%, SK 독주 구도)}}
⚡ {{검색어 매칭 (예: HBM·AI 가속기·GPU 핵심 부품으로 '반도체' 테마 직접 수혜, 월 출하량 +35%)}}
🏭 {{파급 효과 (예: 밸류체인 전방 — 한미반도체(042700) TC본더 수주 +40%, 후방 — 엔비디아 GB200 락인)}}
📅 {{일정·타임라인 (예: 2026 Q1 HBM3E 12단 양산 시작, 2026 Q2 실적 발표 5/1, GB200 출하 피크 2026 Q3)}}
🎯 **수혜주**: {{종목명(코드) 목표가(+상승여력%) — 2~3개 (예: SK하이닉스(000660, 24만원 +18%))}}
📬 **시사점**: {{투자 행동 지침 + 주요 리스크 (예: HBM 사이클 2027까지 매수, 리스크는 GB200 채택 지연)}}

- **원문 링크**: [{orig.get("source", "원문")}]({orig.get("link", "")})

---

## 원본 뉴스 정보
- 출처: {orig.get("source", "")}
- 제목: {orig.get("title", "")}
- 본문: {orig.get("summary", "")[:body_chars]}
- 링크: {orig.get("link", "")}

위 원본 정보만을 근거로 작성하세요. 확인되지 않은 사실은 추가하지 마세요.
원문에 정보가 부족한 라인은 "정보 부족" 이라고 명시하되, 10개 이모지 라인은 **반드시 모두 출력**하세요.
"""


# v2.9.3: 회피 표현 (정보 부족·원문 확인 등) — 카드당 2회까지만 허용
_AVOIDANCE_PHRASES = (
    "정보 부족", "정보부족", "추가 자료 필요", "추가 확인 필요",
    "원문에서 직접", "원문 확인 필요", "확인 불가", "명시되지 않",
)

# v2.9.3: 경영 일반론·역사적 배경 등 금지 표현 (카드당 2회 이상이면 무효)
_FORBIDDEN_MGMT_PHRASES = (
    "역사적으로", "역사적인", "지난 수십 년", "수십 년간", "오랜 세월",
    "1990년대", "1990 년대", "2000년대 초", "2000년대 중반",
    "창업 이래", "창업자", "경영 철학", "기업 철학", "회사의 DNA",
    "장기적으로", "장기적인 관점에서", "결국", "끝내", "마침내",
    "M&A 역사", "인수합병 역사", "과거 수년간", "지난 10년",
)


def _count_phrase_hits(text: str, phrases: tuple) -> Tuple[int, list]:
    """주어진 phrase tuple 이 text 안에 총 몇 번 등장하는지 + 어떤 phrase 가 매칭되었는지 반환."""
    hits = 0
    matched: list = []
    for p in phrases:
        c = text.count(p)
        if c > 0:
            hits += c
            matched.append(p)
    return hits, matched


def _is_item_output_valid(text: str) -> Tuple[bool, str]:
    """v2.9.3: 10줄 귀납법 포맷 + 금지어 검증.
    검증 기준:
      - 최소 글자수 (MIN_ITEM_CHARS = 450)
      - 10개 이모지 라인(💰 📊 📉 📈 🔍 ⚡ 🏭 📅 🎯 📬) 중 최소 7개 이상 존재
      - '시사점' 키워드 존재
      - '수혜주' 또는 🎯 라인 내용 존재
      - 출처/카테고리 라인 존재
      - 숫자 최소 8개 이상 포함
      - v2.9.3: 회피 표현은 2회까지만 허용 (3회 이상이면 정보부족 카드로 판정 → 드랍)
      - v2.9.3: 경영/역사 금지어는 1회까지 허용 (2회 이상이면 재시도 → 드랍)
    """
    if not text:
        return False, "empty"
    if len(text) < MIN_ITEM_CHARS:
        return False, f"too_short({len(text)}<{MIN_ITEM_CHARS})"

    # 필수 이모지 라인 10종 (최소 7개는 존재해야 함 — 원문 정보 부족 시 일부 누락 허용)
    required_emojis = ["💰", "📊", "📉", "📈", "🔍", "⚡", "🏭", "📅", "🎯", "📬"]
    present = [e for e in required_emojis if e in text]
    if len(present) < 7:
        missing = [e for e in required_emojis if e not in text]
        return False, f"too_few_emoji_lines({len(present)}/10, missing={missing})"

    # 📬 라인에 '시사점' 키워드 존재 확인
    if "시사점" not in text:
        return False, "missing_implication_keyword"

    # 🎯 수혜주 라인 존재 확인 (이모지 또는 '수혜주' 키워드)
    if "🎯" not in text and "수혜주" not in text:
        return False, "missing_beneficiary_line"

    # 출처 / 카테고리 메타 라인 존재
    if "**카테고리**" not in text or "**출처**" not in text:
        return False, "missing_meta_line"

    # 수치 포함도 검증 — 숫자 최소 8개 이상 (v2.9.0: 6→8 강화, 10줄 확장)
    digit_count = sum(1 for c in text if c.isdigit())
    if digit_count < 8:
        return False, f"too_few_numbers({digit_count}<8)"

    # 문장 끊김 휴리스틱
    tail = text.rstrip()
    _sentence_end = ".。!?)」』》\"'”’)]"
    if tail and tail[-1] not in _sentence_end:
        return False, "truncated_mid_sentence"

    # v2.9.3: 회피 표현 빈도 (정보 부족 카드 자동 드랍 트리거)
    avoid_hits, avoid_matched = _count_phrase_hits(text, _AVOIDANCE_PHRASES)
    if avoid_hits >= 3:
        return False, f"too_many_avoidance({avoid_hits}>=3, matched={avoid_matched})"

    # v2.9.3: 경영/역사 금지어 검증 (재시도 트리거)
    fb_hits, fb_matched = _count_phrase_hits(text, _FORBIDDEN_MGMT_PHRASES)
    if fb_hits >= 2:
        return False, f"forbidden_management_phrases({fb_hits}>=2, matched={fb_matched})"

    return True, "ok"


def summarize_one_item(client, item: Dict[str, Any]):
    """
    뉴스 1건을 상세 요약. 품질 미달 시 내부적으로 재시도.

    v2.9.3 변경:
      - 반환값이 str 또는 None.
      - 회피 표현 과다(too_many_avoidance) 또는 금지어 과다(forbidden_management_phrases)
        로 모든 시도가 실패하면 **None 반환** → 호출자가 카드를 드랍.
      - 그 외 일반 실패는 기존처럼 best_text / fallback markdown 반환.
    """
    rank = item["rank"]
    prompt = _build_item_prompt(item)

    # 최대 3개 모델 × 각 2회 재시도 → 6회까지
    models_to_try = ("gemini-2.5-flash",) + GEMINI_FALLBACK_MODELS[:2]
    best_text = ""
    last_drop_reason = ""  # v2.9.3: 드랍 트리거 사유 추적

    for m in models_to_try:
        for attempt in range(2):
            if attempt > 0:
                time.sleep(2)
            try:
                logger.info("Step 2) item %d: model=%s attempt=%d", rank, m, attempt + 1)
                text = _call_gemini_simple(
                    client, m, prompt,
                    max_tokens=ITEM_MAX_OUTPUT_TOKENS, temperature=0.4,
                )
                valid, reason = _is_item_output_valid(text)
                if valid:
                    logger.info("Step 2) item %d OK (모델=%s, %d자)",
                                rank, m, len(text))
                    return text
                logger.warning("Step 2) item %d 품질 미달(%s): %d자",
                               rank, reason, len(text or ""))
                # v2.9.3: 드랍 사유 기록
                if reason.startswith("too_many_avoidance") or reason.startswith("forbidden_management_phrases"):
                    last_drop_reason = reason
                if text and len(text) > len(best_text):
                    best_text = text
            except Exception as exc:  # noqa: BLE001
                logger.warning("Step 2) item %d 호출 실패 (%s): %s", rank, m, exc)
                if not _is_transient_error(exc):
                    break

    # ─────────────────────────────────────────────────────────
    # v2.6.3: Gemini 전부 실패 → OpenAI 호환 API 재시도
    # ─────────────────────────────────────────────────────────
    if _is_openai_available():
        try:
            logger.info("Step 2) item %d → OpenAI fallback 시도", rank)
            text = _call_openai_chat(
                prompt,
                max_tokens=ITEM_MAX_OUTPUT_TOKENS,
                temperature=0.4,
                call_label=f"item-{rank}",
            )
            valid, reason = _is_item_output_valid(text)
            if valid:
                logger.info("Step 2) item %d ✅ OpenAI 성공 (%d자)", rank, len(text))
                return text
            logger.warning("Step 2) item %d OpenAI 품질 미달(%s): %d자",
                           rank, reason, len(text or ""))
            if reason.startswith("too_many_avoidance") or reason.startswith("forbidden_management_phrases"):
                last_drop_reason = reason
            if text and len(text) > len(best_text):
                best_text = text
        except Exception as exc:  # noqa: BLE001
            logger.warning("Step 2) item %d OpenAI 호출 실패: %s", rank, exc)

    # v2.9.3: 모든 시도가 회피/금지어로 실패 → 카드 드랍
    if last_drop_reason:
        logger.warning("Step 2) item %d 🚮 카드 드랍 (사유=%s)", rank, last_drop_reason)
        return None

    # 모든 시도 실패 — 원본 정보로 폴백 마크다운 생성
    logger.warning("Step 2) item %d 전체 실패 → 원본 폴백", rank)
    if best_text:
        return best_text  # 품질 미달이어도 응답이 있으면 사용
    return _fallback_item_markdown(item)


def _fallback_item_markdown(item: Dict[str, Any]) -> str:
    """v2.9.0: AI 전면 실패 시 원본 데이터로 10줄 귀납법 포맷 생성.
    AI 수치 분석이 없으므로 각 라인에 장애 안내 또는 원본 발췌를 넣음.
    숫자 8개 이상 확보를 위해 현재 날짜/랭크/시간 정보를 포함.
    """
    orig = item["original"]
    rank = item["rank"]
    category = item.get("category", "기타")
    title = orig.get("title", "(제목 없음)")[:120]
    summary_raw = (orig.get("summary") or "(본문 없음)").replace("\n", " ").strip()
    summary_short = summary_raw[:180]
    summary_mid = summary_raw[180:360] if len(summary_raw) > 180 else "(추가 본문 없음)"
    source = orig.get("source", "")
    link = orig.get("link", "")
    today = _today_kr_str()

    return f"""### {rank}. {title}

- **카테고리**: {category} · **출처**: [{source}]({link})

💰 원문 발췌 1: {summary_short}
📊 원문 발췌 2: {summary_mid}
📉 원인 분석 불가 — AI 요약 엔진({today}) 일시 장애로 구조 분석 생성 실패 (랭크 {rank}/15).
📈 배경 분석 불가 — 원문 기사({source}) 전문을 직접 확인하시기 바랍니다.
🔍 시장 구조 — 자동 분석 엔진 2단계(Gemini→OpenAI) 모두 실패, 원문 링크 참조 필요 (v2.9.0).
⚡ 검색어 매칭 — 카테고리 '{category}' 기반 수집, AI 분석 실패로 수동 확인 권장.
🏭 파급 효과 — AI 분석 실패, 원문 본문 확인 후 밸류체인 영향 직접 평가 필요 (랭크 {rank}위).
📅 일정·타임라인 — 분석 불가 ({today} 기준), 원문 기사의 날짜·일정 확인 필요.
🎯 **수혜주**: 정보 부족 — 원문에서 직접 종목 정보 확인 필요 (AI 분석 100% 실패).
📬 **시사점**: 자동 분석 실패, 원문 기사 전문 확인 후 투자 판단. 랭크 {rank}위 뉴스 (총 15건 중).
"""


def summarize_all_items_parallel(
    client,
    ranked_items: List[Dict[str, Any]],
    max_workers: int = 4,
) -> List[str]:
    """
    v2.6.0: 환경 변수 SUMMARY_MODE 에 따라 순차/병렬 분기.

    - sequential (기본): 각 호출 사이 SUMMARY_CALL_DELAY_SEC 초 대기.
      Gemini 무료 티어 RPM(분당 10회) 제한을 안전하게 통과.
    - parallel: 기존 ThreadPoolExecutor 기반 병렬 실행.

    환경 변수
    ----------
    SUMMARY_MODE : "sequential" | "parallel"
    SUMMARY_CALL_DELAY_SEC : float (순차 호출 간 대기)
    SUMMARY_MAX_WORKERS : int (parallel 일 때만 사용)

    *함수명은 하위 호환을 위해 유지* (내부적으로 모드 분기).
    """
    mode = SUMMARY_MODE
    results: Dict[int, str] = {}

    if mode == "sequential":
        logger.info(
            "Step 2) 순차 모드 — %d건, 호출 간격 %.1f초",
            len(ranked_items), SUMMARY_CALL_DELAY_SEC,
        )
        for idx, item in enumerate(ranked_items):
            rank = item["rank"]
            if idx > 0 and SUMMARY_CALL_DELAY_SEC > 0:
                time.sleep(SUMMARY_CALL_DELAY_SEC)
            try:
                results[rank] = summarize_one_item(client, item)
            except Exception as exc:  # noqa: BLE001
                logger.error("Step 2) item %d 예외(순차): %s", rank, exc)
                results[rank] = _fallback_item_markdown(item)
        return [results[r] for r in sorted(results.keys())]

    # parallel 모드 (하위 호환)
    effective_workers = max(1, min(max_workers, SUMMARY_MAX_WORKERS))
    logger.info(
        "Step 2) 병렬 모드 — %d건, max_workers=%d",
        len(ranked_items), effective_workers,
    )
    with ThreadPoolExecutor(max_workers=effective_workers) as pool:
        future_to_rank = {
            pool.submit(summarize_one_item, client, item): item["rank"]
            for item in ranked_items
        }
        for fut in as_completed(future_to_rank):
            rank = future_to_rank[fut]
            try:
                results[rank] = fut.result()
            except Exception as exc:  # noqa: BLE001
                logger.error("Step 2) item %d 예외(병렬): %s", rank, exc)
                item = next((x for x in ranked_items if x["rank"] == rank), None)
                if item:
                    results[rank] = _fallback_item_markdown(item)

    return [results[r] for r in sorted(results.keys())]


# ════════════════════════════════════════════════════════════
# 단계 3) 최종 조립 + 총평 생성
# ════════════════════════════════════════════════════════════
def _build_overview_prompt(item_markdowns: List[str]) -> str:
    """10개 요약을 바탕으로 '오늘의 한 줄 총평' 생성."""
    today = _today_kr_str()
    # 각 항목의 제목만 추출해 전달 (토큰 절약)
    titles = []
    for md in item_markdowns:
        m = re.search(r"^###\s*\d+\.\s*(.+)$", md, re.MULTILINE)
        if m:
            titles.append(f"- {m.group(1).strip()}")
    title_block = "\n".join(titles)

    return f"""당신은 시니어 애널리스트입니다. 오늘은 **{today}** (KST) 입니다.

아래 오늘의 핵심 뉴스 10개 제목을 보고, 시장 전체 흐름을 **2~3 문장의 총평**으로
작성하세요. 반도체/AI 흐름, 원·달러 환율, 미국 지수 움직임 등 핵심 체크포인트를 포함.

## 오늘의 핵심 뉴스 10건
{title_block}

## 출력 형식 (이대로)
시장 전체 흐름을 2~3 문장으로 설명. 구체적인 섹터·종목·지수 언급 포함.
최소 150자 이상. 다른 설명이나 마크다운 헤딩 추가 금지. 본문 텍스트만.
"""


def generate_overview(client, item_markdowns: List[str]) -> str:
    """오늘의 총평 생성 (짧은 호출). v2.6.3: Gemini 실패 시 OpenAI 폴백."""
    prompt = _build_overview_prompt(item_markdowns)

    # Gemini 먼저 시도
    try:
        text, used = _call_with_retry(
            client, prompt, max_tokens=512, temperature=0.5, call_label="overview",
        )
        logger.info("Step 3) 총평 생성 (모델=%s, %d자)", used, len(text))
        return text.strip()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Step 3) Gemini 총평 실패: %s", exc)

    # v2.6.3: OpenAI 호환 폴백
    if _is_openai_available():
        try:
            logger.info("Step 3) → OpenAI fallback 총평 시도")
            text = _call_openai_chat(
                prompt, max_tokens=512, temperature=0.5, call_label="overview",
            )
            logger.info("Step 3) ✅ OpenAI 총평 성공 (%d자)", len(text))
            return text.strip()
        except Exception as exc2:  # noqa: BLE001
            logger.warning("Step 3) OpenAI 총평도 실패: %s", exc2)

    # 최종 기본 문장
    logger.warning("총평 생성 전면 실패 — 기본 문장 사용")
    return (
        f"{_today_kr_str()} 시장은 반도체·AI 섹터의 모멘텀과 미국 거시 지표의 "
        "영향을 동시에 받고 있습니다. 위 핵심 뉴스들을 참고해 포트폴리오 점검을 권합니다."
    )


def assemble_final_briefing(
    ranked_items: List[Dict[str, Any]],
    item_markdowns: List[str],
    overview: str,
) -> str:
    """
    v2.6.2: 미국/한국 섹션 분리 레이아웃으로 최종 마크다운 작성.

    구조:
      1. 헤더 (제목 + 카테고리 구성)
      2. 오늘의 한 줄 총평
      3. 🇺🇸 미국 시장 섹션 (rank 1~4)
      4. 🇰🇷 한국 시장 섹션 (rank 5~10)
    """
    today = _today_kr_str()

    # 카테고리별 집계 (헤더에 표시)
    from collections import Counter
    cat_counts = Counter(item["category"] for item in ranked_items)
    cat_summary = " · ".join(f"{c} {n}" for c, n in cat_counts.most_common())

    # v2.6.2: 미국/한국 뉴스 분류
    us_indices: List[int] = []
    kr_indices: List[int] = []
    for i, item in enumerate(ranked_items):
        src = item["original"].get("source", "")
        if _is_us_source(src):
            us_indices.append(i)
        else:
            kr_indices.append(i)

    us_count = len(us_indices)
    kr_count = len(kr_indices)

    # ──────────────────────────────────────────────────────────
    # 헤더
    # ──────────────────────────────────────────────────────────
    header = f"""## 📈 {today} 주식·반도체 일일 브리핑

안녕하세요, 한국 개인투자자 여러분. 오늘 시장에 가장 큰 영향을 미칠 **핵심 뉴스 {len(item_markdowns)}건**을
🇺🇸 미국 시장 · 🇰🇷 한국 시장 순으로 분석해 드립니다.

**오늘의 구성**: 🇺🇸 미국 {us_count}건 · 🇰🇷 한국 {kr_count}건 (카테고리: {cat_summary})

"""

    # ──────────────────────────────────────────────────────────
    # 오늘의 한 줄 총평
    # ──────────────────────────────────────────────────────────
    overview_section = f"""## 🔎 오늘의 한 줄 총평

{overview}

---

"""

    # ──────────────────────────────────────────────────────────
    # 🇺🇸 미국 시장 섹션 (v2.6.2 / v2.9.1 진단 강화)
    # ──────────────────────────────────────────────────────────
    us_section = ""
    if us_indices:
        us_header = f"""## 🇺🇸 미국 시장 ({us_count}건)

> 간밤 마감한 미국 시장 핵심 뉴스입니다. 반도체·AI·ETF·거시 지표를 중심으로 정리했습니다.

"""
        us_body = "\n\n".join(item_markdowns[i] for i in us_indices)
        us_section = us_header + us_body + "\n\n---\n\n"
        logger.info("✅ 미국 시장 섹션 생성: %d건", us_count)
    else:
        # v2.9.1: 미국 뉴스가 0건이면 사용자에게 명시적으로 알려준다.
        logger.error(
            "⚠️ 미국 시장 섹션 비어있음! ranked_items=%d, 모든 출처=%s",
            len(ranked_items),
            [it["original"].get("source", "") for it in ranked_items],
        )
        us_section = (
            "## 🇺🇸 미국 시장 (0건)\n\n"
            "> ⚠️ 오늘은 미국 뉴스 수집/랭킹에 문제가 발생해 이 섹션이 비어 있습니다.\n"
            "> 관리자에게 GitHub Actions 로그 공유를 부탁드립니다.\n\n---\n\n"
        )

    # ──────────────────────────────────────────────────────────
    # 🇰🇷 한국 시장 섹션 (v2.6.2 신규)
    # ──────────────────────────────────────────────────────────
    kr_section = ""
    if kr_indices:
        kr_header = f"""## 🇰🇷 한국 시장 ({kr_count}건)

> 오늘 한국 시장 개장에 영향을 줄 핵심 뉴스입니다. 반도체·코스피 주도주·정부 정책을 다룹니다.

"""
        kr_body = "\n\n".join(item_markdowns[i] for i in kr_indices)
        kr_section = kr_header + kr_body

    # v2.6.2: header → overview → 🇺🇸 미국 → 🇰🇷 한국 순서
    return header + overview_section + us_section + kr_section


# ════════════════════════════════════════════════════════════
# v2.9.3 Phase E — 결과보고서 자가 평가 (자가/전문가 점수)
# ════════════════════════════════════════════════════════════
SCORE_LOW_THRESHOLD = 70  # 70점 미만이면 본문 상단에 ⚠ 표시 (사용자 설정)


def _build_evaluation_prompt(briefing_md: str, item_count: int) -> str:
    """v2.9.3 Phase E — B안: 자가/전문가 이중 점수 평가 프롬프트."""
    today = _today_kr_str()
    # 토큰 절약: 본문이 너무 길면 앞 6000자만 전달 (헤더+개요+초기 카드들)
    body_for_eval = briefing_md[:6000]
    return f"""당신은 30년 경력의 한국·미국 금융시장 애널리스트 겸 데일리 브리핑 편집장입니다.

아래는 {today} 발송 예정인 "Morning Stock AI" 일일 브리핑입니다 (총 {item_count}개 카드).
이 보고서를 두 시각으로 평가해 0~100점 점수를 매겨 주세요.

## 평가 기준 (5축 가중)
1. 정확성(25%) — 사실 관계, 숫자, 출처 인용의 정확도
2. 시의성(25%) — 현 시점(±3일) 사건 집중도, 옛 자료/경영 일반론 회피
3. 깊이(20%) — 원인-결과-파급 효과 분석의 논리 일관성
4. 명료성(15%) — 한국 개인투자자 가독성, 문장 길이/구성
5. 실행 가능성(15%) — 수혜주·매수/관망/매도 가이드의 구체성

## 두 시각
- **자가 점수(self)**: AI 본인의 자기 평가 (보통 약간 후함)
- **전문가 점수(expert)**: 한국경제TV 수석 애널리스트의 엄격한 시각 (보통 5~10점 더 박함)

## 출력 형식 (반드시 순수 JSON만)
{{"self": 87, "expert": 82, "weakest_axis": "시의성", "comment": "한 줄 총평(40자 이내)"}}

## 평가 대상 (앞 6000자 발췌)
{body_for_eval}

## 출력 (JSON만)"""


def _parse_evaluation_json(text: str) -> Tuple[int, int, dict]:
    """평가 응답 파싱 — 실패 시 (0, 0, {}) 반환."""
    if not text:
        return 0, 0, {}
    cleaned = text.strip()
    # 코드펜스 제거
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```\s*$", "", cleaned)
    # JSON 블록 추출
    m = re.search(r"\{[\s\S]*\}", cleaned)
    if not m:
        return 0, 0, {}
    try:
        data = json.loads(m.group(0))
        s = int(data.get("self", 0))
        e = int(data.get("expert", 0))
        # 0~100 범위 클램프
        s = max(0, min(100, s))
        e = max(0, min(100, e))
        meta = {
            "weakest_axis": str(data.get("weakest_axis", ""))[:20],
            "comment": str(data.get("comment", ""))[:80],
        }
        return s, e, meta
    except (ValueError, json.JSONDecodeError) as exc:
        logger.warning("v2.9.3 평가 JSON 파싱 실패: %s", exc)
        return 0, 0, {}


def evaluate_briefing(
    client,
    briefing_md: str,
    item_count: int,
) -> Tuple[int, int, dict]:
    """
    v2.9.3 Phase E — 결과보고서를 평가해 (자가, 전문가, 메타) 반환.

    - 1차: Gemini 2.5 flash
    - 2차 (Gemini 실패 시): OpenAI 호환 fallback
    - 모두 실패: (0, 0, {}) 반환 → 호출자가 점수 표시 생략
    """
    prompt = _build_evaluation_prompt(briefing_md, item_count)

    # Gemini 시도 (1회만 — 평가는 critical path 가 아님)
    try:
        text = _call_gemini_simple(
            client, "gemini-2.5-flash", prompt,
            max_tokens=512, temperature=0.3,
        )
        s, e, meta = _parse_evaluation_json(text)
        if s > 0 and e > 0:
            logger.info(
                "v2.9.3 자가 평가 ✅ self=%d expert=%d weakest=%s",
                s, e, meta.get("weakest_axis", "-"),
            )
            return s, e, meta
        logger.warning("v2.9.3 Gemini 평가 결과 비정상 — OpenAI 폴백 시도")
    except Exception as exc:  # noqa: BLE001
        logger.warning("v2.9.3 Gemini 평가 호출 실패: %s — OpenAI 폴백 시도", exc)

    # OpenAI 폴백
    if _is_openai_available():
        try:
            text = _call_openai_chat(
                prompt, max_tokens=512, temperature=0.3,
                call_label="evaluate-briefing",
            )
            s, e, meta = _parse_evaluation_json(text)
            if s > 0 and e > 0:
                logger.info(
                    "v2.9.3 자가 평가 ✅ (OpenAI) self=%d expert=%d", s, e,
                )
                return s, e, meta
        except Exception as exc:  # noqa: BLE001
            logger.warning("v2.9.3 OpenAI 평가 호출 실패: %s", exc)

    logger.warning("v2.9.3 자가 평가 전체 실패 — 점수 표시 생략")
    return 0, 0, {}


def _apply_score_to_briefing(
    briefing_md: str,
    score_self: int,
    score_expert: int,
    score_meta: dict,
) -> str:
    """
    v2.9.3 Phase E — 브리핑 본문에 점수 삽입.

    - 점수가 0/0 이면 원본 그대로 반환 (평가 실패).
    - 첫 H2 헤더 (## 📈 ... 일일 브리핑) 끝에 (자가XX/전문가XX) 추가.
    - 70점 미만이면 헤더 바로 아래에 ⚠ 경고 박스 추가 (본문은 그대로 발송).
    - 본문 최상단에 HTML 주석 메타 마커 삽입 (이메일 발송기에서 활용 가능).
    """
    if score_self <= 0 or score_expert <= 0:
        return briefing_md

    # 점수 라벨
    label = f"({score_self}/{score_expert})"
    low_score = min(score_self, score_expert) < SCORE_LOW_THRESHOLD

    # HTML 주석 메타 (이메일 변환기에서 제거됨)
    weakest = score_meta.get("weakest_axis", "")
    comment = score_meta.get("comment", "")
    meta_marker = (
        f"<!-- BRIEFING_SCORE: self={score_self} expert={score_expert} "
        f"weakest={weakest} comment={comment} low={low_score} -->\n"
    )

    # 첫 H2 헤더에 점수 라벨 부착 (## 📈 ... 일일 브리핑 → ## 📈 ... 일일 브리핑 (87/82))
    def _attach_label(match: re.Match) -> str:
        line = match.group(0).rstrip()
        return f"{line} {label}"

    out = re.sub(
        r"^## 📈 .*?일일 브리핑.*$",
        _attach_label,
        briefing_md,
        count=1,
        flags=re.MULTILINE,
    )

    # 70점 미만이면 경고 박스 삽입 (헤더 직후, '안녕하세요' 앞)
    if low_score:
        warn_box = (
            f"\n> ⚠ **품질 자가검토 경고** — 자가 {score_self}점 / 전문가 {score_expert}점 "
            f"(기준 {SCORE_LOW_THRESHOLD}점). 약점 축: {weakest or '미상'}. "
            f"평소보다 신중히 검토하세요.\n\n"
        )
        # '안녕하세요,' 라인 앞에 삽입
        out = re.sub(
            r"(^안녕하세요)",
            warn_box + r"\1",
            out,
            count=1,
            flags=re.MULTILINE,
        )

    return meta_marker + out


# ════════════════════════════════════════════════════════════
# 메인 진입점 — 2단계 파이프라인 (v2.5.0)
# ════════════════════════════════════════════════════════════
def summarize_with_gemini(
    briefing_input_text: str = "",  # 하위 호환 (미사용, news_list 우선)
    model_name: str = "gemini-2.5-flash",
    api_key: Optional[str] = None,
    news_list: Optional[List[Dict[str, str]]] = None,
) -> str:
    """
    v2.5.0: 2단계 요약 파이프라인.

    Parameters
    ----------
    briefing_input_text : str
        하위 호환용 (v2.4.x 에선 포맷된 텍스트를 받았음). v2.5.0은 사용하지 않고
        `news_list` 를 우선 사용합니다.
    news_list : List[Dict]
        표준 양식 [{source, title, link, summary}, ...]. 이 파라미터가 있으면
        2단계 파이프라인으로 처리합니다. 없으면 OpenAI 호환 폴백만 시도합니다.

    Returns
    -------
    str : 마크다운 브리핑
    """
    key = api_key or os.getenv("GEMINI_API_KEY")

    # ===== Gemini 경로 (news_list 필수) =====
    if key and news_list:
        try:
            from google import genai
            client = genai.Client(api_key=key)

            logger.info("═════ v2.5.0 2단계 파이프라인 시작 ═════")
            logger.info("수집 뉴스 %d건 → 랭킹 → 병렬 요약 → 조립",
                        len(news_list))

            # Step 1) 랭킹
            ranked = rank_top_news(news_list, client)
            if not ranked:
                raise RuntimeError("랭킹 결과가 비어있음")

            # Step 2) 병렬 개별 요약
            item_markdowns = summarize_all_items_parallel(
                client, ranked, max_workers=4,
            )

            # v2.9.3: 정보부족·금지어로 드랍된 카드(None) 필터링 + 동기화
            paired = [
                (it, md) for it, md in zip(ranked, item_markdowns)
                if md is not None
            ]
            dropped = len(ranked) - len(paired)
            if dropped:
                logger.warning(
                    "v2.9.3 🚮 정보부족/금지어로 %d건 드랍 → 잔존 %d건",
                    dropped, len(paired),
                )
            ranked = [p[0] for p in paired]
            item_markdowns = [p[1] for p in paired]

            # Step 3) 총평 + 조립
            overview = generate_overview(client, item_markdowns)
            final = assemble_final_briefing(ranked, item_markdowns, overview)

            # v2.9.3 Phase E: 결과보고서 자가 평가 점수 (자가/전문가)
            try:
                score_self, score_expert, score_meta = evaluate_briefing(
                    client, final, len(ranked),
                )
                final = _apply_score_to_briefing(
                    final, score_self, score_expert, score_meta,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("v2.9.3 자가 평가 실패(무시): %s", exc)

            # 최종 품질 검증
            logger.info(
                "v2.5.0 완료: 총 %d자, %d개 항목, 총평 %d자",
                len(final), len(item_markdowns), len(overview),
            )

            if len(final) < MIN_OUTPUT_CHARS:
                logger.warning(
                    "최종 분량 미달(%d < %d) — 반환은 하되 경고",
                    len(final), MIN_OUTPUT_CHARS,
                )
            return final

        except Exception as exc:  # noqa: BLE001
            logger.error("v2.5.0 2단계 파이프라인 실패: %s", exc, exc_info=True)
            logger.warning("→ OpenAI 호환 폴백 시도")

    # ===== OpenAI 호환 폴백 (v2.4.x 레거시 경로) =====
    if os.getenv("OPENAI_API_KEY"):
        try:
            openai_model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
            input_text = briefing_input_text
            if not input_text and news_list:
                from briefing.modules.formatter import format_data_for_ai
                input_text = format_data_for_ai(news_list)
            return _summarize_with_openai_compat(input_text, model_name=openai_model)
        except Exception as exc:  # noqa: BLE001
            logger.warning("OpenAI 호환도 실패: %s", exc)

    # ===== 최종 비상 — news_list 만으로 규칙 기반 마크다운 =====
    if news_list:
        logger.warning("모든 AI 엔진 실패 — 원본 뉴스 규칙 기반 요약 생성")
        return _fallback_rule_based_briefing(news_list)

    raise RuntimeError(
        "AI 요약 엔진 설정이 없습니다. "
        "GEMINI_API_KEY 또는 (OPENAI_API_KEY + OPENAI_BASE_URL) 중 하나가 필요합니다."
    )


def _fallback_rule_based_briefing(news_list: List[Dict[str, str]]) -> str:
    """최후의 폴백 — AI 없이 원본 RSS 데이터만으로 마크다운 작성."""
    today = _today_kr_str()
    top = news_list[:TARGET_NEWS_COUNT]

    warning = (
        "> ⚠️ **AI 요약 엔진 장애**: 오늘은 AI 모델이 모두 실패하여 "
        "원본 뉴스를 자동 분석 없이 그대로 제공합니다. 각 원문 링크를 확인해 주세요.\n\n"
    )

    # v2.5.3: 총평을 리포트 맨 위로 이동 (폴백 경로도 동일 구조)
    parts = [
        warning,
        f"## 📰 {today} 주식·반도체 주요 뉴스\n\n",
        "## 🔎 오늘의 한 줄 총평\n\n",
        "AI 분석 엔진 장애로 자동 총평을 생성하지 못했습니다. "
        "아래 원본 뉴스들을 직접 확인해 주세요.\n\n",
        "---\n\n",
    ]
    for i, n in enumerate(top, start=1):
        title = (n.get("title") or "(제목 없음)")[:120]
        summary = (n.get("summary") or "")[:300]
        source = n.get("source", "")
        link = n.get("link", "")
        parts.append(f"### {i}. {title}\n")
        parts.append(f"- **출처**: {source}\n")
        if summary:
            parts.append(f"- **요약**: {summary}\n")
        parts.append(f"- **원문 링크**: [{source}]({link})\n\n")

    return "".join(parts)


# ─── OpenAI 호환 폴백 (v2.4.x 호환 유지) ───────────────────
def _summarize_with_openai_compat(
    briefing_input_text: str,
    model_name: str = "gpt-4o-mini",
) -> str:
    from openai import OpenAI

    api_key = os.getenv("OPENAI_API_KEY")
    base_url = os.getenv("OPENAI_BASE_URL")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY 환경변수가 필요합니다.")

    client = OpenAI(api_key=api_key, base_url=base_url) if base_url else OpenAI(api_key=api_key)
    logger.info("OpenAI 호환 호출: model=%s", model_name)

    today = _today_kr_str()
    system_prompt = f"""당신은 한국 개인투자자를 위한 '주식·반도체 일일 브리핑' 시니어 애널리스트입니다.
오늘은 **{today}** (KST) 입니다. 과거 날짜를 쓰지 마세요.

아래 수집 뉴스를 바탕으로 핵심 뉴스 정확히 10개를 순위 매겨 마크다운으로 출력하세요.
각 뉴스는 ### 제목, 출처, 요약(3~4문장), 투자 시사점, 원문 링크 구조로 작성하세요.
전체 분량 최소 5000자 이상, 모든 문장은 완결하세요.
"""

    resp = client.chat.completions.create(
        model=model_name,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": briefing_input_text},
        ],
        max_tokens=MAX_OUTPUT_TOKENS,
    )
    text = (resp.choices[0].message.content or "").strip()
    if not text:
        raise RuntimeError("OpenAI 호환 응답이 비어 있습니다.")
    return text


# 하위 호환용 상수
SYSTEM_PROMPT = f"""[v2.5.0 2단계 파이프라인 전환 — 이 상수는 더 이상 사용되지 않습니다.
각 단계별 프롬프트는 _build_ranking_prompt / _build_item_prompt / _build_overview_prompt 참조.]
"""


# ────────────────────────────────────────────────────
# 단독 실행 테스트
# ────────────────────────────────────────────────────
if __name__ == "__main__":
    import sys

    from briefing.collectors.aggregator import collect_all_data

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    print("=" * 60)
    print("[v2.5.0 테스트] 수집 → 랭킹 → 병렬 상세요약 → 조립")
    print("=" * 60)

    if not os.getenv("GEMINI_API_KEY"):
        print("GEMINI_API_KEY 미설정 — 프롬프트만 미리보기")
        data = collect_all_data(korean_limit=2, us_limit=1)
        print(f"수집 샘플: {len(data)}건")
        if data:
            p = _build_ranking_prompt(data[:5])
            print(p[:800])
        sys.exit(0)

    data = collect_all_data()
    result = summarize_with_gemini(news_list=data)
    print(result)
    print(f"\n총 {len(result)}자")
