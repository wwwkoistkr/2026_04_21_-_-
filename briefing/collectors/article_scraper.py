"""
[v2.6.0 신규] 기사 원문 스크래핑 모듈.

## 문제 배경
Google News RSS (news.google.com/rss/search?...) 는 description 필드에
  <a href="...">제목 링크</a><br><font>출처</font>
처럼 **HTML 래퍼**만 담고 **실제 기사 본문은 주지 않습니다.**
그래서 `_clean_summary()` 를 거치면 평균 30자 내외로 줄어들어
AI 가 3문장 서술형 요약을 생성할 재료가 없습니다.

## 해결 방법
1차 선택: `trafilatura.extract()` — Mozilla Readability 알고리즘 기반.
  - 가볍고(의존성 minimal), 한국어 기사 추출 품질이 newspaper3k 보다 안정적.
  - 정적 HTML 만 파싱 (JS 렌더링 X) — 뉴스 기사엔 충분.
2차 보완: BeautifulSoup 로 `<article>`, `<meta name="description">` 폴백.
3차 보완: 실패 시 원래 RSS description 을 그대로 반환 (서비스 중단 방지).

## 성능·안정성 정책
- 타임아웃 10 초 (뉴스 도메인은 대부분 1~3 초 응답).
- 단일 기사 스크래핑 실패는 **절대 예외를 상위로 던지지 않음** — 빈 문자열 반환.
- 최소 60자 미만이면 의미 없는 본문으로 간주 (폴백 시도).
- Google News 리다이렉트 URL (`news.google.com/...`) 은 `Location` 헤더를
  따라가서 실제 언론사 URL 로 해결.

## 호출 시점
`get_news_from_rss()` 내부에서 각 기사를 수집할 때, description 이 짧거나
비어 있으면 이 모듈의 `fetch_article_text(link)` 를 호출해 본문을 채웁니다.

환경 변수
---------
- `ARTICLE_SCRAPE_ENABLED` (기본 `true`) — false 로 주면 스크래핑 완전 우회.
- `ARTICLE_SCRAPE_TIMEOUT` (기본 `10`) — HTTP 타임아웃(초).
- `ARTICLE_SCRAPE_MIN_CHARS` (기본 `60`) — 이 길이 미만이면 폴백 시도.
"""
from __future__ import annotations

import html
import logging
import os
import re
from typing import Optional
from urllib.parse import urlparse

import requests

logger = logging.getLogger(__name__)

# trafilatura 는 선택 의존성 — 설치 안 돼 있어도 BS4 폴백으로 동작하도록
try:
    import trafilatura
    _HAS_TRAFILATURA = True
except ImportError:  # pragma: no cover
    _HAS_TRAFILATURA = False
    logger.warning("trafilatura 미설치 — BeautifulSoup 폴백만 사용")

try:
    from bs4 import BeautifulSoup
    _HAS_BS4 = True
except ImportError:
    _HAS_BS4 = False

# Google News RSS 링크(news.google.com/rss/articles/…)를 실제 언론사 URL 로 디코딩
try:
    from googlenewsdecoder import gnewsdecoder
    _HAS_GNEWS_DECODER = True
except ImportError:  # pragma: no cover
    _HAS_GNEWS_DECODER = False
    logger.warning("googlenewsdecoder 미설치 — Google News 리다이렉트 URL 은 스크래핑 불가")


# ── 설정 ────────────────────────────────────────────────
def _env_bool(name: str, default: bool) -> bool:
    v = os.getenv(name, "").strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "y", "on")


SCRAPE_ENABLED: bool = _env_bool("ARTICLE_SCRAPE_ENABLED", True)
SCRAPE_TIMEOUT: int = int(os.getenv("ARTICLE_SCRAPE_TIMEOUT", "10"))
MIN_CHARS: int = int(os.getenv("ARTICLE_SCRAPE_MIN_CHARS", "60"))
MAX_CHARS: int = int(os.getenv("ARTICLE_SCRAPE_MAX_CHARS", "2500"))

# 모바일 UA 가 대부분 사이트에서 봇 차단에 덜 걸림
DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ko,en-US;q=0.8,en;q=0.5",
    "Cache-Control": "no-cache",
}

_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")

# 도메인별 "본문이 아닌" 공통 문구 (뉴스레터/구독 안내/저작권 표기 제거)
_NOISE_PATTERNS = [
    re.compile(r"Copyright\s*[©@]?.+?(?:All rights reserved|무단\s*전재)", re.IGNORECASE),
    re.compile(r"이\s*기사는\s*.+?의\s*자체\s*취재.+"),
    re.compile(r"▶[^◀\n]{0,80}"),  # '▶ 네이버에서 구독하기' 류
    re.compile(r"\[.+?뉴스.+?\]"),
    re.compile(r"구독하기|제보하기|네이버에서|카카오톡에서"),
]


# ── Google News URL 디코딩 ──────────────────────────────
def _resolve_google_news_url(url: str) -> str:
    """
    Google News RSS 리다이렉트 URL(news.google.com/rss/articles/...) 를
    실제 언론사 기사 URL 로 해결.

    - `googlenewsdecoder` 가 설치돼 있으면 내부 API 로 실제 URL 추출.
    - 이미 언론사 직접 URL 이면 그대로 반환.
    - 디코딩 실패 시 원본 URL 반환 (스크래핑 자체는 안 되지만 후속 로직은 계속).
    """
    if not url:
        return url
    if "news.google.com" not in url:
        return url
    if not _HAS_GNEWS_DECODER:
        return url
    try:
        result = gnewsdecoder(url, interval=1)
        if result and result.get("status") and result.get("decoded_url"):
            decoded = result["decoded_url"]
            logger.debug("[scrape] gnews decode → %s", _safe_host(decoded))
            return decoded
    except Exception as exc:  # noqa: BLE001
        logger.debug("[scrape] gnews decode 실패: %s", exc)
    return url


# ── 메인 함수 ────────────────────────────────────────────
def fetch_article_text(
    url: str,
    *,
    timeout: int = SCRAPE_TIMEOUT,
    min_chars: int = MIN_CHARS,
    max_chars: int = MAX_CHARS,
) -> str:
    """
    주어진 URL 의 기사 본문을 추출해 반환.

    성공 시 최소 `min_chars` 자 이상의 정리된 텍스트,
    실패 시 빈 문자열("") 을 반환합니다.

    **절대 예외를 던지지 않습니다** — 수집 파이프라인을 멈추면 안 되기 때문.
    """
    if not SCRAPE_ENABLED or not url:
        return ""

    # 0) Google News 리다이렉트 URL 이면 실제 언론사 URL 로 해결
    url = _resolve_google_news_url(url)

    try:
        # 1) HTTP GET (리다이렉트 자동 추적)
        resp = requests.get(
            url,
            headers=DEFAULT_HEADERS,
            timeout=timeout,
            allow_redirects=True,
        )
        if resp.status_code != 200:
            logger.debug("[scrape] %s → HTTP %d", url, resp.status_code)
            return ""

        # 2) 인코딩 보정 (한국 언론사는 간혹 meta charset 미선언)
        if not resp.encoding or resp.encoding.lower() == "iso-8859-1":
            resp.encoding = resp.apparent_encoding or "utf-8"
        html_text = resp.text

        # 3) trafilatura 로 본문 추출 (1차)
        text = ""
        if _HAS_TRAFILATURA:
            try:
                text = trafilatura.extract(
                    html_text,
                    include_comments=False,
                    include_tables=False,
                    favor_recall=True,    # 내용 우선 (한국어 기사 본문 보전)
                    target_language=None,  # 언어 추측은 AI 단계에 맡김
                ) or ""
            except Exception as exc:  # noqa: BLE001
                logger.debug("[scrape] trafilatura 예외 (%s): %s", url, exc)

        # 4) 부족하면 BeautifulSoup 으로 <article>, <meta description> 폴백
        if len(text) < min_chars and _HAS_BS4:
            text = _bs4_fallback(html_text) or text

        if not text:
            logger.debug("[scrape] 본문 추출 0자 — %s", url)
            return ""

        # 5) 정제 — 노이즈/과도한 공백 제거, 최대 길이 컷
        cleaned = _clean_body_text(text, max_chars=max_chars)

        if len(cleaned) < min_chars:
            # 너무 짧으면 "추출 실패"로 간주
            logger.debug("[scrape] too short (%d<%d) — %s",
                         len(cleaned), min_chars, url)
            return ""

        logger.info("[scrape] ✅ %d chars — %s", len(cleaned), _safe_host(url))
        return cleaned

    except requests.Timeout:
        logger.info("[scrape] timeout — %s", url)
    except requests.RequestException as exc:
        logger.info("[scrape] request 실패 (%s) — %s",
                    type(exc).__name__, url)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[scrape] 예상치 못한 오류 (%s): %s", type(exc).__name__, exc)

    return ""


# ── 내부 유틸 ───────────────────────────────────────────
def _bs4_fallback(html_text: str) -> str:
    """trafilatura 가 비었을 때의 최소 추출.

    우선순위:
      1) <meta name="description" content="...">
      2) <article> 또는 <div class*="article|content">
      3) <p> 태그 본문 상위 20개 합치기
    """
    try:
        soup = BeautifulSoup(html_text, "html.parser")

        # 1) meta description
        meta = (
            soup.find("meta", attrs={"name": "description"})
            or soup.find("meta", attrs={"property": "og:description"})
        )
        meta_desc = ""
        if meta and meta.get("content"):
            meta_desc = meta["content"].strip()

        # 2) article / 본문 박스
        article_text = ""
        for sel in ("article", "#articleBody", ".article-body",
                    ".news-article-body", "#content", ".content"):
            node = soup.select_one(sel)
            if node:
                # 광고·스크립트 제거
                for bad in node.select("script, style, figure, iframe, aside, nav"):
                    bad.extract()
                article_text = node.get_text(" ", strip=True)
                if len(article_text) > 100:
                    break

        if article_text and len(article_text) > len(meta_desc):
            return article_text

        # 3) <p> 상위 20개
        ps = [p.get_text(" ", strip=True) for p in soup.find_all("p")[:20]]
        p_text = " ".join(x for x in ps if len(x) > 20)
        if p_text:
            return p_text

        return meta_desc
    except Exception:  # noqa: BLE001
        return ""


def _clean_body_text(text: str, *, max_chars: int) -> str:
    """본문 텍스트 정제 — HTML 엔티티 복원·태그 제거·공백 정규화·노이즈 패턴 제거."""
    if not text:
        return ""
    out = html.unescape(text)
    out = _TAG_RE.sub(" ", out)
    # 노이즈 패턴 제거
    for pat in _NOISE_PATTERNS:
        out = pat.sub(" ", out)
    out = _WHITESPACE_RE.sub(" ", out).strip()
    if len(out) > max_chars:
        out = out[:max_chars].rsplit(" ", 1)[0] + "…"
    return out


def _safe_host(url: str) -> str:
    try:
        return urlparse(url).netloc or url
    except Exception:
        return url


def enrich_summary(
    raw_summary: str,
    link: str,
    *,
    prefer_scrape_threshold: int = 500,
    min_chars: int = MIN_CHARS,
) -> str:
    """
    RSS summary 가 부실하거나 스크래핑으로 더 풍부한 본문을 얻을 수 있을 때 보강.

    정책 (v2.6.0)
    ---------
    - 원본 summary 가 `prefer_scrape_threshold` 자 이상이면 스크래핑 생략
      (이미 충분한 본문이므로 HTTP 호출 낭비 방지).
    - 그보다 짧으면 스크래핑 시도:
        - 스크래핑 결과가 원본보다 길면 → 스크래핑 결과 반환
        - 스크래핑 실패/더 짧으면 → 원본 반환 (서비스 중단 방지)

    Parameters
    ----------
    raw_summary : str
        RSS / Google News 에서 받은 원본 description.
    link : str
        기사 원문 URL (Google News 리다이렉트여도 내부에서 디코딩).
    prefer_scrape_threshold : int
        이 길이 이상이면 스크래핑 생략. 기본 500자.
    min_chars : int
        스크래핑 결과로 인정할 최소 길이.
    """
    raw = (raw_summary or "").strip()[:MAX_CHARS]

    # 이미 충분히 긴 RSS summary — 그대로 사용
    if len(raw) >= prefer_scrape_threshold:
        return raw

    if not link:
        return raw

    scraped = fetch_article_text(link, min_chars=min_chars)
    # 스크래핑이 원본보다 길어야만 교체 (품질 보호)
    if scraped and len(scraped) > len(raw):
        return scraped
    return raw


# ── CLI 테스트 ───────────────────────────────────────────
if __name__ == "__main__":
    import sys

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    test_urls = sys.argv[1:] or [
        "https://www.reuters.com/technology/",
        "https://www.hankyung.com/",
    ]
    for u in test_urls:
        print("=" * 70)
        print(f"URL: {u}")
        body = fetch_article_text(u)
        print(f"길이: {len(body)}자")
        print("-" * 70)
        print(body[:600] + ("..." if len(body) > 600 else ""))
        print()
