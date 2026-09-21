"""Fail-closed Douyin account identity binding at the browser boundary.

Only a one-way fingerprint and a public nickname leave this module.  The raw
``sec_uid`` is intentionally kept inside the short-lived browser worker and is
never returned by the private HTTP API or written to profile metadata.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import re
from urllib.parse import parse_qsl, urljoin, urlsplit


_CURRENT_ACCOUNT_PROFILE_LINKS = (
    '[class~="tab-user_self"] a[href], '
    'a[class~="tab-user_self"][href]'
)
_HEADER_PROFILE_LINKS = (
    'header a[href], nav a[href], [role="navigation"] a[href], '
    '[data-e2e="douyin-header"] a[href], #douyin-header a[href]'
)
_PROFILE_NAME_SELECTORS = (
    '[data-e2e="user-info"] [data-e2e="user-name"]',
    '[data-e2e="user-info"] h1',
    '[data-e2e="user-detail"] h1',
    'main [data-e2e="user-name"]',
    'main h1',
)
_PROFILE_PATH = re.compile(r"/user/([A-Za-z0-9_-]{1,300})")
_FINGERPRINT = re.compile(r"[0-9a-f]{64}")
_GENERIC_LABELS = frozenset({
    "个人主页", "我的主页", "我的", "我", "用户头像", "头像", "账号", "抖音",
    "打开个人主页", "profile", "my profile", "user avatar", "avatar",
})


class DouyinAccountIdentityFailure(RuntimeError):
    """Closed code only; raw DOM values must never be included in errors."""


@dataclass(frozen=True)
class DouyinAccountIdentity:
    fingerprint: str
    display_name: str


def _normalized_display_name(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = " ".join(value.split()).strip()
    if (not normalized or len(normalized) > 100
            or normalized.casefold() in _GENERIC_LABELS):
        return None
    return normalized


def _raw_sec_uid_from_href(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        target = urlsplit(urljoin("https://www.douyin.com/", value))
        if (target.scheme != "https" or target.hostname != "www.douyin.com"
                or target.port not in {None, 443}
                or target.username is not None or target.password is not None
                or target.fragment):
            return None
        if target.query:
            if len(target.query) > 200:
                return None
            query = parse_qsl(
                target.query,
                keep_blank_values=True,
                strict_parsing=True,
                max_num_fields=2,
            )
            if (len(query) != 1 or query[0][0] != "from_nav"
                    or re.fullmatch(
                        r"[A-Za-z0-9_-]{1,100}", query[0][1]
                    ) is None):
                return None
    except ValueError:
        return None
    matched = _PROFILE_PATH.fullmatch(target.path)
    return matched.group(1) if matched else None


def identity_fingerprint_for_raw_sec_uid(raw_sec_uid: str) -> str:
    """Return a platform-scoped one-way digest without retaining the input."""
    if not isinstance(raw_sec_uid, str) or not raw_sec_uid:
        raise DouyinAccountIdentityFailure("douyin_account_identity_missing")
    return hashlib.sha256(
        f"douyin:sec_uid:{raw_sec_uid}".encode("utf-8")
    ).hexdigest()


def account_handle_for_fingerprint(fingerprint: str) -> str:
    if _FINGERPRINT.fullmatch(fingerprint) is None:
        raise DouyinAccountIdentityFailure("douyin_account_identity_missing")
    return f"dyacct_{fingerprint}"


def account_handle_for_raw_sec_uid(raw_sec_uid: str) -> str:
    return account_handle_for_fingerprint(
        identity_fingerprint_for_raw_sec_uid(raw_sec_uid)
    )


def is_bound_account_handle(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(
        r"dyacct_[0-9a-f]{64}", value
    ) is not None


def _visible_text(element: object) -> str | None:
    try:
        if not element.is_visible(timeout=500):  # type: ignore[attr-defined]
            return None
        return _normalized_display_name(
            element.inner_text(timeout=500)  # type: ignore[attr-defined]
        )
    except Exception:
        return None


def _identity_candidates_for_selector(
    page: object, selector: str,
) -> tuple[set[str], set[str], int]:
    raw_ids: set[str] = set()
    names: set[str] = set()
    try:
        anchors = page.locator(selector)  # type: ignore[attr-defined]
        count = min(anchors.count(), 50)
    except Exception:
        return raw_ids, names, 0
    visible_count = 0
    for index in range(count):
        anchor = anchors.nth(index)
        try:
            if not anchor.is_visible(timeout=500):
                continue
            visible_count += 1
            raw_sec_uid = _raw_sec_uid_from_href(
                anchor.get_attribute("href")
            )
        except Exception:
            continue
        if raw_sec_uid is None:
            continue
        raw_ids.add(raw_sec_uid)
        for attribute in ("title", "aria-label"):
            try:
                name = _normalized_display_name(
                    anchor.get_attribute(attribute)
                )
            except Exception:
                name = None
            if name:
                names.add(name)
        text = _visible_text(anchor)
        if text:
            names.add(text)
        try:
            images = anchor.locator("img[alt]")
            image_count = min(images.count(), 3)
        except Exception:
            image_count = 0
        for image_index in range(image_count):
            try:
                image_name = _normalized_display_name(
                    images.nth(image_index).get_attribute("alt")
                )
            except Exception:
                image_name = None
            if image_name:
                names.add(image_name)
    return raw_ids, names, visible_count


def _header_identity_candidates(page: object) -> tuple[set[str], set[str]]:
    current_ids, current_names, current_visible = (
        _identity_candidates_for_selector(
            page, _CURRENT_ACCOUNT_PROFILE_LINKS
        )
    )
    if current_visible:
        return current_ids, current_names
    raw_ids, names, _visible = _identity_candidates_for_selector(
        page, _HEADER_PROFILE_LINKS
    )
    return raw_ids, names


def _profile_page_display_name(page: object, profile_url: str) -> str:
    try:
        if str(page.url) != profile_url:  # type: ignore[attr-defined]
            page.goto(  # type: ignore[attr-defined]
                profile_url,
                wait_until="domcontentloaded",
                timeout=15_000,
            )
        if str(page.url) != profile_url:  # type: ignore[attr-defined]
            raise DouyinAccountIdentityFailure(
                "douyin_account_identity_changed"
            )
    except DouyinAccountIdentityFailure:
        raise
    except Exception:
        raise DouyinAccountIdentityFailure(
            "douyin_account_display_name_missing"
        ) from None
    names: set[str] = set()
    for selector in _PROFILE_NAME_SELECTORS:
        try:
            candidates = page.locator(selector)  # type: ignore[attr-defined]
            count = min(candidates.count(), 10)
        except Exception:
            continue
        for index in range(count):
            name = _visible_text(candidates.nth(index))
            if name:
                names.add(name)
    if not names:
        raise DouyinAccountIdentityFailure(
            "douyin_account_display_name_missing"
        )
    if len(names) != 1:
        raise DouyinAccountIdentityFailure(
            "douyin_account_display_name_ambiguous"
        )
    return next(iter(names))


def extract_douyin_account_identity(page: object) -> DouyinAccountIdentity:
    """Extract one exact own-profile binding from constrained account chrome."""
    raw_ids, names = _header_identity_candidates(page)
    if not raw_ids:
        raise DouyinAccountIdentityFailure(
            "douyin_account_identity_missing"
        )
    if len(raw_ids) != 1:
        raise DouyinAccountIdentityFailure(
            "douyin_account_identity_ambiguous"
        )
    raw_sec_uid = next(iter(raw_ids))
    if len(names) > 1:
        raise DouyinAccountIdentityFailure(
            "douyin_account_display_name_ambiguous"
        )
    display_name = next(iter(names)) if names else _profile_page_display_name(
        page, f"https://www.douyin.com/user/{raw_sec_uid}"
    )
    return DouyinAccountIdentity(
        fingerprint=identity_fingerprint_for_raw_sec_uid(raw_sec_uid),
        display_name=display_name,
    )


def extract_douyin_account_reference_in_place(page: object) -> str:
    """Read one raw sender reference without navigating away.

    The value stays inside the short-lived browser worker. It is used to bind
    the final browser-side submit selector and is never returned by HTTP,
    persisted, or logged.
    """
    raw_ids, _names = _header_identity_candidates(page)
    if not raw_ids:
        raise DouyinAccountIdentityFailure(
            "douyin_account_identity_missing"
        )
    if len(raw_ids) != 1:
        raise DouyinAccountIdentityFailure(
            "douyin_account_identity_ambiguous"
        )
    return next(iter(raw_ids))


def extract_douyin_account_fingerprint_in_place(page: object) -> str:
    """Read the current sender fingerprint without navigating away.

    A display name is deliberately not required because resolving a missing
    nickname would navigate to the sender profile and destroy the frozen
    target context.
    """
    return identity_fingerprint_for_raw_sec_uid(
        extract_douyin_account_reference_in_place(page)
    )
