import errno
import importlib
from pathlib import Path

import pytest


def _stat(proc_root, pid, *, state="Z", pgrp=700, comm="worker"):
    directory = proc_root / str(pid)
    directory.mkdir()
    # Linux stat fields: pid (1), comm (2), state (3), ppid (4), pgrp (5).
    (directory / "stat").write_text(
        f"{pid} ({comm}) {state} 1 {pgrp} " + "0 " * 47 + "\n",
        encoding="utf-8",
    )


def _probe(monkeypatch, tmp_path, *, linux=True, error=None):
    module = importlib.import_module("shensi_adapter.process_group")
    monkeypatch.setattr(module, "_IS_LINUX", linux)
    monkeypatch.setattr(module, "_PROC_ROOT", tmp_path)

    def existence_only(pgid, signum):
        assert pgid == 700
        assert signum == 0, "the probe must never signal a process"
        if error:
            raise error

    monkeypatch.setattr(module.os, "killpg", existence_only)
    return module.owned_process_group_alive(700)


@pytest.mark.parametrize("state", ["Z", "X", "x"])
def test_linux_group_containing_only_terminated_members_is_not_alive(
    tmp_path, monkeypatch, state,
):
    _stat(tmp_path, 701, state=state)
    _stat(tmp_path, 702, pgrp=999, state="R")
    assert _probe(monkeypatch, tmp_path) is False


@pytest.mark.parametrize("state", ["R", "S", "D", "T", "t", "I"])
def test_linux_group_with_a_live_member_remains_alive(tmp_path, monkeypatch, state):
    _stat(tmp_path, 701)
    _stat(tmp_path, 702, state=state)
    assert _probe(monkeypatch, tmp_path) is True


def test_linux_stat_comm_uses_its_last_closing_parenthesis(tmp_path, monkeypatch):
    _stat(tmp_path, 701, comm="browser) R 1 999 (helper)")
    assert _probe(monkeypatch, tmp_path) is False


@pytest.mark.parametrize("linux", [False, True])
def test_absent_process_group_returns_false_without_reading_proc(
    tmp_path, monkeypatch, linux,
):
    absent = tmp_path / "not-mounted"
    assert _probe(
        monkeypatch, absent, linux=linux,
        error=ProcessLookupError(errno.ESRCH, "gone"),
    ) is False


@pytest.mark.parametrize("error", [
    PermissionError(errno.EPERM, "denied"),
    OSError(errno.EIO, "unknown"),
])
def test_group_probe_errors_fail_closed(tmp_path, monkeypatch, error):
    _stat(tmp_path, 701)
    assert _probe(monkeypatch, tmp_path, error=error) is True


def test_non_linux_keeps_an_existing_group_alive_without_proc(tmp_path, monkeypatch):
    assert _probe(monkeypatch, tmp_path / "not-mounted", linux=False) is True


def test_linux_unavailable_proc_fails_closed(tmp_path, monkeypatch):
    assert _probe(monkeypatch, tmp_path / "not-mounted") is True


def test_linux_no_observed_group_members_fails_closed(tmp_path, monkeypatch):
    _stat(tmp_path, 701, pgrp=999)
    assert _probe(monkeypatch, tmp_path) is True


@pytest.mark.parametrize("payload", [
    "701 worker Z 1 700", "701 (worker)", "701 (worker) Z 1 invalid",
    "701 (worker) ZZ 1 700", "702 (worker) Z 1 700",
])
def test_linux_malformed_stat_fails_closed(tmp_path, monkeypatch, payload):
    _stat(tmp_path, 701)
    (tmp_path / "701" / "stat").write_text(payload, encoding="utf-8")
    assert _probe(monkeypatch, tmp_path) is True


@pytest.mark.parametrize("error", [FileNotFoundError("gone"), PermissionError("denied")])
def test_linux_unreadable_stat_fails_closed(tmp_path, monkeypatch, error):
    _stat(tmp_path, 701)
    original = Path.read_text

    def read_text(path, *args, **kwargs):
        if path == tmp_path / "701" / "stat":
            raise error
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read_text)
    assert _probe(monkeypatch, tmp_path) is True


def test_linux_only_reads_numeric_pid_stat_files(tmp_path, monkeypatch):
    _stat(tmp_path, 701)
    (tmp_path / "self").mkdir()
    (tmp_path / "meminfo").write_text("not a process", encoding="utf-8")
    original = Path.read_text

    def read_text(path, *args, **kwargs):
        assert path == tmp_path / "701" / "stat"
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read_text)
    assert _probe(monkeypatch, tmp_path) is False
