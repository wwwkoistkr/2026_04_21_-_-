"""
[2단계] 수집기 통합 함수 (collect_all_data).

지침서 3.2의 예외 처리 원칙에 따라, 하위 수집기 중 어떤 것이 실패해도
나머지 수집은 계속 진행되도록 각 호출을 try-except 로 감쌉니다.
"""
from __future__ import annotations

import logging
from typing import Dict, List

from briefing.collectors.korean_news import collect_korean_news
from briefing.collectors.us_news import get_us_news
from briefing.collectors.youtube_news import get_youtube_news

logger = logging.getLogger(__name__)


def collect_all_data(
    korean_limit: int = 5,
    us_limit: int = 3,
    youtube_limit: int = 5,
) -> List[Dict[str, str]]:
    """
    모든 소스(한국 3사, 미국 매체, 디일렉 유튜브)에서 수집 후 단일 리스트로 반환.

    반환 스키마는 항상 지침서 3.3 표준 양식:
      {source, title, link, summary}
    """
    all_news: List[Dict[str, str]] = []

    # 1) 한국 경제 3사 (증권/IT)
    try:
        k = collect_korean_news(per_feed_limit=korean_limit)
        all_news.extend(k)
        print(f"📰 한국 뉴스 누적: {len(k)}건")
    except Exception as exc:  # noqa: BLE001
        logger.warning("한국 뉴스 수집 전체 실패: %s", exc)
        print(f"❌ 한국 뉴스 수집 전체 실패 (건너뜀): {exc}")

    # 2) 미국 반도체/ETF 매체
    try:
        u = get_us_news(per_feed_limit=us_limit)
        all_news.extend(u)
        print(f"🌎 미국 뉴스 누적: {len(u)}건")
    except Exception as exc:  # noqa: BLE001
        logger.warning("미국 뉴스 수집 전체 실패: %s", exc)
        print(f"❌ 미국 뉴스 수집 전체 실패 (건너뜀): {exc}")

    # 3) 디일렉 유튜브
    try:
        y = get_youtube_news(max_results=youtube_limit)
        all_news.extend(y)
        print(f"📺 유튜브 누적: {len(y)}건")
    except Exception as exc:  # noqa: BLE001
        logger.warning("유튜브 수집 전체 실패: %s", exc)
        print(f"❌ 유튜브 수집 전체 실패 (건너뜀): {exc}")

    # 중복 제거 (동일 링크 기준)
    deduped: List[Dict[str, str]] = []
    seen_links = set()
    for item in all_news:
        key = item.get("link", "").strip()
        if key and key in seen_links:
            continue
        seen_links.add(key)
        deduped.append(item)

    print(f"\n✨ 중복 제거 후 최종: {len(deduped)}건 (원본 {len(all_news)}건)")
    return deduped


# ---------------------------------------------------------------------------
# 단독 실행 테스트 (`python -m briefing.collectors.aggregator`)
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    print("=" * 60)
    print("통합 수집 테스트")
    print("=" * 60)

    data = collect_all_data()

    print("\n" + "=" * 60)
    print("소스별 건수")
    print("=" * 60)
    from collections import Counter

    for src, cnt in Counter(d["source"] for d in data).most_common():
        print(f"  - {src}: {cnt}건")
