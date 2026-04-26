"""v2.9.6 단위 테스트 — 컴팩트 한줄핵심(📌) + 3태그×3불릿

검증 항목:
1. MIN_ITEM_CHARS == 350, MAX_ITEM_CHARS == 700
2. 정상 컴팩트 카드(한줄핵심+9불릿) 통과
3. 한줄핵심(📌) 누락 → invalid
4. 너무 짧음(350자 미만) → invalid
5. 너무 김(700자 초과) → invalid
6. 본문 불릿 < 8개 → invalid
7. 60자 초과 본문 불릿 ≥ 3개 → invalid
8. 폴백 마크다운이 새 검증을 통과
9. 약점 강화 지침 주입 시 프롬프트에 추가됨
10. 프롬프트에 v2.9.6 핵심 키워드 포함 ("한줄핵심", "3태그", "60자")
"""
from __future__ import annotations

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from briefing.modules.ai_summarizer import (
    _is_item_output_valid,
    _build_item_prompt,
    _fallback_item_markdown,
    _WEAKNESS_REINFORCEMENT,
    MIN_ITEM_CHARS,
    MAX_ITEM_CHARS,
)


# ──────────────────────────────────────────────────────────────
# 헬퍼: 정상 v2.9.6 컴팩트 카드 샘플
# ──────────────────────────────────────────────────────────────
def make_valid_card() -> str:
    return """### 1. SK하이닉스 1Q 매출 +39%

- **카테고리**: 반도체 · **출처**: WSJ

📌 **한줄핵심**: HBM3E 12단 단독공급으로 1Q 매출 20.4조 +39%, 24만원(+18%) 매수 권장.

💰 **핵심 현황**
- 1Q 매출 20.4조 원 영업이익 7.03조 +39%
- HBM3E 12단 GB200 100% 단독공급 확보
- 메모리 가격 변동성 단기 리스크 5% 노출

📈 **전망과 파급**
- 2026년 점유율 SK 53% 삼성 38% 마이크론 9%
- CHIPS Act 보조금 4.6조 6월 시행 예정
- 6월 GB300 양산 일정 변곡점 1건 확정

🎯 **투자 시사점**
- SK하이닉스(000660) 24만원 +18% 한미반도체(042700) 21만원 +25%
- 매수 트리거 22만원 이하 청산 26만원 이상
- **시사점**: HBM 사이클 강세 유지, 리스크 수요 둔화 1건

- **원문 링크**: [WSJ](https://wsj.com/abc)
"""


# ──────────────────────────────────────────────────────────────
# Test 1: MIN/MAX_ITEM_CHARS 확인
# ──────────────────────────────────────────────────────────────
def test_1_min_max_item_chars():
    print("\n[Test 1] MIN_ITEM_CHARS == 350, MAX_ITEM_CHARS == 700")
    assert MIN_ITEM_CHARS == 350, f"MIN_ITEM_CHARS={MIN_ITEM_CHARS}, expected 350"
    assert MAX_ITEM_CHARS == 700, f"MAX_ITEM_CHARS={MAX_ITEM_CHARS}, expected 700"
    print(f"  ✅ MIN_ITEM_CHARS={MIN_ITEM_CHARS}, MAX_ITEM_CHARS={MAX_ITEM_CHARS}")


# ──────────────────────────────────────────────────────────────
# Test 2: 정상 컴팩트 카드 통과
# ──────────────────────────────────────────────────────────────
def test_2_valid_compact_card_passes():
    print("\n[Test 2] 정상 컴팩트 카드(한줄핵심+9불릿) 통과")
    card = make_valid_card()
    print(f"  카드 길이: {len(card)}자")
    valid, reason = _is_item_output_valid(card)
    print(f"  결과: valid={valid}, reason={reason}")
    assert valid, f"valid 카드인데 invalid: {reason}"
    print("  ✅ 정상 통과")


# ──────────────────────────────────────────────────────────────
# Test 3: 한줄핵심(📌) 누락 → invalid
# ──────────────────────────────────────────────────────────────
def test_3_missing_headline_invalid():
    print("\n[Test 3] 한줄핵심(📌) 누락 시 invalid")
    card = make_valid_card().replace("📌 **한줄핵심**", "**한줄핵심**")
    valid, reason = _is_item_output_valid(card)
    print(f"  결과: valid={valid}, reason={reason}")
    assert not valid
    assert "missing_required_tags" in reason
    assert "📌" in reason
    print("  ✅ 📌 누락 거부 정상 작동")


# ──────────────────────────────────────────────────────────────
# Test 4: 너무 짧음 (350자 미만) → invalid
# ──────────────────────────────────────────────────────────────
def test_4_too_short_invalid():
    print("\n[Test 4] 350자 미만 카드 거부")
    short_card = "### 1. 짧은 제목\n\n- **카테고리**: 반도체 · **출처**: WSJ\n\n📌 짧음.\n💰 짧음.\n📈 짧음.\n🎯 시사점 수혜주(000660) 짧음.\n"
    print(f"  카드 길이: {len(short_card)}자")
    valid, reason = _is_item_output_valid(short_card)
    print(f"  결과: valid={valid}, reason={reason}")
    assert not valid
    assert "too_short" in reason
    print("  ✅ too_short 거부")


# ──────────────────────────────────────────────────────────────
# Test 5: 너무 김 (700자 초과) → invalid
# ──────────────────────────────────────────────────────────────
def test_5_too_long_invalid():
    print("\n[Test 5] 700자 초과 카드 거부")
    long_card = make_valid_card() + ("매우 긴 추가 본문 " * 100)
    print(f"  카드 길이: {len(long_card)}자")
    valid, reason = _is_item_output_valid(long_card)
    print(f"  결과: valid={valid}, reason={reason}")
    assert not valid
    assert "too_long" in reason
    print("  ✅ too_long 거부")


# ──────────────────────────────────────────────────────────────
# Test 6: 본문 불릿 < 8개 → invalid
# ──────────────────────────────────────────────────────────────
def test_6_too_few_bullets_invalid():
    print("\n[Test 6] 본문 불릿 8개 미만 거부")
    # 불릿을 6개만 (3+2+1) — 너무 적음
    card = """### 1. 짧은 카드 테스트 사례

- **카테고리**: 반도체 · **출처**: WSJ

📌 **한줄핵심**: HBM3E 12단 1Q 매출 20.4조 +39%, 24만원 매수.

💰 **핵심 현황**
- 1Q 매출 20.4조 영업이익 7.03조 +39%
- HBM3E 12단 GB200 100% 단독공급
- 메모리 가격 변동성 5% 단기 리스크

📈 **전망과 파급**
- 2026년 점유율 SK 53% 삼성 38%
- CHIPS Act 4.6조 6월 시행 예정

🎯 **투자 시사점**
- **시사점**: SK하이닉스(000660) 24만원 매수 권장 리스크 1건

- **원문 링크**: [WSJ](https://wsj.com/abc)
"""
    print(f"  카드 길이: {len(card)}자")
    valid, reason = _is_item_output_valid(card)
    print(f"  결과: valid={valid}, reason={reason}")
    assert not valid
    assert "too_few_bullets" in reason
    print("  ✅ 불릿 부족 거부")


# ──────────────────────────────────────────────────────────────
# Test 7: 60자 초과 본문 불릿 ≥ 3개 → invalid
# ──────────────────────────────────────────────────────────────
def test_7_long_bullets_invalid():
    print("\n[Test 7] 60자 초과 본문 불릿 3개 이상 거부")
    long_text = "매우 길고 늘어진 서술형 문장으로 이루어진 불릿이며 60자를 분명하게 명백히 초과하도록 의도된 매우 긴 어떤 사실 1Q 매출 20.4조 영업이익 7.03조 +39%"
    assert len(long_text) > 60, f"테스트용 long_text가 60자 이상이어야 함: {len(long_text)}"
    # 60자 초과 불릿 4개 + 짧은 불릿 5개 = 본문 9불릿
    card = f"""### 1. 긴 불릿 카드

- **카테고리**: 반도체 · **출처**: WSJ

📌 **한줄핵심**: HBM3E 12단 1Q 매출 20.4조 +39%, 24만원 매수 권장.

💰 **핵심 현황**
- {long_text}
- {long_text}
- 짧은 불릿 1Q +39%

📈 **전망과 파급**
- {long_text}
- {long_text}
- 짧은 일정 6월 시행 1건

🎯 **투자 시사점**
- SK하이닉스(000660) 24만원 +18% 매수
- 매수 트리거 22만원 이하 진입
- **시사점**: 강세 유지 리스크 1건

- **원문 링크**: [WSJ](https://wsj.com/abc)
"""
    print(f"  카드 길이: {len(card)}자, 60자 초과 불릿 4개 의도 삽입")
    valid, reason = _is_item_output_valid(card)
    print(f"  결과: valid={valid}, reason={reason}")
    # too_long 으로 먼저 걸리거나 bullets_too_long 으로 걸려야 함
    assert not valid
    assert ("bullets_too_long" in reason) or ("too_long" in reason)
    print("  ✅ 긴 불릿/긴 카드 거부")


# ──────────────────────────────────────────────────────────────
# Test 8: 폴백 마크다운이 새 검증을 통과
# ──────────────────────────────────────────────────────────────
def test_8_fallback_passes_validation():
    print("\n[Test 8] 폴백 마크다운이 v2.9.6 검증을 통과")
    item = {
        "rank": 1,
        "category": "반도체",
        "original": {
            "title": "테스트 폴백 케이스 — Gemini 일시 장애",
            "source": "WSJ",
            "link": "https://wsj.com/test",
            "summary": "원문 발췌 본문이 약 200자 정도 들어있는 케이스. 컴팩트 카드 폴백이 검증을 통과해야 정상." * 3,
        },
    }
    fb = _fallback_item_markdown(item)
    print(f"  폴백 길이: {len(fb)}자")
    valid, reason = _is_item_output_valid(fb)
    print(f"  결과: valid={valid}, reason={reason}")
    assert valid, f"폴백이 invalid: {reason}\n{fb}"
    print("  ✅ 폴백 통과")


# ──────────────────────────────────────────────────────────────
# Test 9: 약점 강화 지침 주입
# ──────────────────────────────────────────────────────────────
def test_9_reinforcement_injection():
    print("\n[Test 9] weak_axes 주입 시 프롬프트에 강화 블록 추가")
    item = {
        "rank": 1,
        "category": "반도체",
        "original": {
            "title": "테스트", "source": "WSJ", "link": "https://x.com",
            "summary": "테스트 본문",
        },
    }
    no_axes = _build_item_prompt(item)
    with_axes = _build_item_prompt(item, weak_axes=["정확성", "심층성"])
    print(f"  no_axes 길이: {len(no_axes)}자")
    print(f"  with_axes 길이: {len(with_axes)}자")
    assert len(with_axes) > len(no_axes), "강화 블록이 추가되지 않음"
    assert "사용자 피드백 강화 지침" in with_axes
    assert "정확성" in with_axes
    assert "심층성" in with_axes
    # weak_axes 없을 때 강화 블록이 없어야 함
    assert "사용자 피드백 강화 지침" not in no_axes
    print("  ✅ 약점 강화 지침 주입 정상 작동")


# ──────────────────────────────────────────────────────────────
# Test 10: 프롬프트에 v2.9.6 핵심 키워드 포함
# ──────────────────────────────────────────────────────────────
def test_10_prompt_contains_v296_keywords():
    print("\n[Test 10] 프롬프트에 v2.9.6 핵심 키워드 포함 확인")
    item = {
        "rank": 1,
        "category": "반도체",
        "original": {
            "title": "테스트", "source": "WSJ", "link": "https://x.com",
            "summary": "본문",
        },
    }
    p = _build_item_prompt(item)
    required_keywords = [
        "한줄핵심",       # 📌 한줄핵심 도입
        "3태그",          # 3태그 컴팩트
        "60자",           # 불릿 60자 제한
        "30초",           # 30초 핵심 파악
        "📌",             # 한줄핵심 이모지
        "💰", "📈", "🎯",  # 3태그 이모지
        "**시사점**",      # 시사점 결론 강제
        "수혜주",         # 수혜주 종목
    ]
    missing = [k for k in required_keywords if k not in p]
    print(f"  프롬프트 길이: {len(p)}자")
    print(f"  누락 키워드: {missing}")
    assert not missing, f"v2.9.6 필수 키워드 누락: {missing}"
    print("  ✅ 모든 v2.9.6 키워드 포함")


# ──────────────────────────────────────────────────────────────
# 메인
# ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    tests = [
        test_1_min_max_item_chars,
        test_2_valid_compact_card_passes,
        test_3_missing_headline_invalid,
        test_4_too_short_invalid,
        test_5_too_long_invalid,
        test_6_too_few_bullets_invalid,
        test_7_long_bullets_invalid,
        test_8_fallback_passes_validation,
        test_9_reinforcement_injection,
        test_10_prompt_contains_v296_keywords,
    ]
    passed = 0
    failed = 0
    for t in tests:
        try:
            t()
            passed += 1
        except AssertionError as e:
            failed += 1
            print(f"  ❌ FAIL: {e}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"  ❌ ERROR: {type(e).__name__}: {e}")
    print(f"\n{'=' * 60}")
    print(f"v2.9.6 테스트 결과: {passed}/{len(tests)} PASS, {failed} FAIL")
    print(f"{'=' * 60}")
    sys.exit(0 if failed == 0 else 1)
