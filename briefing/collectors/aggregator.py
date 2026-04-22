"""
[2단계 v2.3.0] 수집기 통합 함수 (collect_all_data) — KV 중심 우선.

## 동작 흐름
1) 먼저 Cloudflare KV (관리 UI) 에서 활성 소스 목록을 가져와 수집
   → 이게 기본 경로입니다. 한국/미국/사용자 소스가 모두 KV 에 저장돼 있기 때문.
2) KV 수집 결과가 0건이면 (BRIEFING_ADMIN_API 미설정/네트워크 실패 등)
   기존 하드코딩 수집기로 폴백 (한국 3사, 미국 매체)
3) 두 경로 모두 실패해도 각 try/except 가 독립적이라 서비스 중단 없음.

### v2.3.0 변경
- YouTube 수집 제거: 3개월간 0건 실적, API 키 관리 부담 대비 가치 낮음
- 텍스트 뉴스(58건/일)로 충분히 브리핑 품질 유지
- 필요 시 커스텀 소스로 나중에 재추가 가능 (코드는 git 히스토리에 보존)

지침서 3.2 예외 처리 원칙 유지.
"""
from __future__ import annotations

import logging
from typing import Dict, List

from briefing.collectors.custom_sources import collect_custom_sources
from briefing.collectors.korean_news import collect_korean_news
from briefing.collectors.us_news import get_us_news

logger = logging.getLogger(__name__)


def collect_all_data(
    korean_limit: int = 5,
    us_limit: int = 3,
    custom_limit: int = 3,
    **_legacy_kwargs,  # v2.2.x 하위 호환 (youtube_limit 등 무시)
) -> List[Dict[str, str]]:
    """
    활성화된 모든 소스에서 수집 후 단일 리스트로 반환.

    **우선 전략 (v2.3.0)**
    - 1순위: Cloudflare KV (관리 UI v2 스키마, queries 포함)
    - 2순위: KV 에서 0건 반환시 하드코딩 폴백 (한국/미국)

    반환 스키마는 항상 지침서 §3.3 표준 양식:
      {source, title, link, summary}
    """
    all_news: List[Dict[str, str]] = []

    # ── 1) KV 중심 수집 (v2) ────────────────────────────────
    print("\n╔══════════════════════════════════════════════════════╗")
    print("║  📡 KV 소스 수집 (관리 UI v2 스키마)                  ║")
    print("╚══════════════════════════════════════════════════════╝")
    kv_news: List[Dict[str, str]] = []
    try:
        kv_news = collect_custom_sources(per_source_limit=custom_limit)
        print(f"\n🧩 KV 기반 수집 누적: {len(kv_news)}건")
    except Exception as exc:  # noqa: BLE001
        logger.warning("KV 수집 전체 실패: %s", exc)
        print(f"❌ KV 수집 전체 실패 (폴백 모드 진입): {exc}")

    all_news.extend(kv_news)

    # ── 2) KV 실패/비어있음 → 하드코딩 폴백 ─────────────────
    if len(kv_news) == 0:
        print("\n╔══════════════════════════════════════════════════════╗")
        print("║  ⚠️  KV 수집 실패/0건 → 하드코딩 폴백 수집            ║")
        print("╚══════════════════════════════════════════════════════╝")

        # 2-1) 한국 경제 3사 (증권/IT)
        try:
            k = collect_korean_news(per_feed_limit=korean_limit)
            all_news.extend(k)
            print(f"📰 (폴백) 한국 뉴스: {len(k)}건")
        except Exception as exc:  # noqa: BLE001
            logger.warning("폴백 한국 뉴스 실패: %s", exc)
            print(f"❌ (폴백) 한국 뉴스 실패: {exc}")

        # 2-2) 미국 반도체/ETF 매체
        try:
            u = get_us_news(per_feed_limit=us_limit)
            all_news.extend(u)
            print(f"🌎 (폴백) 미국 뉴스: {len(u)}건")
        except Exception as exc:  # noqa: BLE001
            logger.warning("폴백 미국 뉴스 실패: %s", exc)
            print(f"❌ (폴백) 미국 뉴스 실패: {exc}")

    # ── 3) 중복 제거 (동일 링크 기준) ─────────────────────
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
    print("통합 수집 테스트 (v2, KV 우선)")
    print("=" * 60)

    data = collect_all_data()

    print("\n" + "=" * 60)
    print("소스별 건수")
    print("=" * 60)
    from collections import Counter

    for src, cnt in Counter(d["source"] for d in data).most_common():
        print(f"  - {src}: {cnt}건")
