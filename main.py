"""
📊 주식 및 반도체 일일 브리핑 — 메인 파이프라인 (v2.6.0)
================================================

## v2.6.0 주요 변경
기존 단일 파이프라인(run_pipeline) 외에 **3단계 분리 파이프라인**을 추가했습니다.
  - ``run_stage_collect()``   : 수집 → KV (pipeline:collected:YYYYMMDD) 저장
  - ``run_stage_summarize()`` : KV 수집결과 → AI 요약 → KV (pipeline:summary:YYYYMMDD)
  - ``run_stage_send()``      : KV 요약 → 이메일 발송

단계별로 분리되어 있어 다음 이점이 있습니다:
  1) 각 단계의 GitHub Actions 타임아웃(15분) 독립 적용
  2) 특정 단계만 실패했을 때 해당 단계만 재실행 가능
  3) 수집 단계는 AI 호출 0회 → 무제한 재시도 가능
  4) 요약 단계에서 Gemini 할당량 초과 시에도 수집 데이터는 안전하게 보존

실행 방법 (stage 인자)
----------------------
  python main.py collect     → 수집만
  python main.py summarize   → 수집 결과 읽어 AI 요약만
  python main.py send        → 요약 결과 읽어 메일 발송만
  python main.py all         → 기존 단일 파이프라인 (수집→요약→발송, KV 거치지 않음)
  python main.py             → (기본) all 과 동일 — 하위 호환

필수 환경 변수
--------------
    GEMINI_API_KEY       : Google Gemini API 키 (summarize 단계)
    EMAIL_SENDER         : 보내는 Gmail 주소         (send 단계)
    EMAIL_APP_PASSWORD   : Gmail 앱 비밀번호         (send 단계)
    EMAIL_RECIPIENTS     : 받는 이메일 (쉼표 구분)    (send 단계)

3단계 모드에서 필요한 추가 환경 변수
------------------------------------
    BRIEFING_ADMIN_API    : Cloudflare Pages 배포 URL (예: https://morning-stock-briefing.pages.dev)
    BRIEFING_REPORT_TOKEN : collect/summarize/send 단계가 KV 에 결과를 쓸 때 사용
    BRIEFING_READ_TOKEN   : summarize/send 단계가 KV 에서 이전 단계 결과를 읽을 때 사용

선택:
    YOUTUBE_API_KEY       : (레거시) 더 이상 사용 안 함
    DRY_RUN               : 'true' 시 send 단계에서 메일 발송 생략
"""
from __future__ import annotations

import json
import logging
import os
import sys
import traceback
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Optional

LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"


def _is_truthy(val: str | None) -> bool:
    return (val or "").strip().lower() in {"1", "true", "yes", "y", "on"}


def _kst_now() -> datetime:
    try:
        return datetime.now(timezone(timedelta(hours=9)))
    except Exception:
        return datetime.now()


def _kst_date_key() -> str:
    """YYYYMMDD (KST) — Cloudflare Worker 와 동일한 키 규칙."""
    return _kst_now().strftime("%Y%m%d")


def _today_label() -> str:
    d = _kst_now()
    weekday_kr = ["월", "화", "수", "목", "금", "토", "일"][d.weekday()]
    return d.strftime(f"%Y-%m-%d ({weekday_kr})")


# ═══════════════════════════════════════════════════════════════
# Cloudflare KV 통신 유틸 (Phase 2)
# ═══════════════════════════════════════════════════════════════
def _admin_api_base() -> str:
    base = (os.getenv("BRIEFING_ADMIN_API") or "").rstrip("/")
    if not base:
        raise RuntimeError(
            "BRIEFING_ADMIN_API 환경변수가 필요합니다 "
            "(예: https://morning-stock-briefing.pages.dev)."
        )
    return base


def _post_pipeline(endpoint: str, payload: dict) -> dict:
    """BRIEFING_REPORT_TOKEN 으로 파이프라인 상태/결과를 서버에 저장."""
    import requests
    token = os.getenv("BRIEFING_REPORT_TOKEN")
    if not token:
        raise RuntimeError("BRIEFING_REPORT_TOKEN 환경변수가 필요합니다.")
    url = f"{_admin_api_base()}{endpoint}"
    r = requests.post(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def _get_pipeline(endpoint: str) -> dict:
    """BRIEFING_READ_TOKEN 으로 파이프라인 중간 결과를 조회."""
    import requests
    token = os.getenv("BRIEFING_READ_TOKEN")
    if not token:
        raise RuntimeError("BRIEFING_READ_TOKEN 환경변수가 필요합니다.")
    url = f"{_admin_api_base()}{endpoint}"
    r = requests.get(
        url,
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    if r.status_code == 404:
        raise FileNotFoundError(f"KV 에 데이터 없음: {endpoint}")
    r.raise_for_status()
    return r.json()


# ═══════════════════════════════════════════════════════════════
# Stage 1: Collect
# ═══════════════════════════════════════════════════════════════
def run_stage_collect() -> int:
    """
    수집 단계 — 활성 소스에서 뉴스 수집 → Cloudflare KV 에 저장.

    이 단계는 AI API 호출을 하지 않으므로 여러 번 재실행해도 안전합니다.
    """
    logger = logging.getLogger("briefing.main.collect")
    date = _kst_date_key()

    print("=" * 70)
    print(f"🪣 [Stage 1/3] Collect — {_today_label()} (key={date})")
    print("=" * 70)

    try:
        from briefing.collectors.aggregator import collect_all_data
        news = collect_all_data()
    except Exception:
        logger.exception("수집 치명적 오류")
        _safe_notify_error("collected", str(sys.exc_info()[1])[:300])
        return 1

    if not news:
        logger.error("수집된 뉴스가 없습니다.")
        _safe_notify_error("collected", "수집 결과 0건")
        return 1

    print(f"\n✅ 수집 완료: {len(news)}건")

    # KV 저장 (실패해도 로컬 파일엔 백업 저장)
    backup_path = _backup_path("collected", date)
    try:
        with open(backup_path, "w", encoding="utf-8") as f:
            json.dump(news, f, ensure_ascii=False, indent=2)
        print(f"💾 로컬 백업: {backup_path}")
    except Exception as exc:  # noqa: BLE001
        logger.warning("로컬 백업 실패(계속 진행): %s", exc)

    try:
        result = _post_pipeline("/api/public/pipeline/collected",
                                {"date": date, "news": news})
        print(f"☁️  KV 업로드 OK — date={result.get('date')}, count={result.get('count')}")
    except Exception:
        logger.exception("KV 업로드 실패")
        # 로컬 백업은 남아있으므로 치명은 아니지만 이후 단계가 진행 불가
        print("❌ KV 업로드 실패 — 수동으로 수집 파일을 다음 단계에 투입하세요.")
        return 1

    print("\n✅ Stage 1 완료")
    return 0


# ═══════════════════════════════════════════════════════════════
# Stage 2: Summarize
# ═══════════════════════════════════════════════════════════════
def run_stage_summarize() -> int:
    """
    요약 단계 — KV 에서 수집 결과 가져와 AI 요약 → 다시 KV 에 저장.

    실패해도 수집 결과는 보존되므로 다음 날 재시도 가능.
    """
    logger = logging.getLogger("briefing.main.summarize")
    date = _kst_date_key()

    print("=" * 70)
    print(f"🤖 [Stage 2/3] Summarize — {_today_label()} (key={date})")
    print("=" * 70)

    # 1) 수집 결과 읽기 (KV → 실패 시 로컬 백업)
    news: Optional[List[Dict[str, str]]] = None
    try:
        payload = _get_pipeline(f"/api/public/pipeline/collected?date={date}")
        news = payload.get("news") or []
        print(f"📥 KV 에서 {len(news)}건 읽음")
    except FileNotFoundError:
        logger.warning("KV 에 수집 데이터 없음 — 로컬 백업 시도")
    except Exception as exc:
        logger.warning("KV 읽기 실패 (%s) — 로컬 백업 시도", exc)

    if not news:
        backup_path = _backup_path("collected", date)
        if os.path.exists(backup_path):
            with open(backup_path, encoding="utf-8") as f:
                news = json.load(f)
            print(f"📥 로컬 백업에서 {len(news)}건 읽음 ({backup_path})")
        else:
            logger.error("수집 데이터를 어디서도 찾지 못함. Stage 1 먼저 실행 필요.")
            _safe_notify_error("summary", "collect 단계 결과 없음")
            return 1

    if not news:
        _safe_notify_error("summary", "뉴스 0건")
        return 1

    # 2) AI 요약 실행
    try:
        from briefing.modules.ai_summarizer import summarize_with_gemini
        from briefing.modules.formatter import format_data_for_ai
        briefing_input = format_data_for_ai(news)
        markdown = summarize_with_gemini(
            briefing_input_text=briefing_input,
            news_list=news,
        )
    except Exception:
        logger.exception("AI 요약 실패")
        _safe_notify_error("summary", f"AI 요약 실패: {sys.exc_info()[1]}")
        return 1

    print(f"\n🤖 AI 요약 완료: {len(markdown):,}자")

    # 3) 로컬 백업 + KV 업로드
    backup_path = _backup_path("summary", date, ext="md")
    try:
        with open(backup_path, "w", encoding="utf-8") as f:
            f.write(markdown)
        print(f"💾 로컬 백업: {backup_path}")
    except Exception as exc:  # noqa: BLE001
        logger.warning("로컬 백업 실패(계속): %s", exc)

    try:
        result = _post_pipeline(
            "/api/public/pipeline/summary",
            {"date": date, "markdown": markdown},
        )
        print(f"☁️  KV 업로드 OK — date={result.get('date')}, chars={result.get('chars')}")
    except Exception:
        logger.exception("KV 업로드 실패 — 로컬 백업만 남아있음")
        return 1

    print("\n✅ Stage 2 완료")
    return 0


# ═══════════════════════════════════════════════════════════════
# Stage 3: Send
# ═══════════════════════════════════════════════════════════════
def _fetch_today_summary_with_retry(
    date: str,
    *,
    max_attempts: int = 4,
    backoff_seconds: tuple = (60, 90, 120),
) -> Optional[str]:
    """
    v2.9.2: KV 에서 오늘 날짜 요약을 가져온다. 비어있으면 점진적 백오프로 재시도.

    Stage 2 가 v2.9.0 이후 6~8분 걸리는 경우가 잦아, Stage 3 가 너무 일찍 시작하면
    KV 에 데이터가 아직 없을 수 있다. 이 함수는 다음과 같이 동작한다:
      1. 1차 시도: KV 조회 (즉시).
      2. 비어있으면 60초 대기 후 2차 시도.
      3. 90초 대기 후 3차 시도.
      4. 120초 대기 후 4차(최종) 시도.

    🔒 안전장치 (보너스 1): 어제 KV 데이터 재발송 방지를 위해
       ``date`` 키를 명시적으로 사용. KV API 가 잘못된 키로 응답해도
       반환된 ``markdown`` 만 사용 (날짜 검증은 호출자 측 endpoint URL 에서 보장).

    Returns
    -------
    str
        오늘 날짜 요약 마크다운. 모든 재시도 실패 시 ``None``.
    """
    import time

    logger = logging.getLogger("briefing.main.send")

    for attempt in range(1, max_attempts + 1):
        try:
            payload = _get_pipeline(
                f"/api/public/pipeline/summary?date={date}"
            )
            markdown = (payload.get("markdown") or "").strip()
            if markdown:
                if attempt > 1:
                    print(
                        f"✅ 재시도 {attempt}/{max_attempts} 차에서 KV 조회 성공 "
                        f"({len(markdown):,}자)"
                    )
                else:
                    print(f"📥 KV 에서 {len(markdown):,}자 읽음")
                return markdown

            # KV 응답은 왔지만 markdown 비어있음 (Stage 2 진행 중)
            logger.warning(
                "KV 응답 OK 이지만 markdown 비어있음 (시도 %d/%d)",
                attempt, max_attempts,
            )
        except FileNotFoundError:
            logger.warning(
                "KV 에 요약 데이터 없음 (시도 %d/%d)",
                attempt, max_attempts,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "KV 읽기 실패 (%s) (시도 %d/%d)",
                exc, attempt, max_attempts,
            )

        # 마지막 시도면 더 이상 대기하지 않음
        if attempt >= max_attempts:
            break

        # 점진적 백오프 (60 → 90 → 120 초)
        wait_sec = backoff_seconds[min(attempt - 1, len(backoff_seconds) - 1)]
        print(
            f"🔄 {attempt}/{max_attempts} 차 시도 실패 — Stage 2 진행 중일 가능성. "
            f"{wait_sec}초 대기 후 재시도..."
        )
        time.sleep(wait_sec)

    logger.error(
        "❌ %d 회 재시도 후에도 KV 에서 요약 데이터를 가져오지 못함",
        max_attempts,
    )
    return None


def _acquire_send_lock(date: str, ttl_sec: int = 300) -> bool:
    """
    v2.9.2 보너스 2: KV 락(Lock) — 동시 발송 방지.

    같은 날 두 번 발송되는 것을 막는다. 사용자가 cron 발송 직후
    "지금 발송" 버튼을 누르거나, GitHub Actions 가 자동 재시도할 때 충돌 방지.

    Parameters
    ----------
    date : str
        오늘 KST YYYYMMDD.
    ttl_sec : int
        락 자동 만료 시간(초). 기본 5분.

    Returns
    -------
    bool
        True 면 락 획득 성공 → 계속 진행.
        False 면 다른 프로세스가 이미 발송 중 → 종료.
    """
    logger = logging.getLogger("briefing.main.send")
    try:
        # 락 키 조회 (이미 발송 중인지 확인)
        try:
            existing = _get_pipeline(
                f"/api/public/pipeline/lock?date={date}"
            )
            if existing.get("locked"):
                logger.warning(
                    "🔒 이미 발송 진행 중 (락 보유자=%s) — 종료",
                    existing.get("owner", "unknown"),
                )
                return False
        except FileNotFoundError:
            pass  # 락 없음 = 발송 가능

        # 락 획득 (실패해도 발송은 진행 — 호환성 우선)
        try:
            _post_pipeline(
                "/api/public/pipeline/lock",
                {"date": date, "owner": "stage3-send", "ttl": ttl_sec},
            )
            print(f"🔒 발송 락 획득 완료 (TTL {ttl_sec}초)")
        except Exception as exc:  # noqa: BLE001
            # 락 엔드포인트가 아직 배포 안 됐을 수 있음 — 경고만 남기고 진행
            logger.info(
                "락 엔드포인트 미지원 (%s) — 호환 모드로 진행", exc,
            )
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("락 획득 중 예외 (%s) — 호환 모드로 진행", exc)
        return True


def _release_send_lock(date: str) -> None:
    """v2.9.2: 발송 완료 후 락 해제 (실패해도 무시)."""
    try:
        _post_pipeline(
            "/api/public/pipeline/lock/release",
            {"date": date},
        )
    except Exception:  # noqa: BLE001
        pass


def _send_failure_alert_email(date: str, reason: str) -> None:
    """
    v2.9.2 보너스 1: A+B 모두 실패 시 관리자에게 간단한 실패 알림 메일 발송.

    Stage 2 결과 없이 Stage 3 가 실패하면 사용자가 모를 수 있으므로
    EMAIL_SENDER 본인에게 짧은 알림 메일을 보낸다 (Gmail SMTP 사용).
    """
    logger = logging.getLogger("briefing.main.send")
    try:
        from email.mime.text import MIMEText
        from email.mime.multipart import MIMEMultipart
        import smtplib

        sender = os.getenv("EMAIL_SENDER", "")
        password = os.getenv("EMAIL_APP_PASSWORD", "")
        if not sender or not password:
            logger.warning("EMAIL_SENDER/EMAIL_APP_PASSWORD 미설정 — 알림 생략")
            return

        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"⚠️ [Morning Stock AI] {date} 발송 실패 알림"
        msg["From"] = sender
        msg["To"] = sender  # 본인에게 발송

        body_text = (
            f"⚠️ Morning Stock AI 발송 실패\n\n"
            f"날짜: {date} (KST)\n"
            f"단계: Stage 3 (Send)\n"
            f"원인: {reason}\n\n"
            f"조치사항:\n"
            f"  1) GitHub Actions 로그 확인:\n"
            f"     https://github.com/wwwkoistkr/2026_04_21_-_-/actions\n"
            f"  2) Stage 1 (Collect), Stage 2 (Summarize) 실행 결과 확인\n"
            f"  3) 관리 대시보드에서 \"지금 발송\" 수동 시도:\n"
            f"     https://morning-stock-briefing.pages.dev\n\n"
            f"이 알림은 v2.9.2 자동 알림 시스템에서 발송되었습니다."
        )
        msg.attach(MIMEText(body_text, "plain", "utf-8"))

        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=15) as s:
            s.login(sender, password)
            s.sendmail(sender, [sender], msg.as_string())
        print(f"📨 관리자 실패 알림 메일 발송 완료 → {sender}")
    except Exception as exc:  # noqa: BLE001
        logger.warning("관리자 알림 메일 발송 실패 (%s) — 무시", exc)


def _record_retry_stats(date: str, attempts: int, success: bool) -> None:
    """v2.9.2 보너스 3: 재시도 통계 기록 (KV 에 저장, 실패 시 무시)."""
    try:
        _post_pipeline(
            "/api/public/pipeline/retry_stats",
            {
                "date": date,
                "attempts": attempts,
                "success": success,
                "stage": "send",
            },
        )
    except Exception:  # noqa: BLE001
        pass


def run_stage_send() -> int:
    """
    발송 단계 — KV 에서 요약 결과 가져와 이메일 발송.
    AI 호출 없으므로 여러 번 재시도 가능.

    v2.9.2 (2026-04-25): 옵션 A+B 하이브리드 안정화.
      - cron 06:25 → 06:40 KST (workflow yaml 에서 적용)
      - timeout 10 → 15분 (workflow yaml 에서 적용)
      - 재시도 4회 + 점진적 백오프 (60→90→120초)
      - 날짜 키 명시적 검증 (어제 데이터 재발송 방지)
      - KV 락 (동시 발송 방지)
      - 실패 시 관리자 Gmail 알림
      - 재시도 통계 KV 기록
    """
    logger = logging.getLogger("briefing.main.send")
    date = _kst_date_key()
    dry_run = _is_truthy(os.getenv("DRY_RUN"))

    print("=" * 70)
    print(f"📧 [Stage 3/3] Send v2.9.2 — {_today_label()} (key={date})"
          + (" [DRY_RUN]" if dry_run else ""))
    print("=" * 70)

    # 0) KV 락 획득 (동시 발송 방지)
    # DRY_RUN 모드에서는 락 검사 생략 (테스트 자유롭게 가능)
    if not dry_run:
        if not _acquire_send_lock(date):
            print("⏭️  다른 프로세스가 이미 발송 중 — 안전 종료")
            return 0  # 정상 종료 (실패 아님)

    try:
        # 1) 요약 결과 읽기 — v2.9.2: 재시도 + 점진적 백오프
        markdown: Optional[str] = _fetch_today_summary_with_retry(date)
        attempts_used = 1 if markdown else 4

        # 2) KV 실패 시 로컬 백업 시도 (기존 로직 유지)
        if not markdown:
            backup_path = _backup_path("summary", date, ext="md")
            if os.path.exists(backup_path):
                with open(backup_path, encoding="utf-8") as f:
                    markdown = f.read()
                print(f"📥 로컬 백업에서 {len(markdown):,}자 읽음")
            else:
                # ❌ 모든 시도 실패 — 관리자 알림 + 종료
                logger.error(
                    "요약 데이터를 어디서도 찾지 못함 (KV 4회 재시도 + 로컬 백업 부재). "
                    "Stage 2 먼저 실행 필요."
                )
                _safe_notify_error(
                    "send",
                    f"v2.9.2: KV 4회 재시도 실패 + 로컬 백업 없음 ({date})",
                )
                _record_retry_stats(date, attempts=4, success=False)
                _send_failure_alert_email(
                    date,
                    "Stage 2 결과를 KV/로컬 백업 어디서도 찾지 못했습니다. "
                    "Stage 2 가 실패했거나 06:40 KST 까지도 완료되지 못했습니다.",
                )
                return 1
        else:
            _record_retry_stats(date, attempts=attempts_used, success=True)

        # 3) 발송
        subject = f"🌅 Morning Stock AI — 일일 주식·반도체 브리핑 ({_today_label()})"
        try:
            from briefing.modules.email_sender import (
                build_html_email, resolve_recipients, send_email,
            )
        except Exception:
            logger.exception("email_sender 로드 실패")
            _safe_notify_error("send", "email_sender 로드 실패")
            return 1

        if dry_run:
            sender = os.getenv("EMAIL_SENDER", "(미설정)")
            final = resolve_recipients(sender=sender if "@" in sender else None)
            print(f"\n📬 DRY_RUN — 실제 발송 시 수신자 ({len(final)}명)")
            for r in final:
                print(f"  - {r}")
            # HTML 미리보기 저장
            preview_path = "/tmp/briefing_latest.html"
            with open(preview_path, "w", encoding="utf-8") as f:
                f.write(build_html_email(markdown, subject))
            print(f"💾 HTML 프리뷰: {preview_path}")
            _safe_notify_send(recipients=len(final), ok=True)
            return 0

        try:
            send_email(subject=subject, markdown_body=markdown)
        except Exception:
            logger.exception("이메일 발송 실패")
            _safe_notify_error("send", f"발송 실패: {sys.exc_info()[1]}")
            _send_failure_alert_email(
                date,
                f"메일 SMTP 발송 단계에서 예외 발생: {sys.exc_info()[1]}",
            )
            return 1

        # 수신자 수 조회해서 KV 에 기록
        try:
            sender = os.getenv("EMAIL_SENDER")
            recipients = resolve_recipients(sender=sender)
            _safe_notify_send(recipients=len(recipients), ok=True)
        except Exception as exc:  # noqa: BLE001
            logger.warning("발송 상태 업로드 실패(무시): %s", exc)

        print("\n✅ Stage 3 완료 (v2.9.2)")
        return 0
    finally:
        # 락 해제 (예외 발생해도 반드시 해제)
        if not dry_run:
            _release_send_lock(date)


# ═══════════════════════════════════════════════════════════════
# 백업/통지 유틸
# ═══════════════════════════════════════════════════════════════
def _backup_path(kind: str, date: str, ext: str = "json") -> str:
    """로컬 백업 파일 경로 — 작업 디렉터리 하위 ``/tmp/briefing_backup`` 에 저장."""
    root = os.getenv("BRIEFING_BACKUP_DIR", "/tmp/briefing_backup")
    os.makedirs(root, exist_ok=True)
    return os.path.join(root, f"{kind}_{date}.{ext}")


def _safe_notify_error(stage: str, error: str) -> None:
    """Stage 실패 시 KV 상태에 에러 기록 (실패해도 조용히 무시)."""
    try:
        date = _kst_date_key()
        if stage == "collected":
            endpoint = "/api/public/pipeline/collected"  # error 필드 지원 X → skip
            return  # collect 는 body 에 news 필요하므로 에러 기록은 스킵
        elif stage == "summary":
            _post_pipeline("/api/public/pipeline/summary",
                           {"date": date, "error": error})
        elif stage == "send":
            _post_pipeline("/api/public/pipeline/send",
                           {"date": date, "error": error})
    except Exception:  # noqa: BLE001
        pass


def _safe_notify_send(*, recipients: int, ok: bool) -> None:
    """발송 성공/실패 상태를 KV 에 기록 (실패해도 조용히 무시)."""
    try:
        date = _kst_date_key()
        _post_pipeline("/api/public/pipeline/send",
                       {"date": date, "recipients": recipients})
    except Exception:  # noqa: BLE001
        pass


# ═══════════════════════════════════════════════════════════════
# 하위 호환: 기존 단일 파이프라인 (stage=all, 또는 인자 없음)
# ═══════════════════════════════════════════════════════════════
def run_pipeline() -> int:
    """
    전체 브리핑 파이프라인 실행 (단일 프로세스 모드).

    v2.6.0 부터는 ``run_stage_collect → run_stage_summarize → run_stage_send``
    로 분리된 실행이 권장되지만, 로컬 테스트/수동 DRY RUN 을 위해 이 함수도 유지.
    """
    from briefing.collectors.aggregator import collect_all_data
    from briefing.modules.ai_summarizer import summarize_with_gemini
    from briefing.modules.email_sender import send_email
    from briefing.modules.formatter import format_data_for_ai

    logger = logging.getLogger("briefing.main")
    dry_run = _is_truthy(os.getenv("DRY_RUN"))
    today_str = _today_label()

    print("=" * 70)
    print(f"📊 일일 브리핑 파이프라인 시작 — {today_str}"
          + (" [DRY RUN]" if dry_run else ""))
    print("=" * 70)

    # 1) 수집
    try:
        data = collect_all_data()
    except Exception:
        logger.exception("수집 단계 치명적 오류")
        return 1
    if not data:
        logger.error("수집된 뉴스가 없습니다.")
        return 1

    # 2) 포맷팅
    ai_input_text = format_data_for_ai(data)
    print(f"\n📝 AI 입력 텍스트 길이: {len(ai_input_text):,} chars")

    # 3) AI 요약
    if dry_run and not os.getenv("GEMINI_API_KEY"):
        logger.warning("GEMINI_API_KEY 미설정 & DRY_RUN — 모의 요약 반환")
        markdown_summary = (
            "## 🔎 오늘의 한 줄 총평\n"
            "(DRY_RUN) Gemini API 를 호출하지 않은 테스트 실행입니다.\n\n"
            + "\n".join(
                f"### {i+1}. (샘플) {d['title'][:60]}\n"
                f"- **출처**: {d['source']}\n"
                f"- **원문 링크**: [바로가기]({d['link']})\n"
                for i, d in enumerate(data[:10])
            )
        )
    else:
        try:
            markdown_summary = summarize_with_gemini(
                briefing_input_text=ai_input_text,
                news_list=data,
            )
        except Exception:
            logger.exception("Gemini 요약 단계 실패")
            return 1

    print("\n" + "─" * 70)
    print("🤖 AI 요약 결과 (상단 700자 미리보기)")
    print("─" * 70)
    print(markdown_summary[:700] + ("..." if len(markdown_summary) > 700 else ""))
    print("─" * 70 + f"\n(총 {len(markdown_summary):,} chars)\n")

    # 4) 이메일 발송
    subject = f"🌅 Morning Stock AI — 일일 주식·반도체 브리핑 ({today_str})"
    if dry_run:
        from briefing.modules.email_sender import build_html_email, resolve_recipients
        sender = os.getenv("EMAIL_SENDER", "(미설정)")
        final_recipients = resolve_recipients(sender=sender if "@" in sender else None)
        print(f"\n📬 실제 발송 시 수신자 ({len(final_recipients)}명):")
        for r in final_recipients:
            print(f"  - {r}")
        preview_path = "/tmp/briefing_latest.html"
        with open(preview_path, "w", encoding="utf-8") as f:
            f.write(build_html_email(markdown_summary, subject))
        print(f"\n💾 HTML 프리뷰 저장: {preview_path}")
        return 0

    try:
        send_email(subject=subject, markdown_body=markdown_summary)
    except Exception:
        logger.exception("이메일 발송 실패")
        return 1

    print("\n✅ 파이프라인 완료")
    return 0


# ═══════════════════════════════════════════════════════════════
# CLI 엔트리포인트
# ═══════════════════════════════════════════════════════════════
STAGE_FUNCTIONS = {
    "collect":   run_stage_collect,
    "summarize": run_stage_summarize,
    "send":      run_stage_send,
    "all":       run_pipeline,
}


def main() -> int:
    logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)
    # 첫 번째 인자로 단계 지정 (기본 all)
    stage = sys.argv[1].strip().lower() if len(sys.argv) > 1 else "all"
    fn = STAGE_FUNCTIONS.get(stage)
    if not fn:
        print(
            f"❌ 알 수 없는 stage: '{stage}'. "
            f"사용 가능: {', '.join(STAGE_FUNCTIONS.keys())}",
            file=sys.stderr,
        )
        return 2
    try:
        return fn()
    except Exception:  # noqa: BLE001 - 최후 안전망
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
