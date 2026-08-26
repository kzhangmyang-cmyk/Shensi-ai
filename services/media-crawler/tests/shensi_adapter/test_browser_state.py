from __future__ import annotations

from datetime import UTC, datetime, timedelta
import hashlib
import json
import os
from pathlib import Path
import threading

import pytest

import shensi_adapter.app as deployment_app
from shensi_adapter.browser_state import (
    MediaCrawlerDouyinBrowserState,
    _execute_action,
)
from shensi_adapter.douyin_actions import DouyinActionFailure
from shensi_adapter.schemas import ActionRequest


NOW = datetime(2026, 8, 27, tzinfo=UTC)


def action_request(*, deadline_at: datetime | None = None) -> ActionRequest:
    content = "bounded browser action"
    return ActionRequest(
        action_id="action-browser-timeout",
        account_handle="private-handle",
        login_state_version=3,
        kind="comment",
        target_public_url="https://www.douyin.com/video/123",
        content=content,
        deadline_at=deadline_at or NOW + timedelta(minutes=1),
        approved_content_hash="sha256:" + hashlib.sha256(json.dumps(
            {"content": content}, ensure_ascii=False, sort_keys=True,
            separators=(",", ":"),
        ).encode()).hexdigest(),
    )


class RecordingConnection:
    def __init__(self):
        self.command = None
        self.poll_timeouts: list[float] = []

    def send(self, command):
        self.command = command

    def poll(self, timeout):
        self.poll_timeouts.append(timeout)
        return True

    def recv(self):
        assert self.command is not None
        value = (
            {"handle": "login-handle", "qr_image_data_url": "data:image/png;base64,cXI="}
            if self.command["operation"] == "open"
            else {
                "action_id": "action-browser-timeout",
                "state": "failed",
                "platform_receipt_reference": None,
                "occurred_at": NOW.isoformat(),
                "failure_code": "douyin_verification_required",
            }
        )
        return {"id": self.command["id"], "kind": "ok", "value": value}


def test_action_ipc_uses_its_own_manual_window_budget():
    browser = object.__new__(MediaCrawlerDouyinBrowserState)
    browser._connection = RecordingConnection()
    browser._timeout = 5
    browser._action_timeout = 80
    browser._lock = threading.Lock()
    browser._closed = False
    browser._next_command_id = 1

    browser.open_douyin_login(Path("/fixture/profile"))
    browser.execute_douyin_action(Path("/fixture/profile"), action_request())

    assert browser._connection.poll_timeouts == [5, 80]


class VerificationLocator:
    def count(self):
        return 1

    def is_visible(self, **_kwargs):
        return True


class HeadlessVerificationPage:
    def __init__(self):
        self.url = "about:blank"
        self.brought_to_front = 0
        self.waits = 0
        self.bypass_calls: list[str] = []

    def goto(self, url, **_kwargs):
        self.url = url

    def locator(self, selector):
        if selector == '[data-e2e="verification"]':
            return VerificationLocator()
        return EmptyLocator()

    def bring_to_front(self):
        self.brought_to_front += 1

    def wait_for_timeout(self, _milliseconds):
        self.waits += 1

    def screenshot(self, **_kwargs):
        self.bypass_calls.append("screenshot")

    def evaluate(self, *_args, **_kwargs):
        self.bypass_calls.append("evaluate")

    def drag_and_drop(self, *_args, **_kwargs):
        self.bypass_calls.append("drag_and_drop")


class EmptyLocator:
    def count(self):
        return 0


class HeadlessVerificationContext:
    def __init__(self):
        self.pages = [HeadlessVerificationPage()]

    def close(self):
        return None


class HeadlessVerificationChromium:
    def __init__(self):
        self.context = HeadlessVerificationContext()

    def launch_persistent_context(self, _profile_path, **_kwargs):
        return self.context


class HeadlessVerificationPlaywright:
    def __init__(self):
        self.chromium = HeadlessVerificationChromium()

    def stop(self):
        return None


def headless_verification_playwright_factory():
    return HeadlessVerificationPlaywright()


def test_browser_worker_headless_action_never_enters_manual_handoff():
    playwright = HeadlessVerificationPlaywright()

    with pytest.raises(DouyinActionFailure, match="douyin_verification_required"):
        _execute_action(
            playwright,
            "/fixture/profile",
            action_request(deadline_at=datetime.now(UTC) + timedelta(minutes=1)).model_dump(
                mode="json"
            ),
            headless=True,
            browser_channel=None,
            manual_verification_seconds=30,
        )

    page = playwright.chromium.context.pages[0]
    assert page.brought_to_front == 0
    assert page.waits == 0
    assert page.bypass_calls == []


def test_browser_action_ipc_timeout_is_manual_window_plus_fifty_seconds(
    monkeypatch,
):
    monkeypatch.setenv("DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS", "30")
    browser = MediaCrawlerDouyinBrowserState(
        playwright_factory=headless_verification_playwright_factory,
        startup_timeout=2,
        command_timeout=5,
    )
    try:
        assert browser._timeout == 5
        assert browser._action_timeout == 80
    finally:
        browser.close_browser()


def test_deployment_manual_verification_window_defaults_and_validates_range(
    monkeypatch,
):
    parser = getattr(
        deployment_app,
        "deployment_action_manual_verification_seconds",
        None,
    )
    assert parser is not None

    monkeypatch.delenv("DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS", raising=False)
    assert parser() == 120
    for raw, expected in [("30", 30), ("120", 120), ("300", 300)]:
        monkeypatch.setenv("DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS", raw)
        assert parser() == expected
    for invalid in ["29", "301", "30.5", "", " 120 "]:
        monkeypatch.setenv("DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS", invalid)
        with pytest.raises(
            RuntimeError,
            match="DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS",
        ):
            parser()


def test_invalid_deployment_window_is_rejected_before_browser_start(
    tmp_path, monkeypatch,
):
    volume = tmp_path / "encrypted"
    profiles = volume / "profiles"
    profiles.mkdir(parents=True, mode=0o700)
    os.chmod(volume, 0o700)
    os.chmod(profiles, 0o700)
    monkeypatch.setenv("MEDIACRAWLER_ENCRYPTED_VOLUME", str(volume))
    monkeypatch.setenv("MEDIACRAWLER_PROFILE_ROOT", str(profiles))
    monkeypatch.setenv("DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS", "301")
    browser_starts = 0

    class BrowserMustNotStart:
        def __init__(self, **_kwargs):
            nonlocal browser_starts
            browser_starts += 1

    monkeypatch.setattr(
        deployment_app,
        "MediaCrawlerDouyinBrowserState",
        BrowserMustNotStart,
    )

    with pytest.raises(
        RuntimeError,
        match="DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS",
    ):
        deployment_app.create_deployment_account_manager()
    assert browser_starts == 0
