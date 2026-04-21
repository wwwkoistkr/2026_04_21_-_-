"""
[3단계] Gemini 2.5 Flash (주) + OpenAI 호환 엔드포인트 (보조) 를 활용한
핵심 10개 뉴스 요약 모듈.

- 주 엔진: Google Gemini 2.5 Flash (``GEMINI_API_KEY`` 환경변수)
- 보조 엔진: OpenAI 호환 API (``OPENAI_API_KEY`` + ``OPENAI_BASE_URL``)
  → Gemini 키가 없거나 실패할 때 자동 fallback
- 해외 뉴스는 반드시 한국어로 번역한다는 지시를 프롬프트에 명시
- 반환값은 HTML/Markdown 혼합 가능한 순수 텍스트 (메일 본문 생성기가 포맷함)
"""
from __future__ import annotations

import logging
import os
import time
from typing import Optional

logger = logging.getLogger(__name__)

# (v2.2.3) Gemini 503(모델 과부하) 등 일시적 오류에 대한 재시도 설정
# - 같은 모델에 대해 최대 3회 지수 백오프(3s → 6s → 12s)
# - 기본 모델 실패 시 경량 모델(gemini-2.5-flash-lite, gemini-2.0-flash)로 폴백
GEMINI_RETRY_DELAYS_SEC = (3, 6, 12)
GEMINI_FALLBACK_MODELS = ("gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-1.5-flash")
TRANSIENT_KEYWORDS = ("503", "UNAVAILABLE", "overloaded", "RESOURCE_EXHAUSTED", "429", "deadline", "INTERNAL")


def _is_transient_gemini_error(exc: Exception) -> bool:
    """Gemini 503 / 429 / 일시적 네트워크 오류 여부 판단."""
    msg = str(exc)
    return any(k in msg for k in TRANSIENT_KEYWORDS)


def _call_gemini_once(client, model_name: str, full_prompt: str):
    """단일 Gemini 호출 — 재시도/폴백 로직의 기본 단위."""
    from google.genai import types as gt

    response = client.models.generate_content(
        model=model_name,
        contents=full_prompt,
        config=gt.GenerateContentConfig(
            temperature=0.4,
            top_p=0.9,
            max_output_tokens=4096,
        ),
    )
    return (response.text or "").strip()


# ---------------------------------------------------------------------------
# 프롬프트 템플릿 (지침서 [3단계] 3번 항목 충실 반영)
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = """당신은 한국 개인투자자를 위한 '주식 및 반도체 일일 브리핑'을 작성하는
시니어 애널리스트입니다. 아래에 주어진 수집 뉴스(한국 경제신문 3사, 미국 반도체/ETF
매체, 디일렉 유튜브 영상)를 바탕으로 오늘 투자자에게 가장 영향이 큰 핵심 뉴스를
엄선해 한국어 브리핑으로 요약하세요.

[엄수 조건]
1. 반드시 **핵심 뉴스 10개**만 엄선하여 순위를 매깁니다.
   (투자자 관점에서 시장에 미치는 영향이 큰 순서)
2. **해외(영문) 뉴스는 반드시 한국어로 자연스럽게 번역**하여 제시합니다.
   원문 영어 제목을 그대로 노출하지 마세요.
3. 광고성·중복성 기사는 제외합니다. (예: '이벤트 당첨자 발표', '증정 행사')
4. 반도체/ETF/거시경제에 직접 연관된 이슈를 우선합니다.
5. 각 뉴스는 다음 형식(마크다운)으로 출력합니다:

### {순위}. {한국어 핵심 제목}
- **출처**: {원출처}
- **요약**: {2~3문장의 투자자 관점 요약}
- **투자 시사점**: {한 줄로 명확하게}
- **원문 링크**: {link}

마지막에는 `## 🔎 오늘의 한 줄 총평` 섹션을 두고, 시장 전체 흐름을 1~2 문장으로
요약해 주세요.

[수집 뉴스 데이터]
"""


def _summarize_with_openai_compat(
    briefing_input_text: str,
    model_name: str = "gpt-5-mini",
) -> str:
    """
    OpenAI 호환 API(Chat Completions) 로 요약 — Gemini 실패/미설정 시 fallback.
    환경변수 ``OPENAI_API_KEY``, ``OPENAI_BASE_URL`` 필요.
    """
    from openai import OpenAI  # lazy import

    api_key = os.getenv("OPENAI_API_KEY")
    base_url = os.getenv("OPENAI_BASE_URL")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY 환경변수가 필요합니다.")

    client = OpenAI(api_key=api_key, base_url=base_url) if base_url else OpenAI(api_key=api_key)
    logger.info("OpenAI 호환 호출: model=%s, base_url=%s", model_name, base_url or "(default)")

    resp = client.chat.completions.create(
        model=model_name,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": briefing_input_text},
        ],
    )
    text = (resp.choices[0].message.content or "").strip()
    if not text:
        raise RuntimeError("OpenAI 호환 응답이 비어 있습니다.")
    return text


def summarize_with_gemini(
    briefing_input_text: str,
    model_name: str = "gemini-2.5-flash",
    api_key: Optional[str] = None,
) -> str:
    """
    뉴스 요약을 수행. 우선순위:
      1) GEMINI_API_KEY 가 있으면 Gemini 2.5 Flash 사용
      2) 실패/미설정 시 OpenAI 호환 API 로 자동 fallback
         (환경변수 OPENAI_API_KEY / OPENAI_BASE_URL 필요)
    둘 다 없으면 RuntimeError.
    """
    key = api_key or os.getenv("GEMINI_API_KEY")

    # ---- Gemini 우선 시도 (v2.2.3: 재시도 + 경량 모델 폴백) ----
    if key:
        try:
            from google import genai

            client = genai.Client(api_key=key)
            full_prompt = SYSTEM_PROMPT + "\n" + briefing_input_text

            # 시도 순서: 기본 모델 → 경량 폴백 모델들
            models_to_try = [model_name] + [m for m in GEMINI_FALLBACK_MODELS if m != model_name]

            last_exc: Optional[Exception] = None
            for m in models_to_try:
                # 각 모델마다 일시적 오류에 대해 최대 3회 지수 백오프 재시도
                for attempt, delay in enumerate([0, *GEMINI_RETRY_DELAYS_SEC]):
                    if delay:
                        logger.info("Gemini(%s) 재시도 대기 %ds (attempt=%d)", m, delay, attempt)
                        time.sleep(delay)
                    try:
                        logger.info(
                            "Gemini 호출: model=%s, 입력 길이=%d, attempt=%d/%d",
                            m, len(full_prompt), attempt + 1, len(GEMINI_RETRY_DELAYS_SEC) + 1,
                        )
                        text = _call_gemini_once(client, m, full_prompt)
                        if text:
                            if m != model_name or attempt > 0:
                                logger.warning(
                                    "Gemini 회복: 최종 성공 모델=%s, attempt=%d", m, attempt + 1,
                                )
                            return text
                        # 빈 응답 → 재시도할 가치가 있는 케이스로 간주
                        logger.warning("Gemini(%s) 빈 응답 — 재시도", m)
                        last_exc = RuntimeError("empty response")
                    except Exception as exc:  # noqa: BLE001
                        last_exc = exc
                        if _is_transient_gemini_error(exc):
                            logger.warning("Gemini(%s) 일시적 오류 — 재시도 예정: %s", m, exc)
                            continue
                        # 비일시적(예: 인증/요청 오류) 이면 더 시도하지 않고 다음 모델로
                        logger.warning("Gemini(%s) 비일시적 오류, 다음 모델로: %s", m, exc)
                        break
                # 다음 모델로 넘어가기 전 로그
                logger.warning("Gemini 모델(%s) 모든 재시도 실패 — 폴백 모델로 전환", m)

            logger.warning(
                "Gemini 전체 실패(%s) — OpenAI 호환으로 fallback", last_exc,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Gemini 초기화 실패, OpenAI 호환으로 fallback: %s", exc)

    # ---- OpenAI 호환 fallback ----
    if os.getenv("OPENAI_API_KEY"):
        openai_model = os.getenv("OPENAI_MODEL", "gpt-5-mini")
        return _summarize_with_openai_compat(briefing_input_text, model_name=openai_model)

    raise RuntimeError(
        "AI 요약 엔진 설정이 없습니다. "
        "GEMINI_API_KEY 또는 (OPENAI_API_KEY + OPENAI_BASE_URL) 중 하나가 필요합니다. "
        "현재 Gemini 가 일시적으로 과부하(503/UNAVAILABLE) 상태일 수 있으므로 "
        "OPENAI_API_KEY 를 보조 엔진으로 등록하면 이런 장애에도 브리핑이 발송됩니다."
    )


# ---------------------------------------------------------------------------
# 단독 실행 테스트 — GEMINI_API_KEY 가 있어야 동작
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import sys

    from briefing.collectors.aggregator import collect_all_data
    from briefing.modules.formatter import format_data_for_ai

    logging.basicConfig(level=logging.INFO)
    print("[테스트] 수집 → 포맷 → Gemini 요약")

    if not os.getenv("GEMINI_API_KEY"):
        print("GEMINI_API_KEY 미설정 — 실제 호출 대신 프롬프트만 미리보기 합니다.")
        data = collect_all_data(korean_limit=2, us_limit=1, youtube_limit=2)
        text = format_data_for_ai(data)
        print(SYSTEM_PROMPT + text[:1500] + "\n...(생략)")
        sys.exit(0)

    data = collect_all_data()
    text = format_data_for_ai(data)
    result = summarize_with_gemini(text)
    print(result)
