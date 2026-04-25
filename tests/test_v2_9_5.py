"""v2.9.5 단위 테스트
- 서술형 3태그(💰/📈/🎯) 검증 룰
- 약점 강화 지침 주입
- 폴백 마크다운이 새 검증을 통과하는지
- 글머리표 과다 시 invalid 처리
- MIN_ITEM_CHARS = 600
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
    _get_user_feedback_signal,
    MIN_ITEM_CHARS,
)


def test_1_min_item_chars_is_600():
    print("\n[Test 1] MIN_ITEM_CHARS == 600 확인")
    assert MIN_ITEM_CHARS == 600, f"MIN_ITEM_CHARS={MIN_ITEM_CHARS}, expected 600"
    print(f"  ✅ MIN_ITEM_CHARS = {MIN_ITEM_CHARS}")


def test_2_valid_narrative_passes():
    print("\n[Test 2] 정상 서술형 3태그 카드 → valid")
    text = """### 1. SK하이닉스 HBM3E 양산, 매출 20.4조 +39%

- **카테고리**: 반도체 · **출처**: Reuters

💰 **핵심 현황**: SK하이닉스가 2026년 1분기 매출 20.4조 원, 영업이익 7.03조 원으로 전년 대비 39% 성장한 것으로 발표됐다. HBM3E 12단 양산이 1분기에 본격화되면서 엔비디아 GB200 물량 100%를 단독 공급하게 됐고, 삼성전자의 8단 인증 지연이 6개월 연장되며 공급 부족이 심화되고 있다. 다만 GB200 채택 일정 지연 가능성과 메모리 가격 변동성이 단기 리스크로 부각된다.

📈 **전망과 파급**: CHIPS Act 보조금 520억 달러와 美 관세 정책으로 HBM 가격이 28% 상승했고, HBM 시장 점유율은 SK 53% · 삼성 38% · 마이크론 9%로 SK 독주 구도가 굳어졌다. 향후 6개월 내 변곡점은 2026년 5월 1일 1분기 실적 발표와 2분기 GB200 출하 피크가 핵심이다. 밸류체인 전방에서는 한미반도체 TC본더 수주가 40% 증가했고, 후방에서는 엔비디아가 GB200으로 SK 락인 상태가 강화됐다. 이 모든 흐름이 2027년까지 HBM 사이클을 지지할 것으로 보인다.

🎯 **투자 시사점**: 수혜주는 SK하이닉스(000660) 24만원 목표가(+18%), 한미반도체(042700) 21만원 목표가(+25%) 두 종목으로 압축된다. HBM 사이클이 2027년까지 이어질 가능성이 크므로 매수 관점이 유효하며, GB200 채택 지연이나 마이크론의 8단 추격이 트리거되면 부분 청산을 고려해야 한다. **시사점**: HBM 독점 구도 수혜주 매수, 다만 GB200 일정 변동을 주간 단위로 점검할 것.

- **원문 링크**: [Reuters](https://example.com/sk-hynix)
"""
    valid, reason = _is_item_output_valid(text)
    assert valid, f"기대 valid=True, got reason={reason}, len={len(text)}"
    print(f"  ✅ valid=True, length={len(text)}자")


def test_3_too_short_fails():
    print("\n[Test 3] 600자 미만 → too_short")
    text = """### 1. 짧은 카드

- **카테고리**: 반도체 · **출처**: Test

💰 짧은 핵심.
📈 짧은 전망.
🎯 짧은 시사점.
"""
    valid, reason = _is_item_output_valid(text)
    assert not valid, "기대 invalid"
    assert reason.startswith("too_short"), f"기대 too_short, got {reason}"
    print(f"  ✅ invalid (reason={reason})")


def test_4_missing_emoji_fails():
    print("\n[Test 4] 3태그 중 일부 누락 → missing_required_tags")
    text = "### 1. 테스트\n\n- **카테고리**: 반도체 · **출처**: A\n\n" + "가" * 700 + "\n💰 only this tag exists\n수혜주 시사점"
    valid, reason = _is_item_output_valid(text)
    assert not valid, "기대 invalid"
    assert "missing_required_tags" in reason, f"기대 missing_required_tags, got {reason}"
    print(f"  ✅ invalid (reason={reason})")


def test_5_too_many_bullets_fails():
    print("\n[Test 5] 글머리표 5개 이상 → too_many_bullets")
    body = """### 1. 글머리식 카드

- **카테고리**: 반도체 · **출처**: Test

💰 **핵심 현황**: 본문이 충분히 길어야 한다. SK하이닉스가 2026년 1분기 매출 20.4조 원, 영업이익 7.03조 원으로 전년 대비 39% 성장한 것으로 발표됐다. HBM3E 12단 양산이 1분기에 본격화되면서 엔비디아 GB200 물량 100%를 단독 공급하게 됐고, 삼성전자 8단 인증 지연이 6개월 연장되며 공급 부족이 심화되고 있다.
- 글머리 1
- 글머리 2
- 글머리 3
- 글머리 4
- 글머리 5

📈 **전망과 파급**: CHIPS Act 보조금 520억 달러로 HBM 가격이 28% 상승했고, 점유율은 SK 53% · 삼성 38% · 마이크론 9%다. 2026년 5월 1일 실적 발표와 2분기 GB200 출하 피크가 변곡점이다. 한미반도체 TC본더 수주 40% 증가, 엔비디아 GB200 락인 강화. HBM 사이클은 2027년까지 지지될 것으로 보인다.

🎯 **투자 시사점**: 수혜주는 SK하이닉스(000660) 24만원(+18%), 한미반도체(042700) 21만원(+25%)이다. 매수 관점 유효, GB200 지연 시 부분 청산. **시사점**: HBM 독점 수혜주 매수.

- **원문 링크**: [Test](https://example.com)
"""
    valid, reason = _is_item_output_valid(body)
    assert not valid, f"기대 invalid, got valid (reason={reason}, len={len(body)})"
    assert "too_many_bullets" in reason, f"기대 too_many_bullets, got {reason}"
    print(f"  ✅ invalid (reason={reason})")


def test_6_weakness_reinforcement_keys():
    print("\n[Test 6] _WEAKNESS_REINFORCEMENT 5개 축 모두 정의됨")
    expected = {"정확성", "시의성", "심층성", "명료성", "실행가능성"}
    assert set(_WEAKNESS_REINFORCEMENT.keys()) == expected, \
        f"기대 {expected}, got {set(_WEAKNESS_REINFORCEMENT.keys())}"
    for k, v in _WEAKNESS_REINFORCEMENT.items():
        assert isinstance(v, str) and len(v) > 30, f"{k} 강화 지침 너무 짧음: {v}"
    print(f"  ✅ 5개 축 정의: {list(_WEAKNESS_REINFORCEMENT.keys())}")


def test_7_prompt_with_weak_axes_includes_block():
    print("\n[Test 7] weak_axes 전달 시 강화 지침 블록이 프롬프트에 추가됨")
    item = {
        "rank": 1,
        "category": "반도체",
        "original": {
            "title": "테스트 뉴스",
            "summary": "본문",
            "source": "Test",
            "link": "https://example.com",
        },
    }
    p_no = _build_item_prompt(item, weak_axes=None)
    p_yes = _build_item_prompt(item, weak_axes=["정확성", "심층성"])
    assert "사용자 피드백 강화 지침" not in p_no, "weak_axes=None 인데 강화 블록이 들어감"
    assert "사용자 피드백 강화 지침" in p_yes, "weak_axes 전달했는데 강화 블록이 없음"
    assert "정확성" in p_yes and "심층성" in p_yes, "약점 축 이름이 프롬프트에 없음"
    assert _WEAKNESS_REINFORCEMENT["정확성"] in p_yes, "정확성 강화 본문이 안 들어감"
    print(f"  ✅ 강화 블록 주입 확인 (no_axes={len(p_no)}자, with_axes={len(p_yes)}자, 차이={len(p_yes)-len(p_no)}자)")


def test_8_prompt_unknown_axis_ignored():
    print("\n[Test 8] 알 수 없는 약점 축은 무시되고 정상 동작")
    item = {
        "rank": 1,
        "category": "반도체",
        "original": {"title": "t", "summary": "s", "source": "S", "link": "https://e.com"},
    }
    p = _build_item_prompt(item, weak_axes=["foo_unknown_axis"])
    # 알 수 없는 축뿐이면 강화 블록 자체가 추가되지 않아야 함 (lines 가 비어있으면 skip)
    assert "사용자 피드백 강화 지침" not in p, "알 수 없는 축으로 강화 블록이 만들어짐"
    print("  ✅ 알 수 없는 축은 무시됨")


def test_9_fallback_passes_validation():
    print("\n[Test 9] _fallback_item_markdown 출력이 새 검증 룰 통과")
    item = {
        "rank": 5,
        "category": "반도체",
        "original": {
            "title": "AI 분석 실패 시뮬",
            "summary": "원문 발췌가 충분히 길어야 폴백도 600자를 넘는다. " * 8,
            "source": "TestSource",
            "link": "https://example.com/article",
        },
    }
    fb = _fallback_item_markdown(item)
    valid, reason = _is_item_output_valid(fb)
    assert valid, f"폴백이 검증 실패: reason={reason}, len={len(fb)}\n--- output ---\n{fb}"
    print(f"  ✅ 폴백 valid (length={len(fb)}자)")


def test_10_get_user_feedback_signal_no_env():
    print("\n[Test 10] ADMIN_API/READ_TOKEN 미설정 → reinforce=False")
    # 환경변수 없는 상태에서 호출
    saved_admin = os.environ.pop("ADMIN_API", None)
    saved_brief = os.environ.pop("BRIEFING_ADMIN_API", None)
    saved_token = os.environ.pop("BRIEFING_READ_TOKEN", None)
    try:
        sig = _get_user_feedback_signal(days=7)
        assert sig["ok"] is False
        assert sig["reinforce"] is False
        assert sig["weakAxesTop"] == []
        print(f"  ✅ 환경변수 없으면 안전 fallback (ok=False, reinforce=False)")
    finally:
        if saved_admin: os.environ["ADMIN_API"] = saved_admin
        if saved_brief: os.environ["BRIEFING_ADMIN_API"] = saved_brief
        if saved_token: os.environ["BRIEFING_READ_TOKEN"] = saved_token


if __name__ == "__main__":
    tests = [
        test_1_min_item_chars_is_600,
        test_2_valid_narrative_passes,
        test_3_too_short_fails,
        test_4_missing_emoji_fails,
        test_5_too_many_bullets_fails,
        test_6_weakness_reinforcement_keys,
        test_7_prompt_with_weak_axes_includes_block,
        test_8_prompt_unknown_axis_ignored,
        test_9_fallback_passes_validation,
        test_10_get_user_feedback_signal_no_env,
    ]
    passed = 0
    failed = []
    for t in tests:
        try:
            t()
            passed += 1
        except AssertionError as e:
            failed.append((t.__name__, str(e)))
            print(f"  ❌ FAIL: {e}")
        except Exception as e:
            failed.append((t.__name__, f"예외: {e}"))
            print(f"  ❌ ERROR: {e}")

    print(f"\n=== {passed}/{len(tests)} 테스트 통과 ===")
    if failed:
        print("\n실패한 테스트:")
        for name, err in failed:
            print(f"  - {name}: {err}")
        sys.exit(1)
