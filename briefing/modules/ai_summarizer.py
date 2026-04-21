"""
[3단계] Gemini 2.5 Flash 를 활용한 핵심 10개 뉴스 요약 모듈.

- 환경변수 ``GEMINI_API_KEY`` 필수
- 라이브러리: ``google-generativeai`` (pip install google-generativeai)
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


def summarize_with_gemini(
    briefing_input_text: str,
    model_name: str = "gemini-2.5-flash",
    api_key: Optional[str] = None,
) -> str:
    """
    Gemini 에 수집 뉴스를 보내고 10개 핵심 브리핑(마크다운)을 반환.

    Parameters
    ----------
    briefing_input_text : str
        format_data_for_ai() 로 가공된 텍스트.
    model_name : str
        기본 ``gemini-2.5-flash`` (설계서 [3단계] 2번 준수).
    api_key : str, optional
        미지정 시 ``GEMINI_API_KEY`` env 사용.
    """
    key = api_key or os.getenv("GEMINI_API_KEY")
    if not key:
        raise RuntimeError(
            "GEMINI_API_KEY 환경변수가 설정되어 있지 않습니다. "
            "GitHub Secrets 또는 .env 에 추가해 주세요."
        )

    # 지연 import — google-generativeai 미설치 시에도 다른 모듈 import 가능
    import google.generativeai as genai

    genai.configure(api_key=key)

    model = genai.GenerativeModel(
        model_name=model_name,
        generation_config={
            "temperature": 0.4,
            "top_p": 0.9,
            "max_output_tokens": 4096,
        },
    )

    full_prompt = SYSTEM_PROMPT + "\n" + briefing_input_text

    logger.info("Gemini 호출: model=%s, 입력 길이=%d", model_name, len(full_prompt))
    response = model.generate_content(full_prompt)

    text = (response.text or "").strip()
    if not text:
        raise RuntimeError("Gemini 응답이 비어 있습니다.")
    return text


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
