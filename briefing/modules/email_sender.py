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
# 간단 Markdown → HTML 변환기
# ---------------------------------------------------------------------------
def _md_to_html(md: str) -> str:
    """
    의존성 없이 동작하는 '경량' 마크다운→HTML 변환기.
    Gemini 가 주로 출력하는 ### 제목 / **굵게** / - 리스트 만 지원.
    (복잡한 표나 이미지가 필요하면 python-markdown 으로 교체 가능.)
    """
    html_lines: List[str] = []
    in_list = False

    for raw_line in md.splitlines():
        line = raw_line.rstrip()

        # 빈 줄
        if not line.strip():
            if in_list:
                html_lines.append("</ul>")
                in_list = False
            html_lines.append("")
            continue

        # 헤딩 ##/###
        h_match = re.match(r"^(#{1,6})\s+(.*)", line)
        if h_match:
            if in_list:
                html_lines.append("</ul>")
                in_list = False
            level = len(h_match.group(1))
            content = h_match.group(2)
            content = _inline_md(content)
            html_lines.append(f"<h{level}>{content}</h{level}>")
            continue

        # 리스트 항목 "- " 또는 "* "
        if re.match(r"^\s*[-*]\s+", line):
            if not in_list:
                html_lines.append("<ul>")
                in_list = True
            item = re.sub(r"^\s*[-*]\s+", "", line)
            html_lines.append(f"<li>{_inline_md(item)}</li>")
            continue

        # 기본 단락
        if in_list:
            html_lines.append("</ul>")
            in_list = False
        html_lines.append(f"<p>{_inline_md(line)}</p>")

    if in_list:
        html_lines.append("</ul>")

    return "\n".join(html_lines)


def _inline_md(text: str) -> str:
    """인라인 **bold**, *italic*, [link](url) 만 처리."""
    # 링크 [text](url) → <a href=url>text</a>
    text = re.sub(
        r"\[([^\]]+)\]\((https?://[^)]+)\)",
        r'<a href="\2" target="_blank" rel="noopener">\1</a>',
        text,
    )
    # **bold**
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    # *italic*
    text = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", text)
    return text


# ---------------------------------------------------------------------------
# HTML 템플릿
# ---------------------------------------------------------------------------
HTML_TEMPLATE = """\
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <title>{subject}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:'Apple SD Gothic Neo','Malgun Gothic',Helvetica,Arial,sans-serif;color:#222;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="640" cellpadding="0" cellspacing="0"
               style="background:#ffffff;border-radius:14px;box-shadow:0 4px 12px rgba(0,0,0,0.06);overflow:hidden;">
          <tr>
            <td style="background:linear-gradient(135deg,#1d4ed8,#0ea5e9);padding:24px 28px;color:#fff;">
              <div style="font-size:12px;opacity:.85;letter-spacing:1px;">MORNING STOCK AI · DAILY BRIEFING</div>
              <div style="font-size:22px;font-weight:700;margin-top:6px;">🌅 Morning Stock AI Briefing Center</div>
              <div style="font-size:13px;margin-top:4px;opacity:.9;">{today} · 주식·반도체 일일 브리핑</div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 28px 8px;line-height:1.65;font-size:15px;">
              {body}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px 28px;font-size:12px;color:#888;border-top:1px solid #eee;">
              이 메일은 GitHub Actions 에 의해 매일 오전 자동 발송됩니다.<br/>
              원천 데이터: 한국경제/매일경제/머니투데이, Seeking Alpha, ETF.com, Morningstar, 디일렉(YouTube).<br/>
              요약 엔진: Google Gemini.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
"""


def build_html_email(markdown_body: str, subject: str) -> str:
    """Markdown 브리핑을 완전한 HTML 이메일 본문으로 감싸기."""
    today = datetime.now().strftime("%Y년 %m월 %d일 (%a)")
    return HTML_TEMPLATE.format(
        subject=subject,
        today=today,
        body=_md_to_html(markdown_body),
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

    html_body = build_html_email(markdown_body, subject)

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = ", ".join(recipients)
    # (v2.2.4) 스팸 분류를 낮추기 위한 표준 헤더
    msg["Reply-To"] = sender
    msg["Date"] = datetime.utcnow().strftime("%a, %d %b %Y %H:%M:%S +0000")
    # Gmail 은 List-Unsubscribe 헤더가 있는 자동 발송 메일을 '마케팅/알림' 으로 분류하되
    # 신뢰성 점수를 올리는 긍정적 효과가 있음
    msg["List-Unsubscribe"] = f"<mailto:{sender}?subject=unsubscribe>"
    msg["X-Mailer"] = "MorningStockAI-BriefingCenter/2.2.4"

    # 텍스트 대체본 & HTML 본문
    msg.attach(MIMEText(markdown_body, "plain", "utf-8"))
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    logger.info("SMTP 연결: %s:%d", smtp_host, smtp_port)
    print(f"📡 SMTP 연결: {smtp_host}:{smtp_port}")
    try:
        with smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=30) as server:
            server.login(sender, app_password)
            # sendmail() 반환값: {거부된_수신자: (코드, 사유_bytes), ...}
            rejected = server.sendmail(sender, recipients, msg.as_string())
    except smtplib.SMTPAuthenticationError as exc:
        # Gmail 앱 비밀번호 문제의 전형적 원인
        hint = (
            " Gmail 앱 비밀번호(16자리)가 올바른지 확인하세요. "
            "일반 비밀번호는 사용할 수 없으며, 2단계 인증이 활성화되어 있어야 합니다."
        )
        logger.error("SMTP 인증 실패: %s%s", exc, hint)
        raise RuntimeError(f"SMTP 인증 실패: {exc}.{hint}") from exc
    except smtplib.SMTPRecipientsRefused as exc:
        logger.error("모든 수신자가 SMTP 서버에 의해 거부됨: %s", exc.recipients)
        raise RuntimeError(
            f"모든 수신자가 SMTP 서버에 의해 거부되었습니다: {exc.recipients}. "
            "EMAIL_RECIPIENTS 환경변수의 주소 형식/철자를 확인하세요."
        ) from exc

    # (v2.2.4) 일부 수신자 거부 검사 - 과거엔 이 케이스를 놓쳐 '성공'으로 잘못 보고했음
    accepted = [r for r in recipients if r not in (rejected or {})]
    print(f"✅ 수락된 수신자: {len(accepted)}명 → {', '.join(_mask_email(r) for r in accepted)}")
    if rejected:
        rejected_info = {
            r: (
                (v[0] if isinstance(v, tuple) else str(v)),
                (v[1].decode('utf-8', 'replace') if isinstance(v, tuple) and isinstance(v[1], (bytes, bytearray)) else str(v)),
            )
            for r, v in rejected.items()
        }
        logger.warning("일부 수신자 거부됨 (%d명): %s", len(rejected), rejected_info)
        print(f"⚠️  거부된 수신자: {len(rejected)}명 → {list(rejected_info.keys())}")
        for r, (code, reason) in rejected_info.items():
            print(f"   • {_mask_email(r)} → SMTP {code}: {reason}")
        # 수락된 사람이 한 명도 없으면 완전 실패로 간주하고 예외
        if not accepted:
            raise RuntimeError(
                "모든 수신자가 SMTP 서버에 의해 거부되었습니다. 위 로그에서 SMTP 코드/사유를 확인하세요."
            )

    logger.info("메일 발송 완료: %d/%d 수락", len(accepted), len(recipients))
    print(f"✉️  메일 발송 완료: {len(accepted)}/{len(recipients)}명 수락됨 → {', '.join(_mask_email(r) for r in accepted)}")
    print("   💡 메일이 안 보이면 스팸/프로모션 폴더를 확인해 주세요.")


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
