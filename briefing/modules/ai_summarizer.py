"""
[v2.6.3] Gemini/OpenAI 호환 API 기반 2단계 요약 엔진 (OpenAI fallback 강화).

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

# ─── 품질 기준 (v2.5.0 — 강화) ─────────────────────────────
MIN_OUTPUT_CHARS = 3500         # v2.4.1: 1800 → v2.5.0: 3500 (축약 방지)
MIN_NEWS_ITEMS = 10             # v2.4.1: 7 → v2.5.0: 10 (목표 정확히 10개)
MAX_OUTPUT_TOKENS = 8192        # Gemini 2.5 Flash의 max
TARGET_NEWS_COUNT = 10          # 최종 출력 뉴스 개수

# 개별 뉴스 요약 기준
MIN_ITEM_CHARS = 250            # 뉴스 1건의 최소 글자수
ITEM_MAX_OUTPUT_TOKENS = 1024   # 1건 요약에 충분 (한국어 약 500~700자)

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

    return f"""당신은 한국 개인투자자를 위한 '주식·반도체 일일 브리핑'의 편집장입니다.
오늘은 **{today}** (KST) 입니다.

아래 후보 뉴스 {len(news_list)}건 중, 오늘 투자자에게 가장 중요한 **핵심 뉴스 정확히 {TARGET_NEWS_COUNT}개**를
순위를 매겨 선정해 주세요.

## 🚨 필수 카테고리 정확한 비율 (v2.6.2 - 반드시 준수)
반드시 아래 카테고리별 **정확한 수량**을 지켜 선정하세요.
국내 편향을 방지하고 글로벌 시황을 균형 있게 전달하기 위함입니다.
독자는 매일 동일한 구성의 브리핑을 기대하므로 이 비율은 **고정**입니다.

| 카테고리 | 필수 건수 | 설명 |
|---------|----------|------|
| 🇺🇸 **미국 매체 뉴스** | **정확히 4건** | Seeking Alpha, Reuters, Bloomberg, ETF.com, Morningstar (영문 출처) |
| 🇰🇷 **한국 매체 뉴스** | **정확히 6건** | 한국경제, 매일경제, 머니투데이, 조선비즈 등 한글 출처 |

**합계: 미국 4건 + 한국 6건 = 총 10건 (엄격히 준수)**

## 선정 우선순위 (각 그룹 내에서 적용)
### 🇺🇸 미국 매체 4건 선정 기준
1. 반도체·AI (엔비디아, AMD, 인텔, 마이크론, TSMC, HBM)
2. 미국 증시 · ETF · 거시 (나스닥, S&P, 환율, 금리, 연준)
3. 빅테크 (애플, 마이크로소프트, 아마존, 메타, 구글)
4. 기타 시장 영향도 큰 미국 기업/산업 뉴스

### 🇰🇷 한국 매체 6건 선정 기준
1. 반도체 (삼성전자, SK하이닉스, HBM, 파운드리, 메모리)
2. 한국 증시 주요 이슈 (코스피/코스닥 주도주, 정부 정책)
3. AI 관련 한국 기업·산업 뉴스
4. 환율·금리 등 한국 투자자에게 직접 영향이 큰 거시 뉴스

## 제외 기준 (양쪽 공통)
- 광고성·이벤트·당첨 공지
- 동일 사건 중복 기사 (→ 가장 정보가 풍부한 1건만 선택)
- 시장 영향이 없는 단순 인사·사회 뉴스

## 💡 출처 식별 가이드
후보 뉴스의 `(출처)` 부분으로 판단하세요:
- **🇺🇸 미국 매체**: Seeking Alpha, Seeking Alpha (ETF), Reuters, Bloomberg, ETF.com, Morningstar
- **🇰🇷 한국 매체**: 한국경제(증권), 한국경제(IT), 매일경제(증권), 매일경제(IT), 머니투데이(증권), 머니투데이(IT), 조선비즈 등

미국 매체 뉴스는 **제목이 영어**이더라도 한국 투자자에게 중요하므로
반드시 **정확히 4건**을 선정해야 합니다.

## 출력 형식 (반드시 순수 JSON 배열만, 설명 문장 없이)
```json
[
  {{"idx": 후보번호, "rank": 1, "category": "반도체", "region": "US", "reason": "선정 이유 한 줄"}},
  ...(총 {TARGET_NEWS_COUNT}개)
]
```

- `idx`: 위 후보 목록의 [번호]
- `rank`: 1~{TARGET_NEWS_COUNT} (중복 불가, 미국 4건 먼저[1~4], 한국 6건 이후[5~10])
- `category`: "반도체" | "AI" | "미국증시" | "한국증시" | "거시경제" | "빅테크" | "기타"
- `region`: **"US"** (미국 매체) 또는 **"KR"** (한국 매체) — 반드시 명시
- `reason`: 왜 오늘 중요한지 한 줄 (20자 내외)

{news_block}

위 {len(news_list)}건 중 정확히 {TARGET_NEWS_COUNT}개를 선정하되,
🇺🇸 미국 매체(Seeking Alpha/Reuters/Bloomberg/ETF.com/Morningstar) 뉴스 **정확히 4건** +
🇰🇷 한국 매체 뉴스 **정확히 6건**을 포함해야 합니다.
**rank 1~4는 미국, rank 5~10은 한국으로 순서를 맞춰주세요.**
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
            logger.warning("Step 1) 랭킹 API 전면 실패 → 상위 %d건으로 폴백",
                           TARGET_NEWS_COUNT)
            return [
                {
                    "idx": i, "rank": i + 1, "category": "기타",
                    "reason": "API 실패 자동 포함", "original": news_list[i],
                }
                for i in range(min(TARGET_NEWS_COUNT, len(news_list)))
            ]

    parsed = _parse_ranking_json(text)
    if not parsed:
        logger.warning("랭킹 JSON 파싱 실패 → 상위 10건으로 폴백")
        return [
            {
                "idx": i, "rank": i + 1, "category": "기타",
                "reason": "자동 포함", "original": news_list[i],
            }
            for i in range(min(TARGET_NEWS_COUNT, len(news_list)))
        ]

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
    # v2.6.2: 🇺🇸 미국 4건 + 🇰🇷 한국 6건 엄격 쿼터 + 순서 재배치
    # ─────────────────────────────────────────────────────────────
    # 독자는 매일 동일 구성의 브리핑을 기대하므로 수량을 고정한다.
    # 또한 "미국 섹션 먼저 → 한국 섹션 나중" 구조이므로
    # 미국 4건이 rank 1~4 로 오도록 재정렬한다.
    result = _enforce_region_quota(result, news_list, seen_idx,
                                    target_us=US_QUOTA, target_kr=KR_QUOTA)

    logger.info("Step 1) 최종 선정: %d건 (미국 %d + 한국 %d)", len(result),
                sum(1 for r in result if _is_us_source(r["original"].get("source", ""))),
                sum(1 for r in result if not _is_us_source(r["original"].get("source", ""))))
    return result


# ═══════════════════════════════════════════════════════════════
# v2.6.2: 미국/한국 매체 식별 + 엄격 쿼터(미국 4 + 한국 6) 강제 로직
# ═══════════════════════════════════════════════════════════════
US_SOURCE_KEYWORDS = (
    "Seeking Alpha", "Reuters", "Bloomberg",
    "ETF.com", "Morningstar",
)
US_QUOTA = 4  # 🇺🇸 미국 매체 Top 10 중 정확한 건수 (v2.6.2 고정)
KR_QUOTA = 6  # 🇰🇷 한국 매체 Top 10 중 정확한 건수 (v2.6.2 고정)


def _is_us_source(source: str) -> bool:
    """출처명이 미국 매체인지 확인. 대소문자 무시, 부분 일치."""
    if not source:
        return False
    s = source.strip()
    for kw in US_SOURCE_KEYWORDS:
        if kw.lower() in s.lower():
            return True
    return False


def _enforce_region_quota(
    ranked: List[Dict[str, Any]],
    all_news: List[Dict[str, str]],
    seen_idx: set,
    target_us: int = US_QUOTA,
    target_kr: int = KR_QUOTA,
) -> List[Dict[str, Any]]:
    """
    v2.6.2: 엄격한 미국/한국 매체 쿼터 강제 + 순서 재배치.

    최종 목표 구성:
      - rank 1~target_us (4): 🇺🇸 미국 매체 뉴스
      - rank target_us+1 ~ target_us+target_kr (5~10): 🇰🇷 한국 매체 뉴스

    동작:
      1. AI 선정 결과를 미국/한국 두 버킷으로 분리.
      2. 각 버킷이 목표치에 못 미치면 원본 후보에서 보충.
      3. 각 버킷이 목표치를 초과하면 낮은 순위부터 제거.
      4. 미국 먼저(rank 1~4), 한국 나중(rank 5~10) 으로 재정렬.

    이 함수 완료 후 정확히 ``target_us + target_kr`` (=10) 건이 반환된다.
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
        "✅ v2.6.2 쿼터 강제 적용 완료: 🇺🇸 %d건 (rank 1~%d) + 🇰🇷 %d건 (rank %d~%d) = 총 %d건",
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

    # v2.6.0: 원문 본문을 최대 1500자까지 확장 (기존 500자 → 1500자)
    # 이유: 원문 스크래핑(trafilatura)으로 얻은 풍부한 본문을 AI에게 충분히 전달해
    #       "제목만 바꿔 쓴 요약"이 아닌 "본문을 근거로 한 서술형 3문장+" 생성 유도.
    body_chars = ITEM_PROMPT_BODY_CHARS
    return f"""당신은 한국 개인투자자를 위한 시니어 애널리스트입니다.
오늘은 **{today}** (KST) 입니다.

아래 뉴스 1건을 **투자자 관점에서 깊이 있게 분석**하여 마크다운으로 작성하세요.

## 절대 준수 사항
1. **분량**: 전체 응답은 **최소 {MIN_ITEM_CHARS}자 이상** (요약 본문 **반드시 최소 3문장, 권장 4~5문장**의 서술형).
2. **서술형**: 요약 섹션은 "● ●" 같은 불릿이나 단편적 구절 나열이 아닌, **완결된 문장 3문장 이상**으로 작성.
   (예: "삼성전자가 ~를 발표했다. 이는 ~ 때문이며, 업계에서는 ~로 평가한다. 특히 ~가 주목된다.")
3. **원문 활용**: 아래 '원본 뉴스 정보'의 **요약 본문을 근거로** 배경·규모·당사자·시장 영향을 구체적으로 풀어 쓰세요.
4. **날짜**: 절대 과거 날짜를 쓰지 마세요. 참조가 필요하면 "{today}" 또는 "오늘".
5. **언어**: 원문이 영어여도 **반드시 자연스러운 한국어로 번역/의역**.
6. **완결된 문장**: 중간에 끊기면 실패. 모든 문장은 마침표로 끝나야 함.
7. **형식 엄수**: 아래 마크다운 구조 그대로, 빈 줄 포함.

## 출력 형식 (이 구조만 허용)
### {rank}. {{한국어로 재작성한 핵심 제목 (25자 내외)}}

- **카테고리**: {category}
- **출처**: {orig.get("source", "")}
- **요약**: {{핵심 사실을 **3문장 이상**의 서술형으로 설명. 배경·규모·당사자·시장 영향을 빠짐없이.}}
- **투자 시사점**: {{이 뉴스가 어떤 종목/섹터에 어떤 영향(수혜/피해)을 미치는지 **2문장 이상**의 서술형.}}
- **원문 링크**: [{orig.get("source", "원문")}]({orig.get("link", "")})

---

## 원본 뉴스 정보
- 출처: {orig.get("source", "")}
- 제목: {orig.get("title", "")}
- 본문: {orig.get("summary", "")[:body_chars]}
- 링크: {orig.get("link", "")}

위 원본 정보만을 근거로 작성하세요. 확인되지 않은 사실은 추가하지 마세요.
"""


def _is_item_output_valid(text: str) -> Tuple[bool, str]:
    """개별 뉴스 요약 응답 품질 검증."""
    if not text:
        return False, "empty"
    if len(text) < MIN_ITEM_CHARS:
        return False, f"too_short({len(text)}<{MIN_ITEM_CHARS})"
    # 필수 섹션 존재 확인
    required = ["**출처**", "**요약**", "**투자 시사점**", "**원문 링크**"]
    missing = [r for r in required if r not in text]
    if missing:
        return False, f"missing_sections({missing})"
    # 문장 끊김 휴리스틱
    tail = text.rstrip()
    if tail and tail[-1] not in ".。!?)」』》\"'”’)]":
        return False, "truncated_mid_sentence"
    return True, "ok"


def summarize_one_item(client, item: Dict[str, Any]) -> str:
    """
    뉴스 1건을 상세 요약. 품질 미달 시 내부적으로 재시도.
    전부 실패 시 폴백 마크다운 반환(완전 실패 방지).
    """
    rank = item["rank"]
    prompt = _build_item_prompt(item)

    # 최대 3개 모델 × 각 2회 재시도 → 6회까지
    models_to_try = ("gemini-2.5-flash",) + GEMINI_FALLBACK_MODELS[:2]
    best_text = ""

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
            if text and len(text) > len(best_text):
                best_text = text
        except Exception as exc:  # noqa: BLE001
            logger.warning("Step 2) item %d OpenAI 호출 실패: %s", rank, exc)

    # 모든 시도 실패 — 원본 정보로 폴백 마크다운 생성
    logger.warning("Step 2) item %d 전체 실패 → 원본 폴백", rank)
    if best_text:
        return best_text  # 품질 미달이어도 응답이 있으면 사용
    return _fallback_item_markdown(item)


def _fallback_item_markdown(item: Dict[str, Any]) -> str:
    """AI 전면 실패 시 원본 데이터만으로 마크다운 생성."""
    orig = item["original"]
    rank = item["rank"]
    category = item.get("category", "기타")
    title = orig.get("title", "(제목 없음)")[:120]
    summary = orig.get("summary", "(요약 없음)")[:400]
    source = orig.get("source", "")
    link = orig.get("link", "")

    return f"""### {rank}. {title}

- **카테고리**: {category}
- **출처**: {source}
- **요약**: {summary}
- **투자 시사점**: (AI 요약 엔진 장애로 자동 분석을 생성하지 못했습니다. 원문 기사를 확인해 주세요.)
- **원문 링크**: [{source}]({link})
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
    # 🇺🇸 미국 시장 섹션 (v2.6.2 신규)
    # ──────────────────────────────────────────────────────────
    us_section = ""
    if us_indices:
        us_header = f"""## 🇺🇸 미국 시장 ({us_count}건)

> 간밤 마감한 미국 시장 핵심 뉴스입니다. 반도체·AI·ETF·거시 지표를 중심으로 정리했습니다.

"""
        us_body = "\n\n".join(item_markdowns[i] for i in us_indices)
        us_section = us_header + us_body + "\n\n---\n\n"

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

            # Step 3) 총평 + 조립
            overview = generate_overview(client, item_markdowns)
            final = assemble_final_briefing(ranked, item_markdowns, overview)

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
