import os
import time
import socketserver
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from shensi_adapter.accounts import AccountManager
from shensi_adapter.app import create_app
from shensi_adapter.browser_state import MediaCrawlerDouyinBrowserState


SERVICE_SECRET = "mediacrawler-test-secret-that-is-at-least-32-bytes"
NOW = datetime(2026, 9, 1, tzinfo=UTC)
LOGIN_PAGE = {
    "image_data_url": "data:image/jpeg;base64,bG9naW4tanBlZw==",
    "width": 1280,
    "height": 800,
}


class LiveLoginBrowser:
    def __init__(self, vnc_port=5901):
        self.closed = 0
        self.vnc_port = vnc_port
        self.active = False

    def open_douyin_login(self, _profile_path):
        return {
            "handle": "fixture-login-handle",
            "login_page": LOGIN_PAGE,
            "qr_status": "ready",
            "qr_image_data_url": "data:image/png;base64,cXI=",
            "vnc_port": self.vnc_port,
        }

    def poll_douyin_login(self, _context):
        if self.active:
            return {
                "active": True,
                "display_name": "Live fixture",
                "identity_fingerprint": "a" * 64,
            }
        return {
            "active": False,
            "login_page": LOGIN_PAGE,
            "qr_status": "ready",
            "qr_image_data_url": "data:image/png;base64,cXI=",
        }

    def live_vnc_port(self, context):
        return context["vnc_port"]

    def close(self, _context):
        self.closed += 1

    def close_browser(self):
        return None


def _authorization():
    return {"Authorization": f"Bearer {SERVICE_SECRET}"}


def _wait_until_login_page_is_ready(client, session_id):
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        response = client.get(
            f"/internal/v1/douyin/login-sessions/{session_id}",
            headers=_authorization(),
        )
        assert response.status_code == 200
        if response.json()["login_page"] is not None:
            return response.json()
        time.sleep(0.01)
    raise AssertionError("login page did not become ready")


def test_authenticated_client_can_create_one_time_live_login_token(tmp_path):
    manager = AccountManager(
        tmp_path / "profiles",
        LiveLoginBrowser(),
        now=lambda: NOW,
        session_ttl=timedelta(minutes=5),
        sweep_interval=timedelta(hours=1),
    )

    with TestClient(create_app(SERVICE_SECRET, account_manager=manager)) as client:
        created = client.post(
            "/internal/v1/douyin/login-sessions",
            headers=_authorization(),
        ).json()
        ready = _wait_until_login_page_is_ready(client, created["session_id"])
        path = (
            "/internal/v1/douyin/login-sessions/"
            f"{created['session_id']}/live-sessions"
        )

        unauthorized = client.post(path)

        response = client.post(
            path,
            headers=_authorization(),
        )

    assert unauthorized.status_code == 401
    assert response.status_code == 200
    payload = response.json()
    assert set(payload) == {"token", "expires_at"}
    assert len(payload["token"]) >= 40
    assert payload["token"] != created["session_id"]
    assert NOW < datetime.fromisoformat(payload["expires_at"])
    assert datetime.fromisoformat(payload["expires_at"]) <= datetime.fromisoformat(
        ready["expires_at"]
    )


class _EchoVncHandler(socketserver.BaseRequestHandler):
    def handle(self):
        while data := self.request.recv(65_536):
            self.request.sendall(data)


def test_live_login_websocket_proxies_binary_vnc_and_consumes_token(tmp_path):
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _EchoVncHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    manager = AccountManager(
        tmp_path / "profiles",
        LiveLoginBrowser(server.server_address[1]),
        now=lambda: NOW,
        session_ttl=timedelta(minutes=5),
        sweep_interval=timedelta(hours=1),
    )
    try:
        with TestClient(
            create_app(SERVICE_SECRET, account_manager=manager)
        ) as client:
            created = client.post(
                "/internal/v1/douyin/login-sessions",
                headers=_authorization(),
            ).json()
            _wait_until_login_page_is_ready(client, created["session_id"])
            live = client.post(
                "/internal/v1/douyin/login-sessions/"
                f"{created['session_id']}/live-sessions",
                headers=_authorization(),
            ).json()
            socket_path = f"/internal/v1/douyin/live/{live['token']}"

            with client.websocket_connect(socket_path) as websocket:
                websocket.send_bytes(b"RFB 003.008\n")
                assert websocket.receive_bytes() == b"RFB 003.008\n"

            try:
                with client.websocket_connect(socket_path) as websocket:
                    websocket.receive_bytes()
            except WebSocketDisconnect as error:
                assert error.code == 1008
            else:
                raise AssertionError("live token was accepted more than once")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=1)


class _EmptyLocator:
    def count(self):
        return 0


class _VisibleLoginPanel:
    def wait_for(self, **_kwargs):
        return None


class _VisibleQr:
    def count(self):
        return 1

    def nth(self, _index):
        return self

    def is_visible(self):
        return True

    def get_attribute(self, name):
        assert name == "src"
        return "data:image/png;base64,cXI="


class _LiveDisplayPage:
    url = "https://www.douyin.com/"

    def goto(self, url, **_kwargs):
        self.url = url

    def locator(self, selector):
        if selector == "#login-panel-new":
            return _VisibleLoginPanel()
        if selector == "#login-panel-new svg image":
            return _VisibleQr()
        return _EmptyLocator()

    def wait_for_timeout(self, _milliseconds):
        return None

    def screenshot(self, **kwargs):
        assert kwargs == {
            "type": "jpeg",
            "quality": 80,
            "full_page": False,
            "timeout": 5_000,
        }
        return b"login-jpeg"


class _LiveDisplayContext:
    def __init__(self):
        self.pages = [_LiveDisplayPage()]

    def close(self):
        return None


class _LiveDisplayChromium:
    def launch_persistent_context(self, _profile_path, **kwargs):
        assert kwargs["headless"] is False
        assert kwargs["env"]["DISPLAY"] == ":91"
        return _LiveDisplayContext()


class _LiveDisplayPlaywright:
    chromium = _LiveDisplayChromium()

    def stop(self):
        return None


class _FixtureLiveDisplay:
    display = ":91"
    vnc_port = 45_901

    def browser_environment(self):
        return {"DISPLAY": self.display}

    def close(self):
        marker = os.environ.get("SHENSI_TEST_LIVE_DISPLAY_CLOSE_MARKER")
        if marker:
            Path(marker).write_text("closed", encoding="utf-8")
        return None


def _live_display_playwright_factory():
    return _LiveDisplayPlaywright()


def _fixture_live_display_factory():
    return _FixtureLiveDisplay()


def test_browser_login_runs_on_its_live_display_and_returns_vnc_port(
    tmp_path,
    monkeypatch,
):
    marker = tmp_path / "live-display-closed"
    monkeypatch.setenv(
        "SHENSI_TEST_LIVE_DISPLAY_CLOSE_MARKER",
        str(marker),
    )
    browser = MediaCrawlerDouyinBrowserState(
        playwright_factory=_live_display_playwright_factory,
        live_display_factory=_fixture_live_display_factory,
        headless=False,
        startup_timeout=2,
        command_timeout=2,
    )
    try:
        context = browser.open_douyin_login(Path(tmp_path))

        assert browser.live_vnc_port(context) == 45_901
        browser.close(context)
        assert marker.read_text(encoding="utf-8") == "closed"
    finally:
        browser.close_browser()


def test_login_completion_invalidates_unclaimed_live_token(tmp_path):
    browser = LiveLoginBrowser()
    manager = AccountManager(
        tmp_path / "profiles",
        browser,
        now=lambda: NOW,
        session_ttl=timedelta(minutes=5),
        sweep_interval=timedelta(hours=1),
    )

    with TestClient(create_app(SERVICE_SECRET, account_manager=manager)) as client:
        created = client.post(
            "/internal/v1/douyin/login-sessions",
            headers=_authorization(),
        ).json()
        _wait_until_login_page_is_ready(client, created["session_id"])
        live = client.post(
            "/internal/v1/douyin/login-sessions/"
            f"{created['session_id']}/live-sessions",
            headers=_authorization(),
        ).json()

        browser.active = True
        state = client.get(
            f"/internal/v1/douyin/login-sessions/{created['session_id']}",
            headers=_authorization(),
        )
        assert state.json()["state"] == "active"
        assert browser.closed == 1

        try:
            with client.websocket_connect(
                f"/internal/v1/douyin/live/{live['token']}"
            ) as websocket:
                websocket.receive_bytes()
        except WebSocketDisconnect as error:
            assert error.code == 1008
        else:
            raise AssertionError("completed login kept its live token")
