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
import re
import time
from datetime import datetime
from typing import Optional

logger = logging.getLogger(__name__)

# (v2.2.3) Gemini 503(모델 과부하) 등 일시적 오류에 대한 재시도 설정
# - 같은 모델에 대해 최대 3회 지수 백오프(3s → 6s → 12s)
# - 기본 모델 실패 시 경량 모델(gemini-2.5-flash-lite, gemini-2.0-flash)로 폴백
GEMINI_RETRY_DELAYS_SEC = (3, 6, 12)
GEMINI_FALLBACK_MODELS = ("gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-1.5-flash")
TRANSIENT_KEYWORDS = ("503", "UNAVAILABLE", "overloaded", "RESOURCE_EXHAUSTED", "429", "deadline", "INTERNAL")

# (v2.4.1) 응답 품질 검증 기준
# - 최소 글자수 미달 또는 뉴스 항목 수 부족 시 재시도/폴백 트리거
MIN_OUTPUT_CHARS = 1800        # 약 10개 뉴스 × 180자 (너무 짧으면 잘림으로 간주)
MIN_NEWS_ITEMS = 7             # 10개 목표, 최소 7개는 있어야 정상 응답
MAX_OUTPUT_TOKENS = 8192       # v2.4.1: 4096 → 8192 상향 (잘림 방지, 10개 × 5줄 소화)


def _is_transient_gemini_error(exc: Exception) -> bool:
    """Gemini 503 / 429 / 일시적 네트워크 오류 여부 판단."""
    msg = str(exc)
    return any(k in msg for k in TRANSIENT_KEYWORDS)


def _count_news_items(text: str) -> int:
    """'### 1.' ~ '### 10.' 형식의 뉴스 항목 수를 헤아립니다."""
    if not text:
        return 0
    # "### 1." / "### 10." / "### 1)" / "**1." 등 다양한 순번 표기를 허용
    return len(re.findall(r"(?:^|\n)\s*(?:#{1,6}\s*)?\*{0,2}\s*\d{1,2}[.)]\s*\*{0,2}", text))


def _is_output_too_short(text: str) -> tuple[bool, str]:
    """응답이 너무 짧거나 항목 수가 부족한지 판단하고 사유를 반환."""
    if not text:
        return True, "empty"
    if len(text) < MIN_OUTPUT_CHARS:
        return True, f"too_short({len(text)}chars < {MIN_OUTPUT_CHARS})"
    n = _count_news_items(text)
    if n < MIN_NEWS_ITEMS:
        return True, f"too_few_items({n}<{MIN_NEWS_ITEMS})"
    # 출력이 문장 중간에서 끝났는지 휴리스틱: 끝이 마침표/닫는 기호가 아닌 한 글자
    tail = text.rstrip()
    if tail and tail[-1] not in ".。!?)」』》\"'”’)]" and len(tail.split()[-1]) <= 2:
        # 예: 마지막 토큰이 "한"처럼 1~2자로 끝나면 잘림 의심
        return True, "truncated_mid_sentence"
    return False, "ok"


def _call_gemini_once(client, model_name: str, full_prompt: str):
    """단일 Gemini 호출 — 재시도/폴백 로직의 기본 단위."""
    from google.genai import types as gt

    response = client.models.generate_content(
        model=model_name,
        contents=full_prompt,
        config=gt.GenerateContentConfig(
            temperature=0.4,
            top_p=0.9,
            max_output_tokens=MAX_OUTPUT_TOKENS,  # v2.4.1: 8192
        ),
    )
    return (response.text or "").strip()


# ---------------------------------------------------------------------------
# 프롬프트 템플릿 (v2.4.1 — 오늘 날짜 주입 + 분량/품질 강제)
# ---------------------------------------------------------------------------
def _build_system_prompt() -> str:
    """매 호출 시점의 '오늘 날짜'를 주입한 프롬프트를 생성합니다.

    - Gemini가 학습 데이터의 과거 날짜를 환각(hallucination)하는 문제를 방지
    - 한국 개장 시간 기준(KST)을 명시
    """
    try:
        # GitHub Actions는 UTC 기준이므로 KST(+9h)로 보정
        from datetime import timezone, timedelta
        kst = timezone(timedelta(hours=9))
        now_kst = datetime.now(kst)
    except Exception:
        now_kst = datetime.now()

    today_kr = now_kst.strftime("%Y년 %m월 %d일 (%a)")
    today_iso = now_kst.strftime("%Y-%m-%d")
    weekday_kr = ["월", "화", "수", "목", "금", "토", "일"][now_kst.weekday()]

    return f"""당신은 한국 개인투자자를 위한 '주식 및 반도체 일일 브리핑'을 작성하는
시니어 애널리스트입니다. 오늘은 **{today_iso} ({weekday_kr}요일, KST)** 입니다.

아래에 주어진 수집 뉴스(한국 경제신문 3사, 미국 반도체/ETF 매체 등)를 바탕으로
오늘 투자자에게 가장 영향이 큰 핵심 뉴스를 엄선해 한국어 브리핑으로 요약하세요.

═══════════════════════════════════════════════════════════════
⚠️ 절대 준수 사항 (위반 시 전체 재작성)
═══════════════════════════════════════════════════════════════

1. **날짜 표기**: 반드시 "{today_kr}" 로만 표기하세요.
   ❌ 절대 과거 날짜(2024년 등)를 쓰지 마세요. 학습 데이터의 날짜를 임의로
      사용하는 것은 엄격히 금지입니다.

2. **분량 엄수**: 반드시 **핵심 뉴스 정확히 10개**를 순위 매겨 출력합니다.
   - 9개 이하로 출력하면 실패로 간주됩니다.
   - 각 뉴스는 최소 4줄(제목·출처·요약·시사점) 이상으로 충실히 작성합니다.
   - 요약은 반드시 **완전한 문장**으로 마무리하세요. 문장 중간에서 절대 끊지 마세요.

3. **해외 뉴스 번역**: 영문 제목·요약은 반드시 **자연스러운 한국어**로 번역.
   원문 영어를 그대로 노출하지 않습니다.

4. **제외 대상**: 광고성·이벤트·중복 기사는 제외.
   (예: "당첨자 발표", "증정 행사", "구독 안내")

5. **우선순위**: 반도체(HBM·파운드리·메모리) → ETF·미국 증시 →
   거시경제(환율·금리) → 기타 한국 증시 순으로 비중을 둡니다.

═══════════════════════════════════════════════════════════════
📋 출력 형식 (반드시 이 마크다운 구조 그대로)
═══════════════════════════════════════════════════════════════

## 📈 {today_kr} 주식·반도체 일일 브리핑

안녕하세요, 한국 개인투자자 여러분. 시니어 애널리스트입니다.
오늘 {today_kr} 시장에 가장 큰 영향을 미칠 핵심 뉴스 **10가지**를 엄선해
브리핑해 드립니다.

---

### 1. {{한국어 핵심 제목 (20자 내외)}}
- **출처**: {{원출처 (예: 한국경제, Reuters)}}
- **요약**: {{2~3문장. 투자자 관점에서 시장 영향과 배경을 설명. 반드시 완결된 문장.}}
- **투자 시사점**: {{한 줄로 "어떤 종목/섹터에 어떤 영향"을 명확히 제시}}
- **원문 링크**: {{link}}

### 2. {{...}}
(… 같은 형식으로 **10번까지 반드시 출력** …)

### 10. {{...}}
- **출처**: ...
- **요약**: ...
- **투자 시사점**: ...
- **원문 링크**: ...

---

## 🔎 오늘의 한 줄 총평
{{시장 전체 흐름을 2~3 문장으로 요약. 반도체/AI 흐름, 원·달러, 미국 지수
움직임 등 핵심 체크포인트 언급.}}

═══════════════════════════════════════════════════════════════
[수집 뉴스 데이터 — 아래 원문을 참고해서만 작성하세요]
═══════════════════════════════════════════════════════════════
"""


# 하위 호환용 — 외부에서 참조하는 경우를 위해 동적 속성 제공
SYSTEM_PROMPT = _build_system_prompt()  # import 시점 스냅샷 (테스트용)


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

    # v2.4.1: 매 호출마다 '오늘 날짜'가 반영된 프롬프트를 새로 생성
    system_prompt = _build_system_prompt()

    resp = client.chat.completions.create(
        model=model_name,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": briefing_input_text},
        ],
        max_tokens=MAX_OUTPUT_TOKENS,  # v2.4.1: 충분한 출력 확보
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

    # ---- Gemini 우선 시도 (v2.2.3: 재시도 + 경량 모델 폴백, v2.4.1: 응답 품질 검증) ----
    if key:
        try:
            from google import genai

            client = genai.Client(api_key=key)
            # v2.4.1: 매 호출마다 '오늘 날짜'가 반영된 프롬프트 생성
            system_prompt = _build_system_prompt()
            full_prompt = system_prompt + "\n" + briefing_input_text

            # 시도 순서: 기본 모델 → 경량 폴백 모델들
            models_to_try = [model_name] + [m for m in GEMINI_FALLBACK_MODELS if m != model_name]

            last_exc: Optional[Exception] = None
            best_short_text: Optional[str] = None   # v2.4.1: 짧지만 유효한 응답을 비상용으로 보관
            best_short_len: int = 0

            for m in models_to_try:
                # 각 모델마다 일시적 오류/짧은 응답에 대해 최대 3회 지수 백오프 재시도
                for attempt, delay in enumerate([0, *GEMINI_RETRY_DELAYS_SEC]):
                    if delay:
                        logger.info("Gemini(%s) 재시도 대기 %ds (attempt=%d)", m, delay, attempt)
                        time.sleep(delay)
                    try:
                        logger.info(
                            "Gemini 호출: model=%s, 입력 길이=%d, max_tokens=%d, attempt=%d/%d",
                            m, len(full_prompt), MAX_OUTPUT_TOKENS, attempt + 1,
                            len(GEMINI_RETRY_DELAYS_SEC) + 1,
                        )
                        text = _call_gemini_once(client, m, full_prompt)

                        # v2.4.1: 응답 품질 검증
                        too_short, reason = _is_output_too_short(text)
                        if not too_short:
                            if m != model_name or attempt > 0:
                                logger.warning(
                                    "Gemini 회복: 최종 성공 모델=%s, attempt=%d, 길이=%d, 항목수=%d",
                                    m, attempt + 1, len(text), _count_news_items(text),
                                )
                            else:
                                logger.info(
                                    "Gemini 응답 OK: 길이=%d, 항목수=%d",
                                    len(text), _count_news_items(text),
                                )
                            return text

                        # 짧거나 잘린 응답 — 재시도
                        logger.warning(
                            "Gemini(%s) 응답 품질 미달(%s) — 재시도 예정 "
                            "(길이=%d, 항목수=%d)",
                            m, reason, len(text or ""), _count_news_items(text or ""),
                        )
                        # 혹시 모든 재시도가 실패할 경우를 대비해 가장 긴 응답을 보관
                        if text and len(text) > best_short_len:
                            best_short_text = text
                            best_short_len = len(text)
                        last_exc = RuntimeError(f"output quality: {reason}")

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
            # v2.4.1: OpenAI도 실패하면 짧은 응답이라도 반환 (완전 실패보다 낫다)
            # → OpenAI 시도 후에도 실패하면 아래에서 best_short_text 반환
        except Exception as exc:  # noqa: BLE001
            logger.warning("Gemini 초기화 실패, OpenAI 호환으로 fallback: %s", exc)
            best_short_text = None
            best_short_len = 0
    else:
        best_short_text = None
        best_short_len = 0

    # ---- OpenAI 호환 fallback ----
    if os.getenv("OPENAI_API_KEY"):
        try:
            openai_model = os.getenv("OPENAI_MODEL", "gpt-5-mini")
            openai_text = _summarize_with_openai_compat(
                briefing_input_text, model_name=openai_model,
            )
            # v2.4.1: OpenAI 응답도 품질 검증
            too_short, reason = _is_output_too_short(openai_text)
            if not too_short:
                return openai_text
            logger.warning(
                "OpenAI 응답도 품질 미달(%s) — 비상 응답 검토 (길이=%d)",
                reason, len(openai_text or ""),
            )
            if openai_text and len(openai_text) > best_short_len:
                best_short_text = openai_text
        except Exception as exc:  # noqa: BLE001
            logger.warning("OpenAI 호환 호출도 실패: %s", exc)

    # v2.4.1: 마지막 비상 수단 — 짧지만 그래도 생성된 응답이 있으면 경고와 함께 반환
    # (완전 실패보다는 부분적인 결과라도 받는 편이 낫다)
    if best_short_text:
        logger.warning(
            "⚠️ 모든 엔진이 품질 기준 미달. 가장 긴 응답(%d자) 반환 — 수동 확인 필요",
            best_short_len,
        )
        warning_banner = (
            "> ⚠️ **주의**: 이 브리핑은 AI 응답 품질 검증을 통과하지 못했습니다. "
            "일부 내용이 누락되었을 수 있습니다.\n\n"
        )
        return warning_banner + best_short_text

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
