from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import stat

import pytest


ENTRYPOINT = Path(__file__).parents[1] / "scripts" / "frozen-sidecar-entrypoint.py"
SPEC = importlib.util.spec_from_file_location("shensi_frozen_entrypoint", ENTRYPOINT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def make_node(root: Path) -> Path:
    node = root / "playwright" / "driver" / "node"
    node.parent.mkdir(parents=True)
    node.write_bytes(b"node")
    node.chmod(node.stat().st_mode | stat.S_IXUSR)
    return node


def test_frozen_bootstrap_calls_freeze_support_before_argument_parser(monkeypatch: pytest.MonkeyPatch) -> None:
    order: list[str] = []
    monkeypatch.setattr(MODULE.multiprocessing, "freeze_support", lambda: order.append("freeze"))
    monkeypatch.setattr(MODULE, "configure_frozen_node", lambda: order.append("node"))
    monkeypatch.setattr(MODULE, "main", lambda: order.append("main") or 0)
    assert MODULE.frozen_main() == 0
    assert order == ["freeze", "node", "main"]


def test_frozen_node_is_resolved_inside_resource_root_and_prefixed_to_path(tmp_path: Path) -> None:
    node = make_node(tmp_path)
    environment = {"PATH": "/usr/bin:/bin"}
    resolved = MODULE.configure_frozen_node(
        frozen=True, resource_root=tmp_path, environment=environment
    )
    assert resolved == node.resolve()
    assert environment["PATH"] == f"{node.parent.resolve()}{os.pathsep}/usr/bin:/bin"


def test_frozen_node_rejects_missing_non_executable_and_escaping_paths(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="missing"):
        MODULE.configure_frozen_node(frozen=True, resource_root=tmp_path, environment={})
    node = make_node(tmp_path)
    node.chmod(stat.S_IRUSR)
    with pytest.raises(RuntimeError, match="executable"):
        MODULE.configure_frozen_node(frozen=True, resource_root=tmp_path, environment={})
    outside = make_node(tmp_path.parent / f"{tmp_path.name}-outside")
    node.unlink()
    node.symlink_to(outside)
    with pytest.raises(RuntimeError, match="escapes"):
        MODULE.configure_frozen_node(frozen=True, resource_root=tmp_path, environment={})


def test_non_frozen_mode_preserves_path(tmp_path: Path) -> None:
    environment = {"PATH": "/custom/bin"}
    assert MODULE.configure_frozen_node(
        frozen=False, resource_root=tmp_path, environment=environment
    ) is None
    assert environment == {"PATH": "/custom/bin"}


def test_frozen_mode_rejects_absent_meipass_even_when_cwd_contains_node(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    make_node(tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.delattr(MODULE.sys, "_MEIPASS", raising=False)
    with pytest.raises(RuntimeError, match="resource root is missing"):
        MODULE.configure_frozen_node(frozen=True, environment={})


def test_frozen_dispatch_enforces_desktop_action_preflight_before_binding(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / 'services/media-crawler'))
    from shensi_adapter import desktop_entrypoint

    user_data = tmp_path / 'user-data'
    logs = user_data / 'logs'
    logs.mkdir(parents=True)
    secret = tmp_path / 'secret'
    secret.write_text('s' * 48)
    secret.chmod(0o600)
    read_fd, write_fd = os.pipe()
    try:
        for key, value in {
            'SHENSI_RUNTIME_MODE': 'desktop', 'MEDIACRAWLER_BROWSER_DISPLAY': 'operator',
            'SHENSI_USER_DATA_DIR': str(user_data), 'SHENSI_LOG_DIR': str(logs),
            'MEDIACRAWLER_SERVICE_SECRET_FILE': str(secret), 'SHENSI_READY_FD': str(write_fd),
        }.items():
            monkeypatch.setenv(key, value)
        monkeypatch.delenv('SHENSI_DESKTOP_OUTREACH_ACTIONS_ENABLED', raising=False)
        monkeypatch.setattr(MODULE.sys, 'argv', ['frozen-sidecar'])

        def forbidden_listener():
            pytest.fail('invalid frozen startup must not bind a listener')

        monkeypatch.setattr(desktop_entrypoint, 'bind_desktop_listener', forbidden_listener)
        assert MODULE.main() != 0
        assert 'SHENSI_DESKTOP_OUTREACH_ACTIONS_ENABLED' in capsys.readouterr().err
    finally:
        os.close(read_fd)
        os.close(write_fd)
