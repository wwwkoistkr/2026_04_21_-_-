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
from typing import Optional

logger = logging.getLogger(__name__)


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

    # ---- Gemini 우선 시도 (google-genai SDK, 설계서 §2.3 준수) ----
    if key:
        try:
            from google import genai
            from google.genai import types as gt

            client = genai.Client(api_key=key)
            full_prompt = SYSTEM_PROMPT + "\n" + briefing_input_text
            logger.info("Gemini 호출: model=%s, 입력 길이=%d", model_name, len(full_prompt))

            response = client.models.generate_content(
                model=model_name,
                contents=full_prompt,
                config=gt.GenerateContentConfig(
                    temperature=0.4,
                    top_p=0.9,
                    max_output_tokens=4096,
                ),
            )
            text = (response.text or "").strip()
            if text:
                return text
            logger.warning("Gemini 응답이 비어 있음 — OpenAI 호환으로 fallback")
        except Exception as exc:  # noqa: BLE001
            logger.warning("Gemini 호출 실패, OpenAI 호환으로 fallback: %s", exc)

    # ---- OpenAI 호환 fallback ----
    if os.getenv("OPENAI_API_KEY"):
        openai_model = os.getenv("OPENAI_MODEL", "gpt-5-mini")
        return _summarize_with_openai_compat(briefing_input_text, model_name=openai_model)

    raise RuntimeError(
        "AI 요약 엔진 설정이 없습니다. "
        "GEMINI_API_KEY 또는 (OPENAI_API_KEY + OPENAI_BASE_URL) 중 하나가 필요합니다."
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
