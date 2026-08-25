import os
import stat
from collections.abc import Callable
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Query

from .accounts import AccountManager
from .action_jobs import ActionJobManager, ActionReplayConflict
from .browser_state import MediaCrawlerDouyinBrowserState
from .crawl_jobs import CrawlJobManager, CursorConflict, MediaCrawlerRunner
from .schemas import (
    ActionReceipt, ActionRequest, CrawlJobAcknowledgement, CrawlJobPage,
    CrawlJobRequest, CrawlJobView, HealthView, LoginSessionView,
)
from .security import authorize_bearer, require_service_secret


UPSTREAM_COMMIT = "d6f7c5bb906b6dac40ddf343ef9e26438a3de092"


def deployment_browser_headless() -> bool:
    return os.environ.get(
        "MEDIACRAWLER_BROWSER_HEADLESS", "true"
    ).strip().lower() != "false"


def deployment_service_secret() -> str:
    secret_file = os.environ.get("MEDIACRAWLER_SERVICE_SECRET_FILE", "").strip()
    if not secret_file:
        raise RuntimeError("MEDIACRAWLER_SERVICE_SECRET_FILE is required")
    path = Path(secret_file)
    if path.is_symlink() or not path.is_file():
        raise RuntimeError("MEDIACRAWLER_SERVICE_SECRET_FILE must be a regular file")
    metadata = path.stat()
    if metadata.st_mode & 0o077 or metadata.st_uid != os.getuid():
        raise RuntimeError("MEDIACRAWLER_SERVICE_SECRET_FILE must be owner-only")
    return require_service_secret(path.read_text(encoding="utf-8"))


def validate_encrypted_profile_root(volume: Path, root: Path) -> Path:
    """Validate the deployment mount before any browser process starts."""
    if not volume.exists():
        raise RuntimeError("MEDIACRAWLER_ENCRYPTED_VOLUME must exist")
    if volume.is_symlink() or not volume.is_dir():
        raise RuntimeError("MEDIACRAWLER_ENCRYPTED_VOLUME must be a directory")
    if stat.S_IMODE(volume.stat().st_mode) != 0o700:
        raise RuntimeError("MEDIACRAWLER_ENCRYPTED_VOLUME must have mode 0700")
    volume_path = volume.resolve(strict=True)
    root_path = root.resolve()
    if not root_path.is_relative_to(volume_path):
        raise RuntimeError("MEDIACRAWLER_PROFILE_ROOT must be inside MEDIACRAWLER_ENCRYPTED_VOLUME")
    if root.exists() and (root.is_symlink() or not root.is_dir()):
        raise RuntimeError("MEDIACRAWLER_PROFILE_ROOT must be a directory")
    return root_path


def _build_app(secret_provider: Callable[[], str], account_manager: AccountManager | None = None,
               deployment_manager_factory: Callable[[], AccountManager] | None = None,
               crawl_job_manager: CrawlJobManager | None = None,
               deployment_crawl_factory: Callable[[AccountManager], CrawlJobManager] | None = None,
               action_job_manager: ActionJobManager | None = None,
               deployment_action_factory: Callable[[AccountManager], ActionJobManager] | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        if application.state.account_manager is None and deployment_manager_factory is not None:
            application.state.account_manager = deployment_manager_factory()
        if application.state.crawl_job_manager is None and deployment_crawl_factory is not None:
            application.state.crawl_job_manager = deployment_crawl_factory(application.state.account_manager)
        if application.state.action_job_manager is None and deployment_action_factory is not None:
            application.state.action_job_manager = deployment_action_factory(application.state.account_manager)
        try:
            yield
        finally:
            jobs = application.state.crawl_job_manager
            if jobs is not None:
                jobs.close()
                application.state.crawl_job_manager = None
            action_jobs = application.state.action_job_manager
            if action_jobs is not None:
                action_jobs.close()
                application.state.action_job_manager = None
            manager = application.state.account_manager
            if manager is not None:
                manager.close()
                application.state.account_manager = None

    application = FastAPI(docs_url=None, openapi_url=None, redoc_url=None, lifespan=lifespan)
    application.state.account_manager = account_manager
    application.state.crawl_job_manager = crawl_job_manager
    application.state.action_job_manager = action_job_manager

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

    def jobs() -> CrawlJobManager:
        manager = application.state.crawl_job_manager
        if manager is None:
            raise HTTPException(status_code=503, detail="crawl_job_manager_unconfigured")
        return manager

    @application.post("/internal/v1/douyin/crawl-jobs", response_model=CrawlJobView)
    def start_crawl_job(request: CrawlJobRequest,
                        authorization: str | None = Header(default=None)) -> CrawlJobView:
        authorize_bearer(authorization, require_service_secret(secret_provider()))
        try:
            return jobs().start(request)
        except KeyError as error:
            raise HTTPException(status_code=409, detail="active_account_not_found") from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @application.get("/internal/v1/douyin/crawl-jobs/{job_id}", response_model=CrawlJobView)
    def get_crawl_job(job_id: str, authorization: str | None = Header(default=None)) -> CrawlJobView:
        authorize_bearer(authorization, require_service_secret(secret_provider()))
        try:
            return jobs().get(job_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="crawl_job_not_found") from error

    @application.get("/internal/v1/douyin/crawl-jobs/{job_id}/results", response_model=CrawlJobPage)
    def get_crawl_results(job_id: str, cursor: str | None = Query(default=None),
                          authorization: str | None = Header(default=None)) -> CrawlJobPage:
        authorize_bearer(authorization, require_service_secret(secret_provider()))
        try:
            return jobs().page(job_id, cursor)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="crawl_job_not_found") from error
        except CursorConflict as error:
            raise HTTPException(status_code=409, detail="crawl_cursor_conflict") from error

    @application.post(
        "/internal/v1/douyin/crawl-jobs/{job_id}/acknowledgement",
        response_model=CrawlJobAcknowledgement,
    )
    def acknowledge_crawl_job(
        job_id: str,
        authorization: str | None = Header(default=None),
    ) -> CrawlJobAcknowledgement:
        authorize_bearer(authorization, require_service_secret(secret_provider()))
        try:
            return CrawlJobAcknowledgement(
                job_id=job_id,
                acknowledged_at=jobs().acknowledge(job_id),
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail="crawl_job_not_found") from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @application.delete("/internal/v1/douyin/crawl-jobs/{job_id}", status_code=204)
    def cancel_crawl_job(job_id: str, authorization: str | None = Header(default=None)) -> None:
        authorize_bearer(authorization, require_service_secret(secret_provider()))
        try:
            jobs().cancel(job_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="crawl_job_not_found") from error

    @application.post("/internal/v1/douyin/actions/{action_id}", response_model=ActionReceipt)
    def execute_action(action_id: str, request: ActionRequest,
                       authorization: str | None = Header(default=None)) -> ActionReceipt:
        authorize_bearer(authorization, require_service_secret(secret_provider()))
        manager = application.state.action_job_manager
        if manager is None:
            raise HTTPException(status_code=503, detail="action_job_manager_unconfigured")
        if action_id != request.action_id:
            raise HTTPException(status_code=409, detail="action_id_mismatch")
        try:
            return manager.execute(request)
        except ActionReplayConflict as error:
            raise HTTPException(status_code=409, detail="action_replay_conflict") from error

    return application


def create_app(service_secret: str, account_manager: AccountManager | None = None,
               crawl_job_manager: CrawlJobManager | None = None,
               action_job_manager: ActionJobManager | None = None) -> FastAPI:
    normalized_secret = require_service_secret(service_secret)
    return _build_app(lambda: normalized_secret, account_manager,
                      crawl_job_manager=crawl_job_manager,
                      action_job_manager=action_job_manager)


def create_deployment_account_manager() -> AccountManager:
    volume = os.environ.get("MEDIACRAWLER_ENCRYPTED_VOLUME", "").strip()
    root = os.environ.get("MEDIACRAWLER_PROFILE_ROOT", "").strip()
    if not volume or not root:
        raise RuntimeError("MEDIACRAWLER_ENCRYPTED_VOLUME and MEDIACRAWLER_PROFILE_ROOT are required")
    root_path = validate_encrypted_profile_root(Path(volume), Path(root))
    # Validate containment before the Playwright owner thread is even created.
    headless = deployment_browser_headless()
    browser_channel = (
        os.environ.get("MEDIACRAWLER_BROWSER_CHANNEL", "").strip() or None
    )
    return AccountManager(
        root_path,
        MediaCrawlerDouyinBrowserState(
            headless=headless, browser_channel=browser_channel
        ),
    )


# Deployment entry point: fail closed rather than placing browser state on an
# unencrypted/default filesystem. Unit tests use create_app with an injected manager.
app = _build_app(deployment_service_secret,
                 deployment_manager_factory=create_deployment_account_manager,
                 deployment_crawl_factory=lambda manager: CrawlJobManager(
                     manager._root, account_resolver=manager.resolve_crawl_profile,
                     runner=MediaCrawlerRunner(headless=deployment_browser_headless()),
                 ), deployment_action_factory=lambda manager: ActionJobManager(
                     manager._root, account_resolver=manager.resolve_action_profile,
                     executor=manager.execute_action
                 ))
