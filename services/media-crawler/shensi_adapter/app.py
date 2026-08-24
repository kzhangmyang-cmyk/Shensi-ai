import os
from collections.abc import Callable
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException

from .accounts import AccountManager
from .browser_state import MediaCrawlerDouyinBrowserState
from .schemas import HealthView, LoginSessionView
from .security import authorize_bearer, require_service_secret


UPSTREAM_COMMIT = "d6f7c5bb906b6dac40ddf343ef9e26438a3de092"


def _build_app(secret_provider: Callable[[], str], account_manager: AccountManager | None = None,
               deployment_manager_factory: Callable[[], AccountManager] | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        if application.state.account_manager is None and deployment_manager_factory is not None:
            application.state.account_manager = deployment_manager_factory()
        try:
            yield
        finally:
            manager = application.state.account_manager
            if manager is not None:
                manager.close()
                application.state.account_manager = None

    application = FastAPI(docs_url=None, openapi_url=None, redoc_url=None, lifespan=lifespan)
    application.state.account_manager = account_manager

    @application.get("/internal/v1/health", response_model=HealthView)
    def health(authorization: str | None = Header(default=None)) -> HealthView:
        authorize_bearer(authorization, require_service_secret(secret_provider()))
        return HealthView(
            ok=True,
            service="shensi-mediacrawler",
            upstream_commit=UPSTREAM_COMMIT,
        )

    @application.post("/internal/v1/douyin/login-sessions", response_model=LoginSessionView)
    def create_login_session(authorization: str | None = Header(default=None)) -> LoginSessionView:
        authorize_bearer(authorization, require_service_secret(secret_provider()))
        manager = application.state.account_manager
        if manager is None:
            raise HTTPException(status_code=503, detail="account_manager_unconfigured")
        return manager.create_login_session()

    @application.get("/internal/v1/douyin/login-sessions/{session_id}", response_model=LoginSessionView)
    def get_login_session(session_id: str, authorization: str | None = Header(default=None)) -> LoginSessionView:
        authorize_bearer(authorization, require_service_secret(secret_provider()))
        manager = application.state.account_manager
        if manager is None:
            raise HTTPException(status_code=503, detail="account_manager_unconfigured")
        try:
            return manager.get_login_session(session_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="login_session_not_found") from error

    @application.delete("/internal/v1/douyin/login-sessions/{session_id}", status_code=204)
    def disconnect_login_session(session_id: str, authorization: str | None = Header(default=None)) -> None:
        authorize_bearer(authorization, require_service_secret(secret_provider()))
        manager = application.state.account_manager
        if manager is None:
            raise HTTPException(status_code=503, detail="account_manager_unconfigured")
        try:
            manager.disconnect(session_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="login_session_not_found") from error

    return application


def create_app(service_secret: str, account_manager: AccountManager | None = None) -> FastAPI:
    normalized_secret = require_service_secret(service_secret)
    return _build_app(lambda: normalized_secret, account_manager)


def create_deployment_account_manager() -> AccountManager:
    volume = os.environ.get("MEDIACRAWLER_ENCRYPTED_VOLUME", "").strip()
    root = os.environ.get("MEDIACRAWLER_PROFILE_ROOT", "").strip()
    if not volume or not root:
        raise RuntimeError("MEDIACRAWLER_ENCRYPTED_VOLUME and MEDIACRAWLER_PROFILE_ROOT are required")
    root_path, volume_path = Path(root).resolve(), Path(volume).resolve()
    if not root_path.is_relative_to(volume_path):
        raise RuntimeError("MEDIACRAWLER_PROFILE_ROOT must be inside MEDIACRAWLER_ENCRYPTED_VOLUME")
    # Validate containment before the Playwright owner thread is even created.
    return AccountManager(root_path, MediaCrawlerDouyinBrowserState())


# Deployment entry point: fail closed rather than placing browser state on an
# unencrypted/default filesystem. Unit tests use create_app with an injected manager.
app = _build_app(lambda: os.environ.get("MEDIACRAWLER_SERVICE_SECRET", ""),
                 deployment_manager_factory=create_deployment_account_manager)
