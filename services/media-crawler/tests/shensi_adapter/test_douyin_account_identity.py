from __future__ import annotations

import hashlib

import pytest

from shensi_adapter.douyin_account_identity import (
    DouyinAccountIdentityFailure,
    account_handle_for_fingerprint,
    extract_douyin_account_fingerprint_in_place,
    extract_douyin_account_identity,
)


class FakeLocator:
    def __init__(self, items):
        self._items = items

    def count(self):
        return len(self._items)

    def nth(self, index):
        return FakeElement(self._items[index])


class FakeElement:
    def __init__(self, item):
        self._item = item

    def is_visible(self, **_kwargs):
        return self._item.get("visible", True)

    def get_attribute(self, name):
        return self._item.get(name)

    def inner_text(self, **_kwargs):
        return self._item.get("text", "")

    def locator(self, selector):
        if selector == "img[alt]" and self._item.get("img_alt") is not None:
            return FakeLocator([{"alt": self._item["img_alt"]}])
        return FakeLocator([])


class FakePage:
    def __init__(
        self, *, header_links, profile_names=(), current_account_links=(),
    ):
        self.url = "https://www.douyin.com/"
        self.header_links = list(header_links)
        self.current_account_links = list(current_account_links)
        self.profile_names = list(profile_names)
        self.visited = []

    def locator(self, selector):
        if selector == (
            '[class~="tab-user_self"] a[href], '
            'a[class~="tab-user_self"][href]'
        ):
            return FakeLocator(self.current_account_links)
        if selector == (
            'header a[href], nav a[href], [role="navigation"] a[href], '
            '[data-e2e="douyin-header"] a[href], #douyin-header a[href]'
        ):
            return FakeLocator(self.header_links)
        if selector in {
            '[data-e2e="user-info"] [data-e2e="user-name"]',
            '[data-e2e="user-info"] h1',
            '[data-e2e="user-detail"] h1',
            'main [data-e2e="user-name"]',
            'main h1',
        }:
            return FakeLocator([
                {"text": value, "visible": True}
                for value in self.profile_names
            ])
        raise AssertionError(f"unexpected selector: {selector}")

    def goto(self, url, **kwargs):
        assert kwargs == {
            "wait_until": "domcontentloaded",
            "timeout": 15_000,
        }
        self.url = url
        self.visited.append(url)


def test_extracts_unique_header_profile_identity_and_hashes_raw_sec_uid():
    raw_sec_uid = "MS4wLjABStableAccountIdentity"
    page = FakePage(header_links=[{
        "href": f"/user/{raw_sec_uid}",
        "title": "沈思实测账号",
        "text": "沈思实测账号",
    }])

    identity = extract_douyin_account_identity(page)

    expected = hashlib.sha256(
        f"douyin:sec_uid:{raw_sec_uid}".encode("utf-8")
    ).hexdigest()
    assert identity.fingerprint == expected
    assert identity.display_name == "沈思实测账号"
    assert account_handle_for_fingerprint(identity.fingerprint) == (
        f"dyacct_{expected}"
    )
    assert raw_sec_uid not in repr(identity)
    assert raw_sec_uid not in account_handle_for_fingerprint(
        identity.fingerprint
    )
    assert page.visited == []


def test_rejects_ambiguous_header_profile_links_without_exposing_raw_ids():
    page = FakePage(header_links=[
        {"href": "/user/MS4wLjABFirst", "title": "账号一"},
        {"href": "/user/MS4wLjABSecond", "title": "账号二"},
    ])

    with pytest.raises(
        DouyinAccountIdentityFailure,
        match="douyin_account_identity_ambiguous",
    ) as failure:
        extract_douyin_account_identity(page)

    assert "MS4wLjABFirst" not in str(failure.value)
    assert "MS4wLjABSecond" not in str(failure.value)
    assert page.visited == []


def test_uses_exact_profile_page_name_when_header_link_has_no_real_nickname():
    raw_sec_uid = "MS4wLjABProfileFallback"
    page = FakePage(
        header_links=[{
            "href": f"https://www.douyin.com/user/{raw_sec_uid}",
            "aria-label": "个人主页",
            "img_alt": "用户头像",
        }],
        profile_names=["王小二"],
    )

    identity = extract_douyin_account_identity(page)

    assert identity.display_name == "王小二"
    assert page.visited == [
        f"https://www.douyin.com/user/{raw_sec_uid}"
    ]


def test_in_place_fingerprint_never_navigates_for_a_missing_display_name():
    raw_sec_uid = "MS4wLjABInPlaceAccount"
    page = FakePage(header_links=[{
        "href": f"/user/{raw_sec_uid}",
        "title": "个人主页",
        "text": "个人主页",
    }])

    fingerprint = extract_douyin_account_fingerprint_in_place(page)

    assert account_handle_for_fingerprint(fingerprint) == (
        "dyacct_" + hashlib.sha256(
            f"douyin:sec_uid:{raw_sec_uid}".encode("utf-8")
        ).hexdigest()
    )
    assert page.visited == []


def test_in_place_identity_uses_authenticated_account_control_with_from_nav_query():
    bound_sender = "MS4wLjABBoundSender"
    page = FakePage(
        current_account_links=[{
            "href": f"/user/{bound_sender}?from_nav=main",
            "text": "个人主页",
        }],
        header_links=[
            {
                "href": f"/user/{bound_sender}?from_nav=main",
                "text": "个人主页",
            },
            {
                "href": "/user/MS4wLjABVideoAuthor",
                "text": "视频作者",
            },
        ],
    )

    fingerprint = extract_douyin_account_fingerprint_in_place(page)

    assert account_handle_for_fingerprint(fingerprint) == (
        "dyacct_" + hashlib.sha256(
            f"douyin:sec_uid:{bound_sender}".encode("utf-8")
        ).hexdigest()
    )
    assert page.visited == []


@pytest.mark.parametrize(
    "current_account_links,code",
    [
        ([{"href": "/user/MS4wLjABBound?redirect=elsewhere"}],
         "douyin_account_identity_missing"),
        ([{"href": "/user/MS4wLjABBound#fragment"}],
         "douyin_account_identity_missing"),
        ([
            {"href": "/user/MS4wLjABFirst?from_nav=main"},
            {"href": "/user/MS4wLjABSecond?from_nav=main"},
        ], "douyin_account_identity_ambiguous"),
    ],
)
def test_authenticated_account_control_still_fails_closed(
    current_account_links, code,
):
    page = FakePage(
        current_account_links=current_account_links,
        header_links=[{
            "href": "/user/MS4wLjABFallbackMustNotBeUsed",
        }],
    )

    with pytest.raises(DouyinAccountIdentityFailure, match=code):
        extract_douyin_account_fingerprint_in_place(page)


@pytest.mark.parametrize(
    "header_links,profile_names,code",
    [
        ([], [], "douyin_account_identity_missing"),
        ([{"href": "/video/123", "text": "不是主页"}], [],
         "douyin_account_identity_missing"),
        ([{"href": "/user/MS4wLjABNoName", "text": "个人主页"}], [],
         "douyin_account_display_name_missing"),
        ([{"href": "/user/MS4wLjABNameConflict", "title": "个人主页"}], ["张三", "李四"],
         "douyin_account_display_name_ambiguous"),
    ],
)
def test_identity_extraction_fails_closed_for_missing_or_conflicting_dom(
    header_links, profile_names, code,
):
    page = FakePage(
        header_links=header_links,
        profile_names=profile_names,
    )

    with pytest.raises(DouyinAccountIdentityFailure, match=code):
        extract_douyin_account_identity(page)
