"""
[3단계] 지침서 3.3: 수집 데이터(딕셔너리 리스트) → AI 프롬프트용 텍스트 변환.
"""
from __future__ import annotations

from typing import Dict, List


def format_data_for_ai(data_list: List[Dict[str, str]], max_summary: int = 300) -> str:
    """
    수집된 표준 dict 리스트를 Gemini 가 읽기 쉬운 텍스트로 평탄화.

    예시 출력:
        [출처: 한국경제(증권)]
        제목: 삼성전자, HBM3E 12단 양산 돌입...
        내용: (선택) 요약
        링크: https://...
        --------------------------------------------------
    """
    if not data_list:
        return "(수집된 뉴스가 없습니다.)"

    lines: List[str] = []
    for idx, item in enumerate(data_list, 1):
        lines.append(f"[#{idx} 출처: {item.get('source','?')}]")
        lines.append(f"제목: {item.get('title','').strip()}")
        summary = (item.get("summary") or "").strip()
        if summary:
            lines.append(f"내용: {summary[:max_summary]}")
        link = item.get("link", "").strip()
        if link:
            lines.append(f"링크: {link}")
        lines.append("-" * 50)

    return "\n".join(lines)


if __name__ == "__main__":
    # 샘플 테스트
    sample = [
        {
            "source": "한국경제",
            "title": "삼성전자, HBM3E 양산",
            "link": "https://hankyung.com/x",
            "summary": "삼성전자가 엔비디아 납품을 위해…",
        },
        {
            "source": "ETF.com",
            "title": "Top Semiconductor ETFs",
            "link": "https://etf.com/x",
            "summary": "",
        },
    ]
    print(format_data_for_ai(sample))
