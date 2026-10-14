from __future__ import annotations

from datetime import UTC, datetime, timedelta
import hashlib
import inspect
import json
from types import SimpleNamespace

import pytest

from shensi_adapter.douyin_actions import DouyinActionFailure
from shensi_adapter.douyin_spider_private_message import (
    DouyinSpiderPrivateMessageExecutor,
    _DouyinSpiderBindings,
)
from shensi_adapter.vendor.douyin_spider.dy_apis.douyin_api import DouyinAPI
from shensi_adapter.schemas import ActionRequest


NOW = datetime(2026, 8, 31, tzinfo=UTC)
TARGET_SEC_UID = "MS4wLjABAAAArecipient-public-reference"
TARGET_URL = f"https://www.douyin.com/user/{TARGET_SEC_UID}"


def request(*, content: str = "经人工确认的私信") -> ActionRequest:
    return ActionRequest(
        action_id="action-direct-message-1",
        account_handle="bound-account-handle",
        login_state_version=7,
        kind="direct_message",
        target_public_url=TARGET_URL,
        content=content,
        deadline_at=NOW + timedelta(minutes=1),
        approved_content_hash="sha256:" + hashlib.sha256(
            json.dumps(
                {"content": content},
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest(),
    )


class FakeContext:
    def __init__(self, *, cookies: list[dict[str, str]] | None = None):
        self._cookies = cookies or [
            {"name": "sessionid", "value": "private-session"},
            {"name": "s_v_web_id", "value": "verify-private"},
        ]

    def cookies(self, _urls):
        return self._cookies


class FakePage:
    def __init__(self, storage: dict[str, str] | None = None):
        self.storage = storage or {
            "security-sdk/s_sdk_crypt_sdk": json.dumps({
                "data": json.dumps({"ec_privateKey": "private-key"}),
            }),
            "security-sdk/s_sdk_sign_data_key/web_protect": json.dumps({
                "data": json.dumps({
                    "ticket": "private-ticket",
                    "ts_sign": "private-sign",
                    "client_cert": "private-cert",
                }),
            }),
            "security-sdk/s_sdk_server_cert_key": json.dumps({
                "cert": "private-server-cert",
                "sn": "private-server-sn",
            }),
        }

    def evaluate(self, _script, keys=None):
        if keys is not None:
            return {key: self.storage.get(key) for key in keys}
        return {
            "userAgent": "Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36",
            "platform": "Linux x86_64",
            "language": "zh-CN",
            "screen": {"width": 1280, "height": 800},
            "viewport": {
                "innerWidth": 1280,
                "innerHeight": 800,
                "outerWidth": 1280,
                "outerHeight": 800,
                "availWidth": 1280,
                "availHeight": 800,
            },
            "hardwareConcurrency": 8,
            "deviceMemory": 8,
            "uaData": {
                "brands": [
                    {"brand": "Chromium", "version": "149"},
                    {"brand": "Not_A Brand", "version": "24"},
                ],
                "platform": "Linux",
            },
        }


class FakeBindings:
    def __init__(self, *, resolved_sec_uid: str = TARGET_SEC_UID,
                 send_result: bool = True, send_error: Exception | None = None):
        self.resolved_sec_uid = resolved_sec_uid
        self.send_result = send_result
        self.send_error = send_error
        self.calls: list[tuple[object, ...]] = []

    def authenticate(self, *, cookie_header, key_storage,
                     web_protect_storage, server_cert_storage,
                     browser_fingerprint):
        self.calls.append((
            "authenticate",
            cookie_header,
            key_storage,
            web_protect_storage,
            server_cert_storage,
            browser_fingerprint,
        ))
        return object()

    def resolve_recipient(self, _auth, target_url):
        self.calls.append(("resolve_recipient", target_url))
        return {"uid": "123456789", "sec_uid": self.resolved_sec_uid}

    def create_conversation(self, _auth, recipient_uid):
        self.calls.append(("create_conversation", recipient_uid))
        return "conversation-private", 998877, "conversation-ticket-private"

    def send_text(self, _auth, *, conversation_id, conversation_short_id,
                  ticket, content, client_message_id):
        self.calls.append((
            "send_text",
            conversation_id,
            conversation_short_id,
            ticket,
            content,
            client_message_id,
        ))
        if self.send_error is not None:
            raise self.send_error
        return self.send_result


def test_sends_once_through_douyin_spider_and_returns_sanitized_receipt():
    bindings = FakeBindings()
    authority_checks: list[str] = []

    receipt = DouyinSpiderPrivateMessageExecutor(
        bindings=bindings,
        now=lambda: NOW,
    ).execute(
        FakeContext(),
        FakePage(),
        request(),
        account_authority_revalidator=lambda: authority_checks.append("ok"),
    )

    assert [call[0] for call in bindings.calls] == [
        "authenticate",
        "resolve_recipient",
        "create_conversation",
        "send_text",
    ]
    assert authority_checks == ["ok", "ok"]
    send = bindings.calls[-1]
    assert send[1:5] == (
        "conversation-private",
        998877,
        "conversation-ticket-private",
        "经人工确认的私信",
    )
    assert isinstance(send[5], str) and len(send[5]) == 36
    fingerprint = bindings.calls[0][5]
    assert fingerprint["userAgent"].endswith("Safari/537.36")
    assert fingerprint["screen"] == {"width": 1280, "height": 800}
    assert receipt.state == "succeeded"
    assert receipt.failure_code is None
    assert receipt.platform_receipt_reference is not None
    serialized = receipt.model_dump_json()
    assert "经人工确认的私信" not in serialized
    assert "conversation-private" not in serialized
    assert "private-session" not in serialized


def test_missing_browser_security_material_fails_before_any_douyin_api_call():
    bindings = FakeBindings()
    page = FakePage(storage={
        "security-sdk/s_sdk_crypt_sdk": None,
        "security-sdk/s_sdk_sign_data_key/web_protect": None,
        "security-sdk/s_sdk_server_cert_key": None,
    })

    with pytest.raises(
        DouyinActionFailure,
        match="douyin_direct_message_unavailable",
    ):
        DouyinSpiderPrivateMessageExecutor(
            bindings=bindings,
            now=lambda: NOW,
        ).execute(FakeContext(), page, request())

    assert bindings.calls == []


def test_nameless_browser_cookie_does_not_block_an_authenticated_dm():
    bindings = FakeBindings()
    cookies = [
        {"name": "sessionid", "value": "private-session"},
        {"name": "", "value": "unrelated-browser-value"},
        {"name": "s_v_web_id", "value": "verify-private"},
    ]
    receipt = DouyinSpiderPrivateMessageExecutor(
        bindings=bindings, now=lambda: NOW,
    ).execute(FakeContext(cookies=cookies), FakePage(), request())

    assert receipt.state == "succeeded"
    assert bindings.calls[0][1] == (
        "sessionid=private-session; s_v_web_id=verify-private"
    )
    assert [call[0] for call in bindings.calls].count("send_text") == 1
    assert cookies[1] == {"name": "", "value": "unrelated-browser-value"}


@pytest.mark.parametrize("cookies", [
    [{"name": "", "value": "not-a-login"}],
    [{"name": "sessionid", "value": "private; injected=value"}],
    [{"name": "sessionid", "value": "private\r\nInjected: value"}],
    [{"name": "sessionid=other", "value": "private"}],
])
def test_cookie_filter_never_accepts_missing_login_or_header_injection(cookies):
    bindings = FakeBindings()
    with pytest.raises(DouyinActionFailure):
        DouyinSpiderPrivateMessageExecutor(
            bindings=bindings, now=lambda: NOW,
        ).execute(FakeContext(cookies=cookies), FakePage(), request())
    assert bindings.calls == []


@pytest.mark.parametrize("outcome", ["credential_failure", "success", "send_uncertain"])
def test_owned_action_browser_closes_only_after_dm_returns_or_raises(monkeypatch, outcome):
    from shensi_adapter import browser_state

    events = []
    page = FakePage()
    cookies = [{"name": "", "value": "unrelated-browser-value"}]
    if outcome != "credential_failure":
        cookies.append({"name": "sessionid", "value": "private-session"})
    context = FakeContext(cookies=cookies)
    context.pages = [page]
    context.closed = False

    def require_open(stage):
        assert not context.closed, f"browser closed before {stage}"
        events.append(stage)

    def close_context():
        require_open("context_close")
        context.closed = True

    context.close = close_context

    def launch(profile, **options):
        assert profile == "/fixture/owned-dm-profile"
        assert options["headless"] is False
        events.append("launch")
        return context

    bindings = FakeBindings(
        send_error=TimeoutError("fixture response unavailable")
        if outcome == "send_uncertain" else None,
    )

    def authenticate(**kwargs):
        require_open("authenticate")
        FakeBindings.authenticate(bindings, **kwargs)
        return SimpleNamespace(close=lambda: require_open("auth_close"))

    bindings.authenticate = authenticate
    for name in ("resolve_recipient", "create_conversation", "send_text"):
        original = getattr(bindings, name)

        def call(*args, _name=name, _original=original, **kwargs):
            require_open(_name)
            return _original(*args, **kwargs)

        setattr(bindings, name, call)

    monkeypatch.setattr(browser_state, "_require_bound_action_identity",
                        lambda *_: require_open("identity"))
    monkeypatch.setattr(browser_state, "_require_bound_action_identity_in_place",
                        lambda *_: require_open("identity_recheck"))
    monkeypatch.setattr(browser_state, "DouyinSpiderPrivateMessageExecutor",
                        lambda: DouyinSpiderPrivateMessageExecutor(bindings=bindings, now=lambda: NOW))

    def execute():
        return browser_state._execute_action(
            SimpleNamespace(chromium=SimpleNamespace(launch_persistent_context=launch)),
            "/fixture/owned-dm-profile", request().model_dump(mode="json"),
            headless=False, browser_channel=None, manual_verification_seconds=30,
        )

    if outcome == "success":
        assert execute()["state"] == "succeeded"
    else:
        code = "douyin_direct_message_unavailable" if outcome == "credential_failure" else "douyin_action_receipt_ambiguous"
        with pytest.raises(DouyinActionFailure, match=f"^{code}$"):
            execute()

    assert context.closed
    if outcome == "credential_failure":
        assert bindings.calls == []
        assert events == ["launch", "identity", "context_close"]
    else:
        assert events == [
            "launch", "identity", "authenticate", "resolve_recipient",
            "identity_recheck", "create_conversation", "identity_recheck",
            "send_text", "auth_close", "context_close",
        ]


def test_recipient_binding_mismatch_never_creates_or_sends_a_conversation():
    bindings = FakeBindings(resolved_sec_uid="different-recipient")

    with pytest.raises(DouyinActionFailure, match="action_rejected"):
        DouyinSpiderPrivateMessageExecutor(
            bindings=bindings,
            now=lambda: NOW,
        ).execute(FakeContext(), FakePage(), request())

    assert [call[0] for call in bindings.calls] == [
        "authenticate",
        "resolve_recipient",
    ]


def test_known_send_rejection_is_closed_without_a_second_attempt():
    bindings = FakeBindings(send_result=False)

    with pytest.raises(
        DouyinActionFailure,
        match="douyin_direct_message_unavailable",
    ):
        DouyinSpiderPrivateMessageExecutor(
            bindings=bindings,
            now=lambda: NOW,
        ).execute(FakeContext(), FakePage(), request())

    assert [call[0] for call in bindings.calls].count("send_text") == 1


def test_exception_after_send_starts_is_ambiguous_and_never_retried():
    bindings = FakeBindings(send_error=TimeoutError("must not cross boundary"))

    with pytest.raises(
        DouyinActionFailure,
        match="douyin_action_receipt_ambiguous",
    ):
        DouyinSpiderPrivateMessageExecutor(
            bindings=bindings,
            now=lambda: NOW,
        ).execute(FakeContext(), FakePage(), request())

    assert [call[0] for call in bindings.calls].count("send_text") == 1


def test_production_binding_uses_the_authenticated_browser_fingerprint():
    bindings = _DouyinSpiderBindings()
    previous = bindings._fingerprint._profile
    try:
        profile = bindings._configure_browser_fingerprint(
            FakePage().evaluate("fingerprint")
        )
    finally:
        bindings._fingerprint._profile = previous

    assert profile["ua"].startswith("Mozilla/5.0")
    assert profile["browser_version"] == "149.0.0.0"
    assert profile["engine_version"] == "149.0.0.0"
    assert profile["platform"] == "Linux x86_64"
    assert profile["os_name"] == "Linux"
    assert profile["screen_width"] == "1280"
    assert profile["screen_height"] == "800"
    assert profile["geo"] == (
        1280, 800, 1280, 800, 1280, 800, 1280, 800,
    )
    assert profile["sec_ch_ua_platform"] == '"Linux"'


def test_vendored_send_path_never_logs_private_message_payload_or_identifiers():
    source = inspect.getsource(DouyinAPI._send_message_raw)

    assert "logger." not in source
