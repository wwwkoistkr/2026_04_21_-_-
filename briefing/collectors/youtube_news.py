"""
[2단계] 유튜브 수집기 — 디일렉(the elec) 채널 최신 영상.

- 우선 순위 1 : YouTube Data API v3 (환경변수 ``YOUTUBE_API_KEY``)
- 우선 순위 2 : API 키 미존재/실패 시, 유튜브 채널 RSS 피드로 Fallback
  (``https://www.youtube.com/feeds/videos.xml?channel_id=...``)

반환값은 지침서 3.3 표준 양식(dict 리스트)을 엄수합니다.
"""
from __future__ import annotations

import html
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

import feedparser
import requests

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 설정
# ---------------------------------------------------------------------------
# 디일렉(THELEC) 공식 유튜브 채널 ID
# (채널 URL 에서 확인: https://www.youtube.com/@thelec → channel_id)
#
# v2.2.8 버그 수정 2건:
#   ❌ 이전 버그 1: os.getenv("THELEC_YOUTUBE_CHANNEL_ID", "UC2...") — 환경변수가
#      "" (빈 문자열)일 때 기본값 fallback 실패 → 404.
#   ✅ 현재: 런타임에 읽고 빈 값/공백은 기본값으로 fallback.
#
#   ❌ 이전 버그 2: 기본값이 `UC2GRwEADsEKEX5k-Xg9YphA` 였으나 이는 존재하지 않는
#      채널이라 RSS 404 반환.
#   ✅ 현재: @thelec 페이지의 HTML 에서 확인한 실제 채널 ID 로 교체
#      (https://www.youtube.com/@thelec → browseId=UCW45xiXsUy3MJSiZ0zal0aw).
_HARDCODED_THELEC_CHANNEL_ID = "UCW45xiXsUy3MJSiZ0zal0aw"  # @thelec (THELEC)


def _resolve_channel_id(explicit: Optional[str] = None) -> str:
    """
    채널 ID 우선순위:
      1) explicit 인자 (유효한 경우)
      2) 환경변수 THELEC_YOUTUBE_CHANNEL_ID (공백·빈 값이 아닌 경우)
      3) 하드코딩된 디일렉 공식 채널 ID
    """
    if explicit and explicit.strip():
        return explicit.strip()
    env_val = (os.getenv("THELEC_YOUTUBE_CHANNEL_ID") or "").strip()
    if env_val:
        return env_val
    return _HARDCODED_THELEC_CHANNEL_ID


# 하위 호환: 이전에 모듈 속성으로 참조되던 이름 유지 (import 시점 1회 평가)
DEFAULT_THELEC_CHANNEL_ID = _resolve_channel_id()

# YouTube RSS 전용 헤더
# ── YouTube 는 브라우저 UA 로 RSS 피드를 요청하면 404 를 돌려주는 특성이 있습니다.
#    Feed 리더 계열 UA(또는 기본 curl) 를 쓰면 정상 응답하므로, RSS 용도에
#    적합한 헤더를 지정합니다.
DEFAULT_HEADERS = {
    "User-Agent": "feedparser/6.0 +https://github.com/kurtmckee/feedparser",
    "Accept": "application/atom+xml, application/rss+xml, application/xml;q=0.9",
}

_TAG_RE = re.compile(r"<[^>]+>")


def _clean(text: Optional[str], max_len: int = 300) -> str:
    if not text:
        return ""
    t = html.unescape(text)
    t = _TAG_RE.sub("", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t[:max_len]


# ---------------------------------------------------------------------------
# 1) YouTube Data API v3 경로
# ---------------------------------------------------------------------------
def _fetch_via_api(
    channel_id: str, api_key: str, since_hours: int = 36, max_results: int = 5
) -> List[Dict[str, str]]:
    """
    ``google-api-python-client`` 를 이용해 최근 영상을 수집.
    - since_hours: 몇 시간 이내 업로드 영상을 가져올지 (브리핑 특성상 36h)
    - max_results: 최대 반환 개수
    """
    from googleapiclient.discovery import build  # 지연 import (의존성 선택적)

    youtube = build("youtube", "v3", developerKey=api_key, cache_discovery=False)

    published_after = (
        datetime.now(timezone.utc) - timedelta(hours=since_hours)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")

    request = youtube.search().list(
        channelId=channel_id,
        part="snippet",
        order="date",
        type="video",
        publishedAfter=published_after,
        maxResults=max_results,
    )
    response = request.execute()

    videos: List[Dict[str, str]] = []
    for item in response.get("items", []):
        video_id = item["id"].get("videoId")
        if not video_id:
            continue
        snippet = item.get("snippet", {})
        videos.append(
            {
                "source": "디일렉(유튜브)",
                "title": _clean(snippet.get("title", "")),
                "link": f"https://www.youtube.com/watch?v={video_id}",
                "summary": _clean(snippet.get("description", "")),
            }
        )
    return videos


# ---------------------------------------------------------------------------
# 2) 채널 RSS Fallback
# ---------------------------------------------------------------------------
def _fetch_via_rss(
    channel_id: str, max_results: int = 5
) -> List[Dict[str, str]]:
    """
    유튜브 채널 RSS 피드로 최신 영상 수집 (API 키 불필요).
    """
    url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
    response = requests.get(url, headers=DEFAULT_HEADERS, timeout=15)
    response.raise_for_status()
    feed = feedparser.parse(response.content)

    if feed.bozo and not feed.entries:
        raise RuntimeError(f"YouTube RSS 파싱 실패: {feed.bozo_exception}")

    videos: List[Dict[str, str]] = []
    for entry in feed.entries[:max_results]:
        videos.append(
            {
                "source": "디일렉(유튜브)",
                "title": _clean(getattr(entry, "title", "")),
                "link": getattr(entry, "link", ""),
                "summary": _clean(
                    getattr(entry, "summary", None)
                    or getattr(entry, "description", None)
                    or ""
                ),
            }
        )
    return videos


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def get_youtube_news(
    channel_id: Optional[str] = None,
    since_hours: int = 36,
    max_results: int = 5,
) -> List[Dict[str, str]]:
    """
    디일렉 채널 최신 유튜브 영상 수집.

    Parameters
    ----------
    channel_id : str, optional
        유튜브 채널 ID. 미지정 시 ``THELEC_YOUTUBE_CHANNEL_ID`` env 또는
        모듈 기본값 사용.
    since_hours : int
        이 시간(시간 단위) 이내 업로드된 영상만 가져올지 (API 경로에만 적용).
    max_results : int
        최대 수집 영상 수.
    """
    # v2.2.8: 런타임 해석 — 환경변수가 빈 문자열이어도 안전하게 fallback
    channel_id = _resolve_channel_id(channel_id)
    api_key = (os.getenv("YOUTUBE_API_KEY") or "").strip() or None
    logger.info("디일렉 YouTube 수집 채널 ID: %s (API=%s)", channel_id, "ON" if api_key else "OFF")

    # 1차 시도: YouTube Data API v3
    if api_key:
        try:
            videos = _fetch_via_api(
                channel_id=channel_id,
                api_key=api_key,
                since_hours=since_hours,
                max_results=max_results,
            )
            print(f"✅ 디일렉 유튜브 (API): {len(videos)}건 수집 완료")
            return videos
        except Exception as exc:  # noqa: BLE001
            logger.warning("YouTube API 수집 실패 → RSS fallback: %s", exc)
            print(f"⚠️  YouTube API 실패 ({exc}), RSS fallback 시도...")
    else:
        print("ℹ️  YOUTUBE_API_KEY 미설정 → 채널 RSS 로 진행")

    # 2차 시도: 채널 RSS
    try:
        videos = _fetch_via_rss(channel_id=channel_id, max_results=max_results)
        print(f"✅ 디일렉 유튜브 (RSS): {len(videos)}건 수집 완료")
        return videos
    except Exception as exc:  # noqa: BLE001
        logger.warning("YouTube RSS 도 실패: %s", exc)
        print(f"❌ 디일렉 유튜브 수집 실패 (건너뜀): {exc}")
        return []


# ---------------------------------------------------------------------------
# 단독 실행 테스트 (`python -m briefing.collectors.youtube_news`)
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    print("=" * 60)
    print("디일렉 유튜브 수집 테스트")
    print("=" * 60)

    videos = get_youtube_news(max_results=5)
    print(f"\n총 수집 건수: {len(videos)}")
    for i, v in enumerate(videos, 1):
        print(f"\n[{i}] {v['title']}")
        print(f"    🔗 {v['link']}")
        if v["summary"]:
            print(f"    📝 {v['summary'][:120]}...")
