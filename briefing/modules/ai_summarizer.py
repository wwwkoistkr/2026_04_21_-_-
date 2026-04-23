"""
[3단계 v2.5.0] Gemini/OpenAI 호환 API 기반 2단계 요약 엔진.

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

## 선정 우선순위
1. 반도체 (HBM, 파운드리, 메모리, SK하이닉스, 삼성전자, TSMC, 마이크론)
2. AI (엔비디아, AMD, AI 인프라 투자)
3. 미국 증시 · ETF · 거시 (나스닥, S&P, 환율, 금리, 연준)
4. 한국 증시 주요 이슈 (코스피/코스닥 주도주, 정부 정책)
5. 기타 시장 영향도 큰 기업/산업 뉴스

## 제외 기준
- 광고성·이벤트·당첨 공지
- 동일 사건 중복 기사 (→ 가장 정보가 풍부한 1건만 선택)
- 시장 영향이 없는 단순 인사·사회 뉴스

## 출력 형식 (반드시 순수 JSON 배열만, 설명 문장 없이)
```json
[
  {{"idx": 후보번호, "rank": 1, "category": "반도체", "reason": "선정 이유 한 줄"}},
  ...(총 {TARGET_NEWS_COUNT}개)
]
```

- `idx`: 위 후보 목록의 [번호]
- `rank`: 1~{TARGET_NEWS_COUNT} (중복 불가)
- `category`: "반도체" | "AI" | "미국증시" | "한국증시" | "거시경제" | "기타"
- `reason`: 왜 오늘 중요한지 한 줄 (20자 내외)

{news_block}

위 {len(news_list)}건 중 정확히 {TARGET_NEWS_COUNT}개를 선정해, JSON 배열로만 답변하세요.
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

    text, used_model = _call_with_retry(
        client, prompt, max_tokens=2048, temperature=0.2, call_label="rank",
    )
    logger.info("Step 1) 랭킹 응답 (모델=%s, 길이=%d)", used_model, len(text))

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
    logger.info("Step 1) 최종 선정: %d건", len(result))
    return result


# ════════════════════════════════════════════════════════════
# 단계 2) 개별 뉴스 상세 요약
# ════════════════════════════════════════════════════════════
def _build_item_prompt(item: Dict[str, Any]) -> str:
    """개별 뉴스 1건에 대한 상세 요약 프롬프트."""
    today = _today_kr_str()
    orig = item["original"]
    rank = item["rank"]
    category = item.get("category", "기타")

    return f"""당신은 한국 개인투자자를 위한 시니어 애널리스트입니다.
오늘은 **{today}** (KST) 입니다.

아래 뉴스 1건을 **투자자 관점에서 깊이 있게 분석**하여 마크다운으로 작성하세요.

## 절대 준수 사항
1. **분량**: 전체 응답은 **최소 {MIN_ITEM_CHARS}자 이상** (요약 본문 최소 3문장).
2. **날짜**: 절대 과거 날짜를 쓰지 마세요. 참조가 필요하면 "{today}" 또는 "오늘".
3. **언어**: 원문이 영어여도 **반드시 자연스러운 한국어로 번역/의역**.
4. **완결된 문장**: 중간에 끊기면 실패. 모든 문장은 마침표로 끝나야 함.
5. **형식 엄수**: 아래 마크다운 구조 그대로, 빈 줄 포함.

## 출력 형식 (이 구조만 허용)
### {rank}. {{한국어로 재작성한 핵심 제목 (25자 내외)}}

- **카테고리**: {category}
- **출처**: {orig.get("source", "")}
- **요약**: {{핵심 사실을 3~4문장으로 설명. 배경·규모·당사자·시장 영향을 빠짐없이.}}
- **투자 시사점**: {{이 뉴스가 어떤 종목/섹터에 어떤 영향(수혜/피해)을 미치는지 2문장.}}
- **원문 링크**: [{orig.get("source", "원문")}]({orig.get("link", "")})

---

## 원본 뉴스 정보
- 출처: {orig.get("source", "")}
- 제목: {orig.get("title", "")}
- 요약: {orig.get("summary", "")[:500]}
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
    client, ranked_items: List[Dict[str, Any]], max_workers: int = 4,
) -> List[str]:
    """선정된 10개를 병렬로 상세 요약. 순서는 rank 기준으로 정렬하여 반환."""
    results: Dict[int, str] = {}

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        future_to_rank = {
            pool.submit(summarize_one_item, client, item): item["rank"]
            for item in ranked_items
        }
        for fut in as_completed(future_to_rank):
            rank = future_to_rank[fut]
            try:
                results[rank] = fut.result()
            except Exception as exc:  # noqa: BLE001
                logger.error("Step 2) item %d 예외: %s", rank, exc)
                # 해당 item 찾아 폴백
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
    """오늘의 총평 생성 (짧은 호출). 실패 시 기본 문장 반환."""
    try:
        prompt = _build_overview_prompt(item_markdowns)
        text, used = _call_with_retry(
            client, prompt, max_tokens=512, temperature=0.5, call_label="overview",
        )
        logger.info("Step 3) 총평 생성 (모델=%s, %d자)", used, len(text))
        return text.strip()
    except Exception as exc:  # noqa: BLE001
        logger.warning("총평 생성 실패 — 기본 문장 사용: %s", exc)
        return (
            f"{_today_kr_str()} 시장은 반도체·AI 섹터의 모멘텀과 미국 거시 지표의 "
            "영향을 동시에 받고 있습니다. 위 핵심 뉴스들을 참고해 포트폴리오 점검을 권합니다."
        )


def assemble_final_briefing(
    ranked_items: List[Dict[str, Any]],
    item_markdowns: List[str],
    overview: str,
) -> str:
    """10개 요약 + 총평 + 카테고리 배지를 포함한 최종 마크다운 작성."""
    today = _today_kr_str()

    # 카테고리별 집계 (헤더에 표시)
    from collections import Counter
    cat_counts = Counter(item["category"] for item in ranked_items)
    cat_summary = " · ".join(f"{c} {n}" for c, n in cat_counts.most_common())

    header = f"""## 📈 {today} 주식·반도체 일일 브리핑

안녕하세요, 한국 개인투자자 여러분. 오늘 시장에 가장 큰 영향을 미칠 **핵심 뉴스 {len(item_markdowns)}건**을
순위별로 분석해 드립니다.

**오늘의 카테고리 구성**: {cat_summary}

---

"""

    body = "\n\n".join(item_markdowns)

    footer = f"""

---

## 🔎 오늘의 한 줄 총평

{overview}
"""

    return header + body + footer


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
            openai_model = os.getenv("OPENAI_MODEL", "gpt-5-mini")
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

    parts = [warning, f"## 📰 {today} 주식·반도체 주요 뉴스\n\n"]
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

    parts.append("\n---\n\n## 🔎 오늘의 한 줄 총평\n\n")
    parts.append(
        "AI 분석 엔진 장애로 자동 총평을 생성하지 못했습니다. "
        "위 원본 뉴스들을 직접 확인해 주세요.\n"
    )
    return "".join(parts)


# ─── OpenAI 호환 폴백 (v2.4.x 호환 유지) ───────────────────
def _summarize_with_openai_compat(
    briefing_input_text: str,
    model_name: str = "gpt-5-mini",
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
