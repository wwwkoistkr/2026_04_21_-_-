from __future__ import annotations

import os
import re
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
from time import struct_time
from typing import Any, Dict, Optional

KST = timezone(timedelta(hours=9))
STALE_YEAR_RE = re.compile(r"\b(20[0-9]{2})\b")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except Exception:
        return default


def max_article_age_hours() -> int:
    return max(1, _env_int("ARTICLE_MAX_AGE_HOURS", 72))


def allow_undated_articles() -> bool:
    return (os.getenv("ARTICLE_ALLOW_UNDATED", "true").strip().lower()
            in {"1", "true", "yes", "y", "on"})


def now_kst() -> datetime:
    return datetime.now(KST)


def parse_entry_datetime(entry: Any) -> Optional[datetime]:
    for attr in ("published_parsed", "updated_parsed"):
        value = getattr(entry, attr, None)
        if isinstance(value, struct_time):
            return datetime(*value[:6], tzinfo=timezone.utc).astimezone(KST)

    for attr in ("published", "updated", "created"):
        value = getattr(entry, attr, None)
        parsed = parse_datetime(value)
        if parsed:
            return parsed
    return None


def parse_datetime(value: Any) -> Optional[datetime]:
    if not value:
        return None
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, struct_time):
        dt = datetime(*value[:6], tzinfo=timezone.utc)
    else:
        text = str(value).strip()
        if not text:
            return None
        try:
            dt = parsedate_to_datetime(text)
        except Exception:
            try:
                dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
            except Exception:
                return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(KST)


def freshness_metadata(published_at: Optional[datetime], *, now: Optional[datetime] = None) -> Dict[str, Any]:
    current = now or now_kst()
    if published_at is None:
        return {
            "published_at": "",
            "age_hours": None,
            "freshness": "undated",
            "stale_reason": "published date missing",
        }

    age = (current - published_at).total_seconds() / 3600
    max_age = max_article_age_hours()
    if age < -6:
        freshness = "future"
        reason = f"published time is {-age:.1f}h in future"
    elif age <= 24:
        freshness = "today"
        reason = ""
    elif age <= max_age:
        freshness = "recent"
        reason = ""
    else:
        freshness = "stale"
        reason = f"older than {max_age}h"

    return {
        "published_at": published_at.isoformat(),
        "age_hours": round(age, 1),
        "freshness": freshness,
        "stale_reason": reason,
    }


def is_recent_enough(item: Dict[str, Any], *, now: Optional[datetime] = None) -> bool:
    meta = freshness_metadata(parse_datetime(item.get("published_at")), now=now)
    freshness = item.get("freshness") or meta["freshness"]
    if freshness in {"today", "recent", "future"}:
        return True
    if freshness == "undated":
        return allow_undated_articles()
    return False


def mentions_old_year(text: str, *, current_year: Optional[int] = None) -> bool:
    year = current_year or now_kst().year
    for match in STALE_YEAR_RE.finditer(text or ""):
        try:
            if int(match.group(1)) < year:
                return True
        except ValueError:
            continue
    return False


def is_text_stale_signal(item: Dict[str, Any], *, current_year: Optional[int] = None) -> bool:
    title = item.get("title", "")
    summary = item.get("summary", "")
    return mentions_old_year(f"{title}\n{summary}", current_year=current_year)
