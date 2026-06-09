"""
[2단계] 미국 반도체/ETF 매체 수집기.

Seeking Alpha, ETF.com, Morningstar 는 봇 차단이 강력합니다.
지침서 3.1 전략 2 에 따라 **Google News RSS 우회** 방식으로 수집합니다.
  예) https://news.google.com/rss/search?q=site:seekingalpha.com+semiconductor
"""
from __future__ import annotations

import logging
import os
from typing import Dict, List
from urllib.parse import quote_plus

from briefing.collectors.korean_news import get_news_from_rss

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Google News RSS 우회 대상 – site 와 검색어 조합
# v2.9.0: 반도체 + 원자력 2개 테마 확장 (총 10개 피드)
# ---------------------------------------------------------------------------
US_FEEDS: List[Dict[str, str]] = [
    # ─── 🔬 반도체 테마 (6개 피드) ───────────────────────────
    {"source": "Seeking Alpha", "site": "seekingalpha.com",
     "query": "semiconductor OR HBM OR NVIDIA OR TSMC", "topic": "semiconductor"},
    {"source": "Seeking Alpha (ETF)", "site": "seekingalpha.com",
     "query": "SOXX OR SMH semiconductor ETF", "topic": "etf"},
    {"source": "Reuters", "site": "reuters.com",
     "query": "semiconductor OR chip OR NVIDIA OR TSMC OR robotics", "topic": "semiconductor"},
    {"source": "Bloomberg", "site": "bloomberg.com",
     "query": "semiconductor OR chip OR memory OR AI data center power", "topic": "semiconductor"},
    {"source": "ETF.com", "site": "etf.com",
     "query": "semiconductor SOXX SMH nuclear ETF robotics ETF", "topic": "etf"},
    {"source": "Morningstar", "site": "morningstar.com",
     "query": "semiconductor AI chip uranium ETF", "topic": "etf"},
    # ─── ⚛️ 원자력 테마 (v2.9.0 + 공식/전문 소스 보강) ────────
    {"source": "Reuters (Nuclear)", "site": "reuters.com",
     "query": "nuclear power OR SMR OR uranium", "topic": "nuclear"},
    {"source": "Bloomberg (Nuclear)", "site": "bloomberg.com",
     "query": "nuclear OR SMR OR uranium OR data center power", "topic": "nuclear"},
    {"source": "Seeking Alpha (Nuclear)", "site": "seekingalpha.com",
     "query": "nuclear uranium SMR", "topic": "nuclear"},
    {"source": "Morningstar (Nuclear)", "site": "morningstar.com",
     "query": "nuclear uranium ETF", "topic": "nuclear"},
    {"source": "U.S. EIA", "site": "eia.gov",
     "query": "small modular reactor nuclear power uranium", "topic": "nuclear"},
    {"source": "U.S. NRC", "site": "nrc.gov",
     "query": "advanced reactor SMR microreactor", "topic": "nuclear"},
    {"source": "World Nuclear News", "site": "world-nuclear-news.org",
     "query": "SMR uranium nuclear power", "topic": "nuclear"},

    # ─── 🤖 Physical AI / robotics 보강 ───────────────────────
    {"source": "NVIDIA Newsroom", "site": "nvidianews.nvidia.com", "query": "physical AI robotics autonomous vehicles", "topic": "physical_ai"},
    {"source": "The Robot Report", "site": "therobotreport.com", "query": "physical AI robotics NVIDIA humanoid", "topic": "physical_ai"},
    {"source": "IEEE Spectrum Robotics", "site": "spectrum.ieee.org", "query": "robotics physical AI autonomous", "topic": "physical_ai"},
    {"source": "ARK Invest", "site": "ark-invest.com", "query": "robotics physical AI autonomous technology", "topic": "physical_ai"},
    {"source": "WisdomTree", "site": "wisdomtree.com", "query": "physical AI robotics ETF", "topic": "etf"},
]


def _build_google_news_rss(site: str, query: str) -> str:
    """Google News RSS 검색 URL 생성."""
    window = os.getenv("GOOGLE_NEWS_RECENT_WINDOW", "2d").strip()
    q = f"site:{site} {query}"
    if window and "when:" not in q:
        q = f"{q} when:{window}"
    return (
        "https://news.google.com/rss/search?"
        f"q={quote_plus(q)}&hl=en-US&gl=US&ceid=US:en"
    )


def get_us_news(per_feed_limit: int = 3) -> List[Dict[str, str]]:
    """
    미국 반도체/ETF 매체의 최신 기사를 Google News RSS 우회로 수집.

    반환값은 지침서 3.3 표준 양식(dict 리스트).
    """
    all_news: List[Dict[str, str]] = []

    for feed_info in US_FEEDS:
        source_name = feed_info["source"]
        url = _build_google_news_rss(feed_info["site"], feed_info["query"])

        try:
            news = get_news_from_rss(source_name, url, limit=per_feed_limit)
            topic = feed_info.get("topic", "general")
            for item in news:
                item.setdefault("topic", topic)
                item.setdefault("category_group", "us")
            all_news.extend(news)
            logger.info("[%s] %d건 수집 완료", source_name, len(news))
            print(f"✅ {source_name}: {len(news)}건 수집 완료")
        except Exception as exc:  # noqa: BLE001
            logger.warning("[%s] 수집 실패: %s", source_name, exc)
            print(f"⚠️  {source_name} 수집 실패 (건너뜀): {exc}")
            continue

    return all_news


# ---------------------------------------------------------------------------
# 단독 실행 테스트 (`python -m briefing.collectors.us_news`)
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    print("=" * 60)
    print("미국 반도체/ETF 매체 RSS 우회 수집 테스트")
    print("=" * 60)

    news_list = get_us_news(per_feed_limit=2)
    print(f"\n총 수집 건수: {len(news_list)}")
    for i, item in enumerate(news_list[:6], 1):
        print(f"\n[{i}] ({item['source']}) {item['title']}")
        print(f"    🔗 {item['link'][:100]}...")
