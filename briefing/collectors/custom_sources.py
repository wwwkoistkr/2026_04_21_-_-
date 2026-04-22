"""
[확장 v2.3.0] KV 중심 뉴스 소스 수집기 — 검색어(queries) 반복 지원.

Morning Stock AI Briefing Center 의 관리 UI(Hono, Cloudflare Pages, KV)에
등록된 뉴스 소스 목록을 아래 규칙으로 수집합니다.

## v2.3.0 변경 (YouTube 수집 제거)
- YouTube 소스 타입 처리 제거: 3개월간 실제 수집 0건, API 키 관리 부담 대비 효용 낮음
- 기존 KV에 남은 youtube 타입 소스는 자동으로 스킵 (경고 없음)
- 필요 시 git 히스토리에서 복원 가능 (v2.2.9 마지막 YouTube 지원 버전)

## v2 스키마
각 소스는 다음 필드를 갖습니다:
    {
      id, label, category('kr'|'us'|'yt'|'custom'),
      type('rss'|'google_news'|'web'),    # v2.3.0: 'youtube' 제거
      url, site?, queries: [{keyword, limit}], defaultLimit,
      enabled, builtin?, createdAt
    }

## 수집 규칙
1) type=google_news 이고 queries.length > 0
   → 각 검색어마다 `site:{site} "{keyword}"` 로 Google News RSS 조회
   → keyword.limit 개씩 수집 → 한 소스에서 Σ limit 건
2) type=google_news 이고 queries.length == 0
   → `site:{site}` 로 최신 뉴스 defaultLimit 건 수집
3) type=rss
   → URL 을 직접 RSS 로 파싱, defaultLimit 건
4) type=web
   → 현 단계에서 스킵
5) type=youtube (v2.3.0 제거)
   → 조용히 스킵 (레거시 KV 데이터 호환)
"""
from __future__ import annotations

import logging
import os
from typing import Dict, List, Optional
from urllib.parse import quote_plus

import requests

from briefing.collectors.korean_news import get_news_from_rss

logger = logging.getLogger(__name__)


def _build_google_news_rss(site: str, query: str = "", kr: bool = False) -> str:
    """Google News RSS 검색 URL 생성.

    Parameters
    ----------
    site : str
        도메인 (예: 'hankyung.com')
    query : str
        추가 검색어. 비어있으면 `site:xxx` 만 사용 (최신순)
    kr : bool
        한국어 결과 우선 여부
    """
    q = f"site:{site} {query}".strip()
    lang = "hl=ko&gl=KR&ceid=KR:ko" if kr else "hl=en-US&gl=US&ceid=US:en"
    return f"https://news.google.com/rss/search?q={quote_plus(q)}&{lang}"


def _is_korean_site(site: str) -> bool:
    return bool(site) and (site.endswith(".kr") or site.endswith(".co.kr"))


# ───────────────────────────────────────────────────────────
# 1) KV 백엔드에서 소스 목록 받아오기
# ───────────────────────────────────────────────────────────
def fetch_custom_sources(
    admin_api: Optional[str] = None,
    read_token: Optional[str] = None,
    timeout: int = 15,
) -> List[Dict]:
    """관리 UI 의 GET /api/public/sources 를 호출 → 활성 소스 목록 반환."""
    admin_api = admin_api or os.getenv("BRIEFING_ADMIN_API")
    read_token = read_token or os.getenv("BRIEFING_READ_TOKEN")

    if not admin_api:
        logger.info("BRIEFING_ADMIN_API 미설정 — KV 소스 수집 건너뜀")
        return []

    url = admin_api.rstrip("/") + "/api/public/sources"
    headers = {"Accept": "application/json"}
    if read_token:
        headers["Authorization"] = f"Bearer {read_token}"

    logger.info("KV 소스 목록 요청: %s", url)
    resp = requests.get(url, headers=headers, timeout=timeout)
    resp.raise_for_status()
    data = resp.json()
    sources = data.get("sources", [])
    schema = data.get("schema", "v1")
    logger.info("KV 소스 %d건 수신 (schema=%s)", len(sources), schema)
    return sources


# ───────────────────────────────────────────────────────────
# 2) 소스 하나 처리 — v2 스키마 기준
# ───────────────────────────────────────────────────────────
def _collect_one_source(src: Dict) -> List[Dict[str, str]]:
    """v2 스키마의 소스 1건을 수집해 표준 양식 리스트로 반환."""
    label = src.get("label") or "(이름 없음)"
    stype = src.get("type", "rss")
    url = src.get("url", "")
    site = (src.get("site") or "").strip()
    queries = src.get("queries", []) or []
    default_limit = max(1, min(10, int(src.get("defaultLimit", 5))))
    category = src.get("category", "custom")
    kr = category == "kr" or _is_korean_site(site)

    if not src.get("enabled", True):
        return []

    results: List[Dict[str, str]] = []

    try:
        if stype == "google_news":
            if not site:
                print(f"⚠️  [KV] {label}: site 필드가 없어 google_news 수집 불가 → 스킵")
                return []

            if queries:
                # 키워드별 반복 수집
                for q in queries:
                    kw = str(q.get("keyword", "")).strip()
                    lm = max(1, min(10, int(q.get("limit", 3))))
                    if not kw:
                        continue
                    feed_url = _build_google_news_rss(site, kw, kr=kr)
                    display = f"{label} / {kw}"
                    try:
                        news = get_news_from_rss(display, feed_url, limit=lm)
                        results.extend(news)
                        print(f"  🔎 [{label}] '{kw}' → {len(news)}건")
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("[KV:%s] 검색어 '%s' 실패: %s", label, kw, exc)
                        print(f"  ⚠️  [{label}] '{kw}' 실패: {exc}")
            else:
                # 검색어 없음 → 사이트 최신 뉴스
                feed_url = _build_google_news_rss(site, "", kr=kr)
                news = get_news_from_rss(label, feed_url, limit=default_limit)
                results.extend(news)
                print(f"  📰 [{label}] 최신 → {len(news)}건")

        elif stype == "rss":
            if not url:
                return []
            news = get_news_from_rss(label, url, limit=default_limit)
            results.extend(news)
            print(f"  📰 [{label}] RSS → {len(news)}건")

        elif stype == "youtube":
            # v2.3.0: YouTube 수집 제거 - 레거시 KV 데이터 조용히 스킵
            logger.info("[KV:%s] youtube 타입 소스는 v2.3.0에서 제거됨 → 스킵", label)

        elif stype == "web":
            print(f"  ⏭️  [{label}] 'web' 타입은 현재 미지원 → 스킵")

        else:
            print(f"  ⚠️  [{label}] 알 수 없는 타입 '{stype}' → 스킵")

    except Exception as exc:  # noqa: BLE001
        logger.warning("[KV:%s] 수집 실패: %s", label, exc)
        print(f"  ❌ [{label}] 수집 실패: {exc}")

    return results


# ───────────────────────────────────────────────────────────
# 3) 전체 수집 진입점
# ───────────────────────────────────────────────────────────
def collect_custom_sources(
    per_source_limit: int = 3,  # 하위 호환을 위해 유지 (v2 에서는 소스별 queries/limit 사용)
    admin_api: Optional[str] = None,
    read_token: Optional[str] = None,
) -> List[Dict[str, str]]:
    """KV 에 등록된 모든 활성 소스를 수집해 표준 양식으로 반환.

    per_source_limit 파라미터는 v1 하위 호환용입니다.
    v2 에서는 각 소스의 queries/defaultLimit 을 우선 사용합니다.
    """
    try:
        registered = fetch_custom_sources(admin_api=admin_api, read_token=read_token)
    except Exception as exc:  # noqa: BLE001
        logger.warning("KV 소스 목록 조회 실패 (건너뜀): %s", exc)
        print(f"⚠️  KV 소스 목록 조회 실패: {exc}")
        return []

    if not registered:
        print("ℹ️  KV 에 등록된 활성 소스가 없습니다.")
        return []

    # 카테고리별 그룹 헤더 출력 (v2.3.0: 'yt' 카테고리도 남기되 안내만)
    from collections import defaultdict
    grouped = defaultdict(list)
    for s in registered:
        grouped[s.get("category", "custom")].append(s)

    cat_display = {"kr": "🇰🇷 한국", "us": "🌎 미국", "custom": "➕ 사용자"}
    all_news: List[Dict[str, str]] = []

    # v2.3.0: 'yt' 카테고리 제외 (YouTube 수집 제거)
    for cat in ("kr", "us", "custom"):
        group = grouped.get(cat, [])
        if not group:
            continue
        print(f"\n── {cat_display.get(cat, cat)} ({len(group)}개 소스) ──")
        for src in group:
            news = _collect_one_source(src)
            all_news.extend(news)

    return all_news


# ---------------------------------------------------------------------------
# 단독 실행 테스트
#   BRIEFING_ADMIN_API=http://localhost:3000 \
#   BRIEFING_READ_TOKEN=dev-briefing-token \
#   python -m briefing.collectors.custom_sources
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print("=" * 60)
    print("KV 소스 수집 테스트 (v2.3.0 스키마, YouTube 제거)")
    print("=" * 60)
    data = collect_custom_sources()
    print(f"\n총 수집 건수: {len(data)}")
    for i, item in enumerate(data[:8], 1):
        print(f"[{i}] {item['source']} | {item['title'][:50]}...")
