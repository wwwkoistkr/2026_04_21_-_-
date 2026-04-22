"""
[1단계] 한국 경제 신문 3사 RSS 피드 수집기.

설계 지침서 3.3에 명시된 데이터 표준화 양식을 준수합니다.
  - source (출처, str)
  - title  (제목,  str)
  - link   (링크,  str)
  - summary(요약,  str)

에러 방어(3.2): 각 피드 수집을 try-except 로 감싸 한 곳이 죽어도
다른 피드 수집을 계속 진행합니다.
"""
from __future__ import annotations

import html
import logging
import re
from typing import Dict, List, Optional

import feedparser
import requests

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 설정: 한국 경제 3사 RSS 피드 (증권 / IT-과학 섹션 위주)
# ---------------------------------------------------------------------------
# NOTE 1) 언론사별 공식 RSS 가 Cloudflare 등으로 차단되는 경우가 있어,
#         우선 공식 RSS 를 시도 → 실패 시 Google News RSS 우회(지침서 3.1 전략2)
#         를 자동 Fallback 으로 사용하도록 설계했습니다.
# NOTE 2) Google News RSS 는 '어떤 사이트의 어떤 키워드' 도 site: 필터로
#         꺼내올 수 있기 때문에 매우 안정적입니다.
KOREAN_RSS_FEEDS: List[Dict[str, str]] = [
    # ── 한국경제 ──
    {
        "source": "한국경제(증권)",
        "url": "https://rss.hankyung.com/feed/finance.xml",
        "fallback": (
            "https://news.google.com/rss/search?"
            "q=site:hankyung.com+%EC%A6%9D%EA%B6%8C&hl=ko&gl=KR&ceid=KR:ko"
        ),
    },
    {
        "source": "한국경제(IT)",
        "url": "https://rss.hankyung.com/feed/it.xml",
        "fallback": (
            "https://news.google.com/rss/search?"
            "q=site:hankyung.com+IT&hl=ko&gl=KR&ceid=KR:ko"
        ),
    },
    # ── 매일경제 ──
    {
        "source": "매일경제(증권)",
        "url": "https://www.mk.co.kr/rss/50200011/",
        "fallback": (
            "https://news.google.com/rss/search?"
            "q=site:mk.co.kr+%EC%A6%9D%EA%B6%8C&hl=ko&gl=KR&ceid=KR:ko"
        ),
    },
    {
        "source": "매일경제(IT)",
        "url": "https://www.mk.co.kr/rss/50300009/",
        "fallback": (
            "https://news.google.com/rss/search?"
            "q=site:mk.co.kr+IT&hl=ko&gl=KR&ceid=KR:ko"
        ),
    },
    # ── 머니투데이 ──
    # 공식 RSS 가 2024년 경 리디렉션 제거되어 404 리턴 → Google News 우회 사용
    {
        "source": "머니투데이(증권)",
        "url": (
            "https://news.google.com/rss/search?"
            "q=site:mt.co.kr+%EC%A6%9D%EA%B6%8C&hl=ko&gl=KR&ceid=KR:ko"
        ),
        "fallback": None,
    },
    {
        "source": "머니투데이(IT)",
        "url": (
            "https://news.google.com/rss/search?"
            "q=site:mt.co.kr+IT&hl=ko&gl=KR&ceid=KR:ko"
        ),
        "fallback": None,
    },
]

# 브라우저 위장 헤더 (지침서 3.1 전략 1) – 일부 RSS 서버가 봇을 차단할 때 사용
DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
}

# HTML 태그 제거용 정규식 (summary 안에 섞인 <p>, <img> 등 제거)
_TAG_RE = re.compile(r"<[^>]+>")

# Cloudflare WAF / 봇 차단 페이지 감지용 시그니처
# - 한국경제(https://rss.hankyung.com) 등은 Cloudflare 에 보호되어 있어
#   봇으로 판단되면 HTML 4.5KB 분량의 "Attention Required" 페이지를 돌려줍니다.
# - 이 경우 Content-Type 이 text/html 이거나 본문에 아래 키워드가 포함됩니다.
_WAF_SIGNATURES = (
    b"cf-error",
    b"Attention Required",
    b"DDoS protection by Cloudflare",
    b"Cloudflare Ray ID",
    b"ray id",
    b"Access denied",
    b"Just a moment...",
)


def _clean_summary(raw: str, max_len: int = 300) -> str:
    """RSS 의 description / summary 에서 HTML 태그·공백을 정리하고 길이 제한."""
    if not raw:
        return ""
    text = html.unescape(raw)
    text = _TAG_RE.sub("", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:max_len]


def _looks_like_rss(content: bytes, content_type: str) -> bool:
    """
    응답이 RSS/Atom XML 처럼 보이는지 휴리스틱으로 판단.
    Cloudflare WAF 가 403 대신 200 + HTML 페이지를 돌려주는 경우를 잡기 위함.
    """
    if not content:
        return False
    ct = (content_type or "").lower()
    if "xml" in ct or "rss" in ct or "atom" in ct:
        return True
    # Content-Type 이 누락되어도 본문 앞쪽이 <?xml / <rss / <feed 로 시작하면 OK
    head = content[:512].lstrip().lower()
    return (
        head.startswith(b"<?xml")
        or head.startswith(b"<rss")
        or head.startswith(b"<feed")
    )


def _detect_waf_block(content: bytes) -> str:
    """
    Cloudflare 등 WAF 차단 페이지인지 감지. 차단 시 사유 문자열 반환, 아니면 빈 문자열.
    """
    sample = content[:4096] if content else b""
    for sig in _WAF_SIGNATURES:
        if sig in sample:
            # 어떤 시그니처에 걸렸는지도 함께 반환
            return f"WAF block detected ({sig.decode('latin-1', errors='ignore')})"
    return ""


def get_news_from_rss(
    source_name: str,
    url: str,
    limit: int = 5,
    timeout: int = 15,
    retries: int = 2,
) -> List[Dict[str, str]]:
    """
    주어진 RSS URL 에서 뉴스를 가져와 표준 dict 리스트로 반환.

    v2.2.8 강화 내역
    ----------------
    - 타임아웃 10 → 15 초 (한국 서버가 가끔 느림)
    - ``retries`` 인자 추가: 5xx / 네트워크 오류 시 1 회 재시도
    - HTTP 상태 코드별 명확한 예외 메시지
    - Cloudflare 등 WAF 차단 페이지 (200 + HTML) 자동 감지
    - feedparser bozo 분기 개선: XML 이지만 entries=0 인 경우도 실패 처리
    """
    articles: List[Dict[str, str]] = []
    last_exc: Optional[Exception] = None

    for attempt in range(retries + 1):
        try:
            response = requests.get(url, headers=DEFAULT_HEADERS, timeout=timeout)

            # 1) HTTP 상태 검증 — 재시도 대상과 즉시 실패 대상 분리
            if response.status_code == 403:
                raise RuntimeError(
                    f"HTTP 403 (WAF/봇 차단) — {source_name} 공식 RSS 접근 거부"
                )
            if response.status_code == 404:
                raise RuntimeError(
                    f"HTTP 404 (피드 없음) — {source_name} URL 확인 필요"
                )
            if 500 <= response.status_code < 600:
                # 5xx 는 재시도 가치가 있음
                raise ConnectionError(
                    f"HTTP {response.status_code} (서버 오류) — {source_name}"
                )
            response.raise_for_status()

            # 2) Content-Type / 본문 시그니처로 WAF 차단 감지
            waf_reason = _detect_waf_block(response.content)
            if waf_reason:
                raise RuntimeError(f"{waf_reason} — {source_name}")
            if not _looks_like_rss(
                response.content, response.headers.get("Content-Type", "")
            ):
                raise RuntimeError(
                    f"비(非) XML 응답 ({len(response.content)} bytes, "
                    f"Content-Type={response.headers.get('Content-Type', 'N/A')}) "
                    f"— {source_name}"
                )

            # 3) 파싱
            feed = feedparser.parse(response.content)
            if not feed.entries:
                # bozo=1 이거나 빈 피드. RSS 로 보여도 내용이 없으면 fallback.
                reason = (
                    str(feed.bozo_exception) if feed.bozo else "entries=0"
                )
                raise RuntimeError(
                    f"RSS 파싱됐으나 기사 없음 ({reason}) — {source_name}"
                )

            for entry in feed.entries[:limit]:
                title = getattr(entry, "title", "").strip()
                link = getattr(entry, "link", "").strip()
                summary_raw = (
                    getattr(entry, "summary", None)
                    or getattr(entry, "description", None)
                    or ""
                )
                articles.append(
                    {
                        "source": source_name,
                        "title": title,
                        "link": link,
                        "summary": _clean_summary(summary_raw),
                    }
                )
            return articles

        except (requests.Timeout, ConnectionError, requests.ConnectionError) as exc:
            # 재시도 가치가 있는 일시 오류
            last_exc = exc
            if attempt < retries:
                logger.info(
                    "[%s] 일시 오류(%s), 재시도 %d/%d",
                    source_name, exc, attempt + 1, retries,
                )
                continue
            raise RuntimeError(
                f"네트워크 오류 재시도 실패 — {source_name}: {exc}"
            ) from exc
        except Exception:
            # 그 외(403/WAF/파싱 실패 등)는 즉시 실패 → 상위에서 fallback 사용
            raise

    # 정상 경로에서는 도달하지 않지만 안전 장치
    if last_exc:
        raise RuntimeError(f"알 수 없는 오류 — {source_name}: {last_exc}")
    return articles


def collect_korean_news(per_feed_limit: int = 5) -> List[Dict[str, str]]:
    """
    한국 경제 신문 3사(증권·IT 섹션)의 뉴스를 한꺼번에 수집.

    지침서 3.2 의 예외 처리 원칙에 따라, 한 피드가 실패해도
    다른 피드 수집은 계속 진행합니다.
    """
    all_news: List[Dict[str, str]] = []

    for feed_info in KOREAN_RSS_FEEDS:
        source_name = feed_info["source"]
        url = feed_info["url"]
        fallback = feed_info.get("fallback")

        # 1차 시도: 공식 RSS
        try:
            news = get_news_from_rss(source_name, url, limit=per_feed_limit)
            all_news.extend(news)
            logger.info("[%s] %d건 수집 완료", source_name, len(news))
            print(f"✅ {source_name}: {len(news)}건 수집 완료")
            continue
        except Exception as exc:  # noqa: BLE001 - 의도적 광범위 포착
            logger.warning(
                "[%s] 공식 RSS 수집 실패 → fallback 시도: %s", source_name, exc
            )
            print(f"⚠️  {source_name} 공식 RSS 실패 ({exc}), 우회 시도...")

        # 2차 시도: Google News RSS 우회 (지침서 3.1 전략 2)
        if not fallback:
            print(f"   ↳ {source_name} fallback 없음 → 건너뜀")
            continue
        try:
            news = get_news_from_rss(source_name, fallback, limit=per_feed_limit)
            all_news.extend(news)
            logger.info("[%s] fallback으로 %d건 수집", source_name, len(news))
            print(f"✅ {source_name} (Google News 우회): {len(news)}건 수집 완료")
        except Exception as exc:  # noqa: BLE001
            logger.warning("[%s] fallback 도 실패: %s", source_name, exc)
            print(f"❌ {source_name} fallback 도 실패 (건너뜀): {exc}")

    return all_news


# ---------------------------------------------------------------------------
# 로컬 단독 실행 테스트 (`python -m briefing.collectors.korean_news`)
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    print("=" * 60)
    print("한국 경제 3사 RSS 수집 테스트")
    print("=" * 60)

    news_list = collect_korean_news(per_feed_limit=3)

    print("\n" + "=" * 60)
    print(f"총 수집 건수: {len(news_list)}")
    print("=" * 60)

    # 상위 5개 샘플 출력
    for i, item in enumerate(news_list[:5], 1):
        print(f"\n[{i}] ({item['source']}) {item['title']}")
        print(f"    🔗 {item['link']}")
        if item["summary"]:
            print(f"    📝 {item['summary'][:100]}...")
