import asyncio
import os
import re
import stat
import sys
from collections.abc import Callable
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, Header, HTTPException, Query, WebSocket
from starlette.websockets import WebSocketDisconnect

from .accounts import AccountManager
from .action_jobs import ActionJobManager, ActionReplayConflict
from .browser_state import (
    MediaCrawlerDouyinBrowserState,
    configured_action_manual_verification_seconds,
)
from .crawl_jobs import CrawlJobManager, CursorConflict, MediaCrawlerRunner
from .local_browser_session_manager import LocalBrowserSessionManager
from .runtime_config import (
    RuntimeConfig,
    load_runtime_config,
    repository_root_for_module,
)
from .schemas import (
    ActionReceipt, ActionRequest, CrawlJobAcknowledgement, CrawlJobPage,
    DesktopActionRequest, DesktopActionReconciliationRequest, DesktopActionReceipt, DesktopAccountIdentity,
    DesktopAccountIdentityRequest, ActionAcknowledgementRequest, ActionAcknowledgement,
    CrawlJobRequest, CrawlJobView, HealthView, LoginInteractionRequest,
    LiveLoginSessionView, LoginSessionCreateRequest, LoginSessionView,
)
from .security import authorize_bearer, require_service_secret


UPSTREAM_COMMIT = "d6f7c5bb906b6dac40ddf343ef9e26438a3de092"
REPOSITORY_ROOT = repository_root_for_module(__file__)


async def _proxy_live_login_websocket(
    websocket: WebSocket,
    manager: AccountManager,
    token: str,
) -> None:
    try:
        port = manager.claim_live_login_session(token)
    except KeyError:
        await websocket.close(code=1008)
        return
    try:
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
    except (OSError, TimeoutError):
        await websocket.close(code=1011)
        return

    accepted = False
    try:
        await websocket.accept()
        accepted = True

        async def websocket_to_vnc() -> None:
            while True:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    return
                payload = message.get("bytes")
                if payload is None:
                    await websocket.close(code=1003)
                    return
                writer.write(payload)
                await writer.drain()

        async def vnc_to_websocket() -> None:
            while payload := await reader.read(65_536):
                await websocket.send_bytes(payload)

        tasks = {
            asyncio.create_task(websocket_to_vnc()),
            asyncio.create_task(vnc_to_websocket()),
        }
        _done, pending = await asyncio.wait(
            tasks,
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    except WebSocketDisconnect:
        pass
    finally:
        writer.close()
        with suppress(Exception):
            await writer.wait_closed()
        if accepted:
            with suppress(Exception):
                await websocket.close()


def deployment_browser_headless() -> bool:
    return os.environ.get(
        "MEDIACRAWLER_BROWSER_HEADLESS", "true"
    ).strip().lower() != "false"


def deployment_browser_display() -> str:
    mode = os.environ.get(
        "MEDIACRAWLER_BROWSER_DISPLAY", "operator"
    ).strip().lower()
    if mode not in {"operator", "virtual"}:
        raise RuntimeError(
            "MEDIACRAWLER_BROWSER_DISPLAY must be operator or virtual"
        )
    display = os.environ.get("DISPLAY", "").strip()
    if mode == "virtual" and (
        not sys.platform.startswith("linux")
        or re.fullmatch(r":[0-9]+(?:\.[0-9]+)?", display) is None
    ):
        raise RuntimeError(
            "MEDIACRAWLER_BROWSER_DISPLAY=virtual requires Linux DISPLAY"
        )
    return mode


def deployment_runtime_config() -> RuntimeConfig:
    try:
        return load_runtime_config(
            os.environ,
            repository_root=REPOSITORY_ROOT,
        )
    except ValueError as error:
        raise RuntimeError(str(error)) from error


def deployment_browser_proxy() -> str | None:
    value = os.environ.get("MEDIACRAWLER_BROWSER_PROXY", "").strip()
    if not value:
        return None
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise RuntimeError(
            "MEDIACRAWLER_BROWSER_PROXY must be a proxy origin"
        ) from error
    if (
        parsed.scheme.lower() not in {"http", "https", "socks5"}
        or not parsed.hostname
        or port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError(
            "MEDIACRAWLER_BROWSER_PROXY must be a credential-free proxy origin"
        )
    hostname = parsed.hostname
    if ":" in hostname:
        hostname = f"[{hostname}]"
    return f"{parsed.scheme.lower()}://{hostname}:{port}"


def deployment_outreach_actions_enabled() -> bool:
    return deployment_runtime_config().outreach_actions_enabled


def deployment_action_manual_verification_seconds() -> int:
    try:
        return configured_action_manual_verification_seconds(
            os.environ.get("DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS")
        )
    except ValueError as error:
        raise RuntimeError(
            "DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS must be an integer "
            "between 30 and 300"
        ) from error


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


def deployment_crawl_output_root() -> Path:
    volume_value = os.environ.get("MEDIACRAWLER_ENCRYPTED_VOLUME", "").strip()
    root_value = os.environ.get("MEDIACRAWLER_CRAWL_OUTPUT_ROOT", "").strip()
    if not volume_value or not root_value:
        raise RuntimeError(
            "MEDIACRAWLER_ENCRYPTED_VOLUME and "
            "MEDIACRAWLER_CRAWL_OUTPUT_ROOT are required"
        )
    volume = Path(volume_value)
    root = Path(root_value)
    if not root.is_absolute():
        raise RuntimeError("MEDIACRAWLER_CRAWL_OUTPUT_ROOT must be absolute")
    if not volume.exists() or volume.is_symlink() or not volume.is_dir():
        raise RuntimeError("MEDIACRAWLER_ENCRYPTED_VOLUME must be a directory")
    volume_path = volume.resolve(strict=True)
    if root.is_symlink() or not root.is_dir():
        raise RuntimeError(
            "MEDIACRAWLER_CRAWL_OUTPUT_ROOT must be a non-symlinked directory"
        )
    metadata = root.stat()
    if stat.S_IMODE(metadata.st_mode) != 0o700:
        raise RuntimeError("MEDIACRAWLER_CRAWL_OUTPUT_ROOT must have mode 0700")
    if metadata.st_uid != os.getuid():
        raise RuntimeError(
            "MEDIACRAWLER_CRAWL_OUTPUT_ROOT must be owned by the current user"
        )
    root_path = root.resolve(strict=True)
    if root_path == volume_path or not root_path.is_relative_to(volume_path):
        raise RuntimeError(
            "MEDIACRAWLER_CRAWL_OUTPUT_ROOT must be strictly inside "
            "MEDIACRAWLER_ENCRYPTED_VOLUME"
        )
    return root_path


def _build_app(secret_provider: Callable[[], str], account_manager: AccountManager | None = None,
               deployment_manager_factory: Callable[[], AccountManager] | None = None,
               crawl_job_manager: CrawlJobManager | None = None,
               deployment_crawl_factory: Callable[[AccountManager], CrawlJobManager] | None = None,
               action_job_manager: ActionJobManager | None = None,
               deployment_action_factory: Callable[[AccountManager], ActionJobManager] | None = None,
               outreach_actions_enabled: bool = True,
               runtime_mode: str = "web") -> FastAPI:
    request_model = DesktopActionRequest if runtime_mode == "desktop" else ActionRequest
    reconciliation_request_model = DesktopActionReconciliationRequest if runtime_mode == "desktop" else ActionRequest
    receipt_model = DesktopActionReceipt if runtime_mode == "desktop" else ActionReceipt
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        if application.state.account_manager is None and deployment_manager_factory is not None:
            application.state.account_manager = deployment_manager_factory()
        if application.state.crawl_job_manager is None and deployment_crawl_factory is not None:
            application.state.crawl_job_manager = deployment_crawl_factory(application.state.account_manager)
        if (application.state.outreach_actions_enabled
                and application.state.action_job_manager is None
                and deployment_action_factory is not None):
            application.state.action_job_manager = deployment_action_factory(application.state.account_manager)
        try:
            yield
        finally:
            cleanup_failures: list[BaseException] = []
            jobs = application.state.crawl_job_manager
            if jobs is not None:
                try:
                    jobs.close()
                except BaseException as error:
                    cleanup_failures.append(error)
                finally:
                    application.state.crawl_job_manager = None
            action_jobs = application.state.action_job_manager
            if action_jobs is not None:
                try:
                    action_jobs.close()
                except BaseException as error:
                    cleanup_failures.append(error)
                finally:
                    application.state.action_job_manager = None
            manager = application.state.account_manager
            if manager is not None:
                try:
                    manager.close()
                except BaseException as error:
                    cleanup_failures.append(error)
                finally:
                    application.state.account_manager = None
            if len(cleanup_failures) == 1:
                raise cleanup_failures[0]
            if cleanup_failures:
                raise BaseExceptionGroup(
                    "shensi_sidecar_shutdown_failed",
                    cleanup_failures,
                )

    application = FastAPI(docs_url=None, openapi_url=None, redoc_url=None, lifespan=lifespan)
    application.state.account_manager = account_manager
    application.state.crawl_job_manager = crawl_job_manager
    application.state.action_job_manager = action_job_manager
    application.state.outreach_actions_enabled = outreach_actions_enabled

    @application.get("/internal/v1/health", response_model=HealthView)
    def health(authorization: str | None = Header(default=None)) -> HealthView:
        authorize_bearer(authorization, require_service_secret(secret_provider()))
        return HealthView(
            ok=True,
            service="shensi-mediacrawler",
            upstream_commit=UPSTREAM_COMMIT,
        )

    @application.post("/internal/v1/douyin/login-sessions", response_model=LoginSessionView)
    def create_login_session(
        request: LoginSessionCreateRequest | None = None,
        authorization: str | None = Header(default=None),
    ) -> LoginSessionView:
        authorize_bearer(authorization, require_service_secret(secret_provider()))
        manager = application.state.account_manager
        if manager is None:
            raise HTTPException(status_code=503, detail="account_manager_unconfigured")
        try:
            return manager.create_login_session(
                request.account_key if request is not None else None
            )
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

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

    @application.post(
        "/internal/v1/douyin/login-sessions/{session_id}/interactions",
        response_model=LoginSessionView,
    )
    def interact_login_session(
        session_id: str,
        request: LoginInteractionRequest,
        authorization: str | None = Header(default=None),
    ) -> LoginSessionView:
        authorize_bearer(
            authorization,
            require_service_secret(secret_provider()),
        )
        manager = application.state.account_manager
        if manager is None:
            raise HTTPException(
                status_code=503,
                detail="account_manager_unconfigured",
            )
        try:
            return manager.interact_login_session(session_id, request)
        except KeyError as error:
            raise HTTPException(
                status_code=404,
                detail="login_session_not_found",
            ) from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @application.post(
        "/internal/v1/douyin/login-sessions/{session_id}/live-sessions",
        response_model=LiveLoginSessionView,
    )
    def create_live_login_session(
        session_id: str,
        authorization: str | None = Header(default=None),
    ) -> LiveLoginSessionView:
        authorize_bearer(
            authorization,
            require_service_secret(secret_provider()),
        )
        manager = application.state.account_manager
        if manager is None:
            raise HTTPException(
                status_code=503,
                detail="account_manager_unconfigured",
            )
        try:
            return manager.create_live_login_session(session_id)
        except KeyError as error:
            raise HTTPException(
                status_code=404,
                detail="login_session_not_found",
            ) from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

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

    @application.websocket("/internal/v1/douyin/live/{token}")
    async def live_login_websocket(
        websocket: WebSocket,
        token: str,
    ) -> None:
        manager = application.state.account_manager
        if manager is None:
            await websocket.close(code=1013)
            return
        await _proxy_live_login_websocket(websocket, manager, token)

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

    @application.post("/internal/v1/douyin/crawl-jobs/{job_id}/control/{action}")
    def control_crawl_job(job_id: str, action: str, authorization: str | None = Header(default=None)):
        authorize_bearer(authorization, require_service_secret(secret_provider()))
        if action not in {"pause", "resume", "stop"}:
            raise HTTPException(status_code=422, detail="invalid_crawl_control")
        try:
            return jobs().control(job_id, action)
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

    @application.post("/internal/v1/douyin/actions/{action_id}", response_model=receipt_model)
    def execute_action(action_id: str, request: request_model,
                       authorization: str | None = Header(default=None)) -> ActionReceipt:
        authorize_bearer(authorization, require_service_secret(secret_provider()))
        if not application.state.outreach_actions_enabled:
            raise HTTPException(status_code=503, detail="outreach_actions_disabled")
        manager = application.state.action_job_manager
        if manager is None:
            raise HTTPException(status_code=503, detail="action_job_manager_unconfigured")
        if action_id != request.action_id:
            raise HTTPException(status_code=409, detail="action_id_mismatch")
        try:
            receipt = manager.execute(request)
            return receipt_model.model_validate(receipt.model_dump())
        except ActionReplayConflict as error:
            raise HTTPException(status_code=409, detail="action_replay_conflict") from error

    @application.post(
        "/internal/v1/douyin/actions/{action_id}/reconcile",
        response_model=receipt_model,
    )
    def reconcile_action(action_id: str, request: reconciliation_request_model,
                         authorization: str | None = Header(default=None)) -> ActionReceipt:
        authorize_bearer(authorization, require_service_secret(secret_provider()))
        if not application.state.outreach_actions_enabled:
            raise HTTPException(status_code=503, detail="outreach_actions_disabled")
        manager = application.state.action_job_manager
        if manager is None:
            raise HTTPException(status_code=503, detail="action_job_manager_unconfigured")
        if action_id != request.action_id:
            raise HTTPException(status_code=409, detail="action_id_mismatch")
        try:
            receipt = manager.reconcile(request)
            return receipt_model.model_validate(receipt.model_dump())
        except ActionReplayConflict as error:
            raise HTTPException(
                status_code=409,
                detail="action_reconciliation_unavailable",
            ) from error

    if runtime_mode == "desktop":
        @application.post("/internal/v1/douyin/account-identities/resolve", response_model=DesktopAccountIdentity)
        def resolve_identity(request: DesktopAccountIdentityRequest,
                             authorization: str | None = Header(default=None)):
            authorize_bearer(authorization, require_service_secret(secret_provider()))
            manager = application.state.account_manager
            if manager is None:
                raise HTTPException(status_code=503, detail="account_manager_unconfigured")
            try:
                return manager.resolve_account_identity(request.account_key)
            except KeyError as error:
                raise HTTPException(status_code=404, detail="active_account_not_found") from error

        @application.post("/internal/v1/douyin/actions/{action_id}/acknowledgement", response_model=ActionAcknowledgement)
        def acknowledge_action(action_id: str, request: ActionAcknowledgementRequest,
                               authorization: str | None = Header(default=None)):
            authorize_bearer(authorization, require_service_secret(secret_provider()))
            if not application.state.outreach_actions_enabled:
                raise HTTPException(status_code=503, detail="outreach_actions_disabled")
            manager = application.state.action_job_manager
            if manager is None:
                raise HTTPException(status_code=503, detail="action_job_manager_unconfigured")
            try:
                return manager.acknowledge(action_id, request.request_hash, request.receipt_hash)
            except ActionReplayConflict as error:
                raise HTTPException(status_code=409, detail="action_acknowledgement_conflict") from error

    return application


def create_app(service_secret: str, account_manager: AccountManager | None = None,
               crawl_job_manager: CrawlJobManager | None = None,
               action_job_manager: ActionJobManager | None = None,
               runtime_mode: str = "web", outreach_actions_enabled: bool = True) -> FastAPI:
    normalized_secret = require_service_secret(service_secret)
    return _build_app(lambda: normalized_secret, account_manager,
                      crawl_job_manager=crawl_job_manager,
                      action_job_manager=action_job_manager,
                      runtime_mode=runtime_mode, outreach_actions_enabled=outreach_actions_enabled)


def create_deployment_account_manager() -> AccountManager:
    config = deployment_runtime_config()
    deployment_action_manual_verification_seconds()
    if (deployment_outreach_actions_enabled()
            and config.browser_headless):
        raise RuntimeError(
            "DOUYIN_OUTREACH_ACTIONS_ENABLED=true requires "
            "MEDIACRAWLER_BROWSER_HEADLESS=false"
        )
    browser_proxy = deployment_browser_proxy()
    browser_options: dict[str, object] = {
        "headless": config.browser_headless,
        "browser_channel": config.browser_channel,
        "interaction_surface": config.interaction_surface,
    }
    if browser_proxy is not None:
        browser_options["browser_proxy"] = browser_proxy

    if config.mode == "desktop":
        for directory in (
            config.state_root,
            config.profile_root,
            config.crawl_output_root,
        ):
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.chmod(directory, 0o700)
        browser = LocalBrowserSessionManager(
            config.profile_root,
            lease_root=config.state_root,
            browser_factory=lambda: MediaCrawlerDouyinBrowserState(
                **browser_options
            ),
        )
        return AccountManager(
            config.state_root,
            browser,
            profiles_root=config.profile_root,
            interaction_surface=config.interaction_surface,
        )

    volume = os.environ.get("MEDIACRAWLER_ENCRYPTED_VOLUME", "").strip()
    root = os.environ.get("MEDIACRAWLER_PROFILE_ROOT", "").strip()
    if not volume or not root:
        raise RuntimeError(
            "MEDIACRAWLER_ENCRYPTED_VOLUME and "
            "MEDIACRAWLER_PROFILE_ROOT are required"
        )
    deployment_browser_display()
    root_path = validate_encrypted_profile_root(Path(volume), Path(root))
    return AccountManager(
        root_path,
        MediaCrawlerDouyinBrowserState(**browser_options),
        interaction_surface=config.interaction_surface,
    )


def create_deployment_crawl_job_manager(manager: AccountManager) -> CrawlJobManager:
    config = deployment_runtime_config()
    output_root = config.crawl_output_root
    if config.mode == "desktop":
        output_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(output_root, 0o700)
    else:
        output_root = deployment_crawl_output_root()
    return CrawlJobManager(
        manager._root,
        account_resolver=manager.resolve_crawl_profile,
        runner=MediaCrawlerRunner(
            headless=config.browser_headless,
            output_root=output_root,
        ),
    )


def create_deployment_action_job_manager(manager: AccountManager) -> ActionJobManager:
    return ActionJobManager(
        manager._root,
        account_resolver=manager.resolve_action_profile,
        executor=manager.execute_action,
        reconciler=manager.reconcile_action,
    )


def _create_preflighted_deployment_account_manager() -> AccountManager:
    config = deployment_runtime_config()
    if config.mode == "web":
        deployment_crawl_output_root()
    else:
        config.crawl_output_root.mkdir(
            mode=0o700,
            parents=True,
            exist_ok=True,
        )
        os.chmod(config.crawl_output_root, 0o700)
    return create_deployment_account_manager()


def create_deployment_app() -> FastAPI:
    config = deployment_runtime_config()
    outreach_actions_enabled = config.outreach_actions_enabled
    return _build_app(
        deployment_service_secret,
        deployment_manager_factory=_create_preflighted_deployment_account_manager,
        deployment_crawl_factory=create_deployment_crawl_job_manager,
        deployment_action_factory=(
            create_deployment_action_job_manager
            if outreach_actions_enabled else None
        ),
        outreach_actions_enabled=outreach_actions_enabled,
        runtime_mode=config.mode,
    )


# Deployment entry point: fail closed rather than placing browser state on an
# unencrypted/default filesystem. Unit tests use create_app with an injected manager.
app = create_deployment_app()
