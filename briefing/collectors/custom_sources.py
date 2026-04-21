"""
[확장] 사용자 등록 커스텀 소스 수집기.

Morning Stock AI Briefing Center 의 관리 UI(Hono, Cloudflare Pages)에서 사용자가
추가한 뉴스지/애널리스트 RSS/YouTube 채널을 매일 아침 자동으로 읽어와 수집합니다.

흐름:
    1. 환경변수 BRIEFING_ADMIN_API 로 주어진 Hono 웹앱 주소(GET /api/public/sources)를 호출
       - 선택적 BRIEFING_READ_TOKEN 으로 Bearer 인증
    2. 응답을 `source/type/url` 기반으로 분기하여 수집
       - rss / google_news → 기본 RSS 파서
       - youtube          → 채널 RSS 변환 후 파서(UA 교체)
       - web              → 일단은 생략 (향후 Readability 기반 본문 추출 예정)
    3. 지침서 §3.3 표준 양식(dict: source/title/link/summary)으로 통일
"""
from __future__ import annotations

import logging
import os
import re
from typing import Dict, List, Optional

import requests

from briefing.collectors.korean_news import get_news_from_rss

logger = logging.getLogger(__name__)

# YouTube 채널 URL → 채널 ID 추출
_YT_CHANNEL_RE = re.compile(r"youtube\.com/channel/([A-Za-z0-9_-]+)", re.I)
# 이미 RSS 형식인 경우
_YT_RSS_RE = re.compile(r"youtube\.com/feeds/videos\.xml\?channel_id=([A-Za-z0-9_-]+)", re.I)


def _youtube_url_to_rss(url: str) -> Optional[str]:
    """YouTube 채널/사용자 URL 을 RSS feed URL 로 정규화."""
    if _YT_RSS_RE.search(url):
        return url
    m = _YT_CHANNEL_RE.search(url)
    if m:
        return f"https://www.youtube.com/feeds/videos.xml?channel_id={m.group(1)}"
    # @handle 형식은 HTML 페이지에서 channelId 를 파싱해야 해서 일단 미지원
    return None


def fetch_custom_sources(
    admin_api: Optional[str] = None,
    read_token: Optional[str] = None,
    timeout: int = 15,
) -> List[Dict[str, str]]:
    """
    관리 UI 의 GET /api/public/sources 를 호출해 등록된 소스 목록을 반환.

    환경변수:
        BRIEFING_ADMIN_API   : Hono 앱의 루트 URL (예: https://morning-stock.pages.dev)
        BRIEFING_READ_TOKEN  : Hono 앱의 BRIEFING_READ_TOKEN 비밀값

    반환: list of
        { id, label, type('rss'|'google_news'|'youtube'|'web'), url, enabled, createdAt }
    """
    admin_api = admin_api or os.getenv("BRIEFING_ADMIN_API")
    read_token = read_token or os.getenv("BRIEFING_READ_TOKEN")

    if not admin_api:
        logger.info("BRIEFING_ADMIN_API 미설정 — 커스텀 소스 단계 건너뜀")
        return []

    url = admin_api.rstrip("/") + "/api/public/sources"
    headers = {"Accept": "application/json"}
    if read_token:
        headers["Authorization"] = f"Bearer {read_token}"

    logger.info("커스텀 소스 목록 요청: %s", url)
    resp = requests.get(url, headers=headers, timeout=timeout)
    resp.raise_for_status()
    data = resp.json()
    sources = data.get("sources", [])
    logger.info("커스텀 소스 %d건 수신", len(sources))
    return sources


def collect_custom_sources(
    per_source_limit: int = 3,
    admin_api: Optional[str] = None,
    read_token: Optional[str] = None,
) -> List[Dict[str, str]]:
    """
    관리 UI 에 등록된 모든 사용자 정의 소스를 수집해 표준 양식으로 반환.

    타입별 분기:
        - rss / google_news : korean_news.get_news_from_rss 재사용
        - youtube           : 채널 URL → RSS 로 변환 후 feedparser UA 로 수집
        - web               : (TODO) 현 단계에서는 스킵
    """
    try:
        registered = fetch_custom_sources(admin_api=admin_api, read_token=read_token)
    except Exception as exc:  # noqa: BLE001
        logger.warning("커스텀 소스 목록 조회 실패 (건너뜀): %s", exc)
        print(f"⚠️  커스텀 소스 목록 조회 실패: {exc}")
        return []

    if not registered:
        print("ℹ️  관리 UI 에 등록된 커스텀 소스가 없습니다.")
        return []

    all_news: List[Dict[str, str]] = []

    for src in registered:
        label = src.get("label") or "(이름 없음)"
        stype = src.get("type", "rss")
        url = src.get("url", "")

        if not url:
            continue

        try:
            if stype in ("rss", "google_news"):
                news = get_news_from_rss(label, url, limit=per_source_limit)
                all_news.extend(news)
                print(f"✅ [사용자] {label} ({stype}): {len(news)}건")

            elif stype == "youtube":
                rss_url = _youtube_url_to_rss(url)
                if not rss_url:
                    print(f"⚠️  [사용자] {label}: YouTube URL 을 RSS 로 변환 실패 → 스킵")
                    continue
                # feedparser UA 로 YouTube RSS 수집 (brosser UA 는 404 반환)
                news = _fetch_youtube_rss(label, rss_url, limit=per_source_limit)
                all_news.extend(news)
                print(f"✅ [사용자] {label} (YouTube): {len(news)}건")

            elif stype == "web":
                print(f"⏭️  [사용자] {label}: 'web' 타입은 현재 단계에서 미지원 (스킵)")
                continue

            else:
                print(f"⚠️  [사용자] {label}: 알 수 없는 타입 '{stype}' → 스킵")

        except Exception as exc:  # noqa: BLE001 — 지침서 §3.2: 한 곳이 죽어도 계속
            logger.warning("[사용자:%s] 수집 실패: %s", label, exc)
            print(f"⚠️  [사용자] {label} 수집 실패 (건너뜀): {exc}")
            continue

    return all_news


def _fetch_youtube_rss(label: str, rss_url: str, limit: int = 3) -> List[Dict[str, str]]:
    """YouTube RSS 전용 수집 (feedparser UA 필요)."""
    import feedparser

    headers = {
        "User-Agent": "feedparser/6.0 +https://github.com/kurtmckee/feedparser",
        "Accept": "application/atom+xml, application/rss+xml, application/xml;q=0.9",
    }
    resp = requests.get(rss_url, headers=headers, timeout=15)
    resp.raise_for_status()
    feed = feedparser.parse(resp.content)

    out: List[Dict[str, str]] = []
    for entry in feed.entries[:limit]:
        title = getattr(entry, "title", "").strip()
        link = getattr(entry, "link", "").strip()
        summary = (
            getattr(entry, "summary", None)
            or getattr(entry, "description", None)
            or ""
        )
        # HTML 태그 제거
        summary = re.sub(r"<[^>]+>", "", summary).strip()[:300]
        out.append(
            {
                "source": f"{label} (YouTube)",
                "title": title,
                "link": link,
                "summary": summary,
            }
        )
    return out


# ---------------------------------------------------------------------------
# 단독 실행 테스트
#   BRIEFING_ADMIN_API=http://localhost:3000 \
#   BRIEFING_READ_TOKEN=dev-briefing-token \
#   python -m briefing.collectors.custom_sources
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print("=" * 60)
    print("커스텀 소스 수집 테스트")
    print("=" * 60)
    data = collect_custom_sources()
    print(f"\n총 수집 건수: {len(data)}")
    for i, item in enumerate(data[:5], 1):
        print(f"\n[{i}] ({item['source']}) {item['title']}")
        print(f"    🔗 {item['link']}")
