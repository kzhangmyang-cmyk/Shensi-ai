import os
from collections.abc import Callable
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException

from .accounts import AccountManager
from .browser_state import MediaCrawlerDouyinBrowserState
from .schemas import HealthView, LoginSessionView
from .security import authorize_bearer, require_service_secret


UPSTREAM_COMMIT = "d6f7c5bb906b6dac40ddf343ef9e26438a3de092"


def _build_app(
    secret_provider: Callable[[], str], account_manager: AccountManager | None = None
) -> FastAPI:
    application = FastAPI(docs_url=None, openapi_url=None, redoc_url=None)

    @application.get("/internal/v1/health", response_model=HealthView)
    def health(authorization: str | None = Header(default=None)) -> HealthView:
        authorize_bearer(authorization, require_service_secret(secret_provider()))
        return HealthView(
            ok=True,
            service="shensi-mediacrawler",
            upstream_commit=UPSTREAM_COMMIT,
        )

    if account_manager is not None:
        @application.post("/internal/v1/douyin/login-sessions", response_model=LoginSessionView)
        def create_login_session(authorization: str | None = Header(default=None)) -> LoginSessionView:
            authorize_bearer(authorization, require_service_secret(secret_provider()))
            return account_manager.create_login_session()

        @application.get("/internal/v1/douyin/login-sessions/{session_id}", response_model=LoginSessionView)
        def get_login_session(session_id: str, authorization: str | None = Header(default=None)) -> LoginSessionView:
            authorize_bearer(authorization, require_service_secret(secret_provider()))
            try:
                return account_manager.get_login_session(session_id)
            except KeyError as error:
                raise HTTPException(status_code=404, detail="login_session_not_found") from error

    return application


def create_app(service_secret: str, account_manager: AccountManager | None = None) -> FastAPI:
    normalized_secret = require_service_secret(service_secret)
    return _build_app(lambda: normalized_secret, account_manager)


def _default_account_manager() -> AccountManager:
    volume = os.environ.get("MEDIACRAWLER_ENCRYPTED_VOLUME", "").strip()
    root = os.environ.get("MEDIACRAWLER_PROFILE_ROOT", "").strip()
    if not volume or not root:
        return AccountManager(Path("/tmp/shensi-mediacrawler-unconfigured"), _UnavailableBrowser())
    return AccountManager(Path(root), MediaCrawlerDouyinBrowserState())


class _UnavailableBrowser:
    def open_douyin_login(self, _profile: Path) -> dict[str, str]:
        raise RuntimeError("encrypted MediaCrawler profile volume is not configured")

    def poll_douyin_login(self, _context: object) -> dict[str, bool]:
        return {"active": False}

    def close(self, _context: object) -> None:
        return None


# Deployment entry point: fail closed rather than placing browser state on an
# unencrypted/default filesystem. Unit tests use create_app with an injected manager.
app = _build_app(
    lambda: os.environ.get("MEDIACRAWLER_SERVICE_SECRET", ""),
    _default_account_manager(),
)
