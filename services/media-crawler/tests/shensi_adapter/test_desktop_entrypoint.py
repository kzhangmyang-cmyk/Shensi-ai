from __future__ import annotations

import http.client
import json
import os
import select
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from shensi_adapter import desktop_entrypoint


SERVICE_ROOT = Path(__file__).resolve().parents[2]
REMOTE_DISPLAY_EXECUTABLES = (
    "Xvfb",
    "x11vnc",
    "vncserver",
    "websockify",
    "novnc",
    "novnc_proxy",
)


def _owner_only_file(path: Path, value: str) -> None:
    path.write_text(value, encoding="utf-8")
    path.chmod(0o600)


def _desktop_environment(tmp_path: Path, ready_fd: int) -> dict[str, str]:
    user_data = tmp_path / "user-data"
    logs = user_data / "logs"
    user_data.mkdir(mode=0o700)
    logs.mkdir(mode=0o700)
    secret = tmp_path / "sidecar-secret"
    _owner_only_file(secret, "s" * 48)
    return {
        **os.environ,
        "SHENSI_RUNTIME_MODE": "desktop",
        "SHENSI_DESKTOP_OUTREACH_ACTIONS_ENABLED": "false",
        "SHENSI_USER_DATA_DIR": str(user_data),
        "SHENSI_LOG_DIR": str(logs),
        "MEDIACRAWLER_SERVICE_SECRET_FILE": str(secret),
        "SHENSI_READY_FD": str(ready_fd),
        "MEDIACRAWLER_BROWSER_CHANNEL": "chromium",
    }


def _read_ready_line(fd: int, process: subprocess.Popen[bytes]) -> bytes:
    deadline = time.monotonic() + 10
    chunks = bytearray()
    while time.monotonic() < deadline:
        readable, _, _ = select.select([fd], [], [], 0.1)
        if readable:
            chunk = os.read(fd, 4096)
            if not chunk:
                break
            chunks.extend(chunk)
            if b"\n" in chunks:
                return bytes(chunks)
        if process.poll() is not None:
            break
    stderr = (
        process.stderr.read().decode("utf-8", errors="replace")
        if process.stderr
        else ""
    )
    raise AssertionError(f"sidecar did not become ready: {stderr}")


def _health(port: int, secret: str) -> tuple[int, dict[str, object]]:
    deadline = time.monotonic() + 10
    last_error: OSError | None = None
    while time.monotonic() < deadline:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=0.5)
        try:
            connection.request(
                "GET",
                "/internal/v1/health",
                headers={"Authorization": f"Bearer {secret}"},
            )
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        except OSError as error:
            last_error = error
            time.sleep(0.05)
        finally:
            connection.close()
    raise AssertionError(f"sidecar health did not respond: {last_error}")


def _install_remote_display_tripwires(
    tmp_path: Path,
    environment: dict[str, str],
) -> Path:
    binary_root = tmp_path / "remote-display-tripwires"
    binary_root.mkdir(mode=0o700)
    marker = tmp_path / "remote-display-launched"
    program = (
        "#!/bin/sh\n"
        'printf "%s\\n" "$0" >> "$SHENSI_REMOTE_LAUNCH_MARKER"\n'
        "exit 97\n"
    )
    for name in REMOTE_DISPLAY_EXECUTABLES:
        executable = binary_root / name
        executable.write_text(program, encoding="utf-8")
        executable.chmod(0o700)
    environment["PATH"] = f"{binary_root}{os.pathsep}{environment.get('PATH', '')}"
    environment["SHENSI_REMOTE_LAUNCH_MARKER"] = str(marker)
    return marker


def test_desktop_entrypoint_import_has_no_remote_display_launch_dependency():
    source = Path(desktop_entrypoint.__file__).read_text(encoding="utf-8").lower()
    for forbidden in (
        "xvfb",
        "x11vnc",
        "vncserver",
        "websockify",
        "novnc",
        "live-sessions",
    ):
        assert forbidden not in source

    probe = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import json,sys; import shensi_adapter.desktop_entrypoint; "
                "print(json.dumps(sorted(name for name in sys.modules "
                "if name.startswith('shensi_adapter.'))))"
            ),
        ],
        cwd=SERVICE_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    imported = set(json.loads(probe.stdout))
    assert "shensi_adapter.app" not in imported
    assert "shensi_adapter.accounts" not in imported
    assert "shensi_adapter.browser_state" not in imported


@pytest.mark.parametrize(
    ("case", "message"),
    [
        ("missing", "MEDIACRAWLER_SERVICE_SECRET_FILE is required"),
        ("not-found", "must be a regular file"),
        ("symlink", "must be a regular file"),
        ("loose", "must be owner-only"),
        ("readonly", "must have mode 0600"),
        ("owner-executable", "must have mode 0600"),
        ("short", "at least 32"),
    ],
)
def test_preflight_rejects_invalid_service_secret(tmp_path, case, message):
    read_fd, write_fd = os.pipe()
    try:
        environment = _desktop_environment(tmp_path, write_fd)
        secret = Path(environment["MEDIACRAWLER_SERVICE_SECRET_FILE"])
        if case == "missing":
            environment.pop("MEDIACRAWLER_SERVICE_SECRET_FILE")
        elif case == "not-found":
            environment["MEDIACRAWLER_SERVICE_SECRET_FILE"] = str(
                tmp_path / "absent-secret"
            )
        elif case == "symlink":
            linked = tmp_path / "linked-secret"
            linked.symlink_to(secret)
            environment["MEDIACRAWLER_SERVICE_SECRET_FILE"] = str(linked)
        elif case == "loose":
            secret.chmod(0o644)
        elif case == "readonly":
            secret.chmod(0o400)
        elif case == "owner-executable":
            secret.chmod(0o700)
        else:
            _owner_only_file(secret, "too-short")

        with pytest.raises((RuntimeError, ValueError), match=message):
            desktop_entrypoint.load_desktop_entrypoint_config(environment)
    finally:
        os.close(read_fd)
        os.close(write_fd)


@pytest.mark.parametrize(
    "case",
    [
        "missing-user-data",
        "relative-user-data",
        "missing-log-env",
        "missing-log-dir",
        "symlink-log-dir",
        "user-data-file",
    ],
)
def test_preflight_rejects_invalid_application_directories(tmp_path, case):
    read_fd, write_fd = os.pipe()
    try:
        environment = _desktop_environment(tmp_path, write_fd)
        if case == "missing-user-data":
            environment.pop("SHENSI_USER_DATA_DIR")
        elif case == "relative-user-data":
            environment["SHENSI_USER_DATA_DIR"] = "relative/user-data"
        elif case == "missing-log-env":
            environment.pop("SHENSI_LOG_DIR")
        elif case == "missing-log-dir":
            environment["SHENSI_LOG_DIR"] = str(tmp_path / "missing-logs")
        elif case == "symlink-log-dir":
            linked = tmp_path / "linked-logs"
            linked.symlink_to(
                Path(environment["SHENSI_LOG_DIR"]),
                target_is_directory=True,
            )
            environment["SHENSI_LOG_DIR"] = str(linked)
        else:
            file_path = tmp_path / "not-a-directory"
            file_path.write_text("data", encoding="utf-8")
            environment["SHENSI_USER_DATA_DIR"] = str(file_path)

        with pytest.raises(RuntimeError, match="SHENSI_(USER_DATA_DIR|LOG_DIR)"):
            desktop_entrypoint.load_desktop_entrypoint_config(environment)
    finally:
        os.close(read_fd)
        os.close(write_fd)


@pytest.mark.parametrize("value", [None, "not-a-number", "-1", "1"])
def test_preflight_requires_a_dedicated_writable_ready_fd(tmp_path, value):
    read_fd, write_fd = os.pipe()
    try:
        environment = _desktop_environment(tmp_path, write_fd)
        if value is None:
            environment.pop("SHENSI_READY_FD")
        else:
            environment["SHENSI_READY_FD"] = value

        with pytest.raises(RuntimeError, match="SHENSI_READY_FD"):
            desktop_entrypoint.load_desktop_entrypoint_config(environment)
    finally:
        os.close(read_fd)
        os.close(write_fd)


@pytest.mark.parametrize("host", ["0.0.0.0", "localhost", "::1"])
def test_preflight_rejects_every_non_numeric_ipv4_loopback_host(tmp_path, host):
    read_fd, write_fd = os.pipe()
    try:
        environment = _desktop_environment(tmp_path, write_fd)
        environment["SHENSI_SIDECAR_HOST"] = host

        with pytest.raises(RuntimeError, match="127.0.0.1"):
            desktop_entrypoint.load_desktop_entrypoint_config(environment)
    finally:
        os.close(read_fd)
        os.close(write_fd)


@pytest.mark.parametrize("mode", [None, "web"])
def test_preflight_requires_explicit_desktop_runtime(tmp_path, mode):
    read_fd, write_fd = os.pipe()
    try:
        environment = _desktop_environment(tmp_path, write_fd)
        if mode is None:
            environment.pop("SHENSI_RUNTIME_MODE")
        else:
            environment["SHENSI_RUNTIME_MODE"] = mode

        with pytest.raises(RuntimeError, match="SHENSI_RUNTIME_MODE=desktop"):
            desktop_entrypoint.load_desktop_entrypoint_config(environment)
    finally:
        os.close(read_fd)
        os.close(write_fd)


def test_loopback_listener_uses_two_independent_system_assigned_ports():
    first = desktop_entrypoint.bind_desktop_listener()
    second = desktop_entrypoint.bind_desktop_listener()
    try:
        first_host, first_port = first.getsockname()
        second_host, second_port = second.getsockname()

        assert first_host == second_host == "127.0.0.1"
        assert 0 < first_port <= 65535
        assert 0 < second_port <= 65535
        assert first_port != second_port
    finally:
        first.close()
        second.close()


@pytest.mark.parametrize('value', [None, '', 'true ', 'TRUE', 'yes'])
def test_preflight_requires_explicit_boolean_desktop_action_flag(tmp_path, value):
    read_fd, write_fd = os.pipe()
    try:
        environment = _desktop_environment(tmp_path, write_fd)
        if value is None:
            environment.pop('SHENSI_DESKTOP_OUTREACH_ACTIONS_ENABLED')
        else:
            environment['SHENSI_DESKTOP_OUTREACH_ACTIONS_ENABLED'] = value
        with pytest.raises(RuntimeError, match='SHENSI_DESKTOP_OUTREACH_ACTIONS_ENABLED'):
            desktop_entrypoint.load_desktop_entrypoint_config(environment)
    finally:
        os.close(read_fd)
        os.close(write_fd)


def test_preflight_rejects_explicit_headless_desktop(tmp_path):
    read_fd, write_fd = os.pipe()
    try:
        environment = _desktop_environment(tmp_path, write_fd)
        environment['MEDIACRAWLER_BROWSER_HEADLESS'] = 'true'
        with pytest.raises(RuntimeError, match='headless'):
            desktop_entrypoint.load_desktop_entrypoint_config(environment)
    finally:
        os.close(read_fd)
        os.close(write_fd)


def test_module_process_emits_one_ready_record_serves_health_and_stops_on_sigterm(
    tmp_path,
):
    read_fd, write_fd = os.pipe()
    process: subprocess.Popen[bytes] | None = None
    try:
        environment = _desktop_environment(tmp_path, write_fd)
        remote_launch_marker = _install_remote_display_tripwires(
            tmp_path,
            environment,
        )
        environment.pop("DISPLAY", None)
        process = subprocess.Popen(
            [sys.executable, "-m", "shensi_adapter.desktop_entrypoint"],
            cwd=SERVICE_ROOT,
            env=environment,
            pass_fds=(write_fd,),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        os.close(write_fd)
        write_fd = -1

        encoded = _read_ready_line(read_fd, process)
        line, separator, trailing = encoded.partition(b"\n")
        assert separator == b"\n"
        assert trailing == b""
        ready = json.loads(line)
        assert ready == {
            "type": "shensi-sidecar-ready",
            "protocolVersion": 1,
            "pid": process.pid,
            "port": ready["port"],
        }
        assert isinstance(ready["port"], int)
        assert 0 < ready["port"] <= 65535

        readable, _, _ = select.select([read_fd], [], [], 2)
        assert readable
        assert os.read(read_fd, 1) == b""

        status, health = _health(ready["port"], "s" * 48)
        assert status == 200
        assert health["ok"] is True
        assert health["service"] == "shensi-mediacrawler"
        assert not remote_launch_marker.exists()

        process.send_signal(signal.SIGTERM)
        stdout, stderr = process.communicate(timeout=15)
        # Uvicorn 0.29 restores and re-raises the captured signal only after
        # its lifespan shutdown has completed.
        assert process.returncode == -signal.SIGTERM, (stdout, stderr)
        assert b"Application shutdown complete." in stderr
        assert not remote_launch_marker.exists()
        with pytest.raises(OSError):
            connection = http.client.HTTPConnection(
                "127.0.0.1", ready["port"], timeout=0.2
            )
            try:
                connection.request("GET", "/internal/v1/health")
                connection.getresponse()
            finally:
                connection.close()
    finally:
        os.close(read_fd)
        if write_fd >= 0:
            os.close(write_fd)
        if process is not None and process.poll() is None:
            process.kill()
            process.wait(timeout=5)


def test_process_preflight_failure_exits_without_emitting_ready(tmp_path):
    read_fd, write_fd = os.pipe()
    process: subprocess.Popen[bytes] | None = None
    try:
        environment = _desktop_environment(tmp_path, write_fd)
        Path(environment["MEDIACRAWLER_SERVICE_SECRET_FILE"]).chmod(0o644)
        process = subprocess.Popen(
            [sys.executable, "-m", "shensi_adapter.desktop_entrypoint"],
            cwd=SERVICE_ROOT,
            env=environment,
            pass_fds=(write_fd,),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        os.close(write_fd)
        write_fd = -1

        stdout, stderr = process.communicate(timeout=5)
        assert process.returncode != 0, (stdout, stderr)
        assert os.read(read_fd, 1) == b""
        assert b"owner-only" in stderr
    finally:
        os.close(read_fd)
        if write_fd >= 0:
            os.close(write_fd)
        if process is not None and process.poll() is None:
            process.kill()
            process.wait(timeout=5)
