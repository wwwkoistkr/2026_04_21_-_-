"""
[3단계] Gmail SMTP 기반 이메일 발송 모듈.

환경변수:
  - EMAIL_SENDER       : 보내는 Gmail 주소 (예: you@gmail.com)
  - EMAIL_APP_PASSWORD : Gmail 앱 비밀번호 (16자리)
  - EMAIL_RECIPIENTS   : 받는 이메일. 쉼표로 여러 개 가능 ("a@x.com,b@y.com")
  - BRIEFING_ADMIN_API : (선택) Hono 관리 콘솔 URL. 이 값이 있으면 관리 콘솔에
                         등록된 수신자도 함께 발송 대상에 포함됨.
  - BRIEFING_READ_TOKEN: (선택) 위 Hono API 호출 시 Bearer 토큰.

Markdown 으로 작성된 AI 브리핑을 예쁜 HTML 로 변환해 첨부 없이 본문 송신합니다.
"""
from __future__ import annotations

import logging
import os
import re
import smtplib
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import List, Optional

import requests

logger = logging.getLogger(__name__)


def fetch_recipients_from_admin(
    admin_api: Optional[str] = None,
    read_token: Optional[str] = None,
    timeout: int = 10,
) -> List[str]:
    """
    Hono 관리 콘솔에 등록된 활성 수신자 이메일 목록을 가져옵니다.
    실패 시 빈 리스트를 반환(파이프라인이 멈추지 않도록).
    """
    admin_api = admin_api or os.getenv("BRIEFING_ADMIN_API")
    read_token = read_token or os.getenv("BRIEFING_READ_TOKEN")

    if not admin_api:
        return []

    url = admin_api.rstrip("/") + "/api/public/recipients"
    headers = {"Accept": "application/json"}
    if read_token:
        headers["Authorization"] = f"Bearer {read_token}"

    try:
        logger.info("관리 콘솔에서 수신자 목록 요청: %s", url)
        resp = requests.get(url, headers=headers, timeout=timeout)
        resp.raise_for_status()
        data = resp.json()
        emails = data.get("recipients", [])
        logger.info("관리 콘솔 수신자 %d명 수신", len(emails))
        return [e for e in emails if isinstance(e, str) and "@" in e]
    except requests.HTTPError as exc:
        # (v2.2.4) 401/403 때 원인을 명확히 알려 - 과거엔 조용히 폴백하느라 관리UI에
        # 추가한 이메일이 무시되는 현상을 놓쳤음
        status = exc.response.status_code if exc.response is not None else None
        if status in (401, 403):
            logger.warning(
                "관리 콘솔 수신자 조회 401/403 — BRIEFING_READ_TOKEN 이 올바르지 않거나 "
                "BRIEFING_PUBLIC_TOKEN (백엔드 검증값) 과 일치하지 않습니다. "
                "→ 관리 UI에 추가한 수신자들이 이번 발송에서 '반영되지 않았습니다'. "
                "EMAIL_RECIPIENTS 환경변수만 사용됩니다."
            )
            print("⚠️  [관리콘솔 수신자] BRIEFING_READ_TOKEN 인증 실패 → 환경변수 수신자만 사용됨")
        else:
            logger.warning("관리 콘솔 수신자 조회 HTTP %s: %s", status, exc)
        return []
    except Exception as exc:  # noqa: BLE001
        logger.warning("관리 콘솔 수신자 조회 실패 (환경변수만 사용): %s", exc)
        return []


def resolve_recipients(
    recipients: Optional[List[str]] = None,
    sender: Optional[str] = None,
) -> List[str]:
    """
    최종 수신자 목록 결정 우선순위:
      1) 함수 인자로 직접 전달된 recipients
      2) 환경변수 EMAIL_RECIPIENTS (쉼표 구분)
      3) Hono 관리 콘솔의 /api/public/recipients
      4) 그래도 비어 있으면 sender (발신자 본인)에게 발송
    2) 와 3) 은 **합집합** 으로 처리하며 중복 제거합니다.
    """
    if recipients:
        return list(dict.fromkeys(recipients))

    collected: List[str] = []

    # 2) 환경변수
    env_recipients = os.getenv("EMAIL_RECIPIENTS", "")
    for r in env_recipients.split(","):
        r = r.strip()
        if r and "@" in r:
            collected.append(r)

    # 3) Hono 관리 콘솔
    admin_recipients = fetch_recipients_from_admin()
    collected.extend(admin_recipients)

    # 중복 제거 (순서 유지, 소문자 정규화)
    seen = set()
    result: List[str] = []
    for r in collected:
        key = r.strip().lower()
        if key and key not in seen:
            seen.add(key)
            result.append(r.strip())

    # 4) fallback: 본인
    if not result and sender:
        result = [sender]

    return result


# ---------------------------------------------------------------------------
# v2.5.0 카드형 Markdown → HTML 변환기
# ---------------------------------------------------------------------------
# 카테고리별 색상 (배지용)
_CATEGORY_COLORS = {
    "반도체": "#dc2626",      # 빨강
    "AI": "#7c3aed",          # 보라
    "미국증시": "#059669",    # 초록
    "한국증시": "#0284c7",    # 파랑
    "거시경제": "#d97706",    # 주황
    "기타": "#64748b",        # 회색
}


def _category_badge_html(category: str) -> str:
    color = _CATEGORY_COLORS.get(category, _CATEGORY_COLORS["기타"])
    return (
        f'<span style="display:inline-block;padding:3px 10px;border-radius:12px;'
        f'background:{color};color:#fff;font-size:11px;font-weight:600;'
        f'letter-spacing:.3px;">{category}</span>'
    )


def _inline_md(text: str) -> str:
    """인라인 **bold**, *italic*, [link](url) 처리."""
    text = re.sub(
        r"\[([^\]]+)\]\((https?://[^)]+)\)",
        r'<a href="\2" target="_blank" rel="noopener" '
        r'style="color:#1d4ed8;text-decoration:none;font-weight:600;">\1 ↗</a>',
        text,
    )
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", text)
    return text


def _render_news_card(item: dict) -> str:
    """v2.5.0: 뉴스 1건을 카드형 HTML 로 렌더링."""
    rank = item.get("rank", "")
    title = _inline_md(item.get("title", ""))
    meta = item.get("meta", {})  # {출처, 카테고리, 요약, 투자 시사점, 원문 링크}

    category = meta.get("카테고리", "기타")
    source = meta.get("출처", "")
    summary = _inline_md(meta.get("요약", ""))
    insight = _inline_md(meta.get("투자 시사점", ""))
    link_html = _inline_md(meta.get("원문 링크", ""))

    category_badge = _category_badge_html(category)
    rank_badge = (
        f'<span style="display:inline-block;width:28px;height:28px;line-height:28px;'
        f'border-radius:50%;background:linear-gradient(135deg,#1d4ed8,#0ea5e9);'
        f'color:#fff;text-align:center;font-weight:700;font-size:13px;'
        f'margin-right:10px;vertical-align:middle;">{rank}</span>'
    )

    return f"""
<div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;
            padding:18px 20px;margin:14px 0;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
  <div style="display:flex;align-items:center;margin-bottom:10px;">
    {rank_badge}{category_badge}
    <span style="margin-left:auto;font-size:12px;color:#64748b;">📰 {source}</span>
  </div>
  <h3 style="margin:6px 0 12px;font-size:17px;font-weight:700;color:#0f172a;line-height:1.4;">
    {title}
  </h3>
  <div style="background:#f8fafc;border-left:3px solid #0ea5e9;padding:10px 14px;
              margin:10px 0;border-radius:4px;font-size:14px;line-height:1.65;color:#334155;">
    <strong style="color:#0c4a6e;">📊 요약</strong><br/>
    {summary}
  </div>
  <div style="background:#fef3c7;border-left:3px solid #f59e0b;padding:10px 14px;
              margin:10px 0;border-radius:4px;font-size:14px;line-height:1.65;color:#78350f;">
    <strong style="color:#92400e;">💡 투자 시사점</strong><br/>
    {insight}
  </div>
  <div style="margin-top:12px;font-size:13px;">
    🔗 {link_html}
  </div>
</div>
"""


def _md_to_html(md: str) -> str:
    """
    v2.5.0 카드형 변환기.

    2단계 파이프라인 출력 구조를 인식하여 카드로 변환:
      ## 📈 헤더
      ### 1. 제목
        - **카테고리**: ...
        - **출처**: ...
        - **요약**: ...
        - **투자 시사점**: ...
        - **원문 링크**: [...](...)
      ---
      ### 2. 제목
      ...
      ## 🔎 오늘의 한 줄 총평
      본문

    섹션별로 다른 HTML 컴포넌트 렌더링.
    """
    html_lines: List[str] = []
    # 상태 머신: 현재 파싱 중인 뉴스 카드
    current_item: Optional[dict] = None
    in_overview = False
    header_rendered = False

    def flush_item():
        nonlocal current_item
        if current_item is not None:
            html_lines.append(_render_news_card(current_item))
            current_item = None

    lines = md.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        stripped = line.strip()

        # 구분선 --- 무시
        if stripped.startswith("---"):
            i += 1
            continue

        # 빈 줄
        if not stripped:
            i += 1
            continue

        # H2: ## 📈 헤더 또는 ## 🔎 총평
        h2 = re.match(r"^##\s+(.*)", line)
        if h2 and not h2.group(1).startswith("#"):
            flush_item()
            content = h2.group(1).strip()
            if "총평" in content:
                in_overview = True
                html_lines.append(f"""
<div style="background:linear-gradient(135deg,#fef3c7,#fde68a);border-radius:10px;
            padding:18px 22px;margin:24px 0 10px;">
  <h2 style="margin:0 0 10px;font-size:18px;color:#78350f;font-weight:700;">
    {_inline_md(content)}
  </h2>
""")
            elif not header_rendered:
                # 첫 H2 = 브리핑 타이틀
                header_rendered = True
                html_lines.append(
                    f'<h2 style="margin:0 0 12px;font-size:19px;color:#0f172a;'
                    f'font-weight:700;border-bottom:2px solid #e5e7eb;'
                    f'padding-bottom:10px;">{_inline_md(content)}</h2>'
                )
            else:
                html_lines.append(
                    f'<h2 style="margin:20px 0 10px;font-size:17px;color:#0f172a;'
                    f'font-weight:700;">{_inline_md(content)}</h2>'
                )
            i += 1
            continue

        # H3: ### 1. 제목 → 새 뉴스 카드 시작
        h3 = re.match(r"^###\s+(\d+)\.\s*(.+)", line)
        if h3:
            flush_item()
            in_overview = False
            current_item = {
                "rank": h3.group(1),
                "title": h3.group(2).strip(),
                "meta": {},
            }
            i += 1
            continue

        # 리스트 항목 "- **Key**: value" → 카드 메타 수집
        if current_item is not None:
            meta_match = re.match(
                r"^\s*[-*]\s+\*\*([^*]+?)\*\*\s*:\s*(.*)", line,
            )
            if meta_match:
                key = meta_match.group(1).strip()
                val = meta_match.group(2).strip()
                # 여러 줄 이어진 내용 지원 (다음 줄이 들여쓰기/목록 아님)
                j = i + 1
                while j < len(lines):
                    nxt = lines[j].rstrip()
                    if not nxt.strip():
                        break
                    if re.match(r"^\s*[-*]\s+", nxt) or re.match(r"^#", nxt):
                        break
                    val += " " + nxt.strip()
                    j += 1
                current_item["meta"][key] = val
                i = j
                continue

        # 총평 섹션 본문
        if in_overview:
            html_lines.append(
                f'<p style="margin:4px 0;font-size:15px;line-height:1.8;color:#78350f;">'
                f'{_inline_md(line)}</p>'
            )
            i += 1
            continue

        # 기타 일반 텍스트 (인트로 문단 등)
        flush_item()
        html_lines.append(
            f'<p style="margin:10px 0;font-size:14px;line-height:1.7;color:#475569;">'
            f'{_inline_md(line)}</p>'
        )
        i += 1

    flush_item()
    if in_overview:
        html_lines.append("</div>")  # 총평 박스 닫기

    return "\n".join(html_lines)


# ---------------------------------------------------------------------------
# HTML 템플릿
# ---------------------------------------------------------------------------
HTML_TEMPLATE = """\
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>{subject}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Apple SD Gothic Neo','Malgun Gothic',Helvetica,Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;">

          <!-- 헤더 카드 -->
          <tr><td>
            <div style="background:linear-gradient(135deg,#1d4ed8 0%,#0ea5e9 50%,#06b6d4 100%);
                        border-radius:14px 14px 0 0;padding:28px 32px;color:#fff;
                        box-shadow:0 4px 12px rgba(0,0,0,0.08);">
              <div style="font-size:11px;opacity:.85;letter-spacing:2px;font-weight:600;">
                MORNING STOCK AI · DAILY BRIEFING
              </div>
              <div style="font-size:24px;font-weight:700;margin-top:8px;">
                🌅 Morning Stock AI Briefing Center
              </div>
              <div style="font-size:14px;margin-top:6px;opacity:.95;">
                {today} · 주식·반도체 일일 브리핑
              </div>
              <div style="font-size:11px;margin-top:14px;opacity:.85;border-top:1px solid rgba(255,255,255,.2);
                          padding-top:10px;">
                📊 {meta_summary}
              </div>
            </div>
          </td></tr>

          <!-- 본문 카드 -->
          <tr><td style="background:#ffffff;padding:20px 28px;box-shadow:0 4px 12px rgba(0,0,0,0.04);">
            {body}
          </td></tr>

          <!-- 푸터 -->
          <tr><td style="background:#f8fafc;padding:20px 28px 24px;border-radius:0 0 14px 14px;
                         border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;line-height:1.6;
                         box-shadow:0 4px 12px rgba(0,0,0,0.04);">
            <div style="margin-bottom:8px;">
              📌 <strong>이 메일은 매일 오전 6시 30분(KST) GitHub Actions 에 의해 자동 발송됩니다.</strong>
            </div>
            <div style="margin-bottom:6px;">
              🗞️ <strong>원천 데이터</strong>: {sources_summary}
            </div>
            <div style="margin-bottom:6px;">
              🤖 <strong>요약 엔진</strong>: Google Gemini 2.5 Flash (2단계 파이프라인 v2.5.1)
            </div>
            <div style="margin-top:12px;padding-top:10px;border-top:1px dashed #cbd5e1;color:#94a3b8;">
              ⚠️ 본 브리핑은 정보 제공을 위한 참고용 자료이며, 투자 권유가 아닙니다.<br/>
              최종 투자 판단은 독자 본인의 책임 하에 이루어져야 합니다.
            </div>
          </td></tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
"""


def _extract_sources_from_markdown(md: str) -> str:
    """마크다운에서 카드별 출처를 추출해 요약 문자열 반환."""
    from collections import Counter
    sources = re.findall(r"\*\*출처\*\*\s*:\s*([^\n]+)", md)
    if not sources:
        return "한국경제 · 매일경제 · Seeking Alpha · ETF.com 등 주요 경제 매체"
    # 중복 제거, 최대 6개
    counter = Counter(s.strip() for s in sources)
    names = [name for name, _ in counter.most_common(6)]
    # 괄호 안의 부제목(예: "한국경제(증권)") 은 대표명만
    cleaned = []
    seen = set()
    for n in names:
        base = re.sub(r"\s*\([^)]*\)\s*", "", n).strip()
        if base and base not in seen:
            seen.add(base)
            cleaned.append(base)
    return " · ".join(cleaned[:5]) + (" 외" if len(counter) > 5 else "")


def _extract_meta_summary_from_markdown(md: str) -> str:
    """헤더에 표시할 카테고리 구성 문자열 추출."""
    m = re.search(r"\*\*오늘의 카테고리 구성\*\*\s*:\s*([^\n]+)", md)
    if m:
        return m.group(1).strip()
    # 폴백: 카드 수 세기
    n = len(re.findall(r"^###\s+\d+\.", md, re.MULTILINE))
    return f"오늘의 핵심 뉴스 {n}건"


def build_html_email(markdown_body: str, subject: str) -> str:
    """v2.5.0: KST 보정 날짜 + 카드형 + 동적 footer 를 포함한 HTML 이메일 생성."""
    try:
        from datetime import timezone, timedelta
        kst = timezone(timedelta(hours=9))
        now_kst = datetime.now(kst)
    except Exception:
        now_kst = datetime.now()
    weekday_kr = ["월", "화", "수", "목", "금", "토", "일"][now_kst.weekday()]
    today = now_kst.strftime(f"%Y년 %m월 %d일 ({weekday_kr})")

    return HTML_TEMPLATE.format(
        subject=subject,
        today=today,
        body=_md_to_html(markdown_body),
        meta_summary=_extract_meta_summary_from_markdown(markdown_body),
        sources_summary=_extract_sources_from_markdown(markdown_body),
    )


# ---------------------------------------------------------------------------
# SMTP 발송
# ---------------------------------------------------------------------------
def send_email(
    subject: str,
    markdown_body: str,
    recipients: Optional[List[str]] = None,
    sender: Optional[str] = None,
    app_password: Optional[str] = None,
    smtp_host: str = "smtp.gmail.com",
    smtp_port: int = 465,
) -> None:
    """
    Gmail SMTP(SSL) 를 통해 HTML 이메일을 발송합니다.

    v2.2.4 변경점
    -------------
    - ``sendmail()`` 반환값(거부된 수신자 dict)을 검사하여 **일부 실패도 에러로 보고**
    - 수신자별 결과를 명시적으로 로깅
    - Gmail 이 스팸 분류를 줄이도록 **Reply-To**, **Date**, **Message-ID**, **List-Unsubscribe**
      헤더를 추가
    - 발송 전/후 카운트 및 주소 마스킹(개인정보 보호) 로그

    Raises
    ------
    RuntimeError
        필수 환경변수 누락 / 모든 수신자 거부 / 일부 수신자 거부 시.
    smtplib.SMTPException
        SMTP 연결/인증 오류 발생 시.
    """
    sender = sender or os.getenv("EMAIL_SENDER")
    app_password = app_password or os.getenv("EMAIL_APP_PASSWORD")

    if not sender or not app_password:
        raise RuntimeError(
            "EMAIL_SENDER / EMAIL_APP_PASSWORD 환경변수가 필요합니다."
        )

    # 수신자 목록: 환경변수 + Hono 관리 콘솔 병합
    recipients = resolve_recipients(recipients=recipients, sender=sender)
    if not recipients:
        raise RuntimeError(
            "수신자가 없습니다. EMAIL_RECIPIENTS 환경변수 또는 관리 콘솔에 최소 1명 등록해야 합니다."
        )

    # (v2.2.4) 전체 수신자를 가시적으로 로깅 (개인정보 보호를 위해 부분 마스킹)
    masked = [_mask_email(r) for r in recipients]
    logger.info("최종 발송 대상: %d명 → %s", len(recipients), masked)
    print(f"📬 최종 발송 대상: {len(recipients)}명 → {', '.join(masked)}")
    # (v2.2.5) 도메인별 카운트 — 네이버/구글 도착 여부 분석을 쉽게
    from collections import Counter
    domain_counter = Counter(r.split("@", 1)[1].lower() if "@" in r else "?" for r in recipients)
    print(f"   도메인별: {dict(domain_counter)}")

    html_body = build_html_email(markdown_body, subject)

    logger.info("SMTP 연결: %s:%d", smtp_host, smtp_port)
    print(f"📡 SMTP 연결: {smtp_host}:{smtp_port}")

    # (v2.2.5) 🔴 핵심 변경: 수신자별 개별 발송
    # --------------------------------------------------------------
    # 과거 버그: bulk sendmail() 로 모든 수신자를 To: 에 넣어 전송했더니
    #  1) Gmail → Naver 전달 시 "To: 여러 명" 패턴이 스팸 점수를 급격히 올렸고,
    #  2) 네이버는 외부 도메인으로부터 받은 다중 수신자 메일을 기본적으로 스팸 폴더로 보냄.
    #
    # v2.2.5 부터는 각 수신자에게 **개별 To:** 로 발송 → 받는 사람이 자신을 유일한
    # 수신자로 인식 → 스팸 분류 확률이 크게 낮아짐 (Naver/Daum/Kakao 메일에 효과적).
    # --------------------------------------------------------------
    accepted: List[str] = []
    rejected_report: List[dict] = []

    try:
        with smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=30) as server:
            server.login(sender, app_password)

            for idx, recipient in enumerate(recipients, start=1):
                # 수신자마다 새 MIMEMessage 생성 (To 헤더가 본인만 나오도록)
                msg = MIMEMultipart("alternative")
                msg["Subject"] = subject
                msg["From"] = sender
                msg["To"] = recipient
                msg["Reply-To"] = sender
                msg["Date"] = datetime.utcnow().strftime("%a, %d %b %Y %H:%M:%S +0000")
                msg["List-Unsubscribe"] = f"<mailto:{sender}?subject=unsubscribe>"
                msg["X-Mailer"] = "MorningStockAI-BriefingCenter/2.5.0"
                # 고유 Message-ID — 중복 메일 탐지 방지
                msg["Message-ID"] = f"<msaic-{int(datetime.utcnow().timestamp()*1000)}-{idx}@{sender.split('@')[-1]}>"

                # 텍스트 + HTML 동시 첨부 (네이버는 text/plain 도 잘 체크함)
                msg.attach(MIMEText(markdown_body, "plain", "utf-8"))
                msg.attach(MIMEText(html_body, "html", "utf-8"))

                try:
                    refused = server.sendmail(sender, [recipient], msg.as_string())
                    if refused:
                        # 개별 발송인데 refused 가 차있는 경우 — 이 수신자가 거부됨
                        code, reason = (0, "unknown")
                        if recipient in refused:
                            v = refused[recipient]
                            if isinstance(v, tuple):
                                code = v[0]
                                reason = v[1].decode('utf-8', 'replace') if isinstance(v[1], (bytes, bytearray)) else str(v[1])
                        rejected_report.append({"recipient": recipient, "code": code, "reason": reason})
                        print(f"   {idx}/{len(recipients)}. ❌ {_mask_email(recipient)} → SMTP {code}: {reason}")
                    else:
                        accepted.append(recipient)
                        print(f"   {idx}/{len(recipients)}. ✅ {_mask_email(recipient)} 수락됨")
                except smtplib.SMTPRecipientsRefused as exc:
                    info = exc.recipients.get(recipient) if hasattr(exc, 'recipients') else None
                    code, reason = (info[0], info[1].decode('utf-8', 'replace')) if info else (0, str(exc))
                    rejected_report.append({"recipient": recipient, "code": code, "reason": reason})
                    print(f"   {idx}/{len(recipients)}. ❌ {_mask_email(recipient)} → SMTP {code}: {reason}")
                except smtplib.SMTPDataError as exc:
                    rejected_report.append({"recipient": recipient, "code": exc.smtp_code, "reason": str(exc.smtp_error)})
                    print(f"   {idx}/{len(recipients)}. ❌ {_mask_email(recipient)} → SMTP {exc.smtp_code}: {exc.smtp_error}")
                except Exception as exc:  # noqa: BLE001
                    rejected_report.append({"recipient": recipient, "code": -1, "reason": str(exc)})
                    print(f"   {idx}/{len(recipients)}. ❌ {_mask_email(recipient)} → 기타 오류: {exc}")
    except smtplib.SMTPAuthenticationError as exc:
        hint = (
            " Gmail 앱 비밀번호(16자리)가 올바른지 확인하세요. "
            "일반 비밀번호는 사용할 수 없으며, 2단계 인증이 활성화되어 있어야 합니다."
        )
        logger.error("SMTP 인증 실패: %s%s", exc, hint)
        raise RuntimeError(f"SMTP 인증 실패: {exc}.{hint}") from exc

    # 결과 요약
    print("")
    print(f"📊 발송 결과: 수락 {len(accepted)}/{len(recipients)}, 거부 {len(rejected_report)}")
    if accepted:
        print(f"   ✅ 수락: {', '.join(_mask_email(r) for r in accepted)}")
    if rejected_report:
        print(f"   ❌ 거부: {[_mask_email(r['recipient']) for r in rejected_report]}")
        for item in rejected_report:
            print(f"      • {_mask_email(item['recipient'])} → SMTP {item['code']}: {item['reason']}")

    logger.info("메일 발송 완료: %d/%d 수락, %d 거부", len(accepted), len(recipients), len(rejected_report))

    # (v2.2.7) 발송 이력을 Hono Worker 에 POST — 관리 UI 에서 수신자별 "마지막 발송 시간" 표시용
    _report_recipient_events(accepted, rejected_report)

    # 모두 거부된 경우에만 예외
    if not accepted:
        raise RuntimeError(
            "모든 수신자가 SMTP 서버에 의해 거부되었습니다. 위 로그의 SMTP 코드/사유를 확인하세요. "
            "Gmail 앱 비밀번호 만료 또는 발신자 주소 문제일 가능성이 높습니다."
        )

    print("   💡 메일이 안 보이면 스팸/프로모션 폴더를 확인해 주세요.")
    print("   💡 네이버 메일 사용자: '이 메일을 스팸이 아님으로 설정' + 발신자를 '안전 발신인' 에 등록")


def _report_recipient_events(accepted: List[str], rejected: List[dict]) -> None:
    """
    (v2.2.7) Hono Worker 에 발송 이벤트 POST — 관리 UI 수신자 카드에
    '마지막 발송 일시' / '누적 성공/실패 횟수' / '최근 실패 사유' 를 표시하기 위함.
    네트워크 장애·토큰 오류로 실패해도 파이프라인은 영향 없이 계속 진행.
    """
    admin_api = os.getenv("BRIEFING_ADMIN_API")
    read_token = os.getenv("BRIEFING_READ_TOKEN")
    if not admin_api:
        return
    now_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    events = [{"email": e, "success": True, "sentAt": now_iso} for e in accepted]
    for item in rejected:
        events.append({
            "email": item.get("recipient"),
            "success": False,
            "reason": f"SMTP {item.get('code')}: {item.get('reason', '')}"[:200],
            "sentAt": now_iso,
        })
    if not events:
        return
    url = admin_api.rstrip("/") + "/api/public/recipient-events"
    headers = {"Content-Type": "application/json"}
    if read_token:
        headers["Authorization"] = f"Bearer {read_token}"
    try:
        resp = requests.post(url, headers=headers, json={"events": events}, timeout=5)
        if resp.ok:
            data = resp.json()
            logger.info("발송 이벤트 리포트: %d건 업데이트", data.get("updated", 0))
            print(f"   📊 발송 이력 기록됨: {data.get('updated', 0)}건 (관리 UI 에서 확인)")
        else:
            logger.warning("발송 이벤트 리포트 실패 HTTP %s", resp.status_code)
    except Exception as exc:  # noqa: BLE001
        logger.warning("발송 이벤트 리포트 네트워크 오류: %s", exc)


def _mask_email(email: str) -> str:
    """개인정보 보호용 이메일 부분 마스킹: abcdef@gmail.com → ab***f@gmail.com"""
    try:
        local, _, domain = email.partition("@")
        if not domain:
            return email
        if len(local) <= 3:
            masked = local[:1] + "***"
        else:
            masked = local[:2] + "***" + local[-1]
        return f"{masked}@{domain}"
    except Exception:  # noqa: BLE001
        return email


# ---------------------------------------------------------------------------
# 단독 테스트 (자격 증명 필요)
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import sys

    sample_md = """## 🔎 오늘의 한 줄 총평
SK하이닉스의 HBM 실적 기대감이 시장을 견인하는 가운데, 미국 반도체주는 혼조세.

### 1. SK하이닉스, 사상 첫 '120만닉스' 돌파
- **출처**: 한국경제
- **요약**: 사상 최고가를 갈아치우며 역대급 실적 기대감이 반영되고 있습니다.
- **투자 시사점**: HBM 업사이클의 수혜를 직접 본다.
- **원문 링크**: [바로가기](https://hankyung.com/x)
"""
    html = build_html_email(sample_md, "[테스트] 일일 브리핑")
    # 샘플 HTML 을 파일로 저장해 브라우저로 확인할 수 있게
    out = "/tmp/briefing_preview.html"
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"HTML 프리뷰 저장: {out}")

    if "--send" in sys.argv:
        send_email("[테스트] 일일 브리핑", sample_md)
    else:
        print("실제 발송은 `python -m briefing.modules.email_sender --send` 사용.")
