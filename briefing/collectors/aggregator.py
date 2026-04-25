"""
[2단계 v2.6.1] 수집기 통합 함수 (collect_all_data) — KV + 미국 뉴스 하이브리드.

## 동작 흐름
1) Cloudflare KV (관리 UI) 에서 활성 소스 목록을 가져와 수집
   → 보통 한국 증권/IT 3사 및 사용자 커스텀 소스가 여기서 수집됨.
2) Google News RSS 우회로 **미국 반도체/ETF 매체는 항상 추가 수집** (v2.6.1)
   → Seeking Alpha, ETF.com, Morningstar, Reuters, Bloomberg 등 6개 피드
   → KV 수집 성공 여부와 무관하게 실행 (미국 뉴스 누락 방지)
3) KV 수집이 0건이면 (BRIEFING_ADMIN_API 미설정/네트워크 실패 등)
   한국 경제 3사 하드코딩 폴백 가동.
4) 모든 경로는 독립적인 try/except 로 보호 (부분 실패 허용).

### v2.6.1 변경 (2026-04-23)
- 🌎 미국 뉴스 항상 수집: KV 에 미국 소스가 없어도 자동 보강
- us_news.py 의 Google News RSS 우회 로직 항상 실행
- 결과: 브리핑 리포트에 미국 매체 관점이 안정적으로 포함됨

### v2.3.0 (이력)
- YouTube 수집 제거: 3개월간 0건 실적
- 텍스트 뉴스(58건/일)로 충분히 브리핑 품질 유지

지침서 3.2 예외 처리 원칙 유지.
"""
from __future__ import annotations

import logging
import os
from typing import Dict, List

from briefing.collectors.custom_sources import collect_custom_sources
from briefing.collectors.korean_news import collect_korean_news
from briefing.collectors.run_reporter import RunReporter
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

    # v2.4.0: 수집 진행 상황 리포터 (KV 로 결과 전송)
    dry_run_flag = os.getenv("DRY_RUN", "").lower() == "true"
    reporter = RunReporter(dry_run=dry_run_flag)
    run_error: str = ""

    # ── 1) KV 중심 수집 (v2) ────────────────────────────────
    print("\n╔══════════════════════════════════════════════════════╗")
    print("║  📡 KV 소스 수집 (관리 UI v2 스키마)                  ║")
    print("╚══════════════════════════════════════════════════════╝")
    kv_news: List[Dict[str, str]] = []
    try:
        kv_news = collect_custom_sources(per_source_limit=custom_limit, reporter=reporter)
        print(f"\n🧩 KV 기반 수집 누적: {len(kv_news)}건")
    except Exception as exc:  # noqa: BLE001
        logger.warning("KV 수집 전체 실패: %s", exc)
        print(f"❌ KV 수집 전체 실패 (폴백 모드 진입): {exc}")
        run_error = f"KV 수집 실패: {exc}"

    all_news.extend(kv_news)

    # ── 2) 미국 뉴스 항상 수집 (v2.6.1) ──────────────────────
    # v2.3.0 까지는 KV 수집이 0건일 때만 폴백으로 수집했으나,
    # KV 에 한국 소스만 등록된 경우 미국 뉴스가 누락되는 문제가 있어
    # v2.6.1 부터는 Google News RSS 우회로 미국 매체를 **항상** 추가 수집.
    print("\n╔══════════════════════════════════════════════════════╗")
    print("║  🌎 미국 반도체/ETF 매체 항상 수집 (v2.6.1)          ║")
    print("╚══════════════════════════════════════════════════════╝")
    try:
        u = get_us_news(per_feed_limit=us_limit)
        all_news.extend(u)
        print(f"🌎 미국 뉴스: {len(u)}건")
    except Exception as exc:  # noqa: BLE001
        logger.warning("미국 뉴스 수집 실패: %s", exc)
        print(f"❌ 미국 뉴스 수집 실패 (건너뜀): {exc}")

    # ── 3) KV 실패/비어있음 → 한국 뉴스 폴백 ─────────────────
    if len(kv_news) == 0:
        print("\n╔══════════════════════════════════════════════════════╗")
        print("║  ⚠️  KV 수집 실패/0건 → 한국 뉴스 폴백 수집           ║")
        print("╚══════════════════════════════════════════════════════╝")

        # 한국 경제 3사 (증권/IT)
        try:
            k = collect_korean_news(per_feed_limit=korean_limit)
            all_news.extend(k)
            print(f"📰 (폴백) 한국 뉴스: {len(k)}건")
        except Exception as exc:  # noqa: BLE001
            logger.warning("폴백 한국 뉴스 실패: %s", exc)
            print(f"❌ (폴백) 한국 뉴스 실패: {exc}")

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

    # ── 4) 저정보 기사 필터 (v2.9.4: 800 → 200 완화) ──────
    # 사용자 결정(2026-04-25): 미국 RSS 가 보통 짧은 점을 고려해 200자로 완화.
    # 200자 미만은 사실상 광고/이미지 캡션/"Read more →" 같은 빈 깡통이므로
    # "안전 마지노선"으로만 유지. 환경변수 MIN_ARTICLE_CHARS 로 조정/비활성화 가능.
    min_chars = int(os.getenv("MIN_ARTICLE_CHARS", "200"))
    if min_chars > 0:
        filtered: List[Dict[str, str]] = []
        dropped = 0
        for item in deduped:
            summary = (item.get("summary") or "").strip()
            if len(summary) < min_chars:
                dropped += 1
                logger.info(
                    "저정보 기사 제외 (%d자 < %d자): %s",
                    len(summary), min_chars, (item.get("title") or "")[:60]
                )
                continue
            filtered.append(item)
        print(f"🧹 저정보 필터(<{min_chars}자) 적용: {dropped}건 제외 → 최종 {len(filtered)}건 (v2.9.4)")
        deduped = filtered

    # v2.4.0: 리포터에 최종 결과 전송 (이력 기록)
    try:
        reporter.finish_run(
            final_count_after_dedup=len(deduped),
            error=run_error or None,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("리포터 최종 보고 실패 (무시): %s", exc)

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
