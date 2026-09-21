from __future__ import annotations

from pathlib import Path

import pytest


def _load_runtime_config(env: dict[str, str], repository_root: Path):
    # Import inside the test helper so the pre-implementation RED run reports
    # each missing behavior instead of stopping collection at one import error.
    from shensi_adapter.runtime_config import load_runtime_config

    return load_runtime_config(env, repository_root=repository_root)


def test_repository_root_resolution_supports_the_shallow_container_layout(
):
    from shensi_adapter.runtime_config import repository_root_for_module

    container_root = Path("/app")
    module_file = container_root / "shensi_adapter" / "app.py"

    assert repository_root_for_module(
        module_file,
        fallback_root=container_root,
    ) == container_root.resolve()


def test_repository_root_resolution_preserves_the_source_checkout(tmp_path):
    from shensi_adapter.runtime_config import repository_root_for_module

    repository_root = tmp_path / "shensi"
    package_root = repository_root / "services" / "media-crawler"
    package_root.mkdir(parents=True)

    assert repository_root_for_module(
        package_root / "shensi_adapter" / "app.py",
        fallback_root=tmp_path / "fallback",
    ) == repository_root.resolve()


def test_operator_runtime_is_desktop_external_window_without_remote_display(
    tmp_path,
):
    config = _load_runtime_config(
        {"MEDIACRAWLER_BROWSER_DISPLAY": "operator"},
        tmp_path,
    )

    assert config.mode == "desktop"
    assert config.interaction_surface == "external_window"
    assert config.browser_headless is False
    assert config.uses_virtual_display is False
    assert config.supports_live_sessions is False


def test_virtual_runtime_preserves_the_web_remote_canvas_strategy(tmp_path):
    profile_root = tmp_path / "encrypted" / "profiles"
    config = _load_runtime_config(
        {
            "MEDIACRAWLER_BROWSER_DISPLAY": "virtual",
            "MEDIACRAWLER_PROFILE_ROOT": str(profile_root),
        },
        tmp_path,
    )

    assert config.mode == "web"
    assert config.interaction_surface == "remote_canvas"
    assert config.uses_virtual_display is True
    assert config.supports_live_sessions is True
    assert config.profile_root == profile_root


def test_desktop_profile_root_follows_the_configured_application_data_root(
    tmp_path,
):
    first_app_data = tmp_path / "first-app-data"
    second_app_data = tmp_path / "second-app-data"

    first = _load_runtime_config(
        {
            "MEDIACRAWLER_BROWSER_DISPLAY": "operator",
            "SHENSI_USER_DATA_DIR": str(first_app_data),
        },
        tmp_path,
    )
    second = _load_runtime_config(
        {
            "MEDIACRAWLER_BROWSER_DISPLAY": "operator",
            "SHENSI_USER_DATA_DIR": str(second_app_data),
        },
        tmp_path,
    )

    assert first.profile_root == first_app_data / "profiles" / "douyin"
    assert second.profile_root == second_app_data / "profiles" / "douyin"
    assert first.profile_root != second.profile_root


def test_desktop_profile_root_defaults_to_repo_local_data(tmp_path):
    config = _load_runtime_config(
        {"MEDIACRAWLER_BROWSER_DISPLAY": "operator"},
        tmp_path,
    )

    assert config.profile_root == (
        tmp_path / ".local-data" / "profiles" / "douyin"
    )


def test_runtime_config_rejects_an_unknown_browser_display(tmp_path):
    with pytest.raises(
        ValueError,
        match="MEDIACRAWLER_BROWSER_DISPLAY must be operator or virtual",
    ):
        _load_runtime_config(
            {"MEDIACRAWLER_BROWSER_DISPLAY": "embedded"},
            tmp_path,
        )


def test_desktop_chromium_sentinel_selects_the_bundled_playwright_browser(
    tmp_path,
):
    config = _load_runtime_config(
        {
            "SHENSI_RUNTIME_MODE": "desktop",
            "SHENSI_USER_DATA_DIR": str(tmp_path / "app-data"),
            "MEDIACRAWLER_BROWSER_CHANNEL": "chromium",
        },
        tmp_path,
    )

    assert config.browser_channel is None


def test_desktop_chrome_channel_remains_an_explicit_system_browser(
    tmp_path,
):
    config = _load_runtime_config(
        {
            "SHENSI_RUNTIME_MODE": "desktop",
            "SHENSI_USER_DATA_DIR": str(tmp_path / "app-data"),
            "MEDIACRAWLER_BROWSER_CHANNEL": "chrome",
        },
        tmp_path,
    )

    assert config.browser_channel == "chrome"


@pytest.mark.parametrize('mode,desktop,web,expected', [
    ('desktop', None, 'true', False), ('desktop', 'false', 'true', False),
    ('desktop', 'true', 'false', True), ('web', 'true', 'false', False),
    ('web', 'false', 'true', True),
])
def test_runtime_action_capabilities_are_independent(tmp_path, mode, desktop, web, expected):
    env = {'SHENSI_RUNTIME_MODE': mode, 'DOUYIN_OUTREACH_ACTIONS_ENABLED': web}
    if desktop is not None:
        env['SHENSI_DESKTOP_OUTREACH_ACTIONS_ENABLED'] = desktop
    assert _load_runtime_config(env, tmp_path).outreach_actions_enabled is expected


@pytest.mark.parametrize('value', ['', 'TRUE', '1', ' true ', 'yes'])
def test_desktop_rejects_non_boolean_action_capability(tmp_path, value):
    with pytest.raises(ValueError, match='SHENSI_DESKTOP_OUTREACH_ACTIONS_ENABLED'):
        _load_runtime_config({'SHENSI_RUNTIME_MODE': 'desktop',
            'SHENSI_DESKTOP_OUTREACH_ACTIONS_ENABLED': value}, tmp_path)
