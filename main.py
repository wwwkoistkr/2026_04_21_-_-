"""
📊 주식 및 반도체 일일 브리핑 — 메인 파이프라인
================================================

실행 흐름 (설계서 §1):
    수집(collect_all_data)
      ↓
    포맷팅(format_data_for_ai)
      ↓
    AI 요약(summarize_with_gemini, Gemini 2.5 Flash)
      ↓
    이메일 발송(send_email, Gmail SMTP)

GitHub Actions 에서 매일 오전 8시(KST) 자동 실행되도록 워크플로가 구성되어 있습니다.

환경 변수 (필수):
    - GEMINI_API_KEY       : Google Gemini API 키
    - EMAIL_SENDER         : 보내는 Gmail 주소
    - EMAIL_APP_PASSWORD   : Gmail 앱 비밀번호 (16자)
    - EMAIL_RECIPIENTS     : 받는 이메일 (쉼표 구분, 생략 시 본인에게 발송)

선택:
    - YOUTUBE_API_KEY      : YouTube Data API 키 (미설정 시 RSS Fallback)
    - THELEC_YOUTUBE_CHANNEL_ID : 디일렉 채널 ID 덮어쓰기
    - DRY_RUN              : 'true' 설정 시 메일 발송 없이 콘솔만 출력
"""
from __future__ import annotations

import logging
import os
import sys
import traceback
from datetime import datetime

from briefing.collectors.aggregator import collect_all_data
from briefing.modules.ai_summarizer import summarize_with_gemini
from briefing.modules.email_sender import send_email
from briefing.modules.formatter import format_data_for_ai

LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"


def _is_truthy(val: str | None) -> bool:
    return (val or "").strip().lower() in {"1", "true", "yes", "y", "on"}


def run_pipeline() -> int:
    """
    전체 브리핑 파이프라인 실행.
    Returns
    -------
    int
        0 = 정상, 1 = 실패
    """
    logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)
    logger = logging.getLogger("briefing.main")

    dry_run = _is_truthy(os.getenv("DRY_RUN"))
    today_str = datetime.now().strftime("%Y-%m-%d (%a)")

    print("=" * 70)
    print(f"📊 일일 브리핑 파이프라인 시작 — {today_str}"
          + (" [DRY RUN]" if dry_run else ""))
    print("=" * 70)

    # 1) 수집 --------------------------------------------------------------
    try:
        data = collect_all_data()
    except Exception:
        logger.exception("수집 단계 치명적 오류")
        return 1

    if not data:
        logger.error("수집된 뉴스가 없습니다. 브리핑 중단.")
        return 1

    # 2) 포맷팅 -----------------------------------------------------------
    ai_input_text = format_data_for_ai(data)
    print(f"\n📝 AI 입력 텍스트 길이: {len(ai_input_text):,} chars")

    # 3) AI 요약 ---------------------------------------------------------
    if dry_run and not os.getenv("GEMINI_API_KEY"):
        # DRY_RUN 에서 API 키 없이 샘플 요약 생성
        logger.warning("GEMINI_API_KEY 미설정 & DRY_RUN — 모의 요약 반환")
        markdown_summary = (
            "## 🔎 오늘의 한 줄 총평\n"
            "(DRY_RUN) Gemini API 를 호출하지 않은 테스트 실행입니다.\n\n"
            + "\n".join(
                f"### {i+1}. (샘플) {d['title'][:60]}\n"
                f"- **출처**: {d['source']}\n"
                f"- **원문 링크**: [바로가기]({d['link']})\n"
                for i, d in enumerate(data[:10])
            )
        )
    else:
        try:
            markdown_summary = summarize_with_gemini(ai_input_text)
        except Exception:
            logger.exception("Gemini 요약 단계 실패")
            return 1

    print("\n" + "─" * 70)
    print("🤖 AI 요약 결과 (상단 700자 미리보기)")
    print("─" * 70)
    print(markdown_summary[:700] + ("..." if len(markdown_summary) > 700 else ""))
    print("─" * 70 + f"\n(총 {len(markdown_summary):,} chars)\n")

    # 4) 이메일 발송 ------------------------------------------------------
    subject = f"📊 일일 주식·반도체 브리핑 — {today_str}"

    if dry_run:
        logger.info("DRY_RUN=true → 메일 발송 생략")
        # 로컬 프리뷰 저장
        preview_path = "/tmp/briefing_latest.html"
        from briefing.modules.email_sender import build_html_email

        with open(preview_path, "w", encoding="utf-8") as f:
            f.write(build_html_email(markdown_summary, subject))
        print(f"💾 HTML 프리뷰 저장: {preview_path}")
        return 0

    try:
        send_email(subject=subject, markdown_body=markdown_summary)
    except Exception:
        logger.exception("이메일 발송 실패")
        return 1

    print("\n✅ 파이프라인 완료")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(run_pipeline())
    except Exception:  # 최후의 안전망
        traceback.print_exc()
        sys.exit(1)
