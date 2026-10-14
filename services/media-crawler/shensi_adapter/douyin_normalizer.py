"""Closed, bounded normalization for the private Douyin crawler boundary."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import UTC, datetime
from typing import Iterable, Mapping
from urllib.parse import quote

from .schemas import NormalizedDouyinRecord


def _text(value: object, maximum: int) -> str:
    return "" if value is None else "".join(list(str(value).strip())[:maximum])


def _observed(raw: Mapping[str, object], fallback: datetime) -> datetime:
    value = raw.get("create_time")
    if isinstance(value, (int, float)) and 0 < value < 4_102_444_800:
        return datetime.fromtimestamp(value, UTC)
    return fallback


def _hash(payload: Mapping[str, object]) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":")).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _mapping(value: object) -> Mapping[str, object]:
    return value if isinstance(value, Mapping) else {}


def _actor_id(raw: Mapping[str, object], nested_key: str) -> str:
    nested = _mapping(raw.get(nested_key))
    # Nested actors belong to this record; flattened fields are supported only
    # for the adapter/store format that has no nested actor.
    actor = nested if nested else raw
    value = _text(
        actor.get("sec_uid") or actor.get("sec_user_id")
        or actor.get("user_id") or actor.get("uid"),
        300,
    )
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,300}", value):
        raise ValueError("invalid_douyin_actor")
    return value


def _record(kind: str, raw: Mapping[str, object], observed_at: datetime):
    keyword = _text(raw.get("source_keyword"), 100)
    nested_actor = _mapping(raw.get("user") if kind == "comment" else raw.get("author"))
    display_name = _text(
        (nested_actor.get("nickname") if nested_actor else
         raw.get("nickname") or raw.get("display_name")) or "Douyin", 200,
    )
    profile_url = None
    actor_kind = None
    if kind == "video":
        upstream_id = _text(raw.get("aweme_id"), 160)
        url = _text(raw.get("aweme_url"), 2_000) or f"https://www.douyin.com/video/{quote(upstream_id)}"
        excerpt = _text(raw.get("title") or raw.get("desc"), 500)
    elif kind == "comment":
        upstream_id = _text(raw.get("comment_id") or raw.get("cid"), 160)
        aweme_id = _text(raw.get("aweme_id"), 160)
        url = f"https://www.douyin.com/video/{quote(aweme_id)}"
        actor_id = _actor_id(raw, "user")
        profile_url = f"https://www.douyin.com/user/{quote(actor_id, safe='')}"
        actor_kind = "commenter"
        excerpt = _text(raw.get("content") or raw.get("text"), 500)
    elif kind == "creator":
        upstream_id = _actor_id(raw, "author")
        profile_url = f"https://www.douyin.com/user/{quote(upstream_id, safe='')}"
        aweme_id = _text(raw.get("aweme_id"), 160)
        url = (f"https://www.douyin.com/video/{quote(aweme_id, safe='')}"
               if re.fullmatch(r"[A-Za-z0-9_-]{1,160}", aweme_id)
               else profile_url)
        actor_kind = "creator"
        excerpt = _text(raw.get("signature") or raw.get("desc"), 500)
    else:
        raise ValueError("unsupported_douyin_record_kind")
    if not upstream_id or not url.startswith("https://www.douyin.com/"):
        raise ValueError("invalid_douyin_record")
    identity = _hash({"kind": kind, "upstream_id": upstream_id})
    content = {
        "record_id": f"{kind}:{identity[7:]}", "kind": kind,
        "actor_kind": actor_kind,
        "canonical_url": url, "public_display_name": display_name,
        "public_profile_url": profile_url, "text_excerpt": excerpt,
        "source_keyword": keyword,
    }
    return NormalizedDouyinRecord(
        **content,
        observed_at=_observed(raw, observed_at),
        content_hash=_hash(content),
    )


def normalize_douyin_records(
    values: Iterable[tuple[str, Mapping[str, object]]],
    *, observed_at: datetime | None = None,
) -> list[NormalizedDouyinRecord]:
    """Normalize only allowlisted public fields; unknown/raw fields disappear."""
    fallback = observed_at or datetime.now(UTC)
    result: list[NormalizedDouyinRecord] = []
    identities: set[str] = set()
    for kind, raw in values:
        record = _record(kind, raw, fallback)
        if record.record_id not in identities:
            identities.add(record.record_id)
            result.append(record)
    return result
