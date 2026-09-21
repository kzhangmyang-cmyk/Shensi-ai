"""Dedicated loopback-only entry point for the macOS desktop Sidecar."""

from __future__ import annotations

import json
import os
import socket
import stat
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

import uvicorn

from .runtime_config import load_runtime_config, repository_root_for_module
from .security import require_service_secret


LOOPBACK_HOST = "127.0.0.1"
PROTOCOL_VERSION = 1
REPOSITORY_ROOT = repository_root_for_module(__file__)


@dataclass(frozen=True, slots=True)
class DesktopEntrypointConfig:
    host: str
    user_data_dir: Path
    log_dir: Path
    service_secret_file: Path
    ready_fd: int


def _required_directory(environment: Mapping[str, str], name: str) -> Path:
    value = environment.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise RuntimeError(f"{name} must be absolute")
    if path.is_symlink() or not path.is_dir():
        raise RuntimeError(f"{name} must be a non-symlinked directory")
    return path.resolve(strict=True)


def _validate_service_secret(environment: Mapping[str, str]) -> Path:
    value = environment.get("MEDIACRAWLER_SERVICE_SECRET_FILE", "").strip()
    if not value:
        raise RuntimeError("MEDIACRAWLER_SERVICE_SECRET_FILE is required")
    path = Path(value).expanduser()
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise RuntimeError(
            "MEDIACRAWLER_SERVICE_SECRET_FILE must be a regular file"
        ) from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise RuntimeError(
                "MEDIACRAWLER_SERVICE_SECRET_FILE must be a regular file"
            )
        if metadata.st_mode & 0o077 or metadata.st_uid != os.getuid():
            raise RuntimeError(
                "MEDIACRAWLER_SERVICE_SECRET_FILE must be owner-only"
            )
        if stat.S_IMODE(metadata.st_mode) != 0o600:
            raise RuntimeError(
                "MEDIACRAWLER_SERVICE_SECRET_FILE must have mode 0600"
            )
        with os.fdopen(os.dup(descriptor), encoding="utf-8") as source:
            require_service_secret(source.read())
    finally:
        os.close(descriptor)
    return path.resolve(strict=True)


def _ready_fd(environment: Mapping[str, str]) -> int:
    value = environment.get("SHENSI_READY_FD", "").strip()
    try:
        descriptor = int(value)
    except ValueError as error:
        raise RuntimeError("SHENSI_READY_FD must be a file descriptor") from error
    if descriptor <= 2:
        raise RuntimeError("SHENSI_READY_FD must be a dedicated file descriptor")
    try:
        os.fstat(descriptor)
        os.write(descriptor, b"")
    except OSError as error:
        raise RuntimeError("SHENSI_READY_FD must be writable") from error
    return descriptor


def load_desktop_entrypoint_config(
    environment: Mapping[str, str],
) -> DesktopEntrypointConfig:
    if environment.get("SHENSI_RUNTIME_MODE", "").strip().lower() != "desktop":
        raise RuntimeError("SHENSI_RUNTIME_MODE=desktop is required")
    host = environment.get("SHENSI_SIDECAR_HOST", LOOPBACK_HOST).strip()
    if host != LOOPBACK_HOST:
        raise RuntimeError("desktop Sidecar host must be 127.0.0.1")
    user_data_dir = _required_directory(environment, "SHENSI_USER_DATA_DIR")
    log_dir = _required_directory(environment, "SHENSI_LOG_DIR")
    service_secret_file = _validate_service_secret(environment)
    ready_fd = _ready_fd(environment)
    try:
        runtime = load_runtime_config(
            environment,
            repository_root=REPOSITORY_ROOT,
        )
    except ValueError as error:
        raise RuntimeError(str(error)) from error
    if runtime.mode != "desktop":
        raise RuntimeError("SHENSI_RUNTIME_MODE=desktop is required")
    if environment.get("SHENSI_DESKTOP_OUTREACH_ACTIONS_ENABLED") not in {"true", "false"}:
        raise RuntimeError("SHENSI_DESKTOP_OUTREACH_ACTIONS_ENABLED must be explicitly true or false")
    if (runtime.interaction_surface != "external_window" or runtime.browser_headless
            or environment.get("MEDIACRAWLER_BROWSER_HEADLESS", "false") != "false"):
        raise RuntimeError("desktop Sidecar requires external_window and headless=false")
    return DesktopEntrypointConfig(
        host=host,
        user_data_dir=user_data_dir,
        log_dir=log_dir,
        service_secret_file=service_secret_file,
        ready_fd=ready_fd,
    )


def bind_desktop_listener() -> socket.socket:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind((LOOPBACK_HOST, 0))
        listener.listen(socket.SOMAXCONN)
        return listener
    except BaseException:
        listener.close()
        raise


def _emit_ready(descriptor: int, listener: socket.socket) -> None:
    payload = json.dumps(
        {
            "type": "shensi-sidecar-ready",
            "protocolVersion": PROTOCOL_VERSION,
            "pid": os.getpid(),
            "port": listener.getsockname()[1],
        },
        separators=(",", ":"),
    ).encode("utf-8") + b"\n"
    try:
        while payload:
            written = os.write(descriptor, payload)
            if written <= 0:
                raise RuntimeError("SHENSI_READY_FD write failed")
            payload = payload[written:]
    finally:
        os.close(descriptor)


def run(environment: Mapping[str, str]) -> int:
    configuration = load_desktop_entrypoint_config(environment)
    listener = bind_desktop_listener()
    ready_emitted = False
    try:
        from .app import create_deployment_app

        application = create_deployment_app()
        server = uvicorn.Server(
            uvicorn.Config(
                application,
                host=configuration.host,
                port=0,
                workers=1,
                lifespan="on",
                access_log=False,
                timeout_graceful_shutdown=20,
            )
        )
        _emit_ready(configuration.ready_fd, listener)
        ready_emitted = True
        server.run(sockets=[listener])
        return 0 if server.started else 1
    finally:
        listener.close()
        if not ready_emitted:
            try:
                os.close(configuration.ready_fd)
            except OSError:
                pass


def main() -> int:
    try:
        return run(os.environ)
    except (OSError, RuntimeError, ValueError) as error:
        print(f"Shensi desktop Sidecar startup failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
